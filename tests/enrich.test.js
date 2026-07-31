import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanHtml, enrichOne, enrichLeads } from '../src/pipeline/enrich.js';
import { makeLead } from '../src/core/schema.js';

/**
 * A page with enough markup to clear CONFIG.enrich.minUsefulHtmlBytes, so the
 * real-content path runs rather than the too-small-to-read shell path. The
 * padding comment is inert: it exists purely to push the byte count up, the way
 * a real page's CSS, tracking scripts and boilerplate would.
 */
function pad() {
  return `<!-- ${'x'.repeat(2500)} -->`;
}

function buildPage(bodyHtml) {
  return `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    </head><body>${bodyHtml}${pad()}</body></html>`;
}

const REAL_PAGE_FIXTURE = buildPage('<p>Welcome to Attock Dental Clinic.</p>');

let n = 0;
function lead(overrides = {}) {
  n += 1;
  return makeLead({ cid: `0xaa${n}:0xbb${n}`, name: `Business ${n}`, ...overrides });
}

// ---------------------------------------------------------------------------
// scanHtml: pure, no network.
// ---------------------------------------------------------------------------

test('a JavaScript-rendered shell is not reported as a site without a booking widget', () => {
  // Measured live: smilecraftbysohail.bolt.host returns 200 and one kilobyte. We
  // fetched it and learned nothing, so the booleans must stay null and the lead
  // must stay provisional. Writing false here is a confident false negative, and it
  // fails in the expensive direction: a client-rendered build is exactly the kind
  // that does carry a booking widget.
  const patch = scanHtml('<!doctype html><html><head></head><body><div id="root"></div><script src="/a.js"></script></body></html>');
  assert.equal(patch.enriched, false);
  assert.equal(patch.hasBooking, null);
  assert.equal(patch.hasChatbot, null);
  assert.equal(patch.mobileFriendly, null);
  assert.equal(patch.websiteTech, 'unknown', 'tech detection still runs; a shell can still name-drop a script src');
});

test('every enrichment field is written, so "no chatbot" never includes an uninspected site', () => {
  const patch = scanHtml(REAL_PAGE_FIXTURE);
  for (const field of ['hasChatbot', 'hasBooking', 'mobileFriendly']) {
    assert.notEqual(patch[field], null, `${field} must be false, not null, once inspected`);
  }
  assert.equal(patch.enriched, true);
});

test('a mailto with a query string yields the address only', () => {
  assert.equal(scanHtml('<a href="mailto:a@b.pk?subject=Hi">m</a>').email, 'a@b.pk');
});

test('an obviously non-contact address is ignored', () => {
  // sentry, wixpress, example.com and image filenames that look like addresses.
  const html = buildPage(`
    <a href="mailto:noreply@sentry.io">error reporting</a>
    <img src="team-photo@2x.png" alt="team">
    <p>Reach the demo site at info@example.com</p>
  `);
  assert.equal(scanHtml(html).email, null);
});

// ---------------------------------------------------------------------------
// enrichOne: fetching, timeouts, failure classification.
// ---------------------------------------------------------------------------

test('a dead domain is a scoring signal, not an error', async () => {
  const patch = await enrichOne({
    lead: { website: 'https://gone.example' },
    fetchPage: async () => { throw Object.assign(new Error('failed'), { name: 'TypeError' }); },
  });
  assert.equal(patch.websiteTech, 'dead');
  assert.equal(patch.enriched, true);
});

test('a timeout is a dead domain, and does not hang the run', async () => {
  const startedAt = Date.now();
  const patch = await enrichOne({
    lead: { website: 'https://slow.example' },
    // AbortSignal.timeout surfaces as a TimeoutError, verified live against Node's fetch.
    fetchPage: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
  });
  assert.equal(patch.websiteTech, 'dead');
  assert.equal(patch.enriched, true);
  assert.ok(Date.now() - startedAt < 1000, 'an immediate fake rejection must not wait on a real timer');
});

test('an unexplained failure leaves the lead unenriched rather than marking it dead', async () => {
  // Marking it dead would score a live business as a 35-point lead forever.
  const patch = await enrichOne({
    lead: { website: 'https://flaky.example' },
    fetchPage: async () => { throw new Error('something unrelated broke'); },
  });
  assert.equal(patch.websiteTech, null);
  assert.equal(patch.enriched, false);
});

