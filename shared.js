/**
 * Shared helpers for the service worker, side panel and full view.
 * No network I/O here.
 */

import { resolveAts, jobAts } from './ats.js';
import {
  JOB_TYPES,
  SENIORITY_LEVELS,
  ROLE_TYPES,
  CLEARANCES,
  WORKPLACES,
  MAX_YEARS,
  jobTypesOf,
  seniorityFrom,
  clearanceList,
  jobAttributes,
} from './attributes.js';

export { JOB_TYPES, SENIORITY_LEVELS, ROLE_TYPES, CLEARANCES, WORKPLACES, MAX_YEARS };
export { COMPANY_SITE, atsLabel, jobAts, canonicalAts } from './ats.js';

/* ---------------- sources ---------------- */

export const SOURCES = [
  { id: 'hiringcafe', label: 'HiringCafe', hint: 'No sign-in needed. Jobs from company career pages and ATS boards.' },
  { id: 'jobright', label: 'Jobright', hint: 'Needs you to be signed in. Reads your Jobright feed.' },
];

export const DEFAULT_SOURCE = 'jobright';

/** Older stored jobs predate HiringCafe and have no `source`. */
export const jobSource = (job) => job?.source || DEFAULT_SOURCE;

export function sourceLabel(id) {
  return SOURCES.find((x) => x.id === id)?.label || id || '';
}

/** Page on the board itself for a job (the "View on …" link). */
export function jobSourceUrl(job) {
  if (job?.sourceUrl) return job.sourceUrl;
  if (job?.jobrightUrl) return job.jobrightUrl;
  return '';
}

export const STORAGE_KEYS = {
  session: 'jr_session',
  jobs: 'jr_jobs',
  settings: 'jr_settings',
  seen: 'jr_seen',
  /** Jobs the person has applied to. Kept apart from `jobs`: survives "Clear list" and the job cap. */
  applied: 'jr_applied',
};

/** Job descriptions are stored one per key (`jd:<job id>`), so the job list itself stays light to read. */
export const DESC_PREFIX = 'jd:';

/* ---------------- Job functions (mirrors Jobright's "Job Function" picker) ---------------- */

