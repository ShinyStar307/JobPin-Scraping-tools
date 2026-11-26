/**
 * Jobright source — the account-filter step (service worker side).
 *
 * Jobright only shows its feed (`/swan/recommend/list/jobs`) to a signed-in user, narrowed by the
 * filters saved on that account. Before reading the feed, a run therefore:
 *
 *   1. reads the account's saved filters      POST /swan/filter/get/filter
 *   2. compares them with the ones the Filters panel asks for
 *   3. when they differ, finds the filter in use   GET  /swan/filter/saved/list
 *      and puts the wanted values into it          POST /swan/filter/saved/{id}/update
 *   4. reads the filters back to confirm they stuck, then reads the feed with `refresh=true`.
 *
 * Every request is made from inside a jobright.ai tab (`inPageRequest`), so it carries the person's
 * own session. Only the filters the Filters panel actually narrows are changed; everything else saved
 * on the account is sent back untouched.
 */

import { JOB_FUNCTIONS } from './shared.js';

export const JR_BASE = 'https://jobright.ai';
export const JR_START_PATH = '/jobs/recommend';
export const JR_LIST_PATH = '/swan/recommend/list/jobs';
export const JR_FILTER_PATH = '/swan/filter/get/filter';
export const JR_SAVED_LIST_PATH = '/swan/filter/saved/list';
export const JR_UPDATE_PATH = '/swan/filter/saved/{id}/update';
export const JR_OK_CODE = 10000;
export const JR_PAGE_SIZE = 20;
export const JR_PAGE_PAUSE_MS = 1500;
export const JR_RETRY_DELAYS_MS = [3000, 8000];

/* ---------------- Jobright's own vocabularies ---------------- */

/** Job function picker: taxonomy id → title as Jobright writes it. */
const FUNCTIONS = [
  ['01-01-01', 'Backend Engineer'],
  ['01-01-07', 'Full Stack Engineer'],
  ['01-01-02', 'Java Engineer'],
  ['01-01-03', 'Python Engineer'],
  ['01-01-05', 'C/C++ Engineer'],
  ['01-01-04', '.Net Engineer'],
  ['01-01-06', 'Golang Engineer'],
  ['01-01-09', 'Blockchain Engineer'],
  ['01-01-10', 'Salesforce Developer'],
  ['01-08-01', 'Data Analyst'],
  ['01-08-02', 'Data Scientist'],
  ['01-08-03', 'Data Engineer'],
  ['01-08-07', 'Power BI Developer'],
  ['01-08-06', 'Business/BI Analyst'],
  ['01-08-04', 'ETL Developer'],
  ['01-08-05', 'Data Warehouse Engineer'],
  ['01-06-01', 'Machine Learning Engineer'],
  ['01-06-02', 'AI Engineer'],
  ['01-06-04', 'Machine Learning/AI Researcher'],
  ['01-06-05', 'Machine Learning, Deep Learning'],
  ['01-06-03', 'LLM Engineer'],
  ['01-06-06', 'Machine Learning, Model Training and Inference'],
  ['01-06-11', 'Machine Learning, Computer Vision'],
  ['01-06-09', 'Machine Learning, Operations (ML Ops)'],
  ['01-06-07', 'Machine Learning, Search System'],
  ['01-06-08', 'Machine Learning, Ads'],
  ['01-06-10', 'Machine Learning, Infrastructure'],
  ['01-06-12', 'Data Annotation/AI Tutor'],
  ['01-02-01', 'Frontend Software Engineer'],
  ['01-02-02', 'React Developer'],
  ['01-02-05', 'Android Developer'],
  ['01-02-03', 'UI/UX Developer'],
  ['01-02-10', 'Game Developer'],
  ['01-02-04', 'iOS/Swift Developer'],
  ['01-02-07', 'Unity Developer'],
  ['01-02-06', 'Flutter Developer'],
  ['01-02-08', 'Unreal Engine Developer'],
  ['01-02-09', 'AR/VR Developer'],
  ['01-04-08', 'DevOps'],
  ['01-04-07', 'Site Reliability Engineer (SRE)'],
  ['01-04-03', 'Cyber Security Analyst'],
  ['01-04-02', 'Cloud Security Engineer'],
  ['01-04-04', 'Cyber Security Engineer'],
  ['01-04-06', 'Systems Engineer'],
  ['01-04-01', 'Network Security Engineer'],
  ['01-04-05', 'Network Engineer'],
  ['01-04-09', 'SoC Analyst'],
  ['01-05-01', 'IT Support Specialist'],
  ['01-05-02', 'Help Desk Technician/Desktop Support Technician'],
  ['01-05-06', 'Database Administrator'],
  ['01-05-03', 'System Administrator'],
  ['01-05-04', 'Network Support Specialist'],
  ['01-05-05', 'Salesforce Administrator'],
  ['01-03-01', 'Software Testing/Quality Assurance Engineer'],
  ['01-03-02', 'Automation Test Engineer'],
  ['01-03-03', 'QA Manager'],
  ['01-10-01', 'Project/Program Manager'],
  ['01-10-02', 'Technical Project Manager'],
  ['01-10-03', 'Scrum Master'],
  ['01-09-01', 'Engineering Manager'],
  ['01-09-02', 'Software Architect'],
  ['01-09-03', 'Engineering Director/VP'],
  ['01-09-04', 'CTO'],
  ['01-07-03', 'Solutions Architect'],
];

