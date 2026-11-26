/**
 * Isolated-world content script on jobright.ai.
 * - Relays job lists captured by content/hook.js (MAIN world).
 * - Pages through Jobright's own feed API (/swan/recommend/list/jobs) using the user's session.
 * - Fetches /jobs/info/<id> as a fallback when an item has no apply link.
 * Plain script: content scripts cannot use static imports.
 */
(() => {
  if (window.__jrContentLoaded) return;
  window.__jrContentLoaded = true;

  // Same pacing as the HiringCafe run (and the same numbers as jobright.js, which can't be imported here).
  const PAGE_SIZE = 20;
  const PAGE_DELAY_MS = 1500;
  const RETRY_DELAYS_MS = [3000, 8000];
  const OK_CODE = 10000;

  let crawlToken = 0;

  /** Find every { jobResult: { jobId } , companyResult? } object inside an API payload. */
  function extractItems(payload) {
    const out = [];
    const stack = [payload];
    let guard = 0;
    while (stack.length && guard < 200000) {
      guard += 1;
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      if (cur.jobResult && typeof cur.jobResult === 'object' && cur.jobResult.jobId) {
        out.push({ jobResult: cur.jobResult, companyResult: cur.companyResult || null });
        continue;
      }
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
    return out;
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  }

  function forwardItems(items, source) {
    if (items.length) send({ type: 'JR_ITEMS', items, source });
  }

  /* ---------- passive capture from the page's own requests ---------- */

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__jrHook !== true) return;
    try {
      forwardItems(extractItems(JSON.parse(ev.data.text)), 'page');
    } catch {
      /* ignore non-JSON */
    }
  });

  function captureNextData(doc) {
    const el = doc.getElementById('__NEXT_DATA__');
    if (!el?.textContent) return [];
    try {
      return extractItems(JSON.parse(el.textContent));
    } catch {
      return [];
    }
  }

  /* ---------- active crawl through the feed API ---------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Jobright's client still labels sorts RELEVANCE / FRESHNESS / MATCH_SCORE,
   * then sends the numeric enum: 0 Recommended, 1 Most recent, 2 Top matched.
   * The string form is rejected with HTTP 400.
   */
  const SORT_CONDITION_PARAM = {
    RELEVANCE: '0',
    RECOMMENDED: '0',
    FRESHNESS: '1',
    MOST_RECENT: '1',
    MATCH_SCORE: '2',
    TOP_MATCHED: '2',
    0: '0',
    1: '1',
    2: '2',
  };

  function feedSortCondition(value) {
    const key = String(value ?? 'FRESHNESS').trim().toUpperCase();
    return SORT_CONDITION_PARAM[key] || '1';
  }

  /**
   * One page of the signed-in feed. `refresh` makes Jobright rebuild the list: only the first page of a
   * run that has just changed the account's saved filters asks for it.
   */
  async function fetchFeedPage(sortCondition, position, refresh) {
    const qs = new URLSearchParams({
      refresh: String(refresh),
      sortCondition: feedSortCondition(sortCondition),
      position: String(position),
      count: String(PAGE_SIZE),
      syncRerank: 'false',
    });
    const res = await fetch(`/swan/recommend/list/jobs?${qs}`, {
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*', 'X-Client-Type': 'web' },
    });
    if (res.status === 401 || res.status === 403) throw new Error('not_logged_in');
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.errorMsg || body?.message || '';
      } catch {
        /* non-JSON error page */
      }
      throw new Error(detail ? `http_${res.status} ${detail}` : `http_${res.status}`);
    }
    const json = await res.json();
    if (!json || json.success === false || (json.errorCode != null && json.errorCode !== OK_CODE)) {
      throw new Error(json?.errorMsg || `api_error_${json?.errorCode ?? ''}`);
    }
    return extractItems(json);
  }

  /** A page that fails is tried again after 3 s, then 8 s; being signed out is not retried. */
  async function fetchFeedPageWithRetry(sortCondition, position, refresh, token) {
    let lastError;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt) {
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        if (token !== crawlToken) return null;
      }
      try {
        return await fetchFeedPage(sortCondition, position, refresh);
      } catch (e) {
        lastError = e;
        if (String(e?.message) === 'not_logged_in') break;
      }
    }
    throw lastError;
  }

  async function crawl(opts) {
    const token = ++crawlToken;
    const sortCondition = opts.sortCondition || 'FRESHNESS';
    const maxPages = Math.max(1, Math.min(200, Number(opts.maxPages) || 30));
    const cutoffMs = Number(opts.cutoffMs) || 0;
    const refresh = opts.refresh === true;

    const seen = new Set();
    let position = 0;
    let total = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      if (token !== crawlToken) return;
      let items;
      try {
        items = await fetchFeedPageWithRetry(sortCondition, position, refresh && page === 1, token);
      } catch (e) {
        send({ type: 'JR_CRAWL', status: 'error', page, total, error: String(e?.message || e) });
        return;
      }
      if (token !== crawlToken || !items) return;

      const fresh = items.filter((it) => !seen.has(it.jobResult.jobId));
      fresh.forEach((it) => seen.add(it.jobResult.jobId));
      total += fresh.length;
      forwardItems(fresh, 'api');
      send({ type: 'JR_CRAWL', status: 'progress', page, total });

      if (!fresh.length) break;
      // A short page is the last one (the feed is read 20 at a time).
      if (items.length < PAGE_SIZE) break;

      if (cutoffMs && sortCondition === 'FRESHNESS') {
        const allOld = fresh.every((it) => {
          const t = it.jobResult.publishTime;
          const ms = t ? Date.parse(`${String(t).replace(' ', 'T')}Z`) : NaN;
          return Number.isFinite(ms) && ms < cutoffMs;
        });
        if (allOld) break;
      }

      position += items.length;
      await sleep(PAGE_DELAY_MS);
    }

    if (token === crawlToken) send({ type: 'JR_CRAWL', status: 'done', total });
  }

  /* ---------- DOM fallback: job ids visible in the page ---------- */

  function visibleJobIds() {
    const ids = new Set();
    document.querySelectorAll('a[href*="/jobs/info/"]').forEach((a) => {
      const m = String(a.getAttribute('href') || '').match(/\/jobs\/info\/([a-f0-9]{16,32})/i);
      if (m) ids.add(m[1]);
    });
    return [...ids];
  }

  async function fetchDetail(jobId) {
    const res = await fetch(`/jobs/info/${encodeURIComponent(jobId)}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = captureNextData(doc);
    return items.find((it) => String(it.jobResult.jobId) === String(jobId)) || items[0] || null;
  }

  /* ---------- messages from the service worker ---------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const t = message?.type;

    if (t === 'JR_PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (t === 'JR_START') {
      forwardItems(captureNextData(document), 'page');
      crawl(message.options || {});
      const ids = visibleJobIds();
      if (ids.length) send({ type: 'JR_IDS', ids });
      sendResponse({ ok: true });
      return false;
    }

    if (t === 'JR_STOP') {
      crawlToken += 1;
      sendResponse({ ok: true });
      return false;
    }

    if (t === 'JR_FETCH_DETAIL') {
      fetchDetail(message.jobId)
        .then((item) => sendResponse({ ok: !!item, item }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }

    return false;
  });
})();
