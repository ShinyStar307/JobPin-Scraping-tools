/**
 * Applied-jobs behaviour, end to end through the real service worker (background.js) with a fake `chrome`.
 *
 *   node --experimental-default-type=module --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ---------------- a minimal fake chrome ---------------- */

const store = new Map();
const listeners = [];
const tabMessages = [];
const noop = () => {};
const event = () => ({ addListener: noop, removeListener: noop });
const changeListeners = [];
const fireChanged = (changes) => changeListeners.forEach((fn) => fn(changes, 'local'));

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [...store.keys()];
        return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))]));
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store.get(k), newValue: structuredClone(v) };
          store.set(k, structuredClone(v));
        }
        fireChanged(changes);
      },
      async remove(keys) {
        for (const k of [].concat(keys)) store.delete(k);
      },
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) },
  },
  runtime: {
    onInstalled: event(),
    onStartup: event(),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  sidePanel: { setPanelBehavior: async () => {} },
  tabs: {
    onRemoved: event(),
    onUpdated: event(),
    query: async () => [],
    sendMessage: async (id, msg) => {
      tabMessages.push({ id, msg });
      return null;
    },
    create: async () => ({ id: 99 }),
    update: async () => ({}),
    remove: async () => {},
  },
  windows: { update: async () => {} },
  permissions: { contains: async () => false, onAdded: event() },
  scripting: { executeScript: async () => [] },
};

await import('../background.js');
const { STORAGE_KEYS } = await import('../shared.js');

/* ---------------- helpers ---------------- */

const TAB = 7;
const ui = (action, extra = {}) =>
  new Promise((resolve) => {
    for (const fn of listeners) if (fn({ type: 'JR_UI', action, ...extra }, {}, resolve)) return;
  });
const ingest = (items) =>
  new Promise((resolve) => {
    for (const fn of listeners) if (fn({ type: 'JR_ITEMS', items }, { tab: { id: TAB } }, resolve)) return;
  });
const ids = (list) => list.map((j) => j.id).sort();
const read = (key, fallback = []) => store.get(key) ?? fallback;

const item = (jobId, applyLink, extra = {}) => ({
  jobResult: {
    jobId,
    jobTitle: `Engineer ${jobId}`,
    applyLink,
    publishTime: new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    isRemote: true,
    employmentType: 'Full-time',
    ...extra,
  },
  companyResult: { companyName: `Company ${jobId}` },
});

const A = item('a', 'https://boards.greenhouse.io/acme/jobs/1');
const B = item('b', 'https://jobs.lever.co/beta/22222');
const C = item('c', 'https://careers.gamma.com/apply?gh_jid=333');
// Same posting as A, found again with tracking parameters and another id (e.g. from the other board).
const A_TWIN = item('a-twin', 'https://boards.greenhouse.io/acme/jobs/1/?utm_source=jobright&gh_src=abc#apply');
// Same page as C, different job: must NOT be mistaken for it.
const C_OTHER = item('c2', 'https://careers.gamma.com/apply?gh_jid=444');

async function resetAndStartRun() {
  await ui('clear'); // resets the worker's in-memory "seen" list too
  store.clear();
  fireChanged({ [STORAGE_KEYS.applied]: { newValue: undefined } }); // storage wiped from outside the worker
  tabMessages.length = 0;
  store.set(STORAGE_KEYS.session, {
    active: true,
    tabId: TAB,
    stats: { seen: 0, kept: 0, linkedin: 0, jobright: 0, board: 0, noLink: 0, duplicates: 0 },
    src: { jobright: { state: 'crawling', pages: 0, total: 0, message: '' } },
  });
}

/* ---------------- tests ---------------- */

test('a job marked as applied leaves the Inbox and is stored with its time and identity', async () => {
  await resetAndStartRun();
  await ingest([A, B, C]);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['a', 'b', 'c']);

  const before = Date.now();
  const res = await ui('markApplied', { ids: ['a'] });
  assert.deepEqual(res, { ok: true, ids: ['a'] });

  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['b', 'c']);
  const applied = read(STORAGE_KEYS.applied);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].id, 'a');
  assert.ok(applied[0].appliedAtMs >= before);
  assert.equal(applied[0].applyKey, 'boards.greenhouse.io/acme/jobs/1');
  assert.equal(applied[0].title, 'Engineer a'); // the whole job is kept
});

test('marking twice, or marking an unknown id, changes nothing', async () => {
  assert.deepEqual(await ui('markApplied', { ids: ['a'] }), { ok: true, ids: [] });
  assert.deepEqual(await ui('markApplied', { ids: ['nope'] }), { ok: true, ids: [] });
  assert.equal(read(STORAGE_KEYS.applied).length, 1);
});

test('applied jobs never come back in later searches — by id or as the same posting under another id', async () => {
  await ingest([A, B, C, A_TWIN]);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['b', 'c']);
  assert.equal(read(STORAGE_KEYS.session).stats.applied, 1, 'the twin is counted once as skipped (A was seen earlier)');
});