/** Our job-function names (shared.js JOB_FUNCTIONS) that Jobright words differently. */
const FUNCTION_ALIASES = {
  'Machine Learning, Model Training and Optimization': 'Machine Learning, Model Training and Inference',
  'Help Desk Technician/Desktop Support': 'Help Desk Technician/Desktop Support Technician',
  'Software Testing/Quality Assurance': 'Software Testing/Quality Assurance Engineer',
};

const FUNCTION_BY_TITLE = new Map(FUNCTIONS.map(([id, title]) => [title.toLowerCase(), { id, title }]));

/** Jobright's job-type codes, by our job-type ids ("temporary" has none on Jobright). */
const JOB_TYPE_CODES = { full_time: 1, contract: 2, part_time: 3, internship: 4 };
const JOB_TYPE_NAMES = { 1: 'Full-time', 2: 'Contract', 3: 'Part-time', 4: 'Internship' };

/** Jobright's experience-level codes; our "Senior Level" covers Senior, Lead/Staff and Director. */
const SENIORITY_CODES = {
  'No Prior Experience Required': [1],
  'Entry Level': [2],
  'Mid Level': [3],
  'Senior Level': [4, 5, 6],
};
const SENIORITY_NAMES = {
  1: 'Intern/New Grad',
  2: 'Entry Level',
  3: 'Mid Level',
  4: 'Senior Level',
  5: 'Lead/Staff',
  6: 'Director/Executive',
};

const WORK_MODEL_REMOTE = 2;
const WORK_MODEL_NAMES = { 2: 'Remote anywhere in the US' };

/** The one "Date posted" value known to be accepted: Past 3 days. */
const DAYS_AGO_SHORT = 3;

/* ---------------- what the Filters panel asks for ---------------- */

/**
 * @param {import('./shared.js').Settings} settings
 * @returns {{
 *   filters: Record<string, any>,
 *   functions: Array<{ id: string, title: string }>,
 *   notes: string[],
 * }}
 *   `filters`: the saved-filter keys to set; `functions`: the job functions to set (empty = leave as is);
 *   `notes`: wanted filters that can't be set on the account (still applied to the jobs we read).
 */