/** @type {Array<[string, RegExp]>} */
const JOB_FUNCTION_MATCHERS = [
  ['Software Engineer', /\b(software|application|product|platform|founding)\s+(development\s+)?(engineer|developer)\b|\b(staff|principal|distinguished|lead|senior|sr\.?)\s+engineer\b|\bswe\b|\bsde\b|\bprogrammer\b|\bsoftware\s+engineering\b/],
  ['Backend Engineer', /\bback[\s-]?end\b|\bserver[\s-]side\b|\bapi\s+(engineer|developer)\b|\bdistributed\s+systems\b/],
  ['Full Stack Engineer', /\bfull[\s-]?stack\b/],
  ['Java Engineer', /\bjava\b(?!\s*script)/],
  ['Python Engineer', /\bpython\b|\bdjango\b/],
  ['C/C++ Engineer', /\bc\s*\/\s*c\+\+|\bc\+\+|\bembedded\b|\bfirmware\b/],
  ['.Net Engineer', /\.net\b|\bc#|\bdotnet\b/],
  ['Golang Engineer', /\bgolang\b|\bgo\s+(engineer|developer)\b/],
  ['Blockchain Engineer', /\bblockchain\b|\bweb3\b|\bsolidity\b|\bsmart\s+contracts?\b|\bcrypto\b/],
  ['Salesforce Developer', /\bsalesforce\b.*\b(developer|engineer)\b|\bapex\s+developer\b/],
  ['Data Analyst', /\bdata\s+analyst\b|\banalytics\s+(analyst|engineer)\b/],
  ['Data Scientist', /\bdata\s+scien(tist|ce)\b|\bapplied\s+scientist\b/],
  ['Data Engineer', /\bdata\s+engineer|\bdata\s+platform\b|\bbig\s+data\b/],
  ['Power BI Developer', /\bpower\s*bi\b/],
  ['Business/BI Analyst', /\bbusiness\s+(intelligence|analyst)\b|\bbi\s+(analyst|developer|engineer)\b/],
  ['ETL Developer', /\betl\b/],
  ['Data Warehouse Engineer', /\bdata\s+warehous|\bsnowflake\b|\bdatabricks\b/],
  ['Machine Learning Engineer', /\bmachine\s+learning\b|\bml\b|\bmle\b/],
  ['AI Engineer', /\bai\b|\bartificial\s+intelligence\b|\bgen\s*ai\b|\bagentic\b/],
  ['Machine Learning/AI Researcher', /\bresearch\s+(scientist|engineer)\b|\bresearcher\b/],
  ['Machine Learning, Deep Learning', /\bdeep\s+learning\b|\bneural\b/],
  ['LLM Engineer', /\bllms?\b|\blarge\s+language\b|\bnlp\b|\bprompt\s+engineer/],
  ['Machine Learning, Model Training and Optimization', /\bmodel\s+(training|optimization)\b|\btraining\s+platform\b|\binferenc|\b(post|pre)[\s-]?training\b|\bfine[\s-]?tun/],
  ['Machine Learning, Computer Vision', /\bcomputer\s+vision\b|\bperception\b|\bimaging\b/],
  ['Machine Learning, Operations (ML Ops)', /\bml\s*ops\b|\bllm\s*ops\b/],
  ['Machine Learning, Search System', /\bsearch\b|\branking\b|\brecommend(ation|er)?s?\b|\bretrieval\b/],
  ['Machine Learning, Infrastructure', /\b(ml|ai|machine\s+learning)\s+(infra|infrastructure|platform|systems)\b/],
  ['Data Annotation/AI Tutor', /\bannotat|\bai\s+(tutor|trainer)\b|\blabell?ing\b|\brlhf\b/],
  ['Machine Learning, Ads', /\bads?\b.*\b(ml|machine\s+learning|ranking)\b|\b(ml|machine\s+learning)\b.*\bads?\b|\bad\s*tech\b/],
  ['Frontend Software Engineer', /\bfront[\s-]?end\b|\bui\s+engineer\b|\bweb\s+(developer|engineer)\b|\bjavascript\b|\btypescript\b|\bangular\b|\bvue\b/],
  ['React Developer', /\breact\b/],
  ['Android Developer', /\bandroid\b|\bkotlin\b/],
  ['UI/UX Developer', /\bui\s*\/?\s*ux\b|\bux\s+(engineer|developer)\b|\bdesign\s+engineer\b/],
  ['Game Developer', /\bgame(play)?\b|\bgaming\b|\bunity\b/],
  ['iOS/Swift Developer', /\bios\b|\bswift\b|\bmobile\b/],
  ['Unreal Engine Developer', /\bunreal\b/],
  ['AR/VR Developer', /\bar\s*\/\s*vr\b|\b(augmented|virtual|mixed)\s+reality\b|\bxr\b|\bvr\b/],
  ['DevOps', /\bdev\s*(sec)?\s*ops\b|\bplatform\s+engineer|\bcloud\s+(engineer|architect)|\binfrastructure\s+engineer|\bbuild\s+(and|&)\s+release\b|\bkubernetes\b/],
  ['Cyber Security Analyst', /\b(cyber\s*)?security\s+analyst\b|\bthreat\b|\bvulnerability\b/],
  ['Cyber Security Engineer', /\b(cyber\s*)?security\s+engineer|\bappsec\b|\bproduct\s+security\b|\bpenetration\b|\boffensive\s+security\b/],
  ['Cloud Security Engineer', /\bcloud\s+security\b/],
  ['Network Security Engineer', /\bnetwork\s+security\b|\bfirewall\b/],
  ['Systems Engineer', /\bsystems?\s+engineer/],
  ['Flutter Developer', /\bflutter\b|\bdart\b/],
  ['Site Reliability Engineer (SRE)', /\bsre\b|\bsite\s+reliability\b|\breliability\s+engineer|\bproduction\s+engineer/],
  ['Network Engineer', /\bnetwork(ing)?\s+engineer/],
  ['SoC Analyst', /\bsoc\b|\bsecurity\s+operations\b/],
  ['IT Support Specialist', /\bit\s+(support|specialist|technician)\b/],
  ['Help Desk Technician/Desktop Support', /\bhelp\s*desk\b|\bdesktop\s+support\b|\bservice\s+desk\b/],
  ['Database Administrator', /\bdba\b|\bdatabase\s+(administrator|engineer)\b/],
  ['System Administrator', /\bsys(tems?)?\s*admin/],
  ['Network Support Specialist', /\bnetwork\s+(support|administrator|technician)\b/],
  ['Salesforce Administrator', /\bsalesforce\b.*\badmin/],
  ['Software Testing/Quality Assurance', /\bqa\b|\bquality\s+(assurance|engineer)\b|\btest(ing)?\s+engineer|\bsdet\b|\bsoftware\s+test/],
  ['Automation Test Engineer', /\b(test|qa)\s+automation\b|\bautomation\s+(test|qa)\b/],
  ['QA Manager', /\b(qa|quality)\s+(manager|lead)\b/],
  ['Project/Program Manager', /\b(project|program)\s+manager\b|\bpmo\b/],
  ['Technical Project Manager', /\btechnical\s+(project|program)\s+manager\b|\btpm\b/],
  ['Scrum Master', /\bscrum\b|\bagile\s+coach\b/],
  ['Engineering Manager', /\bengineering\s+manager\b|\bmanager,?\s+(software\s+)?engineering\b/],
  ['Software Architect', /\barchitect\b/],
  ['Engineering Director/VP', /\b(director|head|vp|vice\s+president)\b.*\bengineering\b|\bengineering\s+director\b/],
  ['CTO', /\bcto\b|\bchief\s+technology\b/],
  ['Financial Analyst', /\bfinancial\s+analyst\b|\bfp&a\b/],
  ['Risk Analyst', /\brisk\s+analyst\b/],
  ['Quantitative Analyst/Researcher', /\bquant(itative)?\b/],
  ['Equity Analyst', /\bequity\s+(research\s+)?analyst\b/],
  ['Portfolio Manager', /\bportfolio\s+manager\b/],
  ['Asset Manager', /\basset\s+manage/],
  ['Investment Manager', /\binvestment\s+(manager|analyst|associate)\b/],
  ['Securities Trader', /\btrader\b|\btrading\b/],
];

export const JOB_FUNCTIONS = JOB_FUNCTION_MATCHERS.map(([name]) => name);
const FUNCTION_MAP = new Map(JOB_FUNCTION_MATCHERS.map(([n, re]) => [n.toLowerCase(), re]));

const DAY = 24 * 3600e3;

/** Same ladder as HiringCafe's "Date posted". `days` is how far back a job may be. */
export const DATE_OPTIONS = [
  { id: '24h', label: 'Past 24 hours', days: 1 },
  { id: '3d', label: 'Past 3 days', days: 3 },
  { id: 'week', label: 'Past week', days: 7 },
  { id: '2w', label: 'Past 2 weeks', days: 14 },
  { id: '3w', label: 'Past 3 weeks', days: 21 },
  { id: 'month', label: 'Past month', days: 30 },
  { id: '2m', label: 'Past 2 months', days: 60 },
  { id: '3m', label: 'Past 3 months', days: 90 },
  { id: '4m', label: 'Past 4 months', days: 120 },
  { id: '5m', label: 'Past 5 months', days: 150 },
  { id: '6m', label: 'Past 6 months', days: 180 },
  { id: '1y', label: 'Past year', days: 365 },
  { id: '2y', label: 'Past 2 years', days: 730 },
  { id: '3y', label: 'Past 3 years', days: 1095 },
].map((o) => ({ ...o, ms: o.days * DAY }));

export const ANY_DATE = { id: 'any', label: 'Any time', days: 0, ms: 0 };

export function dateOption(id) {
  return DATE_OPTIONS.find((d) => d.id === id) || null;
}

export const TRAVEL_LEVELS = [
  { id: 'none', label: 'None' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'moderate', label: 'Moderate' },
  { id: 'extensive', label: 'Extensive' },
];

export const SORT_OPTIONS = [
  { id: 'FRESHNESS', label: 'Most recent' },
  { id: 'RELEVANCE', label: 'Recommended' },
  { id: 'MATCH_SCORE', label: 'Top matched' },
];

/**
 * @typedef {{
 *   sources: string[],
 *   jobFunctions: string[],
 *   jobTypes: string[],
 *   datePosted: string,
 *   seniority: string[],
 *   roleTypes: string[],
 *   roleYoe: [number, number],
 *   leadershipYoe: [number, number],
 *   clearances: string[],
 *   airTravel: string[],
 *   landTravel: string[],
 *   remoteOnly: boolean,
 *   sortCondition: string,
 *   maxPages: number,
 *   scanEmployerPages: boolean,
 * }} Settings
 */

/** @type {Settings} */
export const DEFAULT_SETTINGS = {
  sources: SOURCES.map((x) => x.id),
  jobFunctions: JOB_FUNCTIONS.slice(),
  jobTypes: ['full_time', 'contract', 'part_time'],
  datePosted: '24h',
  seniority: [],
  roleTypes: [],
  roleYoe: [0, MAX_YEARS],
  leadershipYoe: [0, MAX_YEARS],
  clearances: [],
  airTravel: ['none'],
  landTravel: ['none'],
  remoteOnly: true,
  sortCondition: 'FRESHNESS',
  maxPages: 30,
  scanEmployerPages: true,
};

const asList = (v, allowed) => {
  const list = Array.isArray(v) ? v : [];
  return allowed ? list.filter((x) => allowed.includes(x)) : list;
};

function asRange(v) {
  const [lo, hi] = Array.isArray(v) ? v : [0, MAX_YEARS];
  const a = Math.max(0, Math.min(MAX_YEARS, Math.round(Number(lo) || 0)));
  const b = Math.max(0, Math.min(MAX_YEARS, Math.round(Number.isFinite(Number(hi)) ? Number(hi) : MAX_YEARS)));
  return a <= b ? [a, b] : [b, a];
}

/** Defaults + whatever is stored, with the newer fields made safe for older saved settings. */
export function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  s.sources = asList(s.sources, SOURCES.map((x) => x.id));
  if (!s.sources.length) s.sources = DEFAULT_SETTINGS.sources.slice();
  s.jobTypes = asList(s.jobTypes);
  s.seniority = asList(s.seniority, SENIORITY_LEVELS);
  s.roleTypes = asList(s.roleTypes, ROLE_TYPES);
  s.clearances = asList(s.clearances, CLEARANCES.map((c) => c.id));
  s.roleYoe = asRange(s.roleYoe);
  s.leadershipYoe = asRange(s.leadershipYoe);
  if (s.datePosted !== 'any' && !dateOption(s.datePosted)) s.datePosted = DEFAULT_SETTINGS.datePosted;
  return s;
}

