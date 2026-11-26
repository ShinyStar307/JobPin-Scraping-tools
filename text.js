/**
 * HTML → text helpers shared by the service worker and the pages. No network, no DOM.
 */

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n)));
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

/**
 * Flat, sentence-friendly text (used by the travel classifier).
 * Block boundaries become ". " so one list item never bleeds into the next sentence.
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/\\u003c/gi, '<')
      .replace(/\\u003e/gi, '>')
      .replace(/<script(?![^>]*(application\/(ld\+)?json|__NEXT_DATA__))[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<(style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '. ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Readable text that keeps paragraphs and bullet points (used for the job description pane).
 */
export function htmlToReadable(html) {
  const src = String(html ?? '');
  if (!/<[a-z][\s\S]*>/i.test(src)) return tidy(decodeEntities(src));
  return tidy(
    decodeEntities(
      src
        .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<li[^>]*>/gi, '\n- ')
        .replace(/<\/(p|div|h\d|ul|ol|tr|section|article)>/gi, '\n')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<h\d[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    )
  );
}

function tidy(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
