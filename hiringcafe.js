/**
 * HiringCafe source.
 *
 * HiringCafe's classic search page is a Next.js app. Its listings come from the data route
 *
 *   GET /_next/data/{buildId}/classic.json?searchState=<json>&page=N
 *     → { pageProps: { ssrHits, ssrIsLastPage, ssrTotalCount, ssrCompanyCount } }
 *
 * `buildId` is read from the `__NEXT_DATA__` script of /classic. The searchState is what the site's
 * own filters produce: US, newest first, plus only the filters that actually narrow (a filter left at
 * "any" isn't sent, so HiringCafe's own default — everything — applies).
 */

import { resolveAts } from './ats.js';
import {
  JOB_TYPES,
  MAX_YEARS,
  jobAttributes,
  seniorityFrom,
  roleTypeFrom,
  clearanceList,
  jobTypesOf,
} from './attributes.js';
import { htmlToReadable } from './text.js';

export const HC_BASE = 'https://hiringcafe.com';
export const HC_SOURCE = 'hiringcafe';
export const HC_PAGE_PAUSE_MS = 1500;
export const HC_RETRY_DELAYS_MS = [3000, 8000];

const US_LOCATION = {
  id: 'FxY1yZQBoEtHp_8UEq7V',
  formatted_address: 'United States',
  types: ['country'],
  geometry: { location: { lat: '39.8283', lon: '-98.5795' } },
  address_components: [{ long_name: 'United States', short_name: 'US', types: ['country'] }],
  options: {},
};

/* ---------------- search state ---------------- */

/** Our "Past N days" → HiringCafe's dateFetchedPastNDays (its "Past 24 hours" is 2). */
export function fetchedPastNDays(days) {
  return days > 0 ? Math.round(days) + 1 : null;
}

/**
 * @param {import('./shared.js').Settings} settings
 * @param {{ days?: number }} [opts]  `days`: how far back a job may be (0 / undefined = any time)
 */
export function buildSearchState(settings, { days = 0 } = {}) {
  const state = {
    locations: [US_LOCATION],
    defaultToUserLocation: false,
    searchQuery: '',
    sortBy: 'date',
  };

  const n = fetchedPastNDays(days);
  if (n) state.dateFetchedPastNDays = n;

  if (settings.remoteOnly) state.workplaceTypes = ['Remote'];

  // Job types: only when they narrow the five HiringCafe knows.
  const types = JOB_TYPES.filter((t) => settings.jobTypes.includes(t.id)).map((t) => t.board);
  if (types.length && types.length < JOB_TYPES.length) state.commitmentTypes = types;

  if (settings.seniority.length) state.seniorityLevel = settings.seniority.slice();
  if (settings.roleTypes.length) state.roleTypes = settings.roleTypes.slice();
  if (settings.clearances.length) state.securityClearances = settings.clearances.slice();

  const [rLo, rHi] = settings.roleYoe;
  if (rLo > 0 || rHi < MAX_YEARS) state.roleYoeRange = [rLo, rHi];
  const [lLo, lHi] = settings.leadershipYoe;
  if (lLo > 0 || lHi < MAX_YEARS) state.managementYoeRange = [lLo, lHi];

  return state;
}

export function classicDataUrl(buildId, searchState, page) {
  const q = new URLSearchParams({ searchState: JSON.stringify(searchState), page: String(page) });
  return `${HC_BASE}/_next/data/${encodeURIComponent(buildId)}/classic.json?${q}`;
}

export function parseBuildId(html) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]).buildId || null;
  } catch {
    return null;
  }
}

/** Reads one page of the data route's JSON. */
export function readPage(json) {
  const props = json?.pageProps || json || {};
  return {
    hits: Array.isArray(props.ssrHits) ? props.ssrHits : [],
    last: props.ssrIsLastPage === true,
    total: Number(props.ssrTotalCount) || null,
    companies: Number(props.ssrCompanyCount) || null,
  };
}

/* ---------------- fetching ---------------- */

export class HcError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function failureReason(status, message = '') {
  if (status === 429) return 'too many requests (HiringCafe is slowing us down)';
  if (status === 403 || status === 503) return `blocked by HiringCafe's anti-bot check (${status})`;
  if (status) return `HiringCafe answered ${status}`;
  if (/json|unexpected token|<!doctype/i.test(message)) return "HiringCafe showed its anti-bot check instead of jobs";
  return message || 'no answer';
}

