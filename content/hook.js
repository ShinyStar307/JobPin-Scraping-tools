/**
 * Runs in the page's MAIN world at document_start.
 * Mirrors Jobright's own job-list responses (fetch + XHR) to the isolated content script,
 * so whatever the user scrolls through is captured with full apply-link data.
 */
(() => {
  if (window.__jrHookInstalled) return;
  window.__jrHookInstalled = true;

  const WATCH_RE = /\/swan\/|\/_next\/data\//;

  const post = (url, text) => {
    try {
      window.postMessage({ __jrHook: true, url: String(url), text }, location.origin);
    } catch {
      /* ignore */
    }
  };

  const forwardIfJobs = (url, text) => {
    if (typeof text === 'string' && text.includes('"jobResult"')) post(url, text);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function jrFetch(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : input?.url || '';
        if (WATCH_RE.test(url)) {
          res
            .clone()
            .text()
            .then((t) => forwardIfJobs(url, t))
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };
  }

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;

  XHR.open = function jrOpen(method, url, ...rest) {
    this.__jrUrl = String(url || '');
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.send = function jrSend(...args) {
    if (WATCH_RE.test(this.__jrUrl || '')) {
      this.addEventListener('load', () => {
        try {
          let text = '';
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') text = JSON.stringify(this.response);
          forwardIfJobs(this.__jrUrl, text);
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.apply(this, args);
  };
})();
