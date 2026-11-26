# JobPin — employer-direct jobs from HiringCafe & Jobright (Chrome extension)

A pinned Chrome **side panel** plus a full-page **Inbox** that collect jobs from **HiringCafe** and
**Jobright** whose Apply button goes to the hiring company's own career page or ATS (Greenhouse, Ashby,
Workday, Lever, iCIMS, …). Jobs that only link to LinkedIn, Jobright itself or job boards are skipped,
and the same posting found on both boards is kept once.

## Job boards

| Board | How it is read | Needs |
|-------|----------------|-------|
| **HiringCafe** | Its public search data (`/_next/data/<build>/classic.json`), page by page, newest first. If Cloudflare refuses a plain request, a background HiringCafe tab is opened and the same request is made from inside it. | Nothing — no sign-in |
| **Jobright** | Your signed-in feed (`/swan/recommend/list/jobs`, 20 per page) paged by the content script, plus live capture of whatever you scroll past (`content/hook.js`). Same method as ZOR: first the filters saved on your Jobright account are made the ones in the Filters panel (see below). | Be signed in at jobright.ai |

Pick one or both in the side panel (or under *Job boards* in the filters). They run side by side, each
with its own status line.

### How a Jobright run goes

1. Uses a jobright.ai tab you already have open, or opens one in the background (and closes it when the
   feed has been read).
2. Reads the filters saved on your Jobright account (`/swan/filter/get/filter`) and compares them with the
   Filters panel. When they differ, the filter in use (`/swan/filter/saved/list`) is updated
   (`/swan/filter/saved/{id}/update`) and read back to confirm. If Jobright won't take them, the run stops
   rather than read the feed through the wrong filters.
3. Reads the feed 20 jobs at a time, 1.5 s apart; a failed page is retried after 3 s, then 8 s. The first page
   asks Jobright to rebuild the list (`refresh=true`) only after the filters were changed. A short page
   is the last one.
4. Keeps only jobs whose Apply link is an employer's own page or ATS (as before).

What is set on the account: job type, experience level (our *Senior Level* = Senior + Lead/Staff +
Director), Remote, *Past 3 days* (when Date posted is 24 h or 3 days), *No Security Clearance* (when only
"No explicit reference to clearance" is ticked), US, and job functions (only when you picked a subset
that Jobright has ids for). Anything the panel leaves at "any" is left as it is on your account, and
every filter still applies to the jobs after they are read.

HiringCafe is read the same way ZOR does it: `buildId` from `/classic`, then
`/_next/data/<buildId>/classic.json?searchState=…&page=N`, newest first, 1.5 s between pages, retries after
3 s and 8 s, and a background HiringCafe tab when the direct request is blocked.

## ATS

Every job's apply link is matched to the system behind it (Greenhouse, Ashby, Workday, Lever, iCIMS,
SmartRecruiters, Workable, BambooHR, ADP, Oracle, SuccessFactors, Taleo, Paylocity, UKG, Rippling, Breezy,
JazzHR, Recruitee, Teamtailor, Personio, … or *Company site*). HiringCafe's own label wins when it gives
one. The Inbox's **ATS picker** lists each with a live count and lets you tick several.

## Filters

All filters apply to stored jobs instantly — changing them never requires re-scraping — and the ones a
board can search on are also sent with the next run.

Job function · Job type · Date posted (24 h … 3 years) · Seniority · Role type · Years of experience ·
Leadership experience · Security clearance · Air / Land travel · Remote only.

A posting that doesn't state a value is never hidden by that filter. Only the hand-picked (narrowing)
filters are sent to HiringCafe.

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
  cap never touch it. A job is always in exactly one of the two lists (they're saved in one write).
- **Applied view** — the *Applied* tab in the Inbox (also reached from the side panel's Applied tab):
  grouped by day, searchable, with Today / 7 days / All-time / Companies counts, **Export CSV** (with the
  applied date) and **Move back to Inbox** (**U**) if you marked one by mistake.
- **Same company** — a job at a company you've already applied to is tagged *Applied here*, and its detail
  lists those applications, so a second application is a choice, not an accident.

## Inbox (full view)

Side panel → **⤢**. Search (comma = OR), *hide titles starting with*, board tabs with counts, ATS picker,
sort, and an **Ignore filters** switch. Click a job to read the full description, facts (seniority, role
type, experience, clearance), travel, and to open the apply link. **Filters** opens the same form as the
side panel's settings, in a drawer. Keyboard: ↑ / ↓ move through the list, **A** marks the job applied,
**O** opens its apply page, **U** moves an applied job back, Esc closes pop-ups. **Export CSV** includes
source and ATS. The look follows your system's light or dark theme.

## Travel

There's no travel field on either board. JobPin reads the description (HiringCafe's is full; for
Jobright it reads the employer job page, optional permission, Workday via its JSON endpoint) and
classifies **air** and **land** travel as None / Minimal / Moderate / Extensive from phrases like
"up to 25% travel" or "valid driver's license". Postings that never mention travel count as **None**.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Pin the extension; clicking its icon opens the side panel.

## Use

1. (Jobright only) sign in at [jobright.ai](https://jobright.ai/).
2. Side panel → pick job boards → **⚙** to set filters → **Save**.
3. **Start scraping**. Allow "read employer pages" if prompted (Jobright travel detection).
4. Watch results arrive in the panel, or open the **Inbox**.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, side panel, content scripts, host permissions |
| `background.js` | Session per board, ingestion, employer-only filter, dedup, descriptions, HiringCafe crawl |
| `hiringcafe.js` | HiringCafe search state, paging, retry, Cloudflare tab fallback, job normalising |
| `jobright.js` | Jobright account filters: wanted vs saved, update, confirm |
| `ats.js` | Apply-link → ATS table |
| `attributes.js` | Seniority / role type / experience / clearance vocab and detection |
| `text.js` | HTML → text helpers |
| `shared.js` | Settings, sources, filters, search, URL & travel classification, applied-job identity (`jobKey`) |
| `settings-form.js` | The filters form (side panel and Inbox drawer) |
| `content/hook.js`, `content/jobright.js` | Jobright feed capture |
| `sidepanel.*` | Pinned panel: boards, status, stats, matched jobs, settings |
| `board.*` | Inbox (new tab) |
| `ui.css`, `ui-common.js` | Purple theme (light and dark), icons, toast, shared UI helpers |
| `tests/applied.test.mjs` | Applied-jobs behaviour through the real service worker (fake `chrome`) |

## Tests

    node --experimental-default-type=module --test tests/

Covers marking / moving back, exclusion from later runs (by id and by apply link), *Clear list*, and the
"Did you apply?" bookkeeping.
