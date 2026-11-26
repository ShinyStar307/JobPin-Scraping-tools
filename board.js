import {
  STORAGE_KEYS,
  DESC_PREFIX,
  DEFAULT_SETTINGS,
  SOURCES,
  CLEARANCES,
  mergeSettings,
  jobMatchesFilters,
  splitTerms,
  matchesSearch,
  excludePattern,
  jobSource,
  jobSourceUrl,
  sourceLabel,
  jobAts,
  atsLabel,
  levelLabel,
  jobTypeLabel,
  companyKey,
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
  isFresh,
  dayLabel,
  fullDateTime,
  appliedCounts,
  appliedByCompany,
  appliedCompanyTag,
  toast,
} from './ui-common.js';
import { mountSettingsForm, activeFilterCount } from './settings-form.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;
const PREFS_KEY = 'jr_board';
const OPTIONAL_ORIGINS = ['https://*/*', 'http://*/*'];
const NARROW = window.matchMedia('(max-width: 900px)');
const ui = (action, extra = {}) =>
  chrome.runtime.sendMessage({ type: 'JR_UI', action, ...extra }).catch(() => null);

/* ================= state ================= */

let jobs = []; // stored Inbox jobs
let applied = []; // stored applied jobs, newest first
let settings = mergeSettings(null);
let session = { active: false, src: {} };
let prefs = { q: '', exclude: '', source: 'all', ats: [], sort: 'newest', sortApplied: 'recent', ignore: false, view: 'inbox' };
let view = 'inbox'; // 'inbox' | 'applied'
let page = 0;
let selectedId = null;
let visible = []; // rows after every filter, sorted
/** Jobs being moved between the lists right now: hidden from both until the worker has saved. */
const moving = new Set();

const isApplied = () => view === 'applied';

/** Whether the last input was a key press: only then does a move hand focus to the next row. */
let usingKeyboard = false;
document.addEventListener('keydown', () => (usingKeyboard = true), true);
document.addEventListener('pointerdown', () => (usingKeyboard = false), true);

async function load() {
  const r = await chrome.storage.local.get([STORAGE_KEYS.jobs, STORAGE_KEYS.settings, STORAGE_KEYS.session, STORAGE_KEYS.applied]);
  jobs = Array.isArray(r[STORAGE_KEYS.jobs]) ? r[STORAGE_KEYS.jobs] : [];
  applied = Array.isArray(r[STORAGE_KEYS.applied]) ? r[STORAGE_KEYS.applied] : [];
  settings = mergeSettings(r[STORAGE_KEYS.settings]);
  session = r[STORAGE_KEYS.session] || { active: false, src: {} };
}

/** The two lists as the person should see them (never both, never mid-move). */
function lists() {
  const appliedIds = new Set(applied.map((a) => a.id));
  return {
    inbox: jobs.filter((j) => !moving.has(j.id) && !appliedIds.has(j.id)),
    done: applied.filter((a) => !moving.has(a.id)),
  };
}

async function loadPrefs() {
  const r = await chrome.storage.local.get(PREFS_KEY);
  prefs = { ...prefs, ...(r[PREFS_KEY] || {}) };
  if (!Array.isArray(prefs.ats)) prefs.ats = [];
  $('q').value = prefs.q;
  $('exclude').value = prefs.exclude;
  $('ignoreFilters').checked = !!prefs.ignore;
  const fromHash = location.hash.replace('#', '');
  view = fromHash === 'applied' || fromHash === 'inbox' ? fromHash : prefs.view === 'applied' ? 'applied' : 'inbox';
}

const savePrefs = throttle(() => chrome.storage.local.set({ [PREFS_KEY]: prefs }).catch(() => {}), 400);

/* ================= filtering ================= */

function makeMatcher() {
  const terms = splitTerms(prefs.q);
  const excluded = isApplied() ? null : excludePattern(splitTerms(prefs.exclude));
  return (job, { source = true, ats = true } = {}) => {
    // The Filters panel decides what is worth looking at in the Inbox; it never hides a past application.
    if (!isApplied() && !prefs.ignore && !jobMatchesFilters(job, settings)) return false;
    if (!matchesSearch(job, terms)) return false;
    if (excluded && excluded.test(job.title || '')) return false;
    if (source && prefs.source !== 'all' && jobSource(job) !== prefs.source) return false;
    if (ats && prefs.ats.length && !prefs.ats.includes(jobAts(job))) return false;
    return true;
  };
}