/** "Any" / "5+ years" / "Up to 3 years" / "2–6 years" */
export function yearsText(lo, hi) {
  if (lo <= 0 && hi >= MAX_YEARS) return 'Any';
  if (hi >= MAX_YEARS) return `${lo}+ years`;
  if (lo <= 0) return `Up to ${hi} year${hi === 1 ? '' : 's'}`;
  return lo === hi ? `${lo} year${lo === 1 ? '' : 's'}` : `${lo}–${hi} years`;
}

/** True when a years range actually narrows (anything but the full 0 → MAX span). */
export const isNarrowRange = (r) => r[0] > 0 || r[1] < MAX_YEARS;

/* ---------------- Applied jobs ---------------- */

/** Query parameters that only say where a visitor came from, never which job it is. */
const TRACKING_PARAM = /^(utm_.*|gclid|fbclid|msclkid|dclid|mc_[a-z]+|gh_src|lever-(source|origin).*|trk|trkid|tracking.*|campaign.*|cid|_ga|_gl|ccuid|jr_.*|promo|medium|fromsearch|sid|s_id)$/i;
/** Ambiguous: `?source=jobright` is tracking, `?ref=48213` is a requisition number. Digits-only = keep. */
const MAYBE_TRACKING_PARAM = /^(ref|refid|referrer|ref_src|source|src)$/i;

