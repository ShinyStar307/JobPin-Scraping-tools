import {
  DATE_OPTIONS,
  JOB_FUNCTIONS,
  JOB_TYPES,
  SOURCES,
  MAX_YEARS,
  levelLabel,
  jobSource,
  sourceLabel,
  jobAts,
  atsLabel,
  yearsText,
  companyKey,
} from './shared.js';

/* ---------------- icons (inline SVG, inherit the text colour) ---------------- */

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.8 2.8L16.2 9.6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M6 5h12l2 8v6H4v-6z"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  download: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  building: '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16"/><path d="M14 10h5a1 1 0 0 1 1 1v10"/><path d="M8 8h2M8 12h2M8 16h2M3 21h18"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  arrowLeft: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};

/** `<svg class="icon">` for a named icon. */
export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/* ---------------- time ---------------- */

/** "Just now", "5m ago", "3h ago", "4d ago", then a date. */
export function shortAgo(ms) {
  if (!ms) return '—';
  const min = Math.max(0, Math.floor((Date.now() - ms) / 60e3));
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 31) return `${days}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: days > 330 ? 'numeric' : undefined });
}

export const isFresh = (ms) => !!ms && Date.now() - ms < 24 * 3600e3;

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Local-calendar heading for a moment: Today, Yesterday, "Monday", "Nov 3", "Nov 3, 2025". */
export function dayLabel(ms) {
  const now = new Date();
  const days = Math.round((startOfDay(now) - startOfDay(new Date(ms))) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ms);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** "Tue, Nov 25 · 4:20 PM" */
export function fullDateTime(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** How many applied jobs fall in each window: today (local midnight on), the last 7 days, ever. */
export function appliedCounts(applied) {
  const today = startOfDay(new Date());
  const week = Date.now() - 7 * 864e5;
  let t = 0;
  let w = 0;
  for (const j of applied) {
    if (j.appliedAtMs >= today) t += 1;
    if (j.appliedAtMs >= week) w += 1;
  }
  return { today: t, week: w, total: applied.length };
}

/* ---------------- applied companies ---------------- */

/** company key → how many jobs were applied to there. */
export function appliedByCompany(applied) {
  const map = new Map();
  for (const j of applied) {
    const k = companyKey(j.company);
    if (k) map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

/** "Applied here" marker for a job whose company already has an application. null when it has none. */
export function appliedCompanyTag(job, byCompany) {
  const n = byCompany.get(companyKey(job.company)) || 0;
  if (!n) return null;
  return h(
    'span.tag.applied',
    { title: `You already applied to ${n} other role${n === 1 ? '' : 's'} at ${job.company}.` },
    icon('check'),
    n === 1 ? 'Applied here' : `Applied here ×${n}`
  );
}

/* ---------------- toast ---------------- */

let toastBox = null;

/**
 * A short message at the bottom; with `action` it carries a button (Undo) and stays longer.
 * @param {string} text
 * @param {{ action?: { label: string, onClick: () => void }, ms?: number }} [opts]
 */
export function toast(text, { action, ms } = {}) {
  if (!toastBox) {
    toastBox = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const el = h(`div.toast${action ? '' : '.plain'}`, {}, h('span.msg', { title: text }, text));
  let timer = 0;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  if (action) {
    el.append(
      h('button', { type: 'button', on: { click: () => (close(), action.onClick()) } }, action.label)
    );
  }
  // One message at a time: a new one replaces the old.
  toastBox.replaceChildren(el);
  timer = setTimeout(close, ms ?? (action ? 7000 : 2200));
  return close;
}

/** Tiny DOM builder: h('div.class1.class2', { attrs }, ...children) */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'on') Object.entries(v).forEach(([ev, fn]) => node.addEventListener(ev, fn));
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function initials(name) {
  return (
    String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?'
  );
}

/** Host of the company's own site without "www.", or null. */
function companyHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * The company's icon, shown in place of its initials. Candidates are tried in order: the logo the
 * board gave us, then the favicon of the company's own site. A candidate that fails (or is too
 * small to be a real icon) is skipped; when none works the initials stay as they are.
 */
export function companyLogo(job) {
  const box = h('div.company-logo', {}, initials(job.company));
  const host = companyHost(job.companyUrl);
  const candidates = [
    job.companyLogo && { src: job.companyLogo, minWidth: 0 },
    host && { src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`, minWidth: 32 },
  ].filter(Boolean);

  const tryFrom = (i) => {
    const c = candidates[i];
    if (!c) return;
    // Not attached until it has loaded, so a failed candidate leaves the initials untouched.
    const img = h('img', { alt: '', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => {
      if (img.naturalWidth < c.minWidth) return tryFrom(i + 1);
      box.textContent = '';
      box.append(img);
    });
    img.addEventListener('error', () => tryFrom(i + 1));
    img.src = c.src;
  };
  tryFrom(0);
  return box;
}

