import {
  STORAGE_KEYS,
  DESC_PREFIX,
  SOURCES,
  mergeSettings,
  dateOption,
  normalizeJobrightItem,
  classifyApplyUrl,
  classifyTravel,
  sortJobsNewest,
  sourceLabel,
  jobKey,
  toAppliedRecord,
  fromAppliedRecord,
  indexApplied,
  isAppliedJob,
} from './shared.js';
import { htmlToText } from './text.js';
import {
  HC_BASE,
  HC_SOURCE,
  HcError,
  buildSearchState,
  crawlPages,
  directFetcher,
  inPageFetch,
  normalizeHit,
} from './hiringcafe.js';
import { JR_BASE, JR_START_PATH, requiredFilters, syncAccountFilters } from './jobright.js';

const MAX_STORED_JOBS = 1500;
const MAX_SEEN_IDS = 8000;
const TRAVEL_CONCURRENCY = 2;
const EMPLOYER_FETCH_TIMEOUT_MS = 12000;
const OPTIONAL_ORIGINS = ['https://*/*', 'http://*/*'];

const JOBRIGHT = 'jobright';
const HIRINGCAFE = HC_SOURCE;

/* ---------------- side panel ---------------- */

function enableSidePanelOnClick() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enableSidePanelOnClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnClick);
enableSidePanelOnClick();

/* ---------------- storage ---------------- */

function freshStats() {
  return { seen: 0, kept: 0, linkedin: 0, jobright: 0, board: 0, noLink: 0, duplicates: 0, applied: 0 };
}

function freshSession() {
  return {
    active: false,
    tabId: null,
    startedAtMs: null,
    phase: 'idle',
    pages: 0,
    message: '',
    lastError: null,
    stats: freshStats(),
    /** Per job board: { state: 'idle'|'crawling'|'listening'|'done'|'error', pages, total, message, error } */
    src: {},
  };
}

async function getLocal(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

const loadSession = async () => ({ ...freshSession(), ...(await getLocal(STORAGE_KEYS.session, {})) });
const saveSession = (s) => chrome.storage.local.set({ [STORAGE_KEYS.session]: s });
const loadJobs = async () => {
  const j = await getLocal(STORAGE_KEYS.jobs, []);
  return Array.isArray(j) ? j : [];
};

/** Saves the newest MAX_STORED_JOBS; descriptions of the ones pushed out go with them. */
async function saveJobs(jobs, extra = {}) {
  const sorted = sortJobsNewest(jobs);
  const dropped = sorted.slice(MAX_STORED_JOBS);
  await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: sorted.slice(0, MAX_STORED_JOBS), ...extra });
  if (dropped.length) await chrome.storage.local.remove(dropped.map((j) => DESC_PREFIX + j.id));
}

const loadSettings = async () => mergeSettings(await getLocal(STORAGE_KEYS.settings, null));

let seenCache = null;
async function seenSet() {
  if (!seenCache) seenCache = new Set(await getLocal(STORAGE_KEYS.seen, []));
  return seenCache;
}
async function persistSeen() {
  const arr = [...(await seenSet())].slice(-MAX_SEEN_IDS);
  await chrome.storage.local.set({ [STORAGE_KEYS.seen]: arr });
}

/* ---------------- applied jobs ---------------- */

/**
 * Jobs the person applied to live in their own list, not in `jobs`. Only this worker writes it, so the
 * in-memory index is always current; ingestion checks it to keep applied jobs out of every later run.
 */
let appliedCache = null;

async function appliedIndex() {
  if (!appliedCache) {
    const list = await getLocal(STORAGE_KEYS.applied, []);
    appliedCache = indexApplied(Array.isArray(list) ? list : []);
  }
  return appliedCache;
}

// If the list is changed from outside this worker (storage cleared, imported, edited), re-read it.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.applied]) {
    const next = changes[STORAGE_KEYS.applied].newValue;
    if (!appliedCache || appliedCache.list.length !== (next?.length ?? 0)) appliedCache = null;
  }
});