/**
 * Identity of a posting, from its apply link: host + path + the query parameters that name the job
 * (`gh_jid=123`, `jobId=…`), minus tracking noise and the fragment. The same job found on both
 * boards, or again in a later run with other tracking parameters, gets the same key.
 */
export function jobKey(url) {
  try {
    const u = new URL(url);
    const query = [...u.searchParams]
      .filter(([k, v]) => !TRACKING_PARAM.test(k) && !(MAYBE_TRACKING_PARAM.test(k) && !/^\d+$/.test(v)))
      .map(([k, v]) => `${k.toLowerCase()}=${v}`)
      .sort()
      .join('&');
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}${query ? `?${query}` : ''}`.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

/** Bookkeeping fields that belong to the Inbox only. */
const INBOX_ONLY_FIELDS = ['__scanning', 'openedAtMs', 'openedAck'];

/** The stored record of a job the person applied to: the whole job, when, and its identity. */
export function toAppliedRecord(job, appliedAtMs) {
  const rec = { ...job, appliedAtMs, applyKey: job.applyUrl ? jobKey(job.applyUrl) : '' };
  for (const k of INBOX_ONLY_FIELDS) delete rec[k];
  return rec;
}

/** An applied record back as a plain job (for "Move back to Inbox"). */
export function fromAppliedRecord(rec) {
  const job = { ...rec };
  delete job.appliedAtMs;
  delete job.applyKey;
  return job;
}

/** Lookup tables over the applied list: by job id and by apply-link identity. */
export function indexApplied(list) {
  return {
    list,
    ids: new Set(list.map((j) => j.id)),
    keys: new Set(list.map((j) => j.applyKey || (j.applyUrl ? jobKey(j.applyUrl) : '')).filter(Boolean)),
  };
}

/** True when this job (or the same posting under another id) was already applied to. */
export function isAppliedJob(job, index) {
  return index.ids.has(job.id) || (!!job.applyUrl && index.keys.has(jobKey(job.applyUrl)));
}

/** Jobs the person opened the apply page of and hasn't said anything about yet. */
export const isAwaitingAnswer = (job) => !!job.openedAtMs && !job.openedAck;

/** Normalised company name, for "you already applied there". */
export function companyKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/* ---------------- URL classification ---------------- */

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function hostIs(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Job boards / aggregators: never the hiring company's own page. */
const JOB_BOARD_DOMAINS = [
  'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'dice.com', 'monster.com', 'simplyhired.com',
  'careerbuilder.com', 'builtin.com', 'builtinnyc.com', 'builtinsf.com', 'builtinla.com',
  'builtinboston.com', 'builtinchicago.org', 'builtinaustin.com', 'builtincolorado.com',
  'builtinseattle.com', 'wellfound.com', 'angel.co', 'jobgether.com', 'jooble.org', 'talent.com',
  'adzuna.com', 'lensa.com', 'jobleads.com', 'remoteok.com', 'remoteok.io', 'weworkremotely.com',
  'himalayas.app', 'theladders.com', 'ladders.com', 'flexjobs.com', 'remote.co', 'jobot.com',
  'efinancialcareers.com', 'clearancejobs.com', 'recruit.net', 'learn4good.com', 'snagajob.com',
  'hiring.cafe', 'hiringcafe.com', 'otta.com', 'welcometothejungle.com', 'workingnomads.com',
  'jobspresso.co', 'remotive.com', 'nodesk.co', 'virtualvocations.com', 'getwork.com',
  'tallo.com', 'joinhandshake.com', 'jobcase.com', 'careerjet.com', 'jora.com', 'salary.com',
];

export function isLinkedInUrl(url) {
  const h = hostnameOf(url);
  return hostIs(h, 'linkedin.com') || hostIs(h, 'lnkd.in');
}

export function isJobrightUrl(url) {
  return hostIs(hostnameOf(url), 'jobright.ai');
}

export function isJobBoardUrl(url) {
  const h = hostnameOf(url);
  return JOB_BOARD_DOMAINS.some((d) => hostIs(h, d));
}

/** @returns {'employer'|'linkedin'|'jobright'|'board'|'none'} */
export function classifyApplyUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'none';
  if (isLinkedInUrl(url)) return 'linkedin';
  if (isJobrightUrl(url)) return 'jobright';
  if (isJobBoardUrl(url)) return 'board';
  return 'employer';
}

/* ---------------- Jobright item normalization ---------------- */

function parseJobrightTime(s) {
  if (!s || typeof s !== 'string') return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function parseRelativePostedTime(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (/just\s+now|moments?\s+ago/.test(s)) return Date.now();
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const unit = { minute: 60e3, hour: 3600e3, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2]];
  return Date.now() - Number(m[1]) * unit;
}

/** @returns {string[]} ids from JOB_TYPES */
export const parseEmploymentTypes = (text) => jobTypesOf(text);

function joinText(...parts) {
  const flat = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string') flat.push(v);
    else if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'object') Object.values(v).forEach(push);
  };
  parts.forEach(push);
  return flat.join('\n');
}

/** Lines of a Jobright field (string | string[] | object) as a "- " bullet list. */
function bullets(v) {
  const out = [];
  const push = (x) => {
    if (x == null) return;
    if (typeof x === 'string') {
      const t = x.trim();
      if (t) out.push(t);
    } else if (Array.isArray(x)) x.forEach(push);
    else if (typeof x === 'object') Object.values(x).forEach(push);
  };
  push(v);
  return out.map((l) => `- ${l.replace(/^[-•*]\s*/, '')}`).join('\n');
}

/** The posting as Jobright gives it, as readable text: summary, then labelled sections. */
export function describeJobright(jr) {
  const q = jr.qualifications && typeof jr.qualifications === 'object' ? jr.qualifications : {};
  const parts = [];
  const summary = [jr.jobSummary, jr.jdResponsibilitySummary].find((v) => typeof v === 'string' && v.trim());
  if (summary) parts.push(summary.trim());
  const section = (title, value) => {
    const body = bullets(value);
    if (body) parts.push(`${title}\n${body}`);
  };
  section('Responsibilities', jr.coreResponsibilities);
  section('Requirements', q.mustHave ?? (Array.isArray(jr.qualifications) ? jr.qualifications : null));
  section('Skills', q.skillSummaries);
  section('Preferred', q.preferredHave);
  section('Education', q.educationSummaries);
  section('Benefits', jr.benefitsSummaries);
  section('Why join', jr.whyJoinUs);
  return parts.join('\n\n').slice(0, 12000);
}

/**
 * Convert a Jobright API / __NEXT_DATA__ item ({ jobResult, companyResult }) into our job record.
 * Apply link = jobResult.applyLink ?? jobResult.originalUrl (same as Jobright's own Apply button).
 *
 * `scanText` (long, for travel detection) and `description` (for display) are consumed by the
 * service worker and are not kept on the stored job record itself.
 */
export function normalizeJobrightItem(item) {
  const jr = item?.jobResult || {};
  const cr = item?.companyResult || {};
  const id = jr.jobId ? String(jr.jobId) : null;
  if (!id) return null;

  const applyUrl = jr.applyLink || jr.originalUrl || null;
  const postedAtMs = parseJobrightTime(jr.publishTime) ?? parseRelativePostedTime(jr.publishTimeDesc);
  const title = (jr.jobTitle || jr.jobNlpTitle || '').trim();
  const description = describeJobright(jr);

  const given = {
    jobTypes: jobTypesOf(jr.employmentType),
    seniority: seniorityFrom(jr.jobSeniority),
    roleYoe: jr.minYearsOfExperience,
    clearances:
      jr.isClearanceRequired === true ? ['Other'] : jr.isClearanceRequired === false ? ['None'] : [],
  };
  const attrs = jobAttributes({ title, description, given });
  // Jobright says "clearance required" without naming it: prefer a level the text names.
  if (jr.isClearanceRequired === true) {
    const named = jobAttributes({ title, description }).clearances.filter((c) => c !== 'None');
    if (named.length) attrs.clearances = named;
  }

  return {
    id,
    source: 'jobright',
    title,
    nlpTitle: jr.jobNlpTitle || '',
    company: (cr.companyName || '').trim() || null,
    companyLogo: cr.companyLogo || jr.jdLogo || null,
    companyUrl: cr.companyURL || null,
    companyDesc: cr.gptShortDescription || '',
    isAgency: !!cr.isAgency,
    applyUrl,
    ats: applyUrl ? resolveAts('', applyUrl) : '',
    easyApplyOnJobright: !!jr.jobtargetEasyapply,
    jobrightUrl: `https://jobright.ai/jobs/info/${id}`,
    sourceUrl: `https://jobright.ai/jobs/info/${id}`,
    postedAtMs,
    postedLabel: jr.publishTimeDesc || null,
    employmentType: jr.employmentType || '',
    jobTypes: attrs.jobTypes,
    location: jr.jobLocation || '',
    workModel: jr.workModel || '',
    isRemote: jr.isRemote === true || /remote/i.test(jr.workModel || ''),
    salary: jr.salaryDesc || '',
    seniority: jr.jobSeniority || '',
    seniorityLevel: attrs.seniorityLevel,
    roleType: attrs.roleType,
    roleYoe: attrs.roleYoe,
    leadershipYoe: attrs.leadershipYoe,
    clearances: attrs.clearances,
    taxonomy: Array.isArray(jr.jobTaxonomyV3) ? jr.jobTaxonomyV3 : [],
    description,
    scanText: joinText(
      jr.jobSummary,
      jr.jdResponsibilitySummary,
      jr.coreResponsibilities,
      jr.qualifications,
      jr.benefitsSummaries,
      jr.whyJoinUs
    ).slice(0, 20000),
  };
}

