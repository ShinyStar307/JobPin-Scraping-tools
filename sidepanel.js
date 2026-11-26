import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  SOURCES,
  mergeSettings,
  jobMatchesFilters,
  sortJobsNewest,
  fmtRelative,
  jobTypeLabel,
  sourceLabel,
  isAwaitingAnswer,
} from './shared.js';
import {
  h,
  icon,
  companyLogo,
  sourceTags,
  travelTags,
  filterSummary,
  throttle,
  shortAgo,
  appliedByCompany,
  appliedCompanyTag,
  toast,
} from './ui-common.js';
import { mountSettingsForm } from './settings-form.js';

const $ = (id) => document.getElementById(id);
const LIST_LIMIT = 40;
const OPTIONAL_ORIGINS = ['https://*/*', 'http://*/*'];

const ui = (action, extra = {}) =>
  chrome.runtime.sendMessage({ type: 'JR_UI', action, ...extra }).catch(() => null);

let state = { session: null, jobs: [], applied: [], settings: mergeSettings(null) };
let listTab = 'matched'; // 'matched' | 'applied'
/** Jobs being moved between the lists right now: hidden from both until the worker has saved. */
const moving = new Set();

async function loadState() {
  const r = await chrome.storage.local.get([STORAGE_KEYS.session, STORAGE_KEYS.jobs, STORAGE_KEYS.settings, STORAGE_KEYS.applied]);
  state = {
    session: r[STORAGE_KEYS.session] || { active: false, stats: {}, src: {} },
    jobs: Array.isArray(r[STORAGE_KEYS.jobs]) ? r[STORAGE_KEYS.jobs] : [],
    applied: Array.isArray(r[STORAGE_KEYS.applied]) ? r[STORAGE_KEYS.applied] : [],
    settings: mergeSettings(r[STORAGE_KEYS.settings]),
  };
}

/** The two lists as the person should see them (never both, never mid-move). */
function lists() {
  const appliedIds = new Set(state.applied.map((a) => a.id));
  return {
    inbox: state.jobs.filter((j) => !moving.has(j.id) && !appliedIds.has(j.id)),
    done: state.applied.filter((a) => !moving.has(a.id)),
  };
}

/* ================= applying ================= */

const titleOf = (job) => job.title || 'Untitled role';

async function move(action, ids, undoAction, message) {
  ids.forEach((id) => moving.add(id));
  renderMain();
  const res = await ui(action, { ids });
  ids.forEach((id) => moving.delete(id));
  await loadState();
  renderMain();
  if (!res?.ok) return toast('Couldn’t save that — please try again.');
  if (!res.ids.length) return;
  toast(message(res.ids.length), {
    action: {
      label: 'Undo',
      onClick: async () => {
        res.ids.forEach((id) => moving.add(id));
        renderMain();
        await ui(undoAction, { ids: res.ids });
        res.ids.forEach((id) => moving.delete(id));
        await loadState();
        renderMain();
      },
    },
  });
}

const markApplied = (job) =>
  move('markApplied', [job.id], 'unmarkApplied', () => `Marked “${titleOf(job)}” as applied`);
const unmarkApplied = (job) =>
  move('unmarkApplied', [job.id], 'markApplied', () => 'Moved back to the inbox');

/** The apply link was opened: remember it so the panel can ask how it went. */
function noteOpened(job) {
  const stored = state.jobs.find((j) => j.id === job.id);
  if (stored) {
    stored.openedAtMs = Date.now();
    stored.openedAck = false;
  }
  setTimeout(renderPending, 0);
  ui('linkOpened', { id: job.id });
}

function dismissPending(ids) {
  const set = new Set(ids);
  for (const j of state.jobs) if (set.has(j.id)) j.openedAck = true;
  renderPending();
  ui('ackOpened', { ids });
}

