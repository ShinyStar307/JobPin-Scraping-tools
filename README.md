# JobPin — employer-direct jobs from HiringCafe & Jobright (Chrome extension)

JobPin is a Manifest V3 Chrome extension. A pinned **side panel** and a full-page **Inbox** collect jobs
from **HiringCafe** and **Jobright** whose Apply button goes to the hiring company's own career page or
ATS (Greenhouse, Ashby, Workday, Lever, iCIMS, …). Jobs that only link to LinkedIn, Jobright itself or
other job boards are skipped, and the same posting found on both boards is kept once.

- **Version:** 3.0.0 · **Requires:** Chrome 116+ (side panel API)
- **No build step, no dependencies, no backend.** Plain ES modules; load the folder as-is.
- **Everything stays in your browser** (`chrome.storage.local`). The only network requests are to the two
  job boards and, optionally, to employer pages for travel detection (see [Privacy](#privacy-and-permissions)).

## Contents

[How it works](#how-it-works) · [Job boards](#job-boards) · [ATS](#ats) · [Filters](#filters) ·
[Applied jobs](#applied-jobs) · [Inbox](#inbox-full-view) · [Travel](#travel) · [Install](#install) ·
[Use](#use) · [Privacy and permissions](#privacy-and-permissions) · [Data and limits](#data-and-limits) ·
[Architecture](#architecture) · [Files](#files) · [Tests](#tests) · [Limitations](#known-limitations) ·
[Troubleshooting](#troubleshooting)

## How it works

```
 Side panel / Inbox ──(JR_UI messages)──▶ background.js (service worker)
                                            │  one "session", one status line per board
        ┌───────────────────────────────────┼───────────────────────────────────┐
        ▼                                                                       ▼
 HiringCafe: hiringcafe.js                                         Jobright: jobright.js + content scripts
 /_next/data/<build>/classic.json                                  account filters → /swan/recommend/list/jobs
        │                                                                       │
        └──────────────▶  commitJobs()  ◀───────────────────────────────────────┘
                 skip applied · classify apply link · dedup by apply link ·
                 detect travel · store (jr_jobs, jd:<id>, jr_seen)
                                  │
                                  ▼
                 chrome.storage.local ──▶ side panel + Inbox re-render live
```

1. **Start** (side panel) creates a fresh session and starts each selected board side by side.
2. Each board's jobs are normalised to one record shape (`id`, `source`, `title`, `company`, `applyUrl`,
   `ats`, `postedAtMs`, `isRemote`, seniority / role type / years / clearance, `description`, …).
3. `commitJobs()` in `background.js` is the single ingestion point for both boards. For every job it:
   1. drops it if you already **applied** (same id, or same apply link from the other board);
   2. drops it if it has no apply link (Jobright: asks the tab for the job's detail page first);
   3. skips ids it has already seen (only refreshing the stored record);
   4. classifies the apply link — only `employer` is kept; LinkedIn, Jobright (incl. Easy Apply), known
      job boards and missing links are counted under *Skipped*;
   5. drops a duplicate whose apply link (`jobKey`) is already listed from the other board;
   6. classifies **travel** from the description and stores the job (newest first, capped at 1,500).
4. Filters are applied **at display time** in the side panel and Inbox, so changing a filter never
   requires another scrape.
5. All read-modify-write work on storage goes through one promise queue (`serial()`), so concurrent pages,
   travel scans and UI actions can't overwrite each other.

## Job boards

| Board | How it is read | Needs |
|-------|----------------|-------|
| **HiringCafe** | Its public search data (`/_next/data/<build>/classic.json`), page by page, newest first. If Cloudflare refuses a plain request, a background HiringCafe tab is opened and the same request is made from inside it. | Nothing — no sign-in |
| **Jobright** | Your signed-in feed (`/swan/recommend/list/jobs`, 20 per page) paged by the content script, plus live capture of whatever you scroll past (`content/hook.js`). First the filters saved on your Jobright account are made the ones in the Filters panel (see below). | Be signed in at jobright.ai |

Pick one or both in the side panel (or under *Job boards* in the filters). They run side by side, each
with its own status line (`crawling` → `done` / `error`, or `listening` for Jobright when you used your
own tab).

### How a Jobright run goes

1. Uses a jobright.ai tab you already have open, or opens one in the background (and closes it when the
   feed has been read).
2. Reads the filters saved on your Jobright account (`/swan/filter/get/filter`) and compares them with the
   Filters panel. When they differ, the filter in use (`/swan/filter/saved/list`) is updated
   (`/swan/filter/saved/{id}/update`) and read back to confirm. If Jobright won't take them, the run stops
   rather than read the feed through the wrong filters.
3. Reads the feed 20 jobs at a time, 1.5 s apart; a failed page is retried after 3 s, then 8 s (being
   signed out is not retried). The first page asks Jobright to rebuild the list (`refresh=true`) only
   after the filters were changed. A short page is the last one; with *Most recent* sorting the run also
   stops once a whole page is older than *Date posted*.
4. Keeps only jobs whose Apply link is an employer's own page or ATS.
5. If you started from your own Jobright tab, the extension keeps listening afterwards: jobs you scroll
   past are still captured (`content/hook.js` wraps `fetch` / `XMLHttpRequest` in the page's own world and
   forwards responses that contain `jobResult`). Jobs with no apply link in the list are fetched one at a
   time from `/jobs/info/<id>`.

> **Heads-up — this changes your Jobright account.** To read the feed through the right filters, JobPin
> *edits the saved filter in use on your Jobright account* (everything it doesn't manage is sent back
> unchanged). Expect the filters you see on jobright.ai to match JobPin's panel after a run.

What is set on the account: job type, experience level (our *Senior Level* = Senior + Lead/Staff +
Director), Remote, *Past 3 days* (when Date posted is 24 h or 3 days), *No Security Clearance* (when only
"No explicit reference to clearance" is ticked), US, and job functions (only when you picked a subset
that Jobright has ids for). Anything the panel leaves at "any" is left as it is on your account, and
every filter still applies to the jobs after they are read.

### How a HiringCafe run goes

`buildId` is read from `/classic` (`__NEXT_DATA__`), then
`/_next/data/<buildId>/classic.json?searchState=…&page=N` is requested newest first, 1.5 s between pages,
retries after 3 s and 8 s. A `404` (new site deploy) triggers one build-id refresh. If the direct request
is blocked (403 / 429 / 503 / anti-bot HTML), the run continues from the page it stopped at inside a
background HiringCafe tab, which is closed afterwards. HiringCafe hands over the **full posting text**, so
no employer page needs to be opened for travel detection.

The search state always asks for the **United States**, sorted by date, and adds only filters that
actually narrow: remote, job types (when fewer than all five), seniority, role type, clearance, and the
two years-of-experience ranges.

Both boards read at most **Max pages** pages per run (default 30, range 1–200).

## ATS

Every job's apply link is matched to the system behind it (Greenhouse, Ashby, Workday, Lever, iCIMS,
SmartRecruiters, Workable, Jobvite, BambooHR, ADP, Oracle, SuccessFactors, Taleo, Paylocity, UKG,
Rippling, Breezy, JazzHR, Recruitee, Teamtailor, Personio, Pinpoint, Avature, BrassRing, Cornerstone,
Dayforce, Eightfold, … or *Company site*). HiringCafe's own label wins when it gives one. The Inbox's
**ATS picker** lists each with a live count and lets you tick several. The table lives in `ats.js`; add a
`[id, host regex]` row (and optionally a display label) to teach it a new system.

## Filters

All filters apply to stored jobs instantly — changing them never requires re-scraping — and the ones a
board can search on are also sent with the next run.

| Filter | Notes |
|--------|-------|
| Job function | Matched against the job title with a regex per function (`JOB_FUNCTION_MATCHERS` in `shared.js`). |
| Job type | Full time, Part time, Contract, Internship, Temporary. |
| Date posted | 24 h … 3 years, or any time (default **24 h**). |
| Seniority | No prior experience · Entry · Mid · Senior (Senior includes Lead/Staff/Director). |
| Role type | Individual Contributor / People Manager. |
| Years of experience, Leadership experience | Range sliders, 0–20+. |
| Security clearance | None, Confidential, Secret, Top Secret, TS/SCI, Public Trust, Interim, Other. |
| Air / Land travel | None, Minimal, Moderate, Extensive (default **None** for both). |
| Remote only | Default **on**. |
| Sort (Jobright), Max pages, Scan employer pages | Run options; saved with the other settings. |

**Defaults:** HiringCafe + Jobright, all job functions, full-time / contract / part-time, past 24 hours,
remote only, no air or land travel.

A posting that doesn't state a value (seniority, role type, years, clearance, job type) is never hidden by
that filter. Seniority, role type, years and clearance come from the board when it provides them, and
otherwise are read from the title and description (`attributes.js`).

## Applied jobs

Once you've applied, the job leaves the Inbox and the side panel, **never comes back in a later run**, and
is kept in its own **Applied** list.

- **Mark applied** — the ✓ button on a job (or **A** in the Inbox, or the button in the side panel). It
  moves at once, with an **Undo** toast.
- **Did you apply?** — JobPin can't see what you do on an employer's site, so when you open a job's apply
  link from JobPin it asks afterwards (a banner at the top of the Inbox and the side panel): **Yes, I
  applied** or **Not yet**.
- **Never again** — runs skip a job you applied to, whether it comes back with the same id or as the same
  posting from the other board (matched by its apply link, ignoring tracking parameters but not the ones
  that name the job, like `gh_jid`). Skipped ones are counted under *Skipped* in the side panel; no detail
  request or travel scan is spent on them.
- **Kept safe** — the Applied list is separate from the collected jobs, so *Clear list* and the 1,500-job
  cap never touch it. A job is always in exactly one of the two lists (they're saved in one write, and a
  service-worker restart repairs any overlap).
- **Applied view** — the *Applied* tab in the Inbox (also reached from the side panel's Applied tab):
  grouped by day, searchable, with Today / 7 days / All-time / Companies counts, **Export CSV** (with the
  applied date) and **Move back to Inbox** (**U**) if you marked one by mistake.
- **Same company** — a job at a company you've already applied to is tagged *Applied here*, and its detail
  lists those applications, so a second application is a choice, not an accident.

### How a posting's identity (`jobKey`) is worked out

`host + path + query`, lower-cased, without `www.`, a trailing slash or the fragment. Tracking parameters
(`utm_*`, `gclid`, `fbclid`, `gh_src`, `lever-source`, `trk*`, …) are dropped; parameters that name the
job (`gh_jid`, `jobId`, numeric `ref=48213`) are kept; `source=jobright` is dropped but a numeric
requisition number is kept.

## Inbox (full view)

Side panel → **⤢**. Search (comma = OR, matches title, company and normalised title), *hide titles
starting with*, board tabs with counts, ATS picker, sort, and an **Ignore filters** switch. Click a job to
read the full description, facts (seniority, role type, experience, clearance), travel, and to open the
apply link. **Filters** opens the same form as the side panel's settings, in a drawer. Results are paged
50 at a time.

| Key | Action |
|-----|--------|
| ↑ / ↓ | Move through the list |
| **A** | Mark the selected job applied |
| **O** | Open its apply page |
| **U** | Move an applied job back to the Inbox |
| Esc | Close pop-ups |

**Export CSV** exports the jobs currently listed: source, ATS, company, title, job type, work model,
location, salary, seniority, role type, experience, leadership, clearance, air / land travel, posted
date, apply URL, company site and listing URL (plus the applied date in the Applied view).
Your search / sort / view choices are remembered (`jr_board`). The look follows your system's light or
dark theme.

The side panel is the compact version: status per board, **Start / Stop**, counters (*Matched*,
*Applied*, *Collected*, *Skipped*), the 40 newest matching jobs, a **Clear list** button and settings.

## Travel

There's no travel field on either board. JobPin reads the description (HiringCafe's is full; for
Jobright it reads the employer job page — an optional permission — and Workday through its JSON endpoint)
and classifies **air** and **land** travel as None / Minimal / Moderate / Extensive from phrases like
"up to 25% travel" or "valid driver's license". Postings that never mention travel count as **None**.

How the classifier decides (`classifyTravel` in `shared.js`):

- Text is split into sentences; each sentence is tested for *land* cues (driver's licence, own vehicle,
  mileage, local / regional travel), *air* cues (fly to, international travel, overnight travel) and
  generic "travel as a requirement" wording. Industry phrases ("travel industry", "travel perks") and
  lists such as "benefits, travel & …" are ignored.
- Level: `0%` / "no travel" → none; `≤15%` → minimal; `≤40%` → moderate; above → extensive. Without a
  percentage, words like *occasional / minimal / rarely* → minimal, *frequent / extensive / weekly* →
  extensive, anything else → moderate.
- Generic travel counts as air travel; land travel is only set by land cues. The most demanding mention
  per kind wins, and the matching sentence is kept as a snippet.

Employer-page scanning runs two pages at a time, in the background, for jobs that don't have the full
text yet (up to 12 s and 2.5 MB per page). Pages that can't be read are marked *unreadable* and treated as
"travel not stated". Turn it off with **Scan employer pages** in the settings. (The service worker also
accepts a `rescanTravel` message that re-queues every job, but no button uses it yet.)

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Pin the extension; clicking its icon opens the side panel.
3. After pulling changes, press the reload icon on the extension card (the service worker is a module).

## Use

1. (Jobright only) sign in at [jobright.ai](https://jobright.ai/).
2. Side panel → pick job boards → **⚙** to set filters → **Save**.
3. **Start scraping**. Allow "read employer pages" if prompted (Jobright travel detection).
4. Watch results arrive in the panel, or open the **Inbox** (⤢).
5. Open a job's apply link, answer the *Did you apply?* prompt, and the job moves to **Applied**.

**Stop** cancels both boards (and closes a Jobright tab the extension opened itself). Closing the Jobright
tab you started from also stops its run.

## Privacy and permissions

| Permission | Why |
|------------|-----|
| `storage`, `unlimitedStorage` | Jobs, descriptions, applied list, settings and session are kept in `chrome.storage.local`. |
| `sidePanel` | The pinned panel; clicking the toolbar icon opens it. |
| `tabs`, `scripting` | Find / open a Jobright or HiringCafe tab and run the board requests from inside it (so your session cookies are used). |
| Host: `jobright.ai`, `hiringcafe.com`, `hiring.cafe` | Read the two boards; content scripts run only on `jobright.ai`. |
| Optional host: all `http(s)` sites | Requested **only** if *Scan employer pages* is on, to read apply pages for travel. Declining just turns scanning off. |

- No analytics, no remote server, no account of its own. Your Jobright session is used only from inside
  your own jobright.ai tab.
- The extension never submits an application and never clicks Apply for you.
- Employer-page requests are sent without credentials (`credentials: 'omit'`).

## Data and limits

| Storage key | Content | Limit |
|-------------|---------|-------|
| `jr_jobs` | Collected (Inbox) jobs, newest first | **1,500** (oldest dropped, with their descriptions) |
| `jd:<job id>` | One job's description (kept apart so the list stays light) | Removed with the job |
| `jr_seen` | Ids already processed (so jobs aren't re-evaluated) | Last **8,000** |
| `jr_applied` | Applied jobs | No cap; not touched by *Clear list* |
| `jr_settings`, `jr_session`, `jr_board` | Filters / run options, live status & counters, Inbox view prefs | — |

*Clear list* empties `jr_jobs`, `jr_seen` and the counters — not the applied list. Moving a job back from
Applied makes room for it by dropping the oldest Inbox job if the cap is reached.

Pacing: 1.5 s between pages, retries after 3 s and 8 s, 0.9 s between Jobright detail lookups, two
employer pages at once. These are deliberately gentle; keep them that way to avoid getting blocked.

## Architecture

- **Service worker (`background.js`)** owns all writes: ingestion, applied bookkeeping, travel scans,
  tab management, and the `JR_UI` / `JR_*` message API used by the pages and content scripts. On start-up
  it clears stale "scanning" markers, heals any job present in both lists, and marks a HiringCafe run that
  died with the worker as *interrupted*.
- **Content scripts (`content/*.js`)** are plain scripts (no `import`). `hook.js` runs in the page's
  `MAIN` world; `jobright.js` runs in the isolated world, pages the feed and relays captured jobs.
  `jobright.js` (root) and the content script intentionally duplicate the paging constants because content
  scripts can't import modules — keep them in sync.
- **Pages (`sidepanel.*`, `board.*`)** are read-only views over `chrome.storage.local`; they re-render on
  `storage.onChanged` and ask the worker to change anything.
- **Pure modules** (`shared.js`, `attributes.js`, `ats.js`, `text.js`) have no network or DOM access, which
  is what makes them easy to test and reuse.

Message types: `JR_UI` (`start`, `stop`, `clear`, `saveSettings`, `markApplied`, `unmarkApplied`,
`linkOpened`, `ackOpened`, `rescanTravel`, `openFullView` — `rescanTravel` has no UI button yet), `JR_ITEMS`, `JR_IDS`, `JR_CRAWL`, and from the
worker to the tab `JR_PING`, `JR_START`, `JR_STOP`, `JR_FETCH_DETAIL`.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, side panel, content scripts, host permissions |
| `background.js` | Session per board, ingestion, employer-only filter, dedup, descriptions, HiringCafe crawl, travel scan, applied lists, message API |
| `hiringcafe.js` | HiringCafe search state, paging, retry, Cloudflare tab fallback, job normalising |
| `jobright.js` | Jobright account filters: wanted vs saved, update, confirm |
| `ats.js` | Apply-link → ATS table, aliases, labels |
| `attributes.js` | Job type / seniority / role type / experience / clearance vocab and detection |
| `text.js` | HTML → text helpers |
| `shared.js` | Settings, sources, job functions, filters, search, URL & travel classification, Jobright normalising, applied-job identity (`jobKey`) |
| `settings-form.js` | The filters form (side panel and Inbox drawer) |
| `content/hook.js`, `content/jobright.js` | Jobright feed capture and paging |
| `sidepanel.*` | Pinned panel: boards, status, stats, matched jobs, settings |
| `board.*` | Inbox (new tab) |
| `ui.css`, `ui-common.js` | Purple theme (light and dark), icons, toast, shared UI helpers |
| `tests/applied.test.mjs` | Applied-jobs behaviour through the real service worker (fake `chrome`) |

## Tests

Requires Node 20+ (no packages to install):

    node --experimental-default-type=module --test tests/

Covers marking / moving back, exclusion from later runs (by id and by apply link), *Clear list*, the
"Did you apply?" bookkeeping, opening the Applied view directly, and `jobKey` (tracking noise ignored,
job-naming parameters kept). All 12 tests pass.

Not covered by automated tests: the board crawlers, travel classification, filters and the UI — verify
those manually in Chrome after changes.

## Known limitations

- **Unofficial endpoints.** Both boards are read through the endpoints their own websites use. A change on
  their side (new build id handling, response shape, anti-bot rules, sort codes) can break a run; the
  status line says which board failed and why.
- **Jobright filters are edited on your account** (see above), and only *Past 3 days* is known to be
  accepted as a server-side date filter. Other dates, and job functions without a Jobright id, are applied
  to the results locally instead.
- **United States only** — both boards are searched with country = US.
- **Job-function filter is title-based.** With a subset of functions selected, a job whose title matches
  none of them is hidden. With the default "all functions" the stored filter is still evaluated, so
  unusual titles may not show unless you use **Clear all** (no function filter) or the Inbox's
  *Ignore filters* switch.
- **Travel detection is heuristic** (regexes over text). It can miss or misread unusual wording, and
  pages rendered purely client-side can't be read (except Workday), so those show travel as not stated.
- **A HiringCafe run does not survive a service-worker restart**; press Start again to continue.
- **Apply-link detection** treats anything not on the LinkedIn / Jobright / job-board lists as an
  employer page; a new aggregator not in `shared.js` (`JOB_BOARD_DOMAINS`) would slip through until added.
- Inbox is capped at 1,500 jobs; the oldest are dropped first.

## Troubleshooting

| Symptom | What to do |
|---------|------------|
| "Jobright says you are not signed in" | Sign in at jobright.ai, then press Start again. |
| "Could not reach the Jobright tab" | Reload the Jobright tab (content scripts are injected on demand) and press Start. |
| "Jobright didn't take / keep the wanted filters" | Set the listed filters on jobright.ai by hand, then Start again. |
| "HiringCafe didn't answer … anti-bot check" | Open hiringcafe.com once, pass its check, then press Start again. |
| "stopped at page N" | HiringCafe or Jobright rate-limited the run; kept jobs are saved — run again later. |
| Fewer jobs than expected | Check *Skipped* in the side panel (LinkedIn / Jobright / board links / no link / duplicates / applied) and try **Ignore filters** in the Inbox. |
| Travel shows "None" everywhere | Allow *read employer pages* (Jobright jobs) or check that *Scan employer pages* is on, then run again. |
| Changes to the code don't show | Reload the extension on `chrome://extensions`. |