export function requiredFilters(settings) {
  const filters = { country: 'US' };
  const notes = [];

  const types = (settings.jobTypes || []).map((t) => JOB_TYPE_CODES[t]).filter(Boolean);
  if (types.length) filters.jobTypes = [...new Set(types)].sort((a, b) => a - b);

  const levels = (settings.seniority || []).flatMap((s) => SENIORITY_CODES[s] || []);
  if (levels.length) filters.seniority = [...new Set(levels)].sort((a, b) => a - b);

  if (settings.remoteOnly) filters.workModel = [WORK_MODEL_REMOTE];

  const days = dateDays(settings.datePosted);
  if (days > 0 && days <= DAYS_AGO_SHORT) filters.daysAgo = DAYS_AGO_SHORT;

  // "No explicit reference to clearance" only → Jobright's "No Security Clearance" switch.
  const clearances = settings.clearances || [];
  if (clearances.length === 1 && clearances[0] === 'None') filters.excludeSecurityClearance = true;

  const functions = [];
  const picked = settings.jobFunctions || [];
  const known = picked.map((name) => FUNCTION_BY_TITLE.get((FUNCTION_ALIASES[name] || name).toLowerCase()));
  const unknown = picked.filter((_, i) => !known[i]);
  if (!picked.length || picked.length >= JOB_FUNCTIONS.length) {
    // None picked or every one picked = no narrowing: the account's own job functions stay as they are.
  } else if (!unknown.length) {
    for (const f of known) if (!functions.some((x) => x.id === f.id)) functions.push(f);
  } else if (unknown.length) {
    notes.push(`job functions not set on Jobright (no Jobright id for: ${unknown.slice(0, 3).join(', ')}${unknown.length > 3 ? '…' : ''})`);
  }

  return { filters, functions, notes };
}

function dateDays(id) {
  const DAYS = { '24h': 1, '3d': 3 };
  return DAYS[id] || (id === 'any' ? 0 : Number.MAX_SAFE_INTEGER);
}

/* ---------------- comparing and updating the saved filters ---------------- */