function renderPending() {
  const waiting = lists().inbox.filter(isAwaitingAnswer).sort((a, b) => b.openedAtMs - a.openedAtMs);
  const box = $('pending');
  box.hidden = !waiting.length;
  if (!waiting.length) return box.replaceChildren();
  const job = waiting[0];
  const more = waiting.length - 1;
  box.replaceChildren(
    h(
      'div.pending-head',
      {},
      h('span.pending-icon', {}, icon('link')),
      h(
        'div.pending-text',
        {},
        h('div.pending-q', {}, 'Did you apply to ', h('b', {}, titleOf(job)), ` at ${job.company || 'this company'}?`),
        h('div.hint', {}, `Opened ${shortAgo(job.openedAtMs).toLowerCase()}${more ? ` · ${more} more waiting` : ''}`)
      )
    ),
    h(
      'div.pending-actions',
      {},
      h('button.btn.sm.success.solid', { type: 'button', on: { click: () => markApplied(job) } }, icon('check', 'sm'), 'Yes, I applied'),
      h('button.btn.sm', { type: 'button', on: { click: () => dismissPending([job.id]) } }, 'Not yet'),
      more ? h('button.link-btn', { type: 'button', on: { click: () => dismissPending(waiting.map((j) => j.id)) } }, 'Dismiss all') : null
    )
  );
}

/* ================= main view ================= */

const STATE_TEXT = { crawling: 'Scanning', listening: 'Listening', done: 'Done', error: 'Problem', idle: 'Idle' };

function renderBoards() {
  const { settings, session } = state;
  const running = !!session.active;
  $('boards').replaceChildren(
    ...SOURCES.map((src) => {
      const on = settings.sources.includes(src.id);
      const b = h(
        `button.seg-chip${on ? '.on' : ''}`,
        { type: 'button', 'aria-pressed': String(on), title: src.hint, disabled: running },
        src.label
      );
      b.addEventListener('click', async () => {
        const next = on ? settings.sources.filter((x) => x !== src.id) : [...settings.sources, src.id];
        if (!next.length) return toast('Pick at least one job board.');
        await ui('saveSettings', { settings: { ...settings, sources: next } });
      });
      return b;
    })
  );
}

function renderSourceStatus() {
  const { src = {} } = state.session;
  const rows = Object.entries(src).filter(([, x]) => x && (x.state !== 'idle' || x.message));
  $('srcStatus').replaceChildren(
    ...rows.map(([id, x]) =>
      h(
        `div.src-row.${x.state || 'idle'}`,
        {},
        h('span.dot'),
        h('span.src-name', {}, sourceLabel(id)),
        h('span.src-state', {}, STATE_TEXT[x.state] || ''),
        h('span.src-msg', {}, x.message || '')
      )
    )
  );
}

function jobCard(job, byCompany) {
  const sameCompany = appliedCompanyTag(job, byCompany);
  const apply = h('a.btn.apply', { href: job.applyUrl, target: '_blank', rel: 'noopener', title: job.applyUrl }, icon('external', 'sm'), 'Apply');
  apply.addEventListener('click', () => noteOpened(job));
  apply.addEventListener('auxclick', (e) => e.button === 1 && noteOpened(job));
  const awaiting = isAwaitingAnswer(job);
  return h(
    `article.card.job${awaiting ? '.awaiting' : ''}`,
    {},
    companyLogo(job),
    h(
      'div.job-body',
      {},
      h('div.job-title', {}, titleOf(job)),
      h('div.job-company', {}, job.company || 'Unknown company'),
      h('div.job-meta', {}, [fmtRelative(job.postedAtMs), jobTypeLabel(job), job.workModel || job.location].filter(Boolean).join(' · ')),
      h('div.job-host', {}, ...sourceTags(job), ...travelTags(job), sameCompany, awaiting ? h('span.tag.warn', { title: 'You opened its apply page and haven’t said whether you applied.' }, 'Opened') : null),
      h(
        'div.job-actions',
        {},
        apply,
        h(
          'button.btn.sm.success',
          { type: 'button', title: 'Move this job to Applied', on: { click: () => markApplied(job) } },
          icon('check', 'sm'),
          'Mark applied'
        )
      )
    )
  );
}

function appliedCard(job) {
  const open = h('a.btn.sm', { href: job.applyUrl, target: '_blank', rel: 'noopener', title: job.applyUrl }, icon('external', 'sm'), 'Open page');
  return h(
    'article.card.job',
    {},
    companyLogo(job),
    h(
      'div.job-body',
      {},
      h('div.job-title', {}, titleOf(job)),
      h('div.job-company', {}, job.company || 'Unknown company'),
      h(
        'div.job-meta.applied-when',
        { title: new Date(job.appliedAtMs).toLocaleString() },
        icon('check-circle', 'sm'),
        `Applied ${shortAgo(job.appliedAtMs).toLowerCase()}`
      ),
      h('div.job-host', {}, ...sourceTags(job)),
      h(
        'div.job-actions',
        {},
        open,
        h('button.btn.sm', { type: 'button', title: 'Put this job back in the inbox', on: { click: () => unmarkApplied(job) } }, icon('undo', 'sm'), 'Move back')
      )
    )
  );
}