test('two different jobs on the same page (told apart by gh_jid) are both kept', async () => {
  await ingest([C_OTHER]);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['b', 'c', 'c2']);
});

test('"Clear list" forgets what was collected but not what was applied to', async () => {
  await ui('clear');
  assert.deepEqual(read(STORAGE_KEYS.jobs), []);
  assert.deepEqual(read(STORAGE_KEYS.seen), []);
  assert.equal(read(STORAGE_KEYS.applied).length, 1);

  await ingest([A, B, A_TWIN]);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['b'], 'applied job stays out even after the seen list was wiped');
});

test('an applied job that Jobright only lists by id does not cost a detail request', async () => {
  tabMessages.length = 0;
  await new Promise((resolve) => {
    for (const fn of listeners) if (fn({ type: 'JR_IDS', ids: ['a', 'zzz'] }, { tab: { id: TAB } }, resolve)) return;
  });
  await new Promise((r) => setTimeout(r, 50));
  const asked = tabMessages.filter((m) => m.msg.type === 'JR_FETCH_DETAIL').map((m) => m.msg.jobId);
  assert.deepEqual(asked, ['zzz']);
});

test('a job listed without an apply link is skipped when its id was applied to', async () => {
  const noLink = item('a', null, { originalUrl: null });
  await ingest([noLink]);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['b']);
});

test('moving a job back restores it exactly and lets later runs update it again', async () => {
  const res = await ui('unmarkApplied', { ids: ['a'] });
  assert.deepEqual(res, { ok: true, ids: ['a'] });
  assert.equal(read(STORAGE_KEYS.applied).length, 0);
  const jobs = read(STORAGE_KEYS.jobs);
  assert.deepEqual(ids(jobs), ['a', 'b']);
  const a = jobs.find((j) => j.id === 'a');
  assert.equal(a.appliedAtMs, undefined);
  assert.equal(a.applyKey, undefined);

  await ingest([A, A_TWIN]);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['a', 'b'], 'no duplicate from the twin: it is a duplicate of the listed job');
});

test('opening an apply link asks once; "not yet" stops the question; applying clears it', async () => {
  await ui('linkOpened', { id: 'b' });
  let b = read(STORAGE_KEYS.jobs).find((j) => j.id === 'b');
  assert.ok(b.openedAtMs > 0);
  assert.equal(b.openedAck, false);

  await ui('ackOpened', { ids: ['b'] });
  b = read(STORAGE_KEYS.jobs).find((j) => j.id === 'b');
  assert.equal(b.openedAck, true);

  await ui('linkOpened', { id: 'b' }); // opening it again asks again
  assert.equal(read(STORAGE_KEYS.jobs).find((j) => j.id === 'b').openedAck, false);

  await ui('markApplied', { ids: ['b'] });
  const rec = read(STORAGE_KEYS.applied).find((j) => j.id === 'b');
  assert.equal(rec.openedAtMs, undefined, 'the question is not carried into the applied record');
  assert.equal(rec.openedAck, undefined);
});

test('several jobs can be marked and restored at once; newest applied first', async () => {
  await resetAndStartRun();
  await ingest([A, B, C]);
  await ui('markApplied', { ids: ['a', 'c'] });
  assert.deepEqual(ids(read(STORAGE_KEYS.applied)), ['a', 'c']);
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['b']);
  await new Promise((r) => setTimeout(r, 5));
  await ui('markApplied', { ids: ['b'] });
  assert.equal(read(STORAGE_KEYS.applied)[0].id, 'b');
  await ui('unmarkApplied', { ids: ['a', 'b', 'c'] });
  assert.deepEqual(ids(read(STORAGE_KEYS.jobs)), ['a', 'b', 'c']);
  assert.deepEqual(read(STORAGE_KEYS.applied), []);
});

test('the Applied view can be opened directly', async () => {
  const res = await ui('openFullView', { view: 'applied' });
  assert.equal(res.ok, true);
});

test('jobKey ignores tracking noise but keeps the parameters that name a job', async () => {
  const { jobKey } = await import('../shared.js');
  assert.equal(jobKey('https://www.Acme.com/jobs/1/?utm_source=x&gclid=1#top'), 'acme.com/jobs/1');
  assert.equal(jobKey('https://acme.com/apply?gh_jid=5&utm_medium=email'), 'acme.com/apply?gh_jid=5');
  assert.notEqual(jobKey('https://acme.com/apply?gh_jid=5'), jobKey('https://acme.com/apply?gh_jid=6'));
  assert.equal(jobKey('https://acme.com/apply?ref=jobright'), 'acme.com/apply');
  assert.equal(jobKey('https://acme.com/apply?ref=48213'), 'acme.com/apply?ref=48213');
  assert.equal(jobKey('https://acme.com/a?b=2&a=1'), jobKey('https://acme.com/a?a=1&b=2'));
  assert.equal(jobKey('not a url'), 'not a url');
});

test.after(() => setTimeout(() => process.exit(0), 50));