/** Which board a job came from, and which ATS takes the application. */
export function sourceTags(job) {
  const src = jobSource(job);
  const ats = jobAts(job);
  return [
    h(`span.tag.src-${src}`, { title: `Found on ${sourceLabel(src)}` }, sourceLabel(src)),
    h(`span.tag.ats${ats === 'company' ? '.neutral' : ''}`, { title: 'Applicant tracking system behind the apply link' }, atsLabel(ats)),
  ];
}

export function travelTags(job) {
  const air = job.travelAir || 'none';
  const land = job.travelLand || 'none';
  const cls = (lvl) => (lvl === 'none' ? 'span.tag.ok' : lvl === 'minimal' ? 'span.tag' : 'span.tag.warn');
  const title = job.travelSnippet
    ? `“${job.travelSnippet}”`
    : job.travelSource === 'unreadable'
      ? 'Employer page could not be read; based on Jobright summary only.'
      : 'Travel is not mentioned in the job posting.';
  return [
    h(cls(air), { title: `Air travel · ${title}` }, icon('plane', 'sm'), levelLabel(air)),
    h(cls(land), { title: `Land travel · ${title}` }, icon('car', 'sm'), levelLabel(land)),
  ];
}

export function filterSummary(settings) {
  const chips = [];
  const fnCount = settings.jobFunctions.length;
  chips.push(
    h(
      'span.tag',
      {},
      fnCount === 0
        ? 'All job functions'
        : fnCount >= JOB_FUNCTIONS.length
          ? `All ${fnCount} job functions`
          : fnCount <= 2
            ? settings.jobFunctions.join(', ')
            : `${settings.jobFunctions[0]} +${fnCount - 1}`
    )
  );
  if (settings.sources.length < SOURCES.length) {
    chips.push(h('span.tag', {}, settings.sources.map(sourceLabel).join(' · ')));
  }
  if (settings.jobTypes.length && settings.jobTypes.length < JOB_TYPES.length) {
    chips.push(
      h('span.tag', {}, settings.jobTypes.map((t) => JOB_TYPES.find((j) => j.id === t)?.label || t).join(' · '))
    );
  }
  chips.push(h('span.tag', {}, DATE_OPTIONS.find((d) => d.id === settings.datePosted)?.label || 'Any date'));
  if (settings.seniority.length) chips.push(h('span.tag', {}, settings.seniority.join(' · ')));
  if (settings.roleTypes.length) chips.push(h('span.tag', {}, settings.roleTypes.join(' · ')));
  const [rLo, rHi] = settings.roleYoe;
  if (rLo > 0 || rHi < MAX_YEARS) chips.push(h('span.tag', {}, `Experience: ${yearsText(rLo, rHi)}`));
  const [lLo, lHi] = settings.leadershipYoe;
  if (lLo > 0 || lHi < MAX_YEARS) chips.push(h('span.tag', {}, `Leadership: ${yearsText(lLo, lHi)}`));
  if (settings.clearances.length) chips.push(h('span.tag', {}, `Clearance: ${settings.clearances.join(' · ')}`));
  if (settings.airTravel.length) chips.push(h('span.tag', {}, `Air: ${settings.airTravel.map(levelLabel).join('/')}`));
  if (settings.landTravel.length) chips.push(h('span.tag', {}, `Land: ${settings.landTravel.map(levelLabel).join('/')}`));
  if (settings.remoteOnly) chips.push(h('span.tag', {}, 'Remote'));
  return chips;
}

export function throttle(fn, ms) {
  let t = 0;
  let pending = false;
  return () => {
    if (t) {
      pending = true;
      return;
    }
    fn();
    t = setTimeout(() => {
      t = 0;
      if (pending) {
        pending = false;
        fn();
      }
    }, ms);
  };
}