function emptyCard({ art, ok, title, text, action }) {
  return h(
    'div.empty-state.card',
    {},
    h(`div.art${ok ? '.ok' : ''}`, {}, icon(art)),
    h('h3', {}, title),
    h('p', {}, text),
    action ? h('div.actions', {}, action) : null
  );
}

function renderList() {
  const { settings, jobs } = state;
  const { inbox, done } = lists();
  const matched = sortJobsNewest(inbox.filter((j) => jobMatchesFilters(j, settings)));
  const list = $('list');

  $('tcMatched').textContent = matched.length;
  $('tcApplied').textContent = done.length;
  for (const [id, key] of [['tabMatched', 'matched'], ['tabApplied', 'applied']]) {
    $(id).classList.toggle('on', listTab === key);
    $(id).setAttribute('aria-selected', String(listTab === key));
  }
  $('btnFull2').textContent = listTab === 'applied' ? 'Open applied list →' : 'Open inbox →';

  if (listTab === 'applied') {
    const rows = [...done].sort((a, b) => b.appliedAtMs - a.appliedAtMs);
    if (!rows.length) {
      return list.replaceChildren(
        emptyCard({
          art: 'check-circle',
          ok: true,
          title: 'No applications yet',
          text: 'Press “Mark applied” on a job and it moves here — and never shows up in a search again.',
          action: h('button.btn.sm', { type: 'button', on: { click: () => setTab('matched') } }, 'See matched jobs'),
        })
      );
    }
    const cards = rows.slice(0, LIST_LIMIT).map(appliedCard);
    if (rows.length > LIST_LIMIT) {
      cards.push(h('div.more', {}, h('button.link-btn', { on: { click: openApplied } }, `View all ${rows.length} applications →`)));
    }
    return list.replaceChildren(...cards);
  }

  if (!matched.length) {
    const hidden = inbox.length;
    return list.replaceChildren(
      hidden
        ? emptyCard({ art: 'filter', title: 'No jobs match your filters', text: `${hidden} employer jobs are stored — loosen the filters in Settings to see them.`, action: h('button.btn.sm', { type: 'button', on: { click: showSettings } }, 'Edit filters') })
        : jobs.length || done.length
          ? emptyCard({ art: 'check-circle', ok: true, title: 'All caught up', text: `Everything collected has been applied to. New jobs appear after the next run.`, action: h('button.btn.sm', { type: 'button', on: { click: () => setTab('applied') } }, 'View applied') })
          : emptyCard({ art: 'inbox', title: 'No jobs collected yet', text: 'Press Start. Only jobs whose Apply button goes to the company’s own site or ATS are kept.' })
    );
  }

  const byCompany = appliedByCompany(done);
  const cards = matched.slice(0, LIST_LIMIT).map((job) => jobCard(job, byCompany));
  if (matched.length > LIST_LIMIT) {
    cards.push(h('div.more', {}, h('button.link-btn', { on: { click: openFull } }, `View all ${matched.length} in the inbox →`)));
  }
  list.replaceChildren(...cards);
}

function setTab(tab) {
  listTab = tab;
  renderList();
}

