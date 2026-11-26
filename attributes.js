/**
 * Job attributes the Filters panel narrows by: job type, seniority, role type, years of experience,
 * leadership experience and security clearance.
 *
 * HiringCafe hands most of these over already worked out; anything a board doesn't give is read from
 * the title and description. A value that can't be told stays empty (null / []), and an empty value
 * passes every filter instead of hiding the job.
 */

/* ---------------- vocabularies (HiringCafe's own wording) ---------------- */

export const JOB_TYPES = [
  { id: 'full_time', label: 'Full Time', board: 'Full Time' },
  { id: 'part_time', label: 'Part Time', board: 'Part Time' },
  { id: 'contract', label: 'Contract', board: 'Contract' },
  { id: 'internship', label: 'Internship', board: 'Internship' },
  { id: 'temporary', label: 'Temporary', board: 'Temporary' },
];

export const SENIORITY_LEVELS = ['No Prior Experience Required', 'Entry Level', 'Mid Level', 'Senior Level'];

export const ROLE_TYPES = ['Individual Contributor', 'People Manager'];

/** `id` is what is stored on a job; `label` is what the person sees. */
export const CLEARANCES = [
  { id: 'None', label: 'No explicit reference to clearance' },
  { id: 'Confidential', label: 'Confidential' },
  { id: 'Secret', label: 'Secret' },
  { id: 'Top Secret', label: 'Top Secret' },
  { id: 'Top Secret/SCI', label: 'Top Secret/SCI' },
  { id: 'Public Trust', label: 'Public Trust' },
  { id: 'Interim Clearances', label: 'Interim Clearances' },
  { id: 'Other', label: 'Other' },
];

export const WORKPLACES = ['Remote', 'Hybrid', 'Onsite'];

export const MAX_YEARS = 20;

/* ---------------- helpers ---------------- */

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const text = (v) => (v == null ? '' : String(v));

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), MAX_YEARS) : null;
}

/* ---------------- job type ---------------- */

/** @returns {string[]} ids from JOB_TYPES */
export function jobTypesOf(...values) {
  const t = values.flatMap((v) => asArray(v)).map(text).join(' | ').toLowerCase();
  if (!t) return [];
  const out = [];
  if (/full[\s-]*time|fulltime|permanent/.test(t)) out.push('full_time');
  if (/part[\s-]*time/.test(t)) out.push('part_time');
  if (/\bcontract|contractor|freelance|\bc2c\b|\b1099\b/.test(t)) out.push('contract');
  if (/\bintern/.test(t)) out.push('internship');
  if (/\b(temporary|temp|seasonal)\b/.test(t)) out.push('temporary');
  return out;
}

/* ---------------- seniority ---------------- */

/** Map any board's seniority wording onto HiringCafe's four levels. */
export function seniorityFrom(value) {
  const t = text(value).trim().toLowerCase();
  if (!t) return '';
  if (/no (prior )?experience|none required|intern|new grad/.test(t)) return 'No Prior Experience Required';
  if (/\b(entry|junior|jr|graduate)\b/.test(t)) return 'Entry Level';
  if (/\bmid\b|intermediate/.test(t)) return 'Mid Level';
  if (/\b(senior|sr|staff|principal|lead|expert|executive|director|vp|chief)\b/.test(t)) return 'Senior Level';
  return '';
}

/** Seniority read from a title, the last resort. */
export function seniorityFromTitle(title) {
  const t = text(title);
  if (/\b(intern|internship)\b/i.test(t)) return 'No Prior Experience Required';
  if (/\b(entry|junior|jr\.?|graduate|new grad|associate)\b/i.test(t)) return 'Entry Level';
  if (/\b(senior|sr\.?|staff|principal|lead|distinguished|director|head of|vp)\b/i.test(t)) return 'Senior Level';
  if (/\b(ii|iii|mid)\b/i.test(t)) return 'Mid Level';
  return '';
}

/* ---------------- role type ---------------- */

const MANAGER_TITLE = /\b(manager|director|head of|vp|vice president|chief|supervisor)\b/i;
const NOT_PEOPLE_MANAGER = /\b(product|project|program|account|case|community|content|data|release)\s+manager\b/i;

export function roleTypeFrom(value) {
  const t = text(value).toLowerCase();
  if (!t) return '';
  if (/people|manag/.test(t)) return 'People Manager';
  if (/individual|contributor/.test(t)) return 'Individual Contributor';
  return '';
}