/* ---------------- Travel detection ---------------- */

const LEVEL_RANK = { none: 0, minimal: 1, moderate: 2, extensive: 3 };

const TRAVEL_FALSE_POSITIVE =
  /\btravel\s+(industry|insurance|booking|platform|company|tech(nology)?|experiences?|partners?|agenc(y|ies)|management\s+software|products?|brands?|marketplace|sector|stipend|reimbursement|perks?)\b|\btravell?ers\b|\bsoftware\s+travels?\b/;

const LAND_RE =
  /\bdriver'?s?\s+licen[cs]e\b|\bown\s+(vehicle|car|transportation)\b|\bcompany\s+(vehicle|car)\b|\bdriving\s+(to|between|required|is\s+required)\b|\bdrive\s+to\b|\breliable\s+transportation\b|\bmileage\b|\blocal\s+travel\b|\bregional\s+travel\b|\btravel\s+within\s+(the\s+)?(territory|region|state|area|metro)\b|\bground\s+travel\b|\bcustomer\s+sites?\s+within\b/;

const AIR_RE =
  /\bfly(ing)?\s+to\b|\bair\s+travel\b|\binternational(ly)?\s+travel\b|\btravel\s+(nationally|internationally|domestically|abroad|overseas)\b|\bovernight\s+travel\b|\bdomestic\s+travel\b|\bout[\s-]of[\s-]state\s+travel\b|\bnational\s+travel\b/;