const SORTERS = {
  newest: (a, b) => (b.postedAtMs || 0) - (a.postedAtMs || 0),
  oldest: (a, b) => (a.postedAtMs || 0) - (b.postedAtMs || 0),
  company: (a, b) => String(a.company || '').localeCompare(String(b.company || '')),
  title: (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
  recent: (a, b) => (b.appliedAtMs || 0) - (a.appliedAtMs || 0),
  earliest: (a, b) => (a.appliedAtMs || 0) - (b.appliedAtMs || 0),
};

const SORT_CHOICES = {
  inbox: [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['company', 'Company A–Z'], ['title', 'Title A–Z']],
  applied: [['recent', 'Recently applied'], ['earliest', 'Earliest applied'], ['company', 'Company A–Z'], ['title', 'Title A–Z']],
};

const sortKey = () => (isApplied() ? prefs.sortApplied : prefs.sort);

let sortBuiltFor = '';

function renderSortSelect() {
  const sel = $('sort');
  // Rebuilt only when the list changes, so an open dropdown survives background refreshes.
  if (sortBuiltFor !== view) {
    sortBuiltFor = view;
    sel.replaceChildren(...SORT_CHOICES[view].map(([id, label]) => h('option', { value: id }, label)));
  }
  sel.value = sortKey();
}

/* ================= small helpers ================= */

function travelSourceText(job) {
  if (job.travelSource === 'employer') return 'from the employer page';
  if (job.travelSource === 'jobright') return 'from the Jobright summary';
  if (job.travelSource === 'hiringcafe') return 'from the HiringCafe posting';
  if (job.travelSource === 'unreadable') return 'employer page unreadable';
  return job.employerScanned ? 'not mentioned' : 'not mentioned (so far)';
}

const titleOf = (job) => job.title || 'Untitled role';
const companyOf = (job) => job.company || 'Unknown company';
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/* ================= view switch ================= */

function setView(next, { focus = false } = {}) {
  if (next === view) return;
  view = next;
  prefs.view = next;
  savePrefs();
  if (location.hash !== `#${next}`) history.replaceState(null, '', `#${next}`);
  page = 0;
  selectedId = null;
  detailSig = '';
  $('split').classList.remove('show-detail');
  render();
  if (focus) (isApplied() ? $('tabApplied') : $('tabInbox')).focus();
}

function renderChrome() {
  const a = isApplied();
  for (const [id, on] of [['tabInbox', !a], ['tabApplied', a]]) {
    const t = $(id);
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  }
  $('excludeField').hidden = a;
  $('ignoreField').hidden = a;
  $('btnFilters').hidden = a;
  $('appliedStats').hidden = !a;
  $('btnCsv').title = a ? 'Download the applied jobs listed below as a CSV file' : 'Download the jobs listed below as a CSV file';
  $('rows').setAttribute('aria-label', a ? 'Applied jobs' : 'Inbox jobs');
  renderSortSelect();
}

/* ================= top bar / run status ================= */

const STATE_WORD = { crawling: 'scanning', listening: 'listening', done: 'done', error: 'problem', idle: 'idle' };

function renderRun() {
  const live = !!session.active;
  $('runPill').className = `pill ${live ? 'live' : 'idle'}`;
  $('runText').textContent = live ? (session.phase === 'crawling' ? 'Scanning' : 'Listening') : 'Idle';
  $('btnRun').textContent = live ? 'Stop scraping' : 'Start scraping';
  $('btnRun').className = `btn ${live ? 'stop' : 'primary'}`;

  const rows = Object.entries(session.src || {}).filter(([, x]) => x && (x.state !== 'idle' || x.message));
  const bad = rows.some(([, x]) => x.error);
  const note = $('runNote');
  note.hidden = !rows.length || (!live && !bad);
  note.className = `runnote${bad ? ' warn' : ''}`;
  note.replaceChildren(
    ...rows.map(([id, x]) =>
      h(
        'div.runnote-row',
        {},
        h('b', {}, sourceLabel(id)),
        h(`span.state.${x.state || 'idle'}`, {}, STATE_WORD[x.state] || ''),
        h('span', {}, x.error || x.message || '')
      )
    )
  );
}

/* ================= "Did you apply?" tray ================= */

function renderPending() {
  const waiting = lists().inbox.filter(isAwaitingAnswer).sort((a, b) => b.openedAtMs - a.openedAtMs);
  const box = $('pending');
  box.hidden = !waiting.length;
  if (!waiting.length) return box.replaceChildren();

  const job = waiting[0];
  const more = waiting.length - 1;
  const open = h(
    'button.link-btn.pending-job',
    { type: 'button', title: 'Show this job', on: { click: () => showJob(job.id) } },
    h('b', {}, titleOf(job)),
    ` at ${companyOf(job)}`
  );
  box.replaceChildren(
    h('span.pending-icon', {}, icon('link')),
    h(
      'div.pending-text',
      {},
      h('div.pending-q', {}, 'Did you apply to ', open, '?'),
      h('div.hint', {}, `You opened its apply page ${shortAgo(job.openedAtMs).replace(/^Just now$/, 'just now')}${more ? ` · ${more} more waiting` : ''}`)
    ),
    h(
      'div.pending-actions',
      {},
      h('button.btn.sm.success.solid', { type: 'button', on: { click: () => markApplied([job.id]) } }, icon('check', 'sm'), 'Yes, I applied'),
      h('button.btn.sm', { type: 'button', on: { click: () => dismissPending([job.id]) } }, 'Not yet'),
      more
        ? h('button.btn.sm.ghost', { type: 'button', title: 'Stop asking about all of them', on: { click: () => dismissPending(waiting.map((j) => j.id)) } }, 'Dismiss all')
        : null
    )
  );
}

function dismissPending(ids) {
  const set = new Set(ids);
  for (const j of jobs) if (set.has(j.id)) j.openedAck = true;
  renderPending();
  ui('ackOpened', { ids });
}

/** Opens the Inbox job (switching list if needed) from the tray. */
function showJob(id) {
  if (isApplied()) setView('inbox');
  const idx = visible.findIndex((j) => j.id === id);
  if (idx < 0) {
    // Hidden by a search or filter: clear the search so it can be seen.
    prefs.q = '';
    $('q').value = '';
    prefs.source = 'all';
    prefs.ats = [];
    render();
  }
  if (!visible.some((j) => j.id === id) && !prefs.ignore) {
    // Still hidden: the Filters panel excludes it. Show everything so it can be answered.
    prefs.ignore = true;
    $('ignoreFilters').checked = true;
    savePrefs();
    render();
    toast('Showing all jobs — your filters hide this one.');
  }
  const at = visible.findIndex((j) => j.id === id);
  if (at < 0) return;
  selectedId = id;
  page = Math.floor(at / PAGE_SIZE);
  renderList();
  renderDetail();
  $('split').classList.add('show-detail');
  $('rows').querySelector('.job-row.active')?.scrollIntoView({ block: 'nearest' });
}

/* ================= applying: Inbox ⇄ Applied ================= */

const neighborOf = (id) => {
  const i = visible.findIndex((j) => j.id === id);
  return (visible[i + 1] ?? visible[i - 1])?.id ?? null;
};

/** Inbox → Applied. Instant on screen, saved by the worker, with Undo. */
async function markApplied(ids) {
  const picked = jobs.filter((j) => ids.includes(j.id) && !moving.has(j.id));
  if (!picked.length) return;
  const ok = await moveJobs('markApplied', picked.map((j) => j.id));
  if (!ok) return;
  const label = picked.length === 1 ? `Marked “${titleOf(picked[0])}” as applied` : `Marked ${picked.length} jobs as applied`;
  toast(label, { action: { label: 'Undo', onClick: () => moveJobs('unmarkApplied', ok, { restore: true }) } });
}

/** Applied → Inbox. */
async function unmarkApplied(ids) {
  const picked = applied.filter((j) => ids.includes(j.id) && !moving.has(j.id));
  if (!picked.length) return;
  const ok = await moveJobs('unmarkApplied', picked.map((j) => j.id));
  if (!ok) return;
  toast(picked.length === 1 ? 'Moved back to Inbox' : `Moved ${picked.length} jobs back to Inbox`, {
    action: { label: 'Undo', onClick: () => moveJobs('markApplied', ok, { restore: true }) },
  });
}

/**
 * Runs a move and keeps the screen steady: the jobs vanish at once, the selection slides to the next
 * row, and a failure puts everything back with a message.
 * @returns {Promise<string[]|null>} ids that moved, or null on failure
 */
async function moveJobs(action, ids, { restore = false } = {}) {
  if (!ids.length) return null;
  // Keyboard users keep their place: focus follows the selection to the next row.
  const hadRowFocus = usingKeyboard && (!!document.activeElement?.closest?.('.job-row') || document.activeElement === document.body);
  if (!restore && ids.includes(selectedId)) {
    selectedId = neighborOf(selectedId);
    if (NARROW.matches) $('split').classList.remove('show-detail');
  }
  ids.forEach((id) => moving.add(id));
  render();
  if (hadRowFocus && !restore) $('rows').querySelector('.job-row.active')?.focus({ preventScroll: true });
  const res = await ui(action, { ids });
  ids.forEach((id) => moving.delete(id));
  await load();
  if (restore && res?.ids?.length) {
    // Undo: bring the job back into view.
    const back = action === 'unmarkApplied' ? 'inbox' : 'applied';
    if (view !== back) setView(back);
    selectedId = res.ids[0];
  }
  render();
  if (!res?.ok) {
    toast('Couldn’t save that — please try again.');
    return null;
  }
  if (!res.ids.length) return null;
  return res.ids;
}

/** An apply link was opened from here: remember it, so the tray can ask how it went. */
function noteOpened(job) {
  if (isApplied()) return;
  const stored = jobs.find((j) => j.id === job.id);
  if (stored) {
    stored.openedAtMs = Date.now();
    stored.openedAck = false;
  }
  setTimeout(renderPending, 0);
  ui('linkOpened', { id: job.id });
}

/* ================= source + ATS controls ================= */

function renderSourceSeg(rowsForCounts) {
  const counts = { all: rowsForCounts.length };
  for (const j of rowsForCounts) counts[jobSource(j)] = (counts[jobSource(j)] || 0) + 1;
  const tabs = [{ id: 'all', label: 'All' }, ...SOURCES];
  $('sourceSeg').replaceChildren(
    ...tabs.map((t) => {
      const on = prefs.source === t.id;
      const b = h(
        `button.seg-btn${on ? '.on' : ''}`,
        { type: 'button', 'aria-pressed': String(on) },
        t.label,
        h('span.count', {}, String(counts[t.id] || 0))
      );
      b.addEventListener('click', () => {
        prefs.source = t.id;
        page = 0;
        savePrefs();
        render();
      });
      return b;
    })
  );
}

function atsOptions(rowsForCounts) {
  const map = new Map();
  for (const j of rowsForCounts) {
    const id = jobAts(j);
    map.set(id, (map.get(id) || 0) + 1);
  }
  for (const id of prefs.ats) if (!map.has(id)) map.set(id, 0);
  return [...map].map(([id, count]) => ({ id, count, label: atsLabel(id) }));
}

let atsCache = [];

function renderAtsButton() {
  const n = prefs.ats.length;
  $('atsBtn').textContent = !n ? 'All ATS' : n === 1 ? atsLabel(prefs.ats[0]) : `${n} ATS`;
  $('atsBtn').classList.toggle('on', n > 0);
  $('atsBtn').title = n > 1 ? prefs.ats.map(atsLabel).join(', ') : 'Choose which ATS to list';
}

function renderAtsOptions() {
  const q = $('atsSearch').value.trim().toLowerCase();
  const chosen = new Set(prefs.ats);
  const list = atsCache
    .filter((o) => !q || o.label.toLowerCase().includes(q))
    .sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.label.localeCompare(b.label));

  $('atsOptions').replaceChildren(
    ...(list.length
      ? list.map((o) => {
          const input = h('input', { type: 'checkbox', checked: chosen.has(o.id) });
          input.addEventListener('change', () => {
            const next = new Set(prefs.ats);
            if (input.checked) next.add(o.id);
            else next.delete(o.id);
            prefs.ats = [...next];
            page = 0;
            savePrefs();
            render({ keepMenu: true });
          });
          return h('label.ats-option', { role: 'option' }, input, h('span.box'), h('span.ats-name', {}, o.label), h('span.ats-count', {}, String(o.count)));
        })
      : [h('div.hint.pad', {}, 'No ATS matches.')])
  );
}

