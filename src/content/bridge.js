/**
 * Relay captured search parameters from the page's world to the extension.
 *
 * Exists purely because the two capabilities we need live in different worlds:
 * only a MAIN world script can see the page's own fetch, and only an isolated
 * world script can call chrome.runtime. This file is the isolated half.
 *
 * Also a classic script with no imports, for the same reason as main-world.js.
 */
(() => {
  'use strict';

  // Must equal MSG.CAPTURE_PB in src/core/messages.js. See main-world.js.
  const CAPTURE_PB = 'mapprospector/capture-pb';
  const MIN_PB_LENGTH = 50;

  window.addEventListener('message', (event) => {
    // The page can post messages too, so verify the sender and shape before
    // relaying anything. A forged pb would not leak data, but it would send the
    // harvester somewhere the operator did not ask for.
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;

    const data = event.data;
    if (!data || data.type !== CAPTURE_PB) return;
    if (typeof data.pb !== 'string' || data.pb.length <= MIN_PB_LENGTH) return;

    chrome.runtime.sendMessage({ type: CAPTURE_PB, payload: { pb: data.pb, href: data.href } })
      .catch(() => {
        // The worker may be asleep. The next search re-sends, and the worker also
        // restores its last value from session storage on wake.
      });
  });
})();