/** "travel" used as a job requirement, not as an industry name or perk. */
const TRAVEL_WORD_RE =
  /\btravel(l?ing)?\s+(is\s+|will\s+be\s+|may\s+be\s+)?(required|expected|needed|necessary|up\s+to|of\s+up\s+to|requirements?|to\s+\w+|between|for\s+(work|business|client|customer|team|company|meetings|on-?sites?)|as\s+needed|\(?\d{1,3}\s*%)|\b(willing(ness)?|able|ability|required|expected|need|must|may|will|requires?)\s+(to\s+)?travel\b|\d{1,3}\s*%\s*(of\s+(the\s+)?time\s+)?travel|\btravel\s*:|\bbusiness\s+travel\b|\b(occasional|occasionally|minimal|limited|some|frequent|frequently|extensive|significant|regular|periodic|domestic|international|overnight|local|regional|required|no|zero)\s+travel\b|\bon[\s-]?site\s+visits?\b|\btravel\s+percentage\b/;

const TRAVEL_LIST_RE = /[,(/]\s*travel(l?ing)?\s*(&|and|,|\/|\))|(,|&|and)\s*travel(l?ing)?\s*[,)/]/;

const NONE_RE =
  /\b(no|zero|0\s*%)\s+travel\b|\btravel\s+(is\s+)?not\s+(required|expected|needed)\b|\bno\s+travel\s+(is\s+)?required\b|\bwithout\s+(any\s+)?travel\b|\bnot\s+require\s+(any\s+)?travel\b/;