function toggleAtsMenu(open = $('atsMenu').hidden) {
  $('atsMenu').hidden = !open;
  $('atsBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('atsSearch').value = '';
    renderAtsOptions();
    $('atsSearch').focus();
  }
}

/* ================= list ================= */

/** The little round button on a row: mark as applied (Inbox) or move back (Applied). */
function quickAction(job) {
  const a = isApplied();
  const b = h(
    'button.quick',
    {
      type: 'button',
      class: a ? 'quick undo' : 'quick done',
      title: a ? 'Move back to Inbox (U)' : 'Mark as applied (A)',
      'aria-label': a ? `Move ${titleOf(job)} back to Inbox` : `Mark ${titleOf(job)} as applied`,
    },
    icon(a ? 'undo' : 'check')
  );
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (a) unmarkApplied([job.id]);
    else markApplied([job.id]);
  });
  return b;
}

function row(job, byCompany) {
  const active = job.id === selectedId;
  const a = isApplied();
  const awaiting = !a && isAwaitingAnswer(job);
  const when = a
    ? h('span.chip.when.done', { title: fullDateTime(job.appliedAtMs) }, icon('check', 'sm'), shortAgo(job.appliedAtMs))
    : h(`span.chip.when${isFresh(job.postedAtMs) ? '.fresh' : ''}`, { title: 'Posted' }, shortAgo(job.postedAtMs));
  const sameCompany = !a ? appliedCompanyTag(job, byCompany) : null;
  const el = h(
    `div.job-row${active ? '.active' : ''}${awaiting ? '.awaiting' : ''}`,
    { role: 'option', tabindex: active ? '0' : '-1', 'aria-selected': String(active), 'data-id': job.id },
    companyLogo(job),
    h(
      'div.job-body',
      {},
      h('div.job-row-top', {}, h('div.job-title', {}, titleOf(job)), when),
      h('div.job-company', {}, companyOf(job)),
      h(
        'div.job-meta',
        {},
        ...sourceTags(job),
        job.workModel || job.location ? h('span.tag.neutral', {}, job.workModel || job.location) : null,
        sameCompany,
        awaiting ? h('span.tag.warn', { title: 'You opened its apply page and haven’t said whether you applied.' }, 'Opened') : null
      )
    ),
    quickAction(job)
  );
  el.addEventListener('click', () => select(job.id, { open: true }));
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
      e.preventDefault();
      select(job.id, { open: true });
    }
  });
  return el;
}