/** Direct fetch from the extension's own context (uses the browser's HiringCafe cookies). */
export function directFetcher(searchState) {
  let buildId = null;

  async function loadBuildId() {
    const res = await fetch(`${HC_BASE}/classic`, { headers: { Accept: 'text/html' }, credentials: 'include' });
    if (!res.ok) throw new HcError(`Could not open HiringCafe (${res.status})`, res.status);
    const id = parseBuildId(await res.text());
    if (!id) throw new HcError("HiringCafe didn't expose its build id (anti-bot check?)");
    return id;
  }

  return async function fetchPage(page) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!buildId) buildId = await loadBuildId();
      const res = await fetch(classicDataUrl(buildId, searchState, page), {
        headers: { Accept: 'application/json', 'x-nextjs-data': '1' },
        credentials: 'include',
      });
      // A new site deploy changes the build id: the old data route 404s. Look it up once more.
      if (res.status === 404 && attempt === 0) {
        buildId = null;
        continue;
      }
      if (!res.ok) throw new HcError(`HiringCafe SSR ${res.status}`, res.status);
      return readPage(await res.json());
    }
    throw new HcError('HiringCafe build id kept changing', 404);
  };
}

/**
 * Runs inside a HiringCafe tab (chrome.scripting.executeScript). Must stay self-contained.
 * Used when the direct fetch is blocked: the page already passed HiringCafe's anti-bot check.
 */
