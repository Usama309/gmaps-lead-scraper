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