function levelFromSentence(s) {
  if (NONE_RE.test(s)) return 'none';
  const pct = s.match(/(\d{1,3})\s*%/);
  if (pct) {
    const p = Number(pct[1]);
    if (p === 0) return 'none';
    if (p <= 15) return 'minimal';
    if (p <= 40) return 'moderate';
    return 'extensive';
  }
  if (/\bextensive|\bfrequent(ly)?\b|\bsignificant|\bheavy\b|\bmajority\b|\bweekly\s+travel|\btravel\s+weekly|\bconstant/.test(s)) return 'extensive';
  if (/\boccasional(ly)?\b|\bminimal\b|\blimited\b|\brare(ly)?\b|\binfrequent|\bannual(ly)?\b|\bonce\s+(a|per)\s+(year|quarter)\b|\bquarterly\b|\bfew\s+times\s+(a|per)\s+year\b|\boff-?sites?\b|\bteam\s+(gatherings?|meet-?ups?|summits?)\b|\bcompany\s+(retreats?|events?)\b/.test(s)) return 'minimal';
  return 'moderate';
}

function maxLevel(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

/**
 * @param {string} text
 * @returns {{ air: string, land: string, mentioned: boolean, snippet: string }}
 *   Travel that's never mentioned is reported as 'none' with mentioned=false.
 */
export function classifyTravel(text) {
  const result = { air: null, land: null, mentioned: false, snippet: '' };
  if (text) {
    const sentences = String(text)
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?;•])\s+|\s+[-–•·]\s+/);
    for (const raw of sentences) {
      const s = raw.toLowerCase();
      if (s.length > 600) continue;
      const isLand = LAND_RE.test(s);
      const isAir = AIR_RE.test(s);
      const isGeneric = TRAVEL_WORD_RE.test(s) && !TRAVEL_LIST_RE.test(s) && !TRAVEL_FALSE_POSITIVE.test(s);
      if (!isLand && !isAir && !isGeneric) continue;
      const level = levelFromSentence(s);
      result.mentioned = true;
      if (!result.snippet || level !== 'none') result.snippet = raw.trim().slice(0, 240);
      if (isLand) result.land = maxLevel(result.land, level);
      if (isAir || (isGeneric && !isLand)) result.air = maxLevel(result.air, level);
    }
  }
  return {
    air: result.air || 'none',
    land: result.land || 'none',
    mentioned: result.mentioned,
    snippet: result.snippet,
  };
}