/** Jobs and applied list change together, in one storage write, so a job is never in both or neither. */
async function saveJobsAndApplied(jobs, applied) {
  await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: jobs, [STORAGE_KEYS.applied]: applied });
  appliedCache = indexApplied(applied);
}

const idList = (ids) => new Set((Array.isArray(ids) ? ids : [ids]).filter((x) => x != null).map(String));

/** Inbox → Applied. Returns the ids that actually moved. */
function markApplied(ids) {
  const want = idList(ids);
  return serial(async () => {
    const jobs = await loadJobs();
    const moving = jobs.filter((j) => want.has(j.id));
    if (!moving.length) return { ok: true, ids: [] };
    const index = await appliedIndex();
    const now = Date.now();
    const fresh = moving.filter((j) => !index.ids.has(j.id)).map((j) => toAppliedRecord(j, now));
    await saveJobsAndApplied(
      jobs.filter((j) => !want.has(j.id)),
      [...fresh, ...index.list]
    );
    return { ok: true, ids: moving.map((j) => j.id) };
  });
}

/** Applied → Inbox (undo, or "I haven't really applied"). The job may show up in later runs again. */
function unmarkApplied(ids) {
  const want = idList(ids);
  return serial(async () => {
    const index = await appliedIndex();
    const moving = index.list.filter((j) => want.has(j.id));
    if (!moving.length) return { ok: true, ids: [] };
    const back = moving.map(fromAppliedRecord);
    const jobs = (await loadJobs()).filter((j) => !want.has(j.id));
    // What comes back is kept even if it is older than everything else: make room by dropping the oldest.
    const room = sortJobsNewest(jobs);
    const dropped = room.slice(Math.max(0, MAX_STORED_JOBS - back.length));
    await saveJobsAndApplied(
      sortJobsNewest([...room.slice(0, Math.max(0, MAX_STORED_JOBS - back.length)), ...back]),
      index.list.filter((j) => !want.has(j.id))
    );
    if (dropped.length) await chrome.storage.local.remove(dropped.map((j) => DESC_PREFIX + j.id));
    return { ok: true, ids: moving.map((j) => j.id) };
  });
}

/** "Open apply link" was pressed: the Inbox will ask whether the application went through. */
function noteLinkOpened(id) {
  return serial(async () => {
    const jobs = await loadJobs();
    const i = jobs.findIndex((j) => j.id === String(id));
    if (i < 0) return { ok: true };
    jobs[i] = { ...jobs[i], openedAtMs: Date.now(), openedAck: false };
    await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: jobs });
    return { ok: true };
  });
}

/** "Not yet" / dismiss: stop asking about these. */
function ackOpened(ids) {
  const want = idList(ids);
  return serial(async () => {
    const jobs = await loadJobs();
    if (!jobs.some((j) => want.has(j.id) && j.openedAtMs && !j.openedAck)) return { ok: true };
    await chrome.storage.local.set({
      [STORAGE_KEYS.jobs]: jobs.map((j) => (want.has(j.id) ? { ...j, openedAck: true } : j)),
    });
    return { ok: true };
  });
}

/** Serialize all read-modify-write work on session/jobs. */
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function updateSession(patch) {
  return serial(async () => {
    const s = await loadSession();
    const next = typeof patch === 'function' ? patch(s) || s : { ...s, ...patch };
    await saveSession(next);
    return next;
  });
}

/* ---------------- per-source status ---------------- */

const RUNNING = new Set(['crawling', 'listening']);

/** Derives the overall state (active / phase / message / lastError) from the per-source states. */
function finalize(s) {
  // Sources that stopped on their own keep their last words on screen; idle ones only if they left a note.
  const entries = Object.entries(s.src || {}).filter(([, x]) => x && x.state && (x.state !== 'idle' || x.message));
  s.active = entries.some(([, x]) => RUNNING.has(x.state));
  s.phase = !s.active ? 'idle' : entries.some(([, x]) => x.state === 'crawling') ? 'crawling' : 'listening';
  s.pages = entries.reduce((n, [, x]) => n + (x.pages || 0), 0);
  const lines = entries.map(([id, x]) => (entries.length > 1 ? `${sourceLabel(id)}: ${x.message}` : x.message));
  if (lines.length) s.message = lines.join(' · ');
  const errors = entries.filter(([, x]) => x.error).map(([id, x]) => (entries.length > 1 ? `${sourceLabel(id)}: ${x.error}` : x.error));
  s.lastError = errors.length ? errors.join(' ') : null;
  return s;
}

