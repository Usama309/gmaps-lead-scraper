/**
 * Observe the pb parameter on Google's own search request.
 *
 * TWO PLATFORM CONSTRAINTS SHAPE THIS ENTIRE FILE, and both were found by review
 * after an earlier version that violated both:
 *
 * 1. NO IMPORTS. Content scripts declared in the manifest are injected as CLASSIC
 *    scripts. There is no manifest key to mark one as a module, and this project
 *    has no build step, so an import statement here throws a SyntaxError at
 *    injection time and NOTHING in the file runs. The message type below is
 *    therefore duplicated from src/core/messages.js, and a test asserts the two
 *    never drift apart.
 *
 * 2. NO chrome.* APIS. This runs in world MAIN, which is the page's own JavaScript
 *    realm, and Chrome does not inject extension bindings there. chrome.runtime is
 *    undefined. The only way out is window.postMessage, picked up by bridge.js
 *    running in the isolated world where chrome.* does exist.
 *
 * Running in MAIN is not optional: the isolated world has its own window.fetch, so
 * a patch installed there would observe nothing the page does.
 */
(() => {
  'use strict';

  // Must equal MSG.CAPTURE_PB in src/core/messages.js. Duplicated because this
  // file cannot import. tests/messages.test.js asserts they match.
  const CAPTURE_PB = 'mapprospector/capture-pb';
  const PATCH_FLAG = '__mapProspectorPatched';
  const SEARCH_PATH = '/search';
  const MIN_PB_LENGTH = 50;

  let capturedPb = null;

  /**
   * Never throws. This runs inside Google's own fetch path on every request the
   * page makes, so an escaping error would break Maps in the operator's browser.
   */
  function remember(urlString) {
    try {
      const url = new URL(urlString, location.origin);
      if (!url.pathname.startsWith(SEARCH_PATH)) return;
      if (url.searchParams.get('tbm') !== 'map') return;

      const pb = url.searchParams.get('pb');
      if (!pb || pb.length <= MIN_PB_LENGTH || pb === capturedPb) return;

      capturedPb = pb;
      window.postMessage({ type: CAPTURE_PB, pb, href: location.href }, location.origin);
    } catch {
      // A URL we cannot parse, or a torn-down context. Swallowed deliberately.
    }
  }

  function installObservers() {
    // Chrome can run a document_start script more than once on a soft navigation,
    // and patching a patch builds an ever-deeper call chain on every request.
    if (window[PATCH_FLAG]) return;

    const nativeFetch = window.fetch;
    const nativeOpen = XMLHttpRequest.prototype.open;

    function observedFetch(input, init) {
      const target = typeof input === 'string' ? input : input?.url;
      if (target) remember(target);
      return nativeFetch.call(this, input, init);
    }

    function observedOpen(method, url, ...rest) {
      if (url) remember(url);
      return nativeOpen.call(this, method, url, ...rest);
    }

    if (typeof nativeFetch === 'function') window.fetch = observedFetch;
    if (typeof nativeOpen === 'function') XMLHttpRequest.prototype.open = observedOpen;

    Object.defineProperty(window, PATCH_FLAG, {
      value: { nativeFetch, nativeOpen, observedFetch, observedOpen },
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }

  function removeObservers() {
    const saved = window[PATCH_FLAG];
    if (!saved) return;

    // Only restore what is still ours. If the page has re-wrapped fetch since,
    // blindly restoring the native function would discard the page's own patch.
    if (window.fetch === saved.observedFetch) window.fetch = saved.nativeFetch;
    if (XMLHttpRequest.prototype.open === saved.observedOpen) {
      XMLHttpRequest.prototype.open = saved.nativeOpen;
    }
    delete window[PATCH_FLAG];
  }

  // bfcache suspends the page and fires pagehide, then fires pageshow on restore.
  // Without the pageshow half, a restored tab silently loses capture until a hard
  // reload, and the operator would see a search that harvests nothing.
  window.addEventListener('pagehide', removeObservers);
  window.addEventListener('pageshow', installObservers);

  installObservers();
})();