function renderList() {
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const start = page * PAGE_SIZE;
  const slice = visible.slice(start, start + PAGE_SIZE);

  if (!slice.some((j) => j.id === selectedId)) selectedId = slice[0]?.id ?? null;

  const focusedId = document.activeElement?.closest?.('.job-row')?.dataset.id;
  const scroll = $('rows').scrollTop;
  const byCompany = appliedByCompany(applied);
  const nodes = [];
  let lastDay = null;
  for (const job of slice) {
    // Applied, newest first: one heading per day.
    if (isApplied() && sortKey() === 'recent') {
      const day = dayLabel(job.appliedAtMs);
      if (day !== lastDay) {
        lastDay = day;
        nodes.push(h('div.day-head', { role: 'presentation' }, day));
      }
    }
    nodes.push(row(job, byCompany));
  }
  $('rows').replaceChildren(...nodes);
  $('rows').scrollTop = scroll;
  if (focusedId) $('rows').querySelector(`.job-row[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });

  $('listSummary').textContent = visible.length
    ? `${(start + 1).toLocaleString()}–${(start + slice.length).toLocaleString()} of ${plural(visible.length, isApplied() ? 'application' : 'role')}`
    : isApplied()
      ? 'No applications'
      : 'No roles';
  const companies = new Set(visible.map((j) => j.company).filter(Boolean)).size;
  $('listMeta').textContent = visible.length ? plural(companies, 'company', 'companies') : '';

  renderEmpty();
  $('rows').hidden = visible.length === 0;
  $('shortcuts').hidden = visible.length === 0;

  $('pager').hidden = pages <= 1;
  $('pageLabel').textContent = `Page ${page + 1} of ${pages.toLocaleString()}`;
  $('pagePrev').disabled = page === 0;
  $('pageNext').disabled = page + 1 >= pages;
}

function renderShortcuts() {
  const key = (k) => h('kbd', {}, k);
  $('shortcuts').replaceChildren(
    h('span', {}, key('↑'), key('↓'), ' browse'),
    h('span', {}, key(isApplied() ? 'U' : 'A'), isApplied() ? ' move back' : ' mark applied'),
    h('span', {}, key('O'), ' open link')
  );
}

function emptyState({ art = 'inbox', ok = false, title, text, actions = [] }) {
  return h(
    'div.empty-state',
    {},
    h(`div.art${ok ? '.ok' : ''}`, {}, icon(art)),
    h('h3', {}, title),
    h('p', {}, text),
    actions.length ? h('div.actions', {}, ...actions) : null
  );
}

function renderEmpty() {
  const host = $('empty');
  host.hidden = visible.length > 0;
  if (visible.length) return host.replaceChildren();
  const { inbox, done } = lists();
  const searching = !!(prefs.q.trim() || prefs.source !== 'all' || prefs.ats.length || (!isApplied() && prefs.exclude.trim()));
  const clear = h(
    'button.btn.sm',
    {
      type: 'button',
      on: {
        click: () => {
          prefs.q = '';
          prefs.exclude = '';
          prefs.source = 'all';
          prefs.ats = [];
          $('q').value = '';
          $('exclude').value = '';
          savePrefs();
          render();
        },
      },
    },
    'Clear search'
  );

  let node;
  if (isApplied()) {
    node = done.length
      ? emptyState({ art: 'search', title: 'No applications match', text: 'Nothing in your applied list fits the search.', actions: [clear] })
      : emptyState({
          art: 'check-circle',
          ok: true,
          title: 'No applications yet',
          text: 'Mark a job as applied and it moves here — and stays out of every future search.',
          actions: [h('button.btn.sm.primary', { type: 'button', on: { click: () => setView('inbox') } }, 'Go to Inbox')],
        });
  } else if (!jobs.length && !done.length) {
    node = emptyState({
      art: 'inbox',
      title: 'Nothing collected yet',
      text: 'Start scraping and JobPin will list jobs that apply directly on the employer’s own site.',
      actions: [h('button.btn.sm.primary', { type: 'button', on: { click: () => $('btnRun').click() } }, session.active ? 'Scraping…' : 'Start scraping')],
    });
  } else if (!inbox.length) {
    node = emptyState({
      art: 'check-circle',
      ok: true,
      title: 'All caught up',
      text: `Every collected job is one you’ve applied to (${plural(done.length, 'application')}). New jobs appear after the next run; applied ones never come back.`,
      actions: [
        h('button.btn.sm.primary', { type: 'button', on: { click: () => $('btnRun').click() } }, session.active ? 'Scraping…' : 'Start scraping'),
        h('button.btn.sm', { type: 'button', on: { click: () => setView('applied') } }, 'View applied'),
      ],
    });
  } else {
    node = emptyState({
      art: 'filter',
      title: 'No jobs match',
      text: 'Nothing fits the current search and filters. Loosen them, or ignore the filters.',
      actions: [
        h('button.btn.sm', { type: 'button', on: { click: openDrawer } }, 'Edit filters'),
        !prefs.ignore
          ? h('button.btn.sm', { type: 'button', on: { click: () => ($('ignoreFilters').click()) } }, 'Ignore filters')
          : null,
        searching ? clear : null,
      ],
    });
  }
  host.replaceChildren(node);
}

/* ================= Applied summary ================= */

function renderAppliedStats() {
  const { done } = lists();
  const c = appliedCounts(done);
  const companies = new Set(done.map((j) => companyKey(j.company)).filter(Boolean)).size;
  const stat = (num, label, cls = '') => h(`div.stat${cls}`, {}, h('div.stat-num', {}, num.toLocaleString()), h('div.stat-label', {}, label));
  $('appliedStats').replaceChildren(
    stat(c.today, 'Today', c.today ? '.hot' : ''),
    stat(c.week, 'Last 7 days'),
    stat(c.total, 'All time'),
    stat(companies, 'Companies')
  );
}

/* ================= detail ================= */

const descCache = new Map();

async function loadDescription(job) {
  if (descCache.has(job.id)) return descCache.get(job.id);
  const key = DESC_PREFIX + job.id;
  const r = await chrome.storage.local.get(key);
  const text = r[key] || '';
  descCache.set(job.id, text);
  return text;
}

/** Plain text with "- " bullets → paragraphs, lists and small headings. */
function descriptionNodes(text) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const bullets = (ls) => h('ul', {}, ...ls.map((l) => h('li', {}, l.replace(/^-\s*/, ''))));
      if (lines.every((l) => l.startsWith('- '))) return bullets(lines);
      if (lines.length > 1 && lines[0].length <= 40 && lines.slice(1).every((l) => l.startsWith('- '))) {
        return h('div', {}, h('h4', {}, lines[0]), bullets(lines.slice(1)));
      }
      return h('p', {}, block);
    });
}

function fact(label, value) {
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null;
  return h('div.fact', {}, h('dt', {}, label), h('dd', {}, Array.isArray(value) ? value.join(', ') : String(value)));
}

function clearanceText(job) {
  const ids = job.clearances || [];
  if (!ids.length) return '';
  return ids.map((id) => CLEARANCES.find((c) => c.id === id)?.label || id).join(', ');
}

function yearsFact(n) {
  return n == null ? '' : n === 0 ? 'None required' : `${n}+ years`;
}

function copyLink(job) {
  return h(
    'button.btn',
    {
      type: 'button',
      on: {
        click: (e) => {
          const btn = e.currentTarget;
          navigator.clipboard.writeText(job.applyUrl).then(() => {
            btn.replaceChildren(icon('check'), 'Copied');
            setTimeout(() => btn.replaceChildren(icon('copy'), 'Copy link'), 1400);
          });
        },
      },
    },
    icon('copy'),
    'Copy link'
  );
}

function openApplyLink(job, { primary }) {
  const a = h(
    `a.btn${primary ? '.primary' : ''}`,
    { href: job.applyUrl, target: '_blank', rel: 'noopener', title: job.applyUrl },
    icon('external'),
    isApplied() ? 'Open application page' : 'Open apply link',
    primary ? h('kbd.on-primary', {}, 'O') : null
  );
  const note = () => noteOpened(job);
  a.addEventListener('click', note);
  a.addEventListener('auxclick', (e) => e.button === 1 && note());
  return a;
}

/** Other applications at the same company, so a second one is a choice, not an accident. */
function companyNotice(job) {
  const key = companyKey(job.company);
  if (!key) return null;
  const others = applied.filter((a) => companyKey(a.company) === key && a.id !== job.id && !moving.has(a.id));
  if (!others.length) return null;
  const sorted = [...others].sort((a, b) => b.appliedAtMs - a.appliedAtMs);
  return h(
    'div.banner.info',
    {},
    icon('building'),
    h(
      'div',
      {},
      h('b', {}, `You’ve already applied to ${plural(others.length, 'other role')} at ${companyOf(job)}`),
      h(
        'ul.banner-list',
        {},
        ...sorted.slice(0, 3).map((a) => h('li', {}, `${titleOf(a)} · ${shortAgo(a.appliedAtMs)}`)),
        sorted.length > 3 ? h('li.hint', {}, `+${sorted.length - 3} more`) : null
      )
    )
  );
}

let detailSig = '';

/** Re-renders only when the shown job (or what we know about it) changed, so reading isn't interrupted. */
function renderDetail() {
  const pane = $('detail');
  const job = visible.find((j) => j.id === selectedId);
  const a = isApplied();
  const sig = job
    ? [view, job.id, job.appliedAtMs, job.travelAir, job.travelLand, job.travelSnippet, job.travelSource, job.employerScanned, job.hasDescription, applied.length].join('|')
    : `none|${view}`;
  if (sig === detailSig) return;
  detailSig = sig;
  if (!job) {
    pane.replaceChildren(
      h('div.detail-empty', {}, h('h2', {}, a ? 'Select an application' : 'Select a role'), h('p', {}, a ? 'Pick one to see when you applied and revisit its page.' : 'Pick a job from the list to read it and open its apply page.'))
    );
    return;
  }

  const sourceUrl = jobSourceUrl(job);
  const posted = job.postedAtMs ? new Date(job.postedAtMs) : null;
  const desc = h('div.desc', {}, h('p.hint', {}, 'Loading description…'));

  const banner = a
    ? h(
        'div.banner.ok',
        {},
        icon('check-circle', 'lg'),
        h('div', {}, h('b', {}, 'Applied'), h('div.hint', {}, `${fullDateTime(job.appliedAtMs)} · ${shortAgo(job.appliedAtMs).toLowerCase()}`))
      )
    : null;

  const scroll = h(
    'div.detail-scroll',
    {},
    h(
      'div.detail-inner',
      {},
      h('button.btn.sm.ghost.back', { type: 'button', on: { click: () => $('split').classList.remove('show-detail') } }, icon('arrowLeft', 'sm'), 'All jobs'),
      banner,
      a ? null : companyNotice(job),
      h(
        'div.detail-top',
        {},
        companyLogo(job),
        h(
          'div',
          { style: 'min-width:0' },
          h('div.detail-kicker', {}, `${sourceLabel(jobSource(job))} · ${atsLabel(jobAts(job))}`),
          h('h2.detail-title', {}, titleOf(job)),
          h(
            'div.detail-company',
            {},
            job.companyUrl ? h('a', { href: job.companyUrl, target: '_blank', rel: 'noopener' }, companyOf(job)) : companyOf(job),
            job.isAgency ? h('span.tag.warn', { title: 'Company is a staffing agency' }, 'Agency') : null
          )
        )
      ),
      h(
        'div.chips',
        {},
        job.location ? h('span.chip', {}, job.location) : null,
        job.workModel ? h('span.chip', {}, job.workModel) : null,
        job.salary ? h('span.chip', {}, job.salary) : null,
        h(`span.chip.when${isFresh(job.postedAtMs) ? '.fresh' : ''}`, {}, posted ? `Posted ${shortAgo(job.postedAtMs)}` : 'Posted —'),
        h('span.chip', {}, jobTypeLabel(job)),
        job.seniorityLevel ? h('span.chip', {}, job.seniorityLevel) : null
      ),

      h(
        'section.detail-block',
        {},
        h('h3', {}, 'Role'),
        h(
          'dl.facts',
          {},
          fact('Seniority', job.seniorityLevel || job.seniority),
          fact('Role type', job.roleType),
          fact('Experience', yearsFact(job.roleYoe)),
          fact('Leadership', yearsFact(job.leadershipYoe)),
          fact('Security clearance', clearanceText(job)),
          fact('Apply on', job.applyHost)
        )
      ),

      h(
        'section.detail-block',
        {},
        h('h3', {}, 'Travel'),
        h('div.travel-line', {}, ...travelTags(job), h('span.src', {}, travelSourceText(job))),
        job.travelSnippet ? h('blockquote', {}, job.travelSnippet) : null
      ),

      job.companyDesc
        ? h('section.detail-block', {}, h('h3', {}, `About ${job.company || 'the company'}`), h('p.about', {}, job.companyDesc))
        : null,

      h('section.detail-block', {}, h('h3', {}, 'Description'), desc),

      h(
        'section.detail-block',
        {},
        h('h3', {}, 'Link'),
        h('a.detail-link', { href: job.applyUrl, target: '_blank', rel: 'noopener' }, job.applyUrl)
      )
    )
  );

  // Always in reach, however far the description has been read.
  const bar = h(
    'div.detail-bar',
    {},
    a
      ? [
          openApplyLink(job, { primary: true }),
          h('button.btn', { type: 'button', title: 'Move back to Inbox (U)', on: { click: () => unmarkApplied([job.id]) } }, icon('undo'), 'Move back to Inbox', h('kbd', {}, 'U')),
        ]
      : [
          openApplyLink(job, { primary: true }),
          h('button.btn.success', { type: 'button', title: 'Mark as applied (A)', on: { click: () => markApplied([job.id]) } }, icon('check'), 'Mark as applied', h('kbd', {}, 'A')),
        ],
    h('span.spacer'),
    sourceUrl ? h('a.btn.ghost', { href: sourceUrl, target: '_blank', rel: 'noopener' }, `View on ${sourceLabel(jobSource(job))}`) : null,
    copyLink(job)
  );

  pane.replaceChildren(scroll, bar);

  const forId = job.id;
  loadDescription(job).then((text) => {
    if (selectedId !== forId) return;
    desc.replaceChildren(
      ...(text
        ? descriptionNodes(text)
        : [
            h(
              'p.hint',
              {},
              job.hasDescription === false || job.hasDescription == null
                ? `No description was stored for this job (collected before descriptions were kept). Open it on ${sourceLabel(jobSource(job))} or the apply page.`
                : 'No description available.'
            ),
          ])
    );
  });
}

function select(id, { open = false } = {}) {
  selectedId = id;
  for (const el of $('rows').querySelectorAll('.job-row')) {
    const on = el.dataset.id === id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
    el.tabIndex = on ? 0 : -1;
  }
  renderDetail();
  if (open) $('split').classList.add('show-detail');
}

/* ================= render ================= */

function render({ keepMenu = false } = {}) {
  const { inbox, done } = lists();
  const pool = isApplied() ? done : inbox;
  const matches = makeMatcher();
  const forSource = pool.filter((j) => matches(j, { source: false }));
  const forAts = pool.filter((j) => matches(j, { ats: false }));
  visible = pool.filter((j) => matches(j)).sort(SORTERS[sortKey()] || SORTERS.newest);

  renderChrome();
  atsCache = atsOptions(forAts);
  renderSourceSeg(forSource);
  renderAtsButton();
  if (keepMenu && !$('atsMenu').hidden) renderAtsOptions();

  renderRun();
  renderPending();
  if (isApplied()) renderAppliedStats();
  renderShortcuts();
  renderList();
  renderDetail();

  const matched = inbox.filter((j) => jobMatchesFilters(j, settings)).length;
  $('countInbox').textContent = matched.toLocaleString();
  $('countApplied').textContent = done.length.toLocaleString();

  const n = activeFilterCount(settings);
  $('filterBadge').textContent = String(n);
  $('filterBadge').hidden = !n || prefs.ignore;
  $('activeFilters').hidden = isApplied();
  $('activeFilters').replaceChildren(
    ...(prefs.ignore ? [h('span.tag.neutral', {}, 'Filters ignored — showing every collected employer job')] : filterSummary(settings))
  );

  if (isApplied()) {
    const companies = new Set(done.map((j) => companyKey(j.company)).filter(Boolean)).size;
    $('subtitle').textContent = `${plural(done.length, 'application')} · ${plural(companies, 'company', 'companies')}`;
    document.title = `JobPin — ${done.length} applied`;
  } else {
    $('subtitle').textContent = `${matched.toLocaleString()} matched · ${inbox.length.toLocaleString()} collected · ${done.length.toLocaleString()} applied`;
    document.title = `JobPin — ${matched} matched jobs`;
  }
}

/* ================= export ================= */

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const a = isApplied();
  const header = [
    ...(a ? ['Applied'] : []),
    'Source', 'ATS', 'Company', 'Title', 'Job type', 'Work model', 'Location', 'Salary', 'Seniority', 'Role type',
    'Experience (yrs)', 'Leadership (yrs)', 'Clearance', 'Air travel', 'Land travel', 'Posted', 'Apply URL',
    'Company site', 'Listing URL',
  ];
  const lines = [header.join(',')].concat(
    visible.map((j) =>
      [
        ...(a ? [j.appliedAtMs ? new Date(j.appliedAtMs).toISOString() : ''] : []),
        sourceLabel(jobSource(j)),
        atsLabel(jobAts(j)),
        j.company,
        j.title,
        jobTypeLabel(j),
        j.workModel,
        j.location,
        j.salary,
        j.seniorityLevel || j.seniority,
        j.roleType,
        j.roleYoe,
        j.leadershipYoe,
        (j.clearances || []).join('; '),
        levelLabel(j.travelAir || 'none'),
        levelLabel(j.travelLand || 'none'),
        j.postedAtMs ? new Date(j.postedAtMs).toISOString() : '',
        j.applyUrl,
        j.companyUrl,
        jobSourceUrl(j),
      ]
        .map(csvCell)
        .join(',')
    )
  );
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const link = h('a', { href: URL.createObjectURL(blob), download: `jobpin-${a ? 'applied-' : ''}${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}

/* ================= filters drawer ================= */

let draft = null;

function mountDrawerForm() {
  mountSettingsForm($('drawerForm'), draft, { toast });
}

function openDrawer() {
  if (isApplied()) setView('inbox');
  draft = structuredClone(settings);
  mountDrawerForm();
  $('drawer').hidden = false;
  document.body.classList.add('no-scroll');
  $('drawerForm').scrollTop = 0;
}

function closeDrawer() {
  $('drawer').hidden = true;
  document.body.classList.remove('no-scroll');
}

/* ================= wiring ================= */

const refresh = throttle(() => load().then(() => render({ keepMenu: true })), 400);

let typing = 0;
const onType = () => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    prefs.q = $('q').value;
    prefs.exclude = $('exclude').value;
    page = 0;
    savePrefs();
    render();
  }, 180);
};
$('q').addEventListener('input', onType);
$('exclude').addEventListener('input', onType);
$('sort').addEventListener('change', () => {
  if (isApplied()) prefs.sortApplied = $('sort').value;
  else prefs.sort = $('sort').value;
  savePrefs();
  render();
});
$('ignoreFilters').addEventListener('change', () => {
  prefs.ignore = $('ignoreFilters').checked;
  page = 0;
  savePrefs();
  render();
});