const updateSrc = (id, patch) =>
  updateSession((s) => finalize({ ...s, src: { ...s.src, [id]: { ...(s.src?.[id] || {}), ...patch } } }));

const srcRunning = (s, id) => RUNNING.has(s.src?.[id]?.state);

/* ---------------- tabs ---------------- */

function isJobrightTab(tab) {
  try {
    const h = new URL(tab?.url || '').hostname;
    return h === 'jobright.ai' || h.endsWith('.jobright.ai');
  } catch {
    return false;
  }
}

async function findJobrightTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isJobrightTab(active)) return active;
  const tabs = await chrome.tabs.query({ url: ['https://jobright.ai/*', 'https://*.jobright.ai/*'] });
  return tabs[0] || null;
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScripts(tabId) {
  const ping = await chrome.tabs.sendMessage(tabId, { type: 'JR_PING' }).catch(() => null);
  if (ping?.ok) return;
  await chrome.scripting
    .executeScript({ target: { tabId }, files: ['content/hook.js'], world: 'MAIN' })
    .catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/jobright.js'] }).catch(() => {});
}

const sendToTab = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null);

/* ---------------- ingestion (all sources) ---------------- */

const detailRequested = new Set();

/** Jobright pages still being saved (a run waits for them before it ends). */
let pendingIngests = 0;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function travelFields(j) {
  return {
    travelAir: j.travelAir,
    travelLand: j.travelLand,
    travelMentioned: j.travelMentioned,
    travelSnippet: j.travelSnippet,
    travelSource: j.travelSource,
    employerScanned: j.employerScanned,
    applyHost: j.applyHost,
    capturedAtMs: j.capturedAtMs,
  };
}

/**
 * Keeps the jobs whose Apply link is the hiring company's own page (or its ATS), drops the rest.
 * @param {object[]} jobs normalized jobs ({ id, source, applyUrl, scanText, description, … })
 * @param {string} sourceId job board they came from
 * @param {{ canFetchDetail?: boolean }} [opts]
 * @returns {Promise<string[]>} ids that have no apply link yet and need a detail fetch
 */
