/**
 * The settings / filters form, shared by the side panel (Settings view) and the full view (Filters drawer).
 *
 * mountSettingsForm(root, draft, opts) renders into `root` and edits `draft` in place; the caller
 * decides when to save it. Everything on the form is a filter of the collected jobs, except
 * "Job boards" and "Scraping", which are about what the next run fetches.
 */

import {
  SOURCES,
  JOB_FUNCTIONS,
  JOB_TYPES,
  DATE_OPTIONS,
  ANY_DATE,
  TRAVEL_LEVELS,
  SORT_OPTIONS,
  SENIORITY_LEVELS,
  ROLE_TYPES,
  CLEARANCES,
  MAX_YEARS,
  DEFAULT_SETTINGS,
  yearsText,
} from './shared.js';
import { h } from './ui-common.js';

const OPTIONAL_ORIGINS = ['https://*/*', 'http://*/*'];

/* ---------------- small building blocks ---------------- */

function card(title, ...body) {
  return h('section.card.section', {}, h('div.section-head', {}, h('div.section-title', {}, title)), ...body);
}

function subhead(label, hint) {
  return h('div.subhead', {}, label ? h('div.caps', {}, label) : null, hint ? h('div.hint', {}, hint) : null);
}

/** Multi-select chips (empty selection = no narrowing). */
function chipGroup(options, selected, onChange) {
  const box = h('div.seg');
  const render = () => {
    box.replaceChildren(
      ...options.map(({ id, label }) => {
        const on = selected.includes(id);
        const b = h(`button.seg-chip${on ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(on) }, label);
        b.addEventListener('click', () => {
          const i = selected.indexOf(id);
          if (i >= 0) selected.splice(i, 1);
          else selected.push(id);
          onChange?.();
          render();
        });
        return b;
      })
    );
  };
  render();
  return box;
}

function optionTile(type, name, value, label, checked, onChange) {
  const input = h('input', { type, name, value, checked });
  input.addEventListener('change', onChange);
  return h(`label.option${type === 'radio' ? '.radio' : ''}`, {}, input, h('span.box'), h('span', {}, label));
}

/** Two thumbs on one track: `range` is [lo, hi], edited in place. */
function rangeSlider(label, hint, range, onChange) {
  const out = h('output', {});
  const lo = h('input', { type: 'range', min: 0, max: MAX_YEARS, step: 1, value: range[0], 'aria-label': `${label} minimum` });
  const hi = h('input', { type: 'range', min: 0, max: MAX_YEARS, step: 1, value: range[1], 'aria-label': `${label} maximum` });
  const track = h('div.range-track', {}, lo, hi);

  const paint = () => {
    out.textContent = yearsText(range[0], range[1]);
    track.style.setProperty('--lo', `${(range[0] / MAX_YEARS) * 100}%`);
    track.style.setProperty('--hi', `${(range[1] / MAX_YEARS) * 100}%`);
    track.classList.toggle('narrowed', range[0] > 0 || range[1] < MAX_YEARS);
  };
  const read = (moved) => {
    let a = Number(lo.value);
    let b = Number(hi.value);
    if (a > b) {
      if (moved === lo) a = b;
      else b = a;
      lo.value = a;
      hi.value = b;
    }
    range[0] = a;
    range[1] = b;
    paint();
    onChange?.();
  };
  lo.addEventListener('input', () => read(lo));
  hi.addEventListener('input', () => read(hi));
  paint();

  return h('div.range', {}, h('div.range-head', {}, h('div.caps', {}, label), out), hint ? h('div.hint', {}, hint) : null, track);
}

/* ---------------- job function combo ---------------- */

function jobFunctionSection(draft) {
  const chips = h('div.chip-box');
  const count = h('span.hint');
  const list = h('div.combo-list', { hidden: true });
  const input = h('input', {
    type: 'text',
    placeholder: 'Please select/enter your expected job function',
    autocomplete: 'off',
  });
  let active = 0;
  let items = [];

  const renderChips = () => {
    chips.replaceChildren(
      ...(draft.jobFunctions.length
        ? draft.jobFunctions.map((fn) =>
            h(
              'span.fn-chip',
              { title: fn },
              h('span', {}, fn),
              h(
                'button',
                {
                  type: 'button',
                  title: 'Remove',
                  on: {
                    click: () => {
                      draft.jobFunctions = draft.jobFunctions.filter((f) => f !== fn);
                      renderChips();
                    },
                  },
                },
                '×'
              )
            )
          )
        : [h('span.hint', {}, 'No job function selected — every role is allowed.')])
    );
    count.textContent = `${draft.jobFunctions.length} selected`;
  };

  const add = (name) => {
    const v = String(name || '').trim();
    if (!v) return;
    if (!draft.jobFunctions.some((f) => f.toLowerCase() === v.toLowerCase())) draft.jobFunctions.push(v);
    input.value = '';
    renderChips();
    renderList();
  };

  function renderList() {
    const q = input.value.trim().toLowerCase();
    const selected = new Set(draft.jobFunctions.map((f) => f.toLowerCase()));
    items = JOB_FUNCTIONS.filter((f) => !selected.has(f.toLowerCase()) && (!q || f.toLowerCase().includes(q))).map(
      (f) => ({ label: f, value: f })
    );
    if (q && !JOB_FUNCTIONS.some((f) => f.toLowerCase() === q) && !selected.has(q)) {
      items.push({ label: `Add “${input.value.trim()}” as a title keyword`, value: input.value.trim(), custom: true });
    }
    active = Math.min(active, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...(items.length
        ? items.map((it, i) =>
            h(
              `div.combo-item${it.custom ? '.custom' : ''}${i === active ? '.active' : ''}`,
              { on: { mousedown: (e) => (e.preventDefault(), add(it.value)) } },
              it.label
            )
          )
        : [h('div.combo-item', {}, h('span.hint', {}, 'All job functions are selected'))])
    );
    list.hidden = false;
  }

  input.addEventListener('focus', () => {
    active = 0;
    renderList();
  });
  input.addEventListener('input', () => {
    active = 0;
    renderList();
  });
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      active = Math.min(items.length - 1, active + 1);
      renderList();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      active = Math.max(0, active - 1);
      renderList();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) add(items[active].value);
      else add(input.value);
    } else if (e.key === 'Backspace' && !input.value && draft.jobFunctions.length) {
      draft.jobFunctions.pop();
      renderChips();
      renderList();
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });

  const all = h('button.link-btn', { type: 'button' }, 'Select all');
  all.addEventListener('click', () => {
    const custom = draft.jobFunctions.filter((f) => !JOB_FUNCTIONS.includes(f));
    draft.jobFunctions = [...JOB_FUNCTIONS, ...custom];
    renderChips();
  });
  const none = h('button.link-btn', { type: 'button' }, 'Clear all');
  none.addEventListener('click', () => {
    draft.jobFunctions = [];
    renderChips();
  });

  renderChips();
  return card(
    h('span', {}, 'Job function ', h('span.hint', {}, '(select from drop-down for best results)')),
    chips,
    h('div.combo', {}, input, list),
    h('div.section-actions', {}, all, none, count)
  );
}

/* ---------------- the form ---------------- */

/**
 * @param {HTMLElement} root
 * @param {import('./shared.js').Settings} draft edited in place
 * @param {{ toast?: (msg: string) => void }} [opts]
 */
export function mountSettingsForm(root, draft, { toast = () => {} } = {}) {
  const sections = [];

  /* Job boards */
  const boardCards = h('div.source-grid');
  const renderBoards = () => {
    boardCards.replaceChildren(
      ...SOURCES.map((src) => {
        const input = h('input', { type: 'checkbox', value: src.id, checked: draft.sources.includes(src.id) });
        input.addEventListener('change', () => {
          const next = input.checked ? [...new Set([...draft.sources, src.id])] : draft.sources.filter((x) => x !== src.id);
          if (!next.length) {
            input.checked = true;
            toast('Pick at least one job board.');
            return;
          }
          draft.sources = next;
          renderBoards();
        });
        return h(
          `label.source-card${draft.sources.includes(src.id) ? '.on' : ''}`,
          {},
          input,
          h('span.box'),
          h('span.source-text', {}, h('b', {}, src.label), h('span.hint', {}, src.hint))
        );
      })
    );
  };
  renderBoards();
  sections.push(card('Job boards', boardCards));

  /* Job function */
  sections.push(jobFunctionSection(draft));

  /* Job type */
  sections.push(
    card(
      'Job type',
      h(
        'div.option-grid',
        {},
        ...JOB_TYPES.map((t) =>
          optionTile('checkbox', 'jobType', t.id, t.label, draft.jobTypes.includes(t.id), (e) => {
            draft.jobTypes = e.target.checked
              ? [...new Set([...draft.jobTypes, t.id])]
              : draft.jobTypes.filter((x) => x !== t.id);
          })
        )
      ),
      h('p.hint.note', {}, 'Select none to allow every type. Jobs that don’t state a type are always kept.')
    )
  );

  /* Date posted */
  sections.push(
    card(
      'Date posted',
      h(
        'div.option-grid',
        {},
        ...[ANY_DATE, ...DATE_OPTIONS].map((d) =>
          optionTile('radio', 'datePosted', d.id, d.label, draft.datePosted === d.id, () => {
            draft.datePosted = d.id;
          })
        )
      )
    )
  );

  /* Experience */
  sections.push(
    card(
      'Experience',
      h(
        'div.group',
        {},
        subhead('Seniority', 'Showing every level — select one or more to narrow.'),
        chipGroup(SENIORITY_LEVELS.map((x) => ({ id: x, label: x })), draft.seniority)
      ),
      h(
        'div.group',
        {},
        subhead('Role type', 'Whether the role manages people or contributes hands-on.'),
        chipGroup(ROLE_TYPES.map((x) => ({ id: x, label: x })), draft.roleTypes)
      ),
      h('div.group', {}, rangeSlider('Years of experience — role & industry', null, draft.roleYoe)),
      h(
        'div.group',
        {},
        rangeSlider('Leadership experience', 'Years of management and leadership experience.', draft.leadershipYoe)
      ),
      h('p.hint.note', {}, 'A posting that doesn’t say is never hidden by these filters.')
    )
  );

  /* Security clearance */
  sections.push(
    card(
      'Security clearance',
      subhead(null, 'Showing every level — select one or more to narrow.'),
      chipGroup(CLEARANCES, draft.clearances)
    )
  );

  /* Travel */
  const travelGroup = (key, title, hint) =>
    h('div.travel-group', {}, h('div.caps', {}, title), h('div.hint', {}, hint), chipGroup(TRAVEL_LEVELS, draft[key]));
  sections.push(
    h(
      'section.card.section',
      {},
      travelGroup('airTravel', 'Air travel', 'How much flying the job expects.'),
      travelGroup('landTravel', 'Land travel', 'How much driving or ground travel the job expects.'),
      h('p.hint.note', {}, 'Jobs that never mention travel count as None. Leave a group empty to allow any level.')
    )
  );

  /* Scraping */
  const remote = h('input', { type: 'checkbox', checked: !!draft.remoteOnly });
  remote.addEventListener('change', () => (draft.remoteOnly = remote.checked));

  const scan = h('input', { type: 'checkbox', checked: !!draft.scanEmployerPages });
  scan.addEventListener('change', async () => {
    if (scan.checked) {
      const granted = await chrome.permissions.request({ origins: OPTIONAL_ORIGINS }).catch(() => false);
      if (!granted) {
        scan.checked = false;
        toast('Permission needed to read employer pages.');
        return;
      }
    }
    draft.scanEmployerPages = scan.checked;
  });

  const sort = h(
    'select',
    {},
    ...SORT_OPTIONS.map((o) => h('option', { value: o.id, selected: draft.sortCondition === o.id }, o.label))
  );
  sort.addEventListener('change', () => (draft.sortCondition = sort.value));

  const pages = h('input', { type: 'number', min: 1, max: 200, step: 1, value: draft.maxPages });
  pages.addEventListener('change', () => {
    draft.maxPages = Math.max(1, Math.min(200, Number(pages.value) || DEFAULT_SETTINGS.maxPages));
    pages.value = draft.maxPages;
  });

  const row = (label, hint, control) =>
    h('div.row', {}, h('div.row-label', {}, label, h('span.hint', {}, hint)), control);
  const toggle = (input) => h('label.switch', {}, input, h('span'));

  sections.push(
    h(
      'section.card.section',
      {},
      h('div.section-title', { style: 'margin-bottom: 4px' }, 'Scraping'),
      row('Remote jobs only', 'HiringCafe: workplace Remote · Jobright: work model Remote', toggle(remote)),
      row(
        'Read employer pages for travel',
        'Opens each employer job page in the background to detect travel requirements',
        toggle(scan)
      ),
      row('Feed order', 'Jobright only — the order used when reading your feed', sort),
      row('Pages per run', 'For each job board. Jobright pages hold 20 jobs', pages)
    )
  );

  root.replaceChildren(...sections);
}

/** How many of the narrowing filters differ from "any". */
export function activeFilterCount(s) {
  const narrow = (r) => r[0] > 0 || r[1] < MAX_YEARS;
  return [
    s.jobFunctions.length > 0 && s.jobFunctions.length < JOB_FUNCTIONS.length,
    s.jobTypes.length > 0,
    s.datePosted !== 'any',
    s.seniority.length > 0,
    s.roleTypes.length > 0,
    narrow(s.roleYoe),
    narrow(s.leadershipYoe),
    s.clearances.length > 0,
    s.airTravel.length > 0,
    s.landTravel.length > 0,
    s.remoteOnly,
  ].filter(Boolean).length;
}