const codesOf = (v) => {
  if (!Array.isArray(v)) return [];
  const out = new Set();
  for (const x of v) {
    const n = Number(x);
    if (Number.isFinite(n)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
};

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const named = (codes, names) => (codes.length ? codes.map((c) => names[c] || `code ${c}`).join(', ') : 'none');

/**
 * How the account's saved filters (get/filter's "result") differ from the wanted ones, as jobright.ai
 * names them. Empty when they match.
 */
export function filterDifferences(saved, required) {
  if (!saved || typeof saved !== 'object') return ['Jobright gave no saved filters'];
  const want = required.filters;
  const out = [];

  if (required.functions.length) {
    const have = new Set((Array.isArray(saved.jobTaxonomyList) ? saved.jobTaxonomyList : []).map((f) => String(f?.taxonomyId || '')));
    const wanted = new Set(required.functions.map((f) => f.id));
    const titleOf = (id) => FUNCTIONS.find(([i]) => i === id)?.[1] || id;
    const missing = [...wanted].filter((id) => !have.has(id));
    const extra = [...have].filter((id) => id && !wanted.has(id));
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.map(titleOf).join(', ')}`);
    if (extra.length) parts.push(`not wanted: ${extra.map(titleOf).join(', ')}`);
    if (parts.length) out.push(`Job function: ${parts.join('; ')}`);
  }

  const list = (key, label, names) => {
    if (!want[key]) return;
    const have = codesOf(saved[key]);
    if (!same(have, want[key])) out.push(`${label}: ${named(have, names)} instead of ${named(want[key], names)}`);
  };
  list('jobTypes', 'Job type', JOB_TYPE_NAMES);
  list('seniority', 'Experience level', SENIORITY_NAMES);
  list('workModel', 'Work model', WORK_MODEL_NAMES);

  if (want.daysAgo != null) {
    const have = Number(saved.daysAgo) || 0;
    if (have !== want.daysAgo) out.push(`Date posted: ${have ? `past ${have} days` : 'any time'} instead of past ${want.daysAgo} days`);
  }
  if (want.excludeSecurityClearance === true && saved.excludeSecurityClearance !== true) {
    out.push("Security clearance: jobs needing one aren't left out (No Security Clearance is off)");
  }
  if (want.country && String(saved.country || '').toUpperCase() !== want.country) {
    out.push(`Country: ${saved.country || 'none'}`);
  }
  return out;
}

/**
 * What the account's saved-filter update takes: the saved filters as they are, with the wanted ones
 * put in. `jobTitle` is the functions' titles as jobright.ai writes it: joined by ", ", a comma inside
 * a title turned into a space ("Machine Learning  Deep Learning").
 */
export function filterUpdateBody(saved, required) {
  const body = saved && typeof saved === 'object' ? { ...saved } : {};
  if (required.functions.length) {
    body.jobTaxonomyList = required.functions.map((f) => ({ taxonomyId: f.id, title: f.title }));
    body.jobTitle = required.functions.map((f) => f.title.replace(/,/g, ' ')).join(', ');
  }
  for (const [k, v] of Object.entries(required.filters)) body[k] = Array.isArray(v) ? v.slice() : v;
  return body;
}

/** Entries of saved/list's result: it comes as a list, or wrapped in an object. */
function savedEntries(result) {
  if (Array.isArray(result)) return result.filter((e) => e && typeof e === 'object');
  if (result && typeof result === 'object') {
    for (const v of Object.values(result)) {
      if (Array.isArray(v) && v.some((e) => e && typeof e === 'object' && 'surveyId' in e)) return v;
    }
  }
  return [];
}

/**
 * Where the account's filter in use is updated: its surveyId from saved/list (the one active, else
 * the only one, unless Jobright marks it not in use). "" when there is none to go by.
 * The id stays text: it is too long a number for JavaScript.
 */
export function updatePath(savedList) {
  const entries = savedEntries(savedList);
  const active = entries.find((e) => e.isActive === true);
  const only = entries.length === 1 && entries[0].isActive !== false ? entries[0] : null;
  const chosen = active || only;
  const id = String(chosen?.surveyId ?? '').trim();
  return /^\d{1,30}$/.test(id) ? JR_UPDATE_PATH.replace('{id}', id) : '';
}

/* ---------------- requests ---------------- */

/**
 * One JSON request made from inside a jobright.ai tab (chrome.scripting.executeScript).
 * Must stay self-contained. Jobright answers `{ success, errorCode: 10000, result }` when it's happy.
 */
export async function inPageRequest(url, method, body, okCode) {
  try {
    const headers = { Accept: 'application/json, text/plain, */*', 'X-Client-Type': 'web' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers,
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) return { error: `Jobright answered HTTP ${res.status} to ${url}` };
    const json = await res.json();
    if (!json || !json.success || json.errorCode !== okCode) {
      return {
        error: `Jobright answered "${(json && (json.errorMsg || json.errorCode)) || 'nothing'}" to ${url} (signed in to jobright.ai?)`,
      };
    }
    return { ok: true, value: json.result ?? null };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

async function request(tabId, path, method = 'GET', body = null) {
  const [r] = await chrome.scripting
    .executeScript({ target: { tabId }, func: inPageRequest, args: [path, method, body, JR_OK_CODE] })
    .catch((e) => [{ result: { error: e.message } }]);
  if (!r?.result?.ok) {
    throw new Error(r?.result?.error || 'the Jobright tab gave no answer (signed in to jobright.ai?)');
  }
  return r.result.value;
}

/**
 * Makes the account's saved filters the wanted ones (see the file header). Throws when they can't be
 * set, so nothing is read through the wrong filters.
 *
 * @param {number} tabId a jobright.ai tab
 * @param {ReturnType<typeof requiredFilters>} required
 * @param {(text: string) => void} [onStatus]
 * @returns {Promise<{ changed: boolean, differences: string[] }>}
 */
export async function syncAccountFilters(tabId, required, onStatus) {
  const saved = await request(tabId, JR_FILTER_PATH, 'POST');
  const differences = filterDifferences(saved, required);
  if (!differences.length) return { changed: false, differences };

  const hint = `Set them on jobright.ai: ${differences.join('; ')}`;
  const path = updatePath(await request(tabId, JR_SAVED_LIST_PATH));
  if (!path) {
    throw new Error(`the filters saved on jobright.ai aren't the wanted ones, and no saved filter is in use there to update. ${hint}`);
  }

  onStatus?.("setting Jobright's filters…");
  const done = await request(tabId, path, 'POST', filterUpdateBody(saved, required));
  if (done === false) throw new Error(`Jobright didn't take the wanted filters, so nothing was read. ${hint}`);

  const left = filterDifferences(await request(tabId, JR_FILTER_PATH, 'POST'), required);
  if (left.length) {
    throw new Error(`Jobright didn't keep the wanted filters, so nothing was read. Set them on jobright.ai: ${left.join('; ')}`);
  }
  return { changed: true, differences };
}
