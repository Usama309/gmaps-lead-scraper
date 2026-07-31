import { CONFIG } from '../core/config.js';

/**
 * Attach an anonymous Google session cookie to our own requests, and nothing else.
 *
 * WHY THIS EXISTS. Google drops the review count from the search payload unless the
 * request carries a session cookie. Measured live on 2026-07-30, same pb and same
 * context back to back: cookieless gave 5% coverage on reviewCount, cookie-bearing
 * gave 95%, and no other mapped field moved by more than one record. The canary
 * caught the gap and halted the run, which is the only reason this was found at all.
 *
 * WHY NOT JUST DROP `credentials: 'omit'`. Because that hands Chrome the whole
 * google.com jar, which in the operator's real browser includes their signed-in
 * account. The binding control is "no Google account is attached to any request",
 * and switching to `include` would end it.
 *
 * HOW THIS KEEPS THE CONTROL. The fetch stays `credentials: 'omit'`, so Chrome sends
 * no cookie at all, and the Cookie header is then written from scratch by a
 * declarativeNetRequest rule holding only ALLOWLISTED names. An allowlist is doing
 * real work here: a denylist of known account cookies would silently start leaking
 * the day Google introduces a name nobody listed.
 *
 * Two scoping properties matter as much as the allowlist, and both are verified:
 *   - the rule is SESSION scoped, so it cannot outlive the browser
 *   - the rule matches tabId -1 only, so it never touches Google Maps' own requests
 *     in the operator's tab. Without that it would strip their real session and
 *     break the page they are looking at.
 */

/**
 * Cookie names that carry a signed-in Google account.
 *
 * Deliberately NOT the mechanism that keeps them out: the allowlist already does
 * that, and this list exists only so a test can assert the allowlist holds against
 * concrete real-world names. Treating this as the control would be the denylist
 * mistake the allowlist is here to avoid.
 */
export const ACCOUNT_COOKIE_NAMES = Object.freeze([
  'SID', 'SSID', 'HSID', 'APISID', 'SAPISID', 'LSID',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PAPISID', '__Secure-3PAPISID',
]);

/**
 * A cookie value may not contain anything that could end its own pair.
 *
 * A value carrying `; SID=...` would smuggle a second cookie into a header we
 * promised holds one allowlisted name, defeating the allowlist through the value
 * rather than the name. Rejecting the whole pair is correct: a value we cannot
 * vouch for is not one to send.
 */
function isSafeValue(value) {
  return typeof value === 'string' && value.length > 0 && !/[;,\s\\"]/.test(value);
}

/**
 * Build the Cookie header from an allowlist.
 *
 * Returns null when nothing allowlisted is available, which the caller must treat
 * as "do not install a rule" rather than "send everything".
 */
export function buildCookieHeader(cookies, allow = CONFIG.anonCookie.allow) {
  if (!Array.isArray(cookies)) return null;

  const pairs = [];
  for (const name of allow) {
    const match = cookies.find((c) => c && c.name === name);
    if (!match || !isSafeValue(match.value)) continue;
    pairs.push(`${name}=${match.value}`);
  }

  return pairs.length > 0 ? pairs.join('; ') : null;
}

/**
 * The query marker that identifies a request as ours.
 *
 * The single source of truth for both halves: google-payload.js writes it onto the
 * URL, and the rule below matches on it. If these two ever disagreed the rule would
 * silently match nothing, so neither may hardcode the string.
 */
export function markerParam(config = CONFIG.anonCookie) {
  return { name: config.marker, value: config.markerValue };
}

/** The declarativeNetRequest rule that writes that header onto our own requests. */
export function buildRule(cookieHeader, config = CONFIG.anonCookie) {
  const { name, value } = markerParam(config);
  return {
    id: config.ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      // `set`, never `append`. Appending would add our cookie ALONGSIDE whatever
      // Chrome attached, which is the whole jar the moment anyone relaxes
      // `credentials: 'omit'`, and the allowlist would quietly stop being one.
      requestHeaders: [{ header: 'cookie', operation: 'set', value: cookieHeader }],
    },
    condition: {
      // Host, path AND our own marker. The marker is what makes this precise: it is
      // written by exactly one line of code in this extension, so no request built by
      // anyone else can match, whatever context it comes from.
      urlFilter: `||${new URL(CONFIG.googleSearchUrl).host}${new URL(CONFIG.googleSearchUrl).pathname}?*${name}=${value}`,
      resourceTypes: [...config.resourceTypes],
      tabIds: [config.workerOnlyTabId],
    },
  };
}

/**
 * Install the rule for the duration of a run.
 *
 * Failing to install is FATAL, not advisory, and the caller must treat it that way.
 * An earlier version told the operator "review counts will be missing" and started
 * the run anyway. That was wrong: reviewCount carries a canary coverage floor of
 * 80%, cookieless coverage is about 5%, so the very first page fails the canary and
 * the whole job halts with a payload-drift error that has nothing to do with drift.
 * Better to say so before spending a single request.
 *
 * Never throws, so the caller decides what to do rather than losing the reason.
 */
export async function installAnonCookieRule({ cookies, declarativeNetRequest, config = CONFIG.anonCookie }) {
  try {
    const jar = await cookies.getAll({ url: 'https://www.google.com/' });
    const header = buildCookieHeader(jar, config.allow);

    if (!header) {
      return {
        installed: false,
        reason: `no anonymous Google cookie found (looked for ${config.allow.join(', ')}). `
          + 'Google omits review counts without one, and the payload check then halts the run, '
          + 'so there is nothing to gain by starting. Open Google Maps once and retry.',
      };
    }

    await declarativeNetRequest.updateSessionRules({
      removeRuleIds: [config.ruleId],
      addRules: [buildRule(header, config)],
    });
    return { installed: true };
  } catch (error) {
    return { installed: false, reason: `could not attach the anonymous cookie: ${error?.message ?? String(error)}` };
  }
}

/**
 * Remove the rule.
 *
 * Must run on EVERY path out of a run, including abort and failure. A rule left
 * behind keeps rewriting a header in the operator's browser long after the run they
 * started it with has finished.
 */
export async function removeAnonCookieRule({ declarativeNetRequest, config = CONFIG.anonCookie }) {
  try {
    await declarativeNetRequest.updateSessionRules({ removeRuleIds: [config.ruleId] });
    return { removed: true };
  } catch (error) {
    return { removed: false, reason: error?.message ?? String(error) };
  }
}