test('a 404 or 500 response is a dead domain, the same as an unreachable one', async () => {
  const patch = await enrichOne({
    lead: { website: 'https://gone-but-resolves.example' },
    fetchPage: async () => ({ status: 500, body: '<html></html>' }),
  });
  assert.equal(patch.websiteTech, 'dead');
  assert.equal(patch.enriched, true);
});

test('enrichment fetches send no credentials', async () => {
  // We are not logged in to a prospect's site and must never appear to be.
  const source = await readFile(new URL('../src/pipeline/enrich.js', import.meta.url), 'utf8');
  assert.match(source, /fetch\(url,\s*\{\s*credentials:\s*'omit'/);
});

// ---------------------------------------------------------------------------
// enrichOne, Task 4: email and the two extra pages.
// ---------------------------------------------------------------------------

test('an email on the homepage costs no extra fetch', async () => {
  // A same-origin /contact link is present too, so this only proves the guard
  // works if the implementation would otherwise have somewhere to follow.
  const html = buildPage('<a href="mailto:info@attockdental.pk">Email us</a><a href="/contact">Contact</a>');
  let calls = 0;
  const patch = await enrichOne({
    lead: { website: 'https://attockdental.pk' },
    fetchPage: async () => { calls += 1; return { status: 200, body: html }; },
  });
  assert.equal(patch.email, 'info@attockdental.pk');
  assert.equal(calls, 1, 'a homepage address must not trigger a follow-up fetch');
});

test('a missing email follows contact then about, and stops at two', async () => {
  const homepage = buildPage('<a href="/contact">Contact</a><a href="/about">About</a>');
  const calls = [];
  const patch = await enrichOne({
    lead: { website: 'https://attockdental.pk' },
    fetchPage: async ({ url }) => {
      calls.push(url);
      const body = url === 'https://attockdental.pk' ? homepage : buildPage('<p>No address published.</p>');
      return { status: 200, body };
    },
  });
  assert.equal(patch.email, null);
  // Assert the fetch count, not just the result. The cap is the point.
  assert.deepEqual(calls, [
    'https://attockdental.pk',
    'https://attockdental.pk/contact',
    'https://attockdental.pk/about',
  ]);
});

test('an off-origin contact link is not followed', async () => {
  // Following arbitrary links off a prospect's site is not something this tool does.
  const homepage = buildPage(
    '<a href="https://booking.otherhost.com/contact">Contact</a><a href="/about">About</a>'
  );
  const calls = [];
  const patch = await enrichOne({
    lead: { website: 'https://attockdental.pk' },
    fetchPage: async ({ url }) => {
      calls.push(url);
      const body = url === 'https://attockdental.pk' ? homepage : buildPage('<p>No address published.</p>');
      return { status: 200, body };
    },
  });
  assert.equal(patch.email, null);
  assert.deepEqual(calls, ['https://attockdental.pk', 'https://attockdental.pk/about']);
  assert.ok(!calls.includes('https://booking.otherhost.com/contact'), 'the off-origin link must never be fetched');
});

// ---------------------------------------------------------------------------
// enrichLeads: the batch over a filtered set.
// ---------------------------------------------------------------------------

test('enrichLeads never fetches a lead with no real website', async () => {
  const withSite = lead({ website: 'https://real-clinic.pk' });
  const noSite = lead();

  let calls = 0;
  const { patches, stats } = await enrichLeads({
    leads: [withSite, noSite],
    fetchPage: async () => { calls += 1; return { status: 200, body: REAL_PAGE_FIXTURE }; },
  });

  assert.equal(calls, 1);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].key, withSite.key);
  assert.equal(stats.candidates, 1);
});

test('enrichLeads tallies dead, enriched and unresolved outcomes separately', async () => {
  const ok = lead({ website: 'https://ok.pk' });
  const dead = lead({ website: 'https://dead.pk' });
  const flaky = lead({ website: 'https://flaky.pk' });

  const { stats } = await enrichLeads({
    leads: [ok, dead, flaky],
    // Three distinct domains means two real throttle gaps. Without this, the
    // test would wait on the real 1.2 to 2.8 second default delay twice.
    delay: async () => {},
    fetchPage: async ({ url }) => {
      if (url === 'https://ok.pk') return { status: 200, body: REAL_PAGE_FIXTURE };
      if (url === 'https://dead.pk') throw Object.assign(new Error('x'), { name: 'TypeError' });
      throw new Error('mystery failure');
    },
  });

  assert.equal(stats.enriched, 1);
  assert.equal(stats.dead, 1);
  assert.equal(stats.unresolved, 1);
});

