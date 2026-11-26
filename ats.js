/**
 * ATS (Applicant Tracking System) detection.
 *
 * An apply link tells us which system hosts the application form: greenhouse.io → Greenhouse,
 * myworkdayjobs.com → Workday, … A link that matches none of them is the company's own site.
 * HiringCafe also names the ATS itself (hit.source); that value wins when present.
 */

/** Pseudo-ATS id for an apply link on the company's own careers page. */
export const COMPANY_SITE = 'company';

/** [id, host regex] — first match wins. */
const ATS_HOSTS = [
  ['workday', /(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)workday\.com$/],
  ['greenhouse', /(^|\.)greenhouse\.io$/],
  ['lever', /(^|\.)lever\.co$/],
  ['ashby', /(^|\.)ashbyhq\.com$/],
  ['icims', /(^|\.)icims\.com$/],
  ['smartrecruiters', /(^|\.)smartrecruiters\.com$/],
  ['workable', /(^|\.)workable\.com$/],
  ['jobvite', /(^|\.)jobvite\.com$/],
  ['bamboohr', /(^|\.)bamboohr\.com$/],
  ['oraclecloud', /(^|\.)oraclecloud\.com$/],
  ['successfactors', /(^|\.)successfactors\.(com|eu)$/],
  ['taleo', /(^|\.)taleo\.net$/],
  ['adp', /(^|\.)adp\.com$/],
  ['paylocity', /(^|\.)paylocity\.com$/],
  ['ukg', /(^|\.)ultipro\.com$|(^|\.)ukg\.net$|(^|\.)ukg\.com$/],
  ['rippling', /(^|\.)rippling\.com$/],
  ['breezy', /(^|\.)breezy\.hr$/],
  ['jazzhr', /(^|\.)jazzhr\.com$|(^|\.)applytojob\.com$/],
  ['recruitee', /(^|\.)recruitee\.com$/],
  ['teamtailor', /(^|\.)teamtailor\.com$/],
  ['personio', /(^|\.)personio\.(de|com)$/],
  ['pinpoint', /(^|\.)pinpointhq\.com$/],
  ['avature', /(^|\.)avature\.net$/],
  ['brassring', /(^|\.)brassring\.com$/],
  ['careerplug', /(^|\.)careerplug\.com$/],
  ['csod', /(^|\.)csod\.com$/],
  ['dayforce', /(^|\.)dayforcehcm\.com$/],
  ['eightfold', /(^|\.)eightfold\.ai$/],
  ['zohorecruit', /(^|\.)zohorecruit\.(com|eu|in)$/],
  ['ttcportals', /(^|\.)ttcportals\.com$/],
  ['phenom', /(^|\.)phenompeople\.com$/],
  ['join', /(^|\.)join\.com$/],
  ['comeet', /(^|\.)comeet\.(co|com)$/],
  ['gem', /(^|\.)gem\.com$/],
  ['linkedin', /(^|\.)linkedin\.com$/],
  ['indeed', /(^|\.)indeed\.com$/],
];

const ALIASES = {
  grnhse: 'greenhouse',
  icims2: 'icims',
  myworkdayjobs: 'workday',
  ashbyhq: 'ashby',
  talentbrewc: 'talentbrew',
};

const LABELS = {
  greenhouse: 'Greenhouse',
  workable: 'Workable',
  ashby: 'Ashby',
  lever: 'Lever',
  smartrecruiters: 'SmartRecruiters',
  workday: 'Workday',
  eightfold: 'Eightfold',
  oraclecloud: 'Oracle Cloud',
  zohorecruit: 'Zoho Recruit',
  icims: 'iCIMS',
  jobvite: 'Jobvite',
  bamboohr: 'BambooHR',
  adp: 'ADP',
  adprecruiting: 'ADP Recruiting',
  csod: 'Cornerstone',
  csodsaba: 'Cornerstone',
  ukg: 'UKG',
  jazzhr: 'JazzHR',
  successfactors: 'SuccessFactors',
  ttcportals: 'TTC Portals',
  talentbrew: 'TalentBrew',
  careerplug: 'CareerPlug',
  brassring: 'BrassRing',
  [COMPANY_SITE]: 'Company site',
};

/** Normalise an ATS name coming from any board to one id ('Grnhse' → 'greenhouse'). */
export function canonicalAts(value) {
  const v = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '');
  if (!v) return '';
  return ALIASES[v] || v;
}

/** The ATS an apply link goes to, or '' when it is the company's own site. */
export function atsFromUrl(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  for (const [id, re] of ATS_HOSTS) if (re.test(host)) return id;
  return '';
}

/** Best ATS id for a job: the board's own value, else the apply link, else the company site. */
export function resolveAts(boardValue, applyUrl) {
  return canonicalAts(boardValue) || atsFromUrl(applyUrl) || COMPANY_SITE;
}

export function atsLabel(id) {
  const key = canonicalAts(id);
  if (!key) return LABELS[COMPANY_SITE];
  if (LABELS[key]) return LABELS[key];
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The ATS id of a stored job (older records have no `ats` field). */
export function jobAts(job) {
  return job?.ats || resolveAts('', job?.applyUrl);
}