export function roleTypeFromTitle(title) {
  const t = text(title);
  if (!t) return '';
  return MANAGER_TITLE.test(t) && !NOT_PEOPLE_MANAGER.test(t) ? 'People Manager' : 'Individual Contributor';
}

/* ---------------- years of experience ---------------- */

const ROLE_YEARS =
  /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?years?(?:'|’)?(?:\s+of)?(?:\s+[\w/+#.-]+){0,5}?\s+experience/gi;
const LEADERSHIP_YEARS =
  /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?years?(?:'|’)?(?:\s+of)?[^.\n]{0,40}?\b(management|managing|leadership|leading (?:teams|engineers|people)|people manag)/gi;

/** Largest "N+ years … experience" minimum in the text (the most demanding requirement). */
export function roleYoeFromText(body) {
  const s = text(body);
  let best = null;
  for (const m of s.matchAll(ROLE_YEARS)) {
    const n = toNumber(m[1]);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best;
}

export function leadershipYoeFromText(body) {
  const s = text(body);
  let best = null;
  for (const m of s.matchAll(LEADERSHIP_YEARS)) {
    const n = toNumber(m[1]);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best;
}

/* ---------------- security clearance ---------------- */

const CLEARANCE_TEXT =
  /top secret\s*\/\s*sci|\bts\s*\/\s*sci\b|top secret|public trust|interim (?:secret|clearance)|\b(?:secret|confidential)\s+(?:security\s+)?clearance|(?:security\s+)?clearance/i;
const NO_CLEARANCE =
  /\bno (?:security )?clearance\b|clearance (?:is )?not required|(?:does not|doesn't) require (?:a )?(?:security )?clearance/i;

/** Normalise one clearance value ("TS/SCI", "secret", "No clearance"…) to a CLEARANCES id. */
export function clearanceOf(value) {
  const t = text(value).trim();
  if (!t) return '';
  if (/^\s*(none|no|not required|n\/?a)\s*$|no (explicit )?(reference|mention)/i.test(t)) return 'None';
  if (/top secret\s*\/\s*sci|\bts\s*\/\s*sci\b/i.test(t)) return 'Top Secret/SCI';
  if (/top secret/i.test(t)) return 'Top Secret';
  if (/interim/i.test(t)) return 'Interim Clearances';
  if (/public trust/i.test(t)) return 'Public Trust';
  if (/\bsecret\b/i.test(t)) return 'Secret';
  if (/confidential/i.test(t)) return 'Confidential';
  if (/clearance/i.test(t)) return 'Other';
  return 'Other';
}

export function clearancesFromText(body) {
  const s = text(body);
  if (!s) return [];
  if (NO_CLEARANCE.test(s)) return ['None'];
  const m = s.match(CLEARANCE_TEXT);
  if (!m) return [];
  const id = clearanceOf(m[0]);
  return id && id !== 'None' ? [id] : ['Other'];
}

/* ---------------- one job ---------------- */

/**
 * @param {{ title?: string, description?: string, given?: object }} input
 *   `given` holds what the board itself says (already-normalised where possible):
 *   { jobTypes[], seniority, roleType, roleYoe, leadershipYoe, clearances[] }
 * @returns {{ jobTypes: string[], seniorityLevel: string, roleType: string, roleYoe: number|null,
 *            leadershipYoe: number|null, clearances: string[] }}
 */
export function jobAttributes({ title = '', description = '', given = {} } = {}) {
  const body = `${title}\n${description}`;

  const jobTypes = given.jobTypes?.length ? given.jobTypes : jobTypesOf(description.slice(0, 4000));

  const seniorityLevel = given.seniority || seniorityFromTitle(title);

  const roleType = given.roleType || roleTypeFromTitle(title);

  const roleYoe = given.roleYoe != null ? toNumber(given.roleYoe) : roleYoeFromText(description);
  const leadershipYoe =
    given.leadershipYoe != null ? toNumber(given.leadershipYoe) : leadershipYoeFromText(description);

  const clearances = given.clearances?.length ? given.clearances : clearancesFromText(body);

  return { jobTypes, seniorityLevel, roleType, roleYoe, leadershipYoe, clearances };
}

/** Clearance values a board gave (string | string[]) → CLEARANCES ids. */
export function clearanceList(value) {
  return [...new Set(asArray(value).map(clearanceOf).filter(Boolean))];
}