test('enrichLeads stops at an aborted signal and keeps what it already enriched', async () => {
  const a = lead({ website: 'https://a.pk' });
  const b = lead({ website: 'https://b.pk' });
  const controller = new AbortController();

  let calls = 0;
  const { patches } = await enrichLeads({
    leads: [a, b],
    signal: controller.signal,
    fetchPage: async () => {
      calls += 1;
      controller.abort();
      return { status: 200, body: REAL_PAGE_FIXTURE };
    },
  });

  assert.equal(calls, 1, 'the abort must be observed before the second lead starts');
  assert.equal(patches.length, 1);
});

// ---------------------------------------------------------------------------
// enrichLeads, Task 5: the throttle and the domain cache.
// ---------------------------------------------------------------------------

test('two leads sharing a domain cost one fetch', async () => {
  // A chain, or one agency landing page reused across listings. Different
  // paths on the same host must still normalise to one domain.
  const a = lead({ website: 'https://shared.pk/location-a' });
  const b = lead({ website: 'https://shared.pk/location-b' });

  let calls = 0;
  const { patches, stats } = await enrichLeads({
    leads: [a, b],
    delay: async () => {},
    fetchPage: async () => { calls += 1; return { status: 200, body: REAL_PAGE_FIXTURE }; },
  });

  assert.equal(calls, 1, 'the second lead must reuse the first fetch, not repeat it');
  assert.equal(patches.length, 2, 'each lead still gets its own patch entry');
  assert.deepEqual(patches.map((p) => p.key), [a.key, b.key]);
  assert.equal(patches[0].websiteTech, patches[1].websiteTech, 'both share the one result fetched');
  assert.equal(stats.enriched, 2, 'both leads count as outcomes even though only one was fetched');
});

test('a persistent cache hit costs no fetch and no delay', async () => {
  const fresh = lead({ website: 'https://fresh.pk' });
  const cachedLead = lead({ website: 'https://cached.pk' });
  const cachedPatch = {
    enriched: true, websiteTech: 'shopify', mobileFriendly: true,
    hasBooking: false, hasChatbot: false, email: 'shop@cached.pk', socials: [],
  };

  let fetchCalls = 0;
  let delayCalls = 0;
  const { patches } = await enrichLeads({
    leads: [fresh, cachedLead],
    delay: async () => { delayCalls += 1; },
    getCached: async (domain) => (domain === 'cached.pk' ? cachedPatch : null),
    fetchPage: async () => { fetchCalls += 1; return { status: 200, body: REAL_PAGE_FIXTURE }; },
  });

  assert.equal(fetchCalls, 1, 'only the uncached lead is fetched');
  assert.equal(delayCalls, 0, 'a cache hit has no server to be polite to, so it must never throttle');
  assert.equal(patches[1].websiteTech, 'shopify', 'the cached patch is used as-is');
});

test('the throttle fires between fetches, not before the first or after the last', async () => {
  const a = lead({ website: 'https://a1.pk' });
  const b = lead({ website: 'https://b1.pk' });
  const c = lead({ website: 'https://c1.pk' });

  let fetchCalls = 0;
  let delayCalls = 0;
  const { patches } = await enrichLeads({
    leads: [a, b, c],
    delay: async (ms) => {
      delayCalls += 1;
      assert.ok(Number.isFinite(ms) && ms > 0, 'must receive a real figure from nextDelayMs, not a stray unit');
    },
    fetchPage: async () => { fetchCalls += 1; return { status: 200, body: REAL_PAGE_FIXTURE }; },
  });

  assert.equal(fetchCalls, 3);
  assert.equal(patches.length, 3);
  assert.equal(delayCalls, 2, 'three fetches need exactly two gaps between them');
});

test('progress fires once per lead, in order, not once at the end', async () => {
  const a = lead({ website: 'https://prog-a.pk' });
  const b = lead({ website: 'https://prog-b.pk' });

  const seen = [];
  await enrichLeads({
    leads: [a, b],
    delay: async () => {},
    fetchPage: async () => ({ status: 200, body: REAL_PAGE_FIXTURE }),
    onProgress: (p) => seen.push(p.done),
  });

  assert.deepEqual(seen, [1, 2], 'a long batch must report progress as it goes, not only once at the end');
});