async function commitJobs(jobs, sourceId, { canFetchDetail = false } = {}) {
  const needDetail = [];
  let addedEmployer = false;

  await serial(async () => {
    const s = await loadSession();
    if (!srcRunning(s, sourceId)) return;
    const seen = await seenSet();
    const stored = await loadJobs();
    const byId = new Map(stored.map((j) => [j.id, j]));
    const byUrl = new Map(stored.filter((j) => j.applyUrl).map((j) => [jobKey(j.applyUrl), j.id]));
    const descWrites = {};
    const applied = await appliedIndex();

    for (const job of jobs) {
      const { scanText, description, ...rest } = job;

      // Already applied to (here, or the same posting on the other board): never list it again, and
      // don't spend a detail request or a travel scan on it.
      if (isAppliedJob(job, applied)) {
        if (!seen.has(job.id)) {
          seen.add(job.id);
          s.stats.seen += 1;
          s.stats.applied = (s.stats.applied || 0) + 1;
        }
        continue;
      }

      if (!job.applyUrl) {
        if (canFetchDetail) {
          if (!seen.has(job.id) && !detailRequested.has(job.id)) needDetail.push(job.id);
        } else if (!seen.has(job.id)) {
          seen.add(job.id);
          s.stats.seen += 1;
          s.stats.noLink += 1;
        }
        continue;
      }

      if (seen.has(job.id)) {
        const existing = byId.get(job.id);
        if (existing) {
          byId.set(job.id, { ...existing, ...rest, ...travelFields(existing), hasDescription: existing.hasDescription || !!description });
          if (!existing.hasDescription && description) descWrites[DESC_PREFIX + job.id] = description;
        }
        continue;
      }

      seen.add(job.id);
      s.stats.seen += 1;

      const kind = job.easyApplyOnJobright ? 'jobright' : classifyApplyUrl(job.applyUrl);
      if (kind !== 'employer') {
        s.stats[kind === 'none' ? 'noLink' : kind] += 1;
        continue;
      }

      const key = jobKey(job.applyUrl);
      const twin = byUrl.get(key);
      if (twin && twin !== job.id) {
        s.stats.duplicates += 1; // already listed from another board
        continue;
      }

      const t = classifyTravel(scanText);
      // HiringCafe hands over the whole posting: no need to open the employer page for travel.
      const fullPosting = job.source !== JOBRIGHT && (description || '').length > 300;
      const record = {
        ...rest,
        hasDescription: !!description,
        travelAir: t.air,
        travelLand: t.land,
        travelMentioned: t.mentioned,
        travelSnippet: t.snippet,
        travelSource: t.mentioned ? job.source || JOBRIGHT : 'not_stated',
        employerScanned: fullPosting,
        applyHost: hostOf(job.applyUrl),
        capturedAtMs: Date.now(),
      };
      byId.set(job.id, record);
      byUrl.set(key, job.id);
      if (description) descWrites[DESC_PREFIX + job.id] = description;
      if (!fullPosting) addedEmployer = true;
      s.stats.kept += 1;
    }

    await saveJobs([...byId.values()], descWrites);
    await saveSession(s);
    await persistSeen();
    if (addedEmployer) scheduleTravelScan();
  });

  return needDetail;
}

/* ---- Jobright ---- */

async function ingestItems(items, tabId) {
  const session = await loadSession();
  if (!srcRunning(session, JOBRIGHT) || session.tabId !== tabId) return;
  const jobs = items.map(normalizeJobrightItem).filter(Boolean);
  const needDetail = await commitJobs(jobs, JOBRIGHT, { canFetchDetail: true });
  for (const id of needDetail) requestDetail(id, tabId);
}

/* Detail fallback: one at a time, so we don't hammer Jobright. */
let detailChain = Promise.resolve();
function requestDetail(jobId, tabId) {
  if (detailRequested.has(jobId)) return;
  detailRequested.add(jobId);
  detailChain = detailChain.then(async () => {
    const s = await loadSession();
    if (!srcRunning(s, JOBRIGHT) || s.tabId !== tabId) return;
    const res = await sendToTab(tabId, { type: 'JR_FETCH_DETAIL', jobId });
    const item = res?.ok ? res.item : null;
    if (item && (item.jobResult?.applyLink || item.jobResult?.originalUrl)) {
      await ingestItems([item], tabId);
    } else {
      await serial(async () => {
        const seen = await seenSet();
        if (seen.has(jobId)) return;
        seen.add(jobId);
        const ss = await loadSession();
        ss.stats.seen += 1;
        ss.stats.noLink += 1;
        await saveSession(ss);
        await persistSeen();
      });
    }
    await new Promise((r) => setTimeout(r, 900));
  });
}

/* ---- HiringCafe ---- */