function renderMain() {
  const { session, settings } = state;
  const stats = session.stats || {};
  const { inbox, done } = lists();
  const matched = inbox.filter((j) => jobMatchesFilters(j, settings));

  const pill = $('statePill');
  const live = !!session.active;
  pill.className = `pill ${live ? 'live' : 'idle'}`;
  $('stateText').textContent = live ? (session.phase === 'crawling' ? 'Scanning' : 'Listening') : 'Idle';
  $('startedAt').textContent =
    live && session.startedAtMs
      ? `since ${new Date(session.startedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';

  renderBoards();
  renderSourceStatus();

  const hasRows = Object.values(session.src || {}).some((x) => x && (x.state !== 'idle' || x.message));
  $('statusMsg').hidden = hasRows;
  $('statusMsg').textContent = live ? 'Collecting jobs…' : 'Choose your job boards, then press Start.';
  $('statusErr').hidden = !session.lastError;
  $('statusErr').textContent = session.lastError || '';

  const btn = $('btnToggle');
  btn.textContent = live ? 'Stop scraping' : 'Start scraping';
  btn.className = `btn block ${live ? 'stop' : 'primary'}`;

  const skipped = (stats.linkedin || 0) + (stats.jobright || 0) + (stats.board || 0) + (stats.noLink || 0) + (stats.duplicates || 0) + (stats.applied || 0);
  $('stMatched').textContent = matched.length;
  $('stApplied').textContent = done.length;
  $('stEmployer').textContent = inbox.length;
  $('stSkipped').textContent = skipped;
  $('stSkippedBox').title =
    `Skipped while collecting:\nLinkedIn-only: ${stats.linkedin || 0}\nApplies on Jobright: ${stats.jobright || 0}\n` +
    `Job boards (Indeed, Glassdoor…): ${stats.board || 0}\nNo apply link: ${stats.noLink || 0}\n` +
    `Already listed from another board: ${stats.duplicates || 0}\nAlready applied to: ${stats.applied || 0}`;

  $('filterSummary').replaceChildren(...filterSummary(settings));
  renderPending();
  renderList();
}

const openFull = () => ui('openFullView');
const openApplied = () => ui('openFullView', { view: 'applied' });

/* ================= settings view ================= */

let draft = mergeSettings(null);

function mountForm() {
  mountSettingsForm($('settingsForm'), draft, { toast });
}

function showSettings() {
  draft = structuredClone(state.settings);
  mountForm();
  $('viewMain').hidden = true;
  $('viewSettings').hidden = false;
  window.scrollTo(0, 0);
}

function showMain() {
  $('viewSettings').hidden = true;
  $('viewMain').hidden = false;
  window.scrollTo(0, 0);
}

$('btnBack').addEventListener('click', showMain);
$('btnReset').addEventListener('click', () => {
  draft = structuredClone(DEFAULT_SETTINGS);
  mountForm();
});
$('btnSave').addEventListener('click', async () => {
  await ui('saveSettings', { settings: draft });
  toast('Settings saved');
  showMain();
});

/* ================= wiring ================= */

async function refresh() {
  await loadState();
  renderMain();
}
const refreshSoon = throttle(refresh, 400);

$('btnToggle').addEventListener('click', async () => {
  const btn = $('btnToggle');
  btn.disabled = true;
  try {
    if (state.session.active) {
      await ui('stop');
    } else {
      if (state.settings.scanEmployerPages) {
        const granted = await chrome.permissions.request({ origins: OPTIONAL_ORIGINS }).catch(() => false);
        if (!granted) await ui('saveSettings', { settings: { ...state.settings, scanEmployerPages: false } });
      }
      const res = await ui('start');
      if (!res?.ok && res?.error) toast(res.error);
    }
  } finally {
    btn.disabled = false;
    refresh();
  }
});
$('btnClear').addEventListener('click', async () => {
  const n = state.applied.length;
  const keep = n ? ` Your ${n} applied job${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} kept, and stay out of future searches.` : '';
  if (!confirm(`Remove all collected jobs?${keep}`)) return;
  await ui('clear');
  refresh();
});
$('btnSettings').addEventListener('click', showSettings);
$('filterSummary').addEventListener('click', showSettings);
$('btnFull').addEventListener('click', openFull);
$('btnFull2').addEventListener('click', () => (listTab === 'applied' ? openApplied() : openFull()));
$('tabMatched').addEventListener('click', () => setTab('matched'));
$('tabApplied').addEventListener('click', () => setTab('applied'));
$('stAppliedBtn').addEventListener('click', () => {
  setTab('applied');
  $('listTabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

const WATCHED = new Set([STORAGE_KEYS.session, STORAGE_KEYS.jobs, STORAGE_KEYS.settings, STORAGE_KEYS.applied]);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => WATCHED.has(k))) refreshSoon();
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'JR_SHOW_SETTINGS') loadState().then(showSettings);
});
setInterval(() => {
  if (!$('viewMain').hidden) renderMain();
}, 60000);

refresh();