test('an abort keeps the patches already produced, and never starts the next fetch', async () => {
  const a = lead({ website: 'https://abort-a.pk' });
  const b = lead({ website: 'https://abort-b.pk' });
  const c = lead({ website: 'https://abort-c.pk' });
  const controller = new AbortController();

  let calls = 0;
  const { patches, stats } = await enrichLeads({
    leads: [a, b, c],
    signal: controller.signal,
    delay: async () => {},
    fetchPage: async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      return { status: 200, body: REAL_PAGE_FIXTURE };
    },
  });

  assert.equal(calls, 2, 'the third lead must never be fetched once the signal is aborted');
  assert.equal(patches.length, 2, 'the two leads already enriched must survive in the result');
  assert.deepEqual(patches.map((p) => p.key), [a.key, b.key]);
  assert.equal(stats.candidates, 3, 'stats.candidates reports the whole intended batch, not just what finished');
});

// ---------------------------------------------------------------------------
// background.js, Task 5: the ENRICH wiring.
//
// background.js calls chrome.runtime.onMessage.addListener and
// chrome.sidePanel.setPanelBehavior at module load, so importing it in bare
// Node throws before a single test could run. These read the source text
// instead, the same pattern tests/messages.test.js already uses for the
// content scripts, which have the same problem.
// ---------------------------------------------------------------------------

/** Slice out one top-level function's source by balancing braces from its first `{`. */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) return null;
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

test('a second concurrent enrichment is refused, and the slot is claimed before the first await', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const body = extractFunction(source, 'async function runEnrich');
  assert.ok(body, 'background.js must define runEnrich');

  assert.match(body, /if \(activeEnrich\) throw/, 'a concurrent call must be refused, not silently queued');

  const checkIndex = body.search(/if \(activeEnrich\) throw/);
  const claimIndex = body.search(/activeEnrich = \{/);
  const firstAwaitIndex = body.search(/\bawait\b/);
  assert.ok(checkIndex >= 0 && checkIndex < firstAwaitIndex,
    'the refusal check must run before the first await, or two fast calls both pass it');
  assert.ok(claimIndex >= 0 && claimIndex < firstAwaitIndex,
    'the slot must be claimed before the first await too, for the same reason');
});

test('the enrichment slot is released in a finally, so a thrown error cannot wedge it shut', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const body = extractFunction(source, 'async function runEnrich');
  const finallyIndex = body.search(/\bfinally\s*\{/);
  assert.ok(finallyIndex >= 0, 'runEnrich must have a finally block');
  assert.match(body.slice(finallyIndex), /activeEnrich = null/, 'the finally block must clear the slot');
});

test('runEnrich resolves leads through getLeads, not the whole store', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const body = extractFunction(source, 'async function runEnrich');
  assert.match(body, /getLeads\(/, 'must resolve the filter state through getLeads, which applies filterLeads');
  assert.doesNotMatch(body, /getAllLeads\(/, 'must not read every stored lead directly, bypassing the filter');
});

test('ENRICH_PROGRESS is broadcast from inside onProgress, not only in the final response', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const body = extractFunction(source, 'async function runEnrich');
  const onProgressIndex = body.search(/onProgress:\s*\(/);
  assert.ok(onProgressIndex >= 0, 'runEnrich must pass onProgress to enrichLeads');
  const nextCommaIndex = body.indexOf('},', onProgressIndex);
  const onProgressBody = body.slice(onProgressIndex, nextCommaIndex);
  assert.match(onProgressBody, /broadcast\(MSG\.ENRICH_PROGRESS/,
    'progress must be broadcast per lead, from inside the callback that fires per lead');
});

test('ABORT_ENRICH stops activeEnrich, independently of ABORT_RUN', async () => {
  const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const abortEnrichIndex = source.indexOf('[MSG.ABORT_ENRICH]');
  assert.ok(abortEnrichIndex >= 0, 'background.js must handle ABORT_ENRICH');
  const body = source.slice(abortEnrichIndex, source.indexOf('},', abortEnrichIndex) + 2);
  assert.match(body, /activeEnrich\.controller\.abort\(\)/);
  assert.doesNotMatch(body, /activeRun\.controller\.abort\(\)/,
    'ABORT_ENRICH must stop the enrichment controller, not the harvest one');
});