let hcRun = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Crawls HiringCafe's classic search from a HiringCafe tab (it already passed the anti-bot check). */
async function crawlViaTab(searchState, crawlOpts) {
  const tab = await chrome.tabs.create({ url: `${HC_BASE}/classic`, active: false });
  try {
    await waitForTabComplete(tab.id, 45000);
    // The anti-bot interstitial usually clears by itself in a real browser: give it a moment.
    for (let i = 0; i < 16; i += 1) {
      const [r] = await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: () => !!document.querySelector('#__NEXT_DATA__') })
        .catch(() => [null]);
      if (r?.result) break;
      await sleep(1500);
    }
    const fetchPage = async (page) => {
      const [r] = await chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: inPageFetch, args: [searchState, page] })
        .catch((e) => [{ result: { error: e.message } }]);
      const res = r?.result;
      if (!res || !Array.isArray(res.hits)) {
        throw new HcError(res?.error || 'the HiringCafe tab gave no answer', res?.status || 0);
      }
      return res;
    };
    return await crawlPages({ ...crawlOpts, fetchPage });
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runHiringCafe(settings) {
  const run = ++hcRun;
  const cancelled = () => run !== hcRun;
  const days = dateOption(settings.datePosted)?.days || 0;
  const searchState = buildSearchState(settings, { days });
  const maxPages = Math.max(1, Math.min(200, Number(settings.maxPages) || 30));

  let read = 0;
  let boardTotal = null;

  const onPage = async (page, index) => {
    if (cancelled()) return;
    const jobs = page.hits.map(normalizeHit).filter(Boolean);
    read += jobs.length;
    boardTotal = page.total || boardTotal;
    await commitJobs(jobs, HIRINGCAFE);
    await updateSrc(HIRINGCAFE, {
      state: 'crawling',
      pages: index + 1,
      total: read,
      boardTotal,
      message: `page ${index + 1} · ${read} jobs read${boardTotal ? ` of ${boardTotal.toLocaleString()}` : ''}`,
    });
  };
  const onRetry = (index, reason) =>
    updateSrc(HIRINGCAFE, { message: `page ${index + 1}: retrying (${reason})` });

  const common = { maxPages, onPage, onRetry, shouldStop: cancelled };

  let result;
  try {
    result = await crawlPages({ ...common, fetchPage: directFetcher(searchState) });
    if (result.stoppedAt !== undefined && !cancelled()) {
      await updateSrc(HIRINGCAFE, { message: 'direct request blocked — using a HiringCafe tab…' });
      result = await crawlViaTab(searchState, { ...common, startPage: result.stoppedAt });
    }
  } catch (e) {
    result = { stoppedAt: 0, reason: String(e?.message || e), pages: 0 };
  }

  if (cancelled()) return;

  if (result.stoppedAt !== undefined && !read) {
    await updateSrc(HIRINGCAFE, {
      state: 'error',
      message: 'could not read HiringCafe.',
      error: `HiringCafe didn't answer: ${result.reason}. Open hiringcafe.com once, pass its check, then press Start again.`,
    });
  } else if (result.stoppedAt !== undefined) {
    await updateSrc(HIRINGCAFE, {
      state: 'done',
      message: `stopped at page ${result.stoppedAt + 1}: ${result.reason}. ${read} jobs read — run again later for the rest.`,
    });
  } else {
    await updateSrc(HIRINGCAFE, { state: 'done', message: `finished · ${read} jobs read.`, error: null });
  }
}

/* ---------------- employer page scan (travel requirements) ---------------- */

async function hasEmployerAccess() {
  try {
    return await chrome.permissions.contains({ origins: OPTIONAL_ORIGINS });
  } catch {
    return false;
  }
}

/** Workday renders client-side; its JSON endpoint has the full description. */
function workdayApiUrl(url) {
  try {
    const u = new URL(url);
    const m = u.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
    if (!m) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (/^[a-z]{2}-[A-Z]{2}$/.test(parts[0] || '')) parts.shift();
    const jobIdx = parts.indexOf('job');
    if (jobIdx < 1) return null;
    const site = parts[jobIdx - 1];
    return `${u.origin}/wday/cxs/${m[1]}/${site}/${parts.slice(jobIdx).join('/')}`;
  } catch {
    return null;
  }
}

async function fetchText(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMPLOYER_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { accept },
    });
    if (!res.ok) return '';
    return (await res.text()).slice(0, 2_500_000);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEmployerText(applyUrl) {
  const wd = workdayApiUrl(applyUrl);
  if (wd) {
    const raw = await fetchText(wd, 'application/json');
    try {
      const j = JSON.parse(raw);
      const info = j.jobPostingInfo || {};
      return htmlToText(`${info.title || ''}. ${info.jobDescription || ''} ${info.timeType || ''}`);
    } catch {
      /* fall through to HTML */
    }
  }
  const html = await fetchText(applyUrl, 'text/html,application/xhtml+xml');
  return html ? htmlToText(html).slice(0, 300000) : '';
}

