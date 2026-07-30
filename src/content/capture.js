import { MSG } from '../core/messages.js';

/**
 * Capture a valid `pb` blob from the Maps page's own search request.
 *
 * The blob is opaque and Google-generated. Synthesising one by hand is fragile,
 * so instead we patch `window.fetch` and `XMLHttpRequest.open` to observe the
 * page issuing its own `/search?tbm=map` call and lift the parameter off it.
 *
 * If Maps ever stops making that request, capture fails loudly. That is
 * deliberate: a silent failure here would look like "this city has no businesses".
 */
const SEARCH_PATH = '/search';
const PATCH_FLAG = '__mapProspectorPatched';

let capturedPb = null;

/**
 * Observe a URL without ever being able to break the host page.
 *
 * Everything here runs inside Google Maps' own JavaScript context, on every
 * fetch the page makes. A throw escaping this function would break Maps for the
 * user, so the whole body is guarded and failures are swallowed deliberately.
 */
function remember(urlString) {
  try {
    const url = new URL(urlString, location.origin);
    if (!url.pathname.startsWith(SEARCH_PATH)) return;
    if (url.searchParams.get('tbm') !== 'map') return;

    const pb = url.searchParams.get('pb');
    if (!pb || pb.length <= 50) return;
    if (pb === capturedPb) return; // already have this one

    capturedPb = pb;
    chrome.runtime
      .sendMessage({ type: MSG.CAPTURE_PB, payload: { pb, href: location.href } })
      .catch(() => {
        // The worker may be asleep. We keep the blob locally and answer the
        // direct request below, so a dropped message costs nothing.
      });
  } catch {
    // A URL we cannot parse, or a revoked extension context. Never rethrow:
    // this runs on Google's own fetch path.
  }
}

/**
 * Patch the page's network primitives, once.
 *
 * Guarded against double injection: Chrome can run a document_start content
 * script more than once on a soft navigation, and patching a patch would build
 * an ever-deeper call chain on every Maps request.
 */
function installObservers() {
  if (window[PATCH_FLAG]) return;

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function observedFetch(input, init) {
      const target = typeof input === 'string' ? input : input?.url;
      if (target) remember(target);
      return nativeFetch.call(this, input, init);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  if (typeof nativeOpen === 'function') {
    XMLHttpRequest.prototype.open = function observedOpen(method, url, ...rest) {
      if (url) remember(url);
      return nativeOpen.call(this, method, url, ...rest);
    };
  }

  Object.defineProperty(window, PATCH_FLAG, {
    value: { nativeFetch, nativeOpen },
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

/** Restore the page's own functions. Exposed for teardown and for debugging. */
function removeObservers() {
  const saved = window[PATCH_FLAG];
  if (!saved) return;
  if (saved.nativeFetch) window.fetch = saved.nativeFetch;
  if (saved.nativeOpen) XMLHttpRequest.prototype.open = saved.nativeOpen;
  delete window[PATCH_FLAG];
}

// Restore the page's own functions if it navigates away or the tab is discarded.
window.addEventListener('pagehide', removeObservers, { once: true });

installObservers();

// Answer direct requests from the worker for whatever we have captured so far.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== MSG.CAPTURE_PB) return false;
  respond({
    ok: Boolean(capturedPb),
    data: { pb: capturedPb },
    error: capturedPb ? null : 'no search parameters captured yet',
  });
  return true;
});