/* ---------------- Filtering ---------------- */

export function jobMatchesFunctions(job, functions) {
  if (!functions || !functions.length) return true;
  const hay = `${job.title || ''} | ${job.nlpTitle || ''}`.toLowerCase();
  for (const f of functions) {
    const re = FUNCTION_MAP.get(String(f).toLowerCase());
    if (re) {
      if (re.test(hay)) return true;
    } else if (f && hay.includes(String(f).toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * @param {object} job
 * @param {Settings} settings
 */
export function jobMatchesFilters(job, settings) {
  const s = mergeSettings(settings);

  if (s.remoteOnly && !job.isRemote) return false;

  if (s.datePosted !== 'any') {
    const opt = DATE_OPTIONS.find((d) => d.id === s.datePosted);
    if (opt) {
      if (job.postedAtMs == null || Date.now() - job.postedAtMs > opt.ms) return false;
    }
  }

  if (s.jobTypes.length && job.jobTypes && job.jobTypes.length) {
    if (!job.jobTypes.some((t) => s.jobTypes.includes(t))) return false;
  }

  // Experience filters. A value the posting doesn't give is unknown, and unknown passes.
  if (s.seniority.length && job.seniorityLevel && !s.seniority.includes(job.seniorityLevel)) return false;
  if (s.roleTypes.length && job.roleType && !s.roleTypes.includes(job.roleType)) return false;
  if (!yearsWithin(job.roleYoe, s.roleYoe)) return false;
  if (!yearsWithin(job.leadershipYoe, s.leadershipYoe)) return false;
  if (s.clearances.length && job.clearances?.length && !job.clearances.some((c) => s.clearances.includes(c))) {
    return false;
  }

  if (!jobMatchesFunctions(job, s.jobFunctions)) return false;

  if (s.airTravel.length && !s.airTravel.includes(job.travelAir || 'none')) return false;
  if (s.landTravel.length && !s.landTravel.includes(job.travelLand || 'none')) return false;

  return true;
}

/** `years` inside the chosen span; unknown years and an un-narrowed span always pass. */
function yearsWithin(years, range) {
  if (years == null || !isNarrowRange(range)) return true;
  return years >= range[0] && (range[1] >= MAX_YEARS || years <= range[1]);
}

/* ---------------- Search & exclude (the Inbox's own boxes) ---------------- */

/** "engineer, salesforce" → ['engineer', 'salesforce'] (trimmed, empty ones dropped, no repeats). */
export function splitTerms(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value ?? '').split(/[,;\n]/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** A job matches a search when any search word is in its title, company or ATS. Empty = everything. */
export function matchesSearch(job, terms) {
  if (!terms.length) return true;
  const hay = `${job.title || ''} ${job.company || ''} ${job.nlpTitle || ''}`.toLowerCase();
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A title is excluded when an exclude word *starts* a word in it: "Sale" hides "Sales Engineer" and
 * "Salesperson", not "Wholesale Platform Engineer". Returns null when nothing is excluded.
 */
export function excludePattern(terms) {
  if (!terms.length) return null;
  return new RegExp(`(?<![\\w])(?:${terms.map(escapeRe).join('|')})`, 'i');
}

export function sortJobsNewest(jobs) {
  return [...jobs].sort((a, b) => (b.postedAtMs || 0) - (a.postedAtMs || 0) || String(a.id).localeCompare(String(b.id)));
}

/* ---------------- Formatting ---------------- */

export function fmtRelative(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function levelLabel(id) {
  return TRAVEL_LEVELS.find((l) => l.id === id)?.label || '—';
}

export function jobTypeLabel(job) {
  if (job.employmentType) return job.employmentType;
  return (job.jobTypes || []).map((t) => JOB_TYPES.find((j) => j.id === t)?.label || t).join(', ') || '—';
}