let travelRunning = 0;
let travelTimer = 0;
function scheduleTravelScan() {
  clearTimeout(travelTimer);
  travelTimer = setTimeout(runTravelScan, 300);
}

async function runTravelScan() {
  const settings = await loadSettings();
  if (!settings.scanEmployerPages || !(await hasEmployerAccess())) return;

  while (travelRunning < TRAVEL_CONCURRENCY) {
    travelRunning += 1;
    const next = await serial(async () => {
      const all = await loadJobs();
      const idx = all.findIndex((j) => !j.employerScanned && !j.__scanning);
      if (idx < 0) return null;
      all[idx] = { ...all[idx], __scanning: true };
      await saveJobs(all);
      return all[idx];
    });
    if (!next) {
      travelRunning -= 1;
      return;
    }
    scanOne(next).finally(() => {
      travelRunning -= 1;
      scheduleTravelScan();
    });
  }
}

async function scanOne(job) {
  let text = '';
  try {
    text = await fetchEmployerText(job.applyUrl);
  } catch {
    text = '';
  }
  const t = text ? classifyTravel(text) : null;
  await serial(async () => {
    const all = await loadJobs();
    const idx = all.findIndex((j) => j.id === job.id);
    if (idx < 0) return;
    const cur = { ...all[idx], employerScanned: true };
    delete cur.__scanning;
    if (t && t.mentioned) {
      cur.travelAir = t.air;
      cur.travelLand = t.land;
      cur.travelMentioned = true;
      cur.travelSnippet = t.snippet;
      cur.travelSource = 'employer';
    } else if (!cur.travelMentioned) {
      cur.travelSource = text ? 'not_stated' : 'unreadable';
    }
    all[idx] = cur;
    await saveJobs(all);
  });
}

/* ---------------- session control ---------------- */

/** A Jobright tab we opened ourselves for the run (closed when the feed has been read). */
let ownJobrightTab = null;

function closeOwnJobrightTab(tabId) {
  if (ownJobrightTab !== tabId) return;
  ownJobrightTab = null;
  chrome.tabs.remove(tabId).catch(() => {});
}