$('tabInbox').addEventListener('click', () => setView('inbox'));
$('tabApplied').addEventListener('click', () => setView('applied'));
$('tabInbox').parentElement.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  setView(isApplied() ? 'inbox' : 'applied', { focus: true });
});
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (v === 'applied' || v === 'inbox') setView(v);
});

$('atsBtn').addEventListener('click', () => toggleAtsMenu());
$('atsDone').addEventListener('click', () => toggleAtsMenu(false));
$('atsClear').addEventListener('click', () => {
  prefs.ats = [];
  page = 0;
  savePrefs();
  render({ keepMenu: true });
});
$('atsSearch').addEventListener('input', renderAtsOptions);
document.addEventListener('click', (e) => {
  if (!$('atsMenu').hidden && !$('atsPicker').contains(e.target)) toggleAtsMenu(false);
});

$('pagePrev').addEventListener('click', () => {
  page = Math.max(0, page - 1);
  renderList();
  renderDetail();
  $('rows').scrollTo({ top: 0 });
});
$('pageNext').addEventListener('click', () => {
  page += 1;
  renderList();
  renderDetail();
  $('rows').scrollTo({ top: 0 });
});

$('btnCsv').addEventListener('click', exportCsv);
$('btnFilters').addEventListener('click', openDrawer);
$('activeFilters').addEventListener('click', openDrawer);
$('activeFilters').addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openDrawer()));
$('drawerClose').addEventListener('click', closeDrawer);
$('drawerCancel').addEventListener('click', closeDrawer);
$('drawerScrim').addEventListener('click', closeDrawer);
$('drawerReset').addEventListener('click', () => {
  draft = structuredClone(DEFAULT_SETTINGS);
  mountDrawerForm();
});
$('drawerSave').addEventListener('click', async () => {
  await ui('saveSettings', { settings: draft });
  settings = mergeSettings(draft);
  page = 0;
  closeDrawer();
  render();
  toast('Filters saved');
});