export async function inPageFetch(searchState, page) {
  try {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el || !el.textContent) return { error: "HiringCafe's page didn't load (its anti-bot check?)" };
    const buildId = JSON.parse(el.textContent).buildId;
    if (!buildId) return { error: "HiringCafe's page has no build id" };
    const q = new URLSearchParams({ searchState: JSON.stringify(searchState), page: String(page) });
    const res = await fetch(`/_next/data/${buildId}/classic.json?${q}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', 'x-nextjs-data': '1' },
    });
    if (!res.ok) return { status: res.status };
    const json = await res.json();
    const props = json.pageProps || json;
    return {
      hits: Array.isArray(props.ssrHits) ? props.ssrHits : [],
      last: props.ssrIsLastPage === true,
      total: Number(props.ssrTotalCount) || null,
      companies: Number(props.ssrCompanyCount) || null,
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pages through the results: pauses between pages, retries a failed page (3 s, then 8 s), stops at the
 * last page. A page that never answers ends the run but keeps what was already fetched.
 *
 * @param {{
 *   maxPages: number,
 *   startPage?: number,
 *   fetchPage: (page: number) => Promise<{hits: any[], last: boolean, total: number|null, companies: number|null}>,
 *   onPage: (page: {hits: any[], total: number|null, companies: number|null}, index: number) => Promise<void>,
 *   onRetry?: (index: number, reason: string) => void,
 *   retryDelays?: number[],
 *   shouldStop?: () => boolean,
 * }} o
 * @returns {Promise<{ stoppedAt?: number, reason?: string, pages: number, cancelled?: boolean }>}
 */
export async function crawlPages({
  maxPages,
  startPage = 0,
  fetchPage,
  onPage,
  onRetry,
  shouldStop,
  retryDelays = HC_RETRY_DELAYS_MS,
}) {
  let pages = 0;
  for (let index = startPage; index < maxPages; index += 1) {
    if (shouldStop?.()) return { pages, cancelled: true };
    if (index > startPage) await sleep(HC_PAGE_PAUSE_MS);

    let result = null;
    let reason = '';
    for (let attempt = 0; attempt <= retryDelays.length && !result; attempt += 1) {
      if (attempt) {
        onRetry?.(index, reason);
        await sleep(retryDelays[attempt - 1]);
        if (shouldStop?.()) return { pages, cancelled: true };
      }
      try {
        result = await fetchPage(index);
      } catch (e) {
        reason = failureReason(e?.status, e?.message);
      }
    }
    if (!result) return { stoppedAt: index, reason, pages };

    pages += 1;
    if (result.hits.length) await onPage(result, index);
    if (result.last || !result.hits.length) return { pages };
  }
  return { pages };
}

/* ---------------- hit → job ---------------- */

const get = (obj, ...path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
const firstText = (...values) => {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

const CURRENCY = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$', INR: '₹' };

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return v >= 1000 ? `${Math.round(v / 1000)}K` : String(Math.round(v));
}

function salaryFrom(v5, hit) {
  const lo = money(v5.yearly_min_compensation);
  const hi = money(v5.yearly_max_compensation);
  if (lo || hi) {
    const cur = String(v5.listed_compensation_currency || 'USD').toUpperCase();
    const sym = CURRENCY[cur] || `${cur} `;
    return lo && hi && lo !== hi ? `${sym}${lo}–${sym}${hi}/yr` : `${sym}${lo || hi}/yr`;
  }
  return firstText(hit.salary, hit.compensation, v5.salary);
}

function locationFrom(hit, v5, info) {
  const direct = firstText(
    v5.formatted_workplace_location,
    hit.formatted_location,
    hit.job_location,
    info.location,
    hit.location
  );
  if (direct) return direct;
  const parts = [...(v5.workplace_cities || []), ...(v5.workplace_states || []), ...(v5.workplace_countries || [])];
  return [...new Set(parts.filter(Boolean))].slice(0, 3).join(', ');
}

function workplaceFrom(v5, hit) {
  const raw = firstText(v5.workplace_type, hit.workplace_type, hit.workplaceType, hit.work_arrangement);
  if (/remote/i.test(raw)) return 'Remote';
  if (/hybrid/i.test(raw)) return 'Hybrid';
  if (/on[\s-]?site|in[\s-]?office/i.test(raw)) return 'Onsite';
  return raw;
}

/**
 * One HiringCafe hit → our job record (null when it isn't a usable job).
 * `scanText` and `description` are consumed by the service worker, like for Jobright.
 */
export function normalizeHit(hit) {
  if (!hit || typeof hit !== 'object') return null;
  if (hit.is_expired === true) return null;

  const externalId = firstText(hit.objectID, hit.id, hit.job_incarnation, hit.external_id);
  if (!externalId) return null;

  const info = hit.job_information || {};
  const v5 = hit.v5_processed_job_data || {};
  const company = hit.v5_processed_company_data || {};
  const enriched = hit.enriched_company_data || {};

  const title = firstText(info.title, hit.job_title_raw, v5.core_job_title, hit.title);
  const applyUrl = firstText(hit.apply_url, hit.url, hit.job_url) || null;
  const description = htmlToReadable(
    firstText(info.description, hit.description, v5.requirements_summary, enriched.description) || ''
  ).slice(0, 12000);

  const workModel = workplaceFrom(v5, hit);
  const commitment = Array.isArray(v5.commitment) ? v5.commitment : v5.commitment ? [v5.commitment] : [];

  const attrs = jobAttributes({
    title,
    description,
    given: {
      jobTypes: jobTypesOf(commitment),
      seniority: seniorityFrom(v5.seniority_level),
      roleType: roleTypeFrom(v5.role_type),
      roleYoe: v5.min_industry_and_role_yoe,
      leadershipYoe: v5.min_management_and_leadership_yoe,
      clearances: clearanceList(v5.security_clearance),
    },
  });

  const companyName = firstText(company.name, enriched.name, hit.company_name, v5.company_name);
  const website = firstText(company.website, enriched.website, company.homepage_uri, hit.company_website);
  const logo = firstText(company.image_url, enriched.image_url, enriched.logo, company.logo_url);

  return {
    id: `hc:${externalId}`,
    source: HC_SOURCE,
    title,
    nlpTitle: firstText(v5.core_job_title),
    company: companyName || null,
    companyLogo: logo || null,
    companyUrl: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null,
    companyDesc: firstText(enriched.tagline, company.tagline, enriched.description).slice(0, 400),
    isAgency: false,
    applyUrl,
    ats: resolveAts(hit.source, applyUrl),
    easyApplyOnJobright: false,
    sourceUrl: `${HC_BASE}/viewjob/${encodeURIComponent(externalId)}`,
    postedAtMs:
      toMs(v5.estimated_publish_date_millis) ??
      toMs(v5.estimated_publish_date) ??
      toMs(hit.posted_at) ??
      toMs(hit.created_at),
    postedLabel: null,
    employmentType: commitment.join(', '),
    jobTypes: attrs.jobTypes,
    location: locationFrom(hit, v5, info),
    workModel,
    isRemote: /remote/i.test(workModel),
    salary: salaryFrom(v5, hit),
    seniority: firstText(v5.seniority_level),
    seniorityLevel: attrs.seniorityLevel,
    roleType: attrs.roleType,
    roleYoe: attrs.roleYoe,
    leadershipYoe: attrs.leadershipYoe,
    clearances: attrs.clearances,
    taxonomy: [firstText(v5.job_category, v5.listing_job_family)].filter(Boolean),
    description,
    scanText: `${title}. ${description}`.slice(0, 20000),
  };
}