async function startJobright(settings) {
  let tab = await findJobrightTab();
  ownJobrightTab = null;
  if (!tab) {
    // Like ZOR: a background tab, so the page the person is on isn't taken over.
    tab = await chrome.tabs.create({ url: `${JR_BASE}${JR_START_PATH}`, active: false });
    ownJobrightTab = tab.id;
    await waitForTabComplete(tab.id);
  }
  if (tab.status !== 'complete') await waitForTabComplete(tab.id);

  try {
    await ensureContentScripts(tab.id);
    detailRequested.clear();

    const dateOpt = dateOption(settings.datePosted);
    const cutoffMs = dateOpt ? Date.now() - dateOpt.ms : 0;

    await updateSession((s) =>
      finalize({
        ...s,
        tabId: tab.id,
        src: { ...s.src, [JOBRIGHT]: { state: 'crawling', pages: 0, total: 0, message: 'checking your Jobright filters…', error: null } },
      })
    );

    // The feed only shows what the account's saved filters allow: make them the ones asked for first.
    const required = requiredFilters(settings);
    const sync = await syncAccountFilters(tab.id, required, (message) => updateSrc(JOBRIGHT, { message }));
    if (sync.changed) await updateSrc(JOBRIGHT, { message: `Jobright's filters set (they had: ${sync.differences.join('; ')})` });
    if (required.notes.length) await updateSrc(JOBRIGHT, { message: `reading your feed… (${required.notes.join('; ')})` });
    else await updateSrc(JOBRIGHT, { message: 'reading your feed…' });

    const ok = await sendToTab(tab.id, {
      type: 'JR_START',
      options: {
        sortCondition: settings.sortCondition,
        maxPages: settings.maxPages,
        cutoffMs,
        refresh: sync.changed,
      },
    });
    if (!ok) {
      const error = 'Could not reach the Jobright tab. Reload it and press Start again.';
      await updateSrc(JOBRIGHT, { state: 'error', message: 'not reachable.', error });
      closeOwnJobrightTab(tab.id);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e) {
    closeOwnJobrightTab(tab.id);
    throw e;
  }
}

async function startSession() {
  const settings = await loadSettings();
  const wanted = SOURCES.map((x) => x.id).filter((id) => settings.sources.includes(id));

  // Fresh run: every chosen board starts "crawling", so the panel is live at once.
  hcRun += 1; // cancels a HiringCafe run still going
  await updateSession((s) =>
    finalize({
      ...s,
      startedAtMs: Date.now(),
      tabId: null,
      lastError: null,
      src: Object.fromEntries(wanted.map((id) => [id, { state: 'crawling', pages: 0, total: 0, message: 'starting…', error: null }])),
    })
  );

  const errors = [];
  let started = 0;

  if (wanted.includes(JOBRIGHT)) {
    try {
      const r = await startJobright(settings);
      if (r.ok) started += 1;
      else errors.push(r.error);
    } catch (e) {
      const error = `Jobright: ${String(e?.message || e)}`;
      await updateSrc(JOBRIGHT, { state: 'error', message: 'failed.', error });
      errors.push(error);
    }
  }

  if (wanted.includes(HIRINGCAFE)) {
    started += 1;
    runHiringCafe(settings).catch((e) =>
      updateSrc(HIRINGCAFE, { state: 'error', message: 'failed.', error: String(e?.message || e) })
    );
  }

  scheduleTravelScan();
  return started ? { ok: true } : { ok: false, error: errors[0] || 'No job board is selected.' };
}

async function stopSource(id, reason) {
  if (id === HIRINGCAFE) hcRun += 1;
  const s = await updateSession((cur) => {
    if (!srcRunning(cur, id)) return cur;
    return finalize({ ...cur, src: { ...cur.src, [id]: { ...cur.src[id], state: 'idle', message: reason || 'stopped.' } } });
  });
  if (id === JOBRIGHT && s.tabId != null) {
    await sendToTab(s.tabId, { type: 'JR_STOP' });
    closeOwnJobrightTab(s.tabId);
  }
  return s;
}

async function stopSession(reason) {
  await stopSource(HIRINGCAFE, reason);
  return stopSource(JOBRIGHT, reason);
}

function crawlErrorText(err, tabClosed = false) {
  if (/not_logged_in|401|403/.test(err)) return 'Jobright says you are not signed in. Sign in on jobright.ai and press Start again.';
  return tabClosed
    ? `Jobright feed request failed (${err}). Press Start again later.`
    : `Jobright feed request failed (${err}). Scroll the Jobright page — visible jobs are still captured.`;
}

/* ---------------- messages ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const t = message?.type;
  const tabId = sender.tab?.id;

  if (t === 'JR_ITEMS' && tabId != null) {
    pendingIngests += 1;
    ingestItems(Array.isArray(message.items) ? message.items : [], tabId).finally(() => {
      pendingIngests -= 1;
      sendResponse({ ok: true });
    });
    return true;
  }

  if (t === 'JR_IDS' && tabId != null) {
    (async () => {
      const seen = await seenSet();
      const applied = await appliedIndex();
      for (const id of message.ids || []) if (!seen.has(id) && !applied.ids.has(id)) requestDetail(id, tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (t === 'JR_CRAWL' && tabId != null) {
    (async () => {
      const own = ownJobrightTab === tabId;
      // Our own background tab ends with the run: let the last pages finish saving before it does.
      if (own && message.status !== 'progress') {
        for (let i = 0; i < 50 && pendingIngests > 0; i += 1) await sleep(100);
      }
      await updateSession((s) => {
        if (!srcRunning(s, JOBRIGHT) || s.tabId !== tabId) return s;
        let patch;
        if (message.status === 'progress') {
          patch = { state: 'crawling', pages: message.page, total: message.total, message: `feed page ${message.page} · ${message.total} jobs read` };
        } else if (message.status === 'done') {
          patch = own
            ? { state: 'done', message: `finished · ${message.total} jobs read.`, error: null }
            : {
                state: 'listening',
                message: `feed scanned (${message.total} jobs read). Still listening — scroll Jobright to capture more.`,
              };
        } else if (own) {
          patch = { state: 'error', error: crawlErrorText(message.error || '', true), message: 'could not read the feed.' };
        } else {
          patch = { state: 'listening', error: crawlErrorText(message.error || ''), message: 'listening to the page…' };
        }
        return finalize({ ...s, src: { ...s.src, [JOBRIGHT]: { ...s.src[JOBRIGHT], ...patch } } });
      });
      if (own && message.status !== 'progress') closeOwnJobrightTab(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (t === 'JR_UI') {
    (async () => {
      const a = message.action;
      if (a === 'start') return sendResponse(await startSession());
      if (a === 'stop') return sendResponse({ ok: true, session: await stopSession() });
      if (a === 'clear') {
        await serial(async () => {
          const jobs = await loadJobs();
          seenCache = new Set();
          detailRequested.clear();
          await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: [], [STORAGE_KEYS.seen]: [] });
          if (jobs.length) await chrome.storage.local.remove(jobs.map((j) => DESC_PREFIX + j.id));
          const s = await loadSession();
          s.stats = freshStats();
          await saveSession(s);
        });
        return sendResponse({ ok: true });
      }
      if (a === 'saveSettings') {
        await chrome.storage.local.set({ [STORAGE_KEYS.settings]: mergeSettings(message.settings) });
        scheduleTravelScan();
        return sendResponse({ ok: true });
      }
      if (a === 'markApplied') return sendResponse(await markApplied(message.ids));
      if (a === 'unmarkApplied') return sendResponse(await unmarkApplied(message.ids));
      if (a === 'linkOpened') return sendResponse(await noteLinkOpened(message.id));
      if (a === 'ackOpened') return sendResponse(await ackOpened(message.ids));
      if (a === 'rescanTravel') {
        await serial(async () => {
          const jobs = (await loadJobs()).map((j) => ({ ...j, employerScanned: false, __scanning: undefined }));
          await saveJobs(jobs);
        });
        scheduleTravelScan();
        return sendResponse({ ok: true });
      }
      if (a === 'openFullView') {
        const url = chrome.runtime.getURL('board.html');
        // `view: 'applied'` lands on the Applied list; the page follows hash changes without reloading.
        const target = message.view === 'applied' ? `${url}#applied` : message.view === 'inbox' ? `${url}#inbox` : url;
        const existing = await chrome.tabs.query({ url });
        if (existing[0]?.id != null) {
          await chrome.tabs.update(existing[0].id, target === url ? { active: true } : { active: true, url: target });
          await chrome.windows.update(existing[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: target, active: true });
        }
        return sendResponse({ ok: true });
      }
      return sendResponse({ ok: false, error: 'unknown_action' });
    })();
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await loadSession();
  if (srcRunning(s, JOBRIGHT) && s.tabId === tabId) await stopSource(JOBRIGHT, 'Jobright tab was closed — scraping stopped.');
});

chrome.permissions.onAdded.addListener(() => scheduleTravelScan());

/* On a service-worker restart: clear stale "scanning" markers, and a HiringCafe run that died with it. */
serial(async () => {
  const applied = await appliedIndex();
  let jobs = await loadJobs();
  // A job is never in both lists (they're written together); heal it anyway if something ever broke that.
  const clean = jobs.filter((j) => !applied.ids.has(j.id));
  if (clean.length !== jobs.length) {
    jobs = clean;
    await chrome.storage.local.set({ [STORAGE_KEYS.jobs]: jobs });
  }
  if (jobs.some((j) => j.__scanning)) {
    await saveJobs(jobs.map((j) => ({ ...j, __scanning: undefined })));
  }
  const s = await loadSession();
  if (srcRunning(s, HIRINGCAFE)) {
    await saveSession(
      finalize({ ...s, src: { ...s.src, [HIRINGCAFE]: { ...s.src[HIRINGCAFE], state: 'idle', message: 'interrupted — press Start again.' } } })
    );
  }
}).then(scheduleTravelScan);