$('btnRun').addEventListener('click', async () => {
  const btn = $('btnRun');
  btn.disabled = true;
  try {
    if (session.active) {
      await ui('stop');
    } else {
      if (settings.scanEmployerPages) {
        const granted = await chrome.permissions.request({ origins: OPTIONAL_ORIGINS }).catch(() => false);
        if (!granted) await ui('saveSettings', { settings: { ...settings, scanEmployerPages: false } });
      }
      const res = await ui('start');
      if (!res?.ok && res?.error) toast(res.error);
    }
  } finally {
    btn.disabled = false;
  }
});

function moveSelection(delta) {
  const i = visible.findIndex((j) => j.id === selectedId);
  const next = visible[Math.max(0, Math.min(visible.length - 1, i + delta))];
  if (!next || next.id === selectedId) return;
  const idx = visible.indexOf(next);
  const targetPage = Math.floor(idx / PAGE_SIZE);
  selectedId = next.id;
  if (targetPage !== page) {
    page = targetPage;
    renderList();
    renderDetail();
  } else {
    select(next.id);
  }
  const el = $('rows').querySelector('.job-row.active');
  el?.scrollIntoView({ block: 'nearest' });
  // Keep real focus with the selection when the list already had it.
  if (document.activeElement?.closest?.('.job-row')) el?.focus({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('drawer').hidden) closeDrawer();
    else if (!$('atsMenu').hidden) toggleAtsMenu(false);
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag) || !$('drawer').hidden || e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  const job = visible.find((j) => j.id === selectedId);
  if (!job) return;
  // Letter shortcuts act on the selected job (A: applied, U: move back, O: open its apply page).
  const key = e.key.toLowerCase();
  if (key === 'a' && !isApplied()) {
    e.preventDefault();
    markApplied([job.id]);
  } else if (key === 'u' && isApplied()) {
    e.preventDefault();
    unmarkApplied([job.id]);
  } else if (key === 'o') {
    e.preventDefault();
    window.open(job.applyUrl, '_blank', 'noopener');
    noteOpened(job);
  }
});

const WATCHED = new Set([STORAGE_KEYS.jobs, STORAGE_KEYS.settings, STORAGE_KEYS.session, STORAGE_KEYS.applied]);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => WATCHED.has(k))) refresh();
});
setInterval(() => render({ keepMenu: true }), 60000);

loadPrefs()
  .then(load)
  .then(() => {
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    render();
  });
