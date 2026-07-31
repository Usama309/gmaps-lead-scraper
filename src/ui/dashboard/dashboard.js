import { MSG, makeRequest } from '../../core/messages.js';
import { DEFAULT_FILTER_STATE } from '../../pipeline/filter.js';
import { estimateMinutes } from '../../pipeline/review-pass.js';

const state = { ...DEFAULT_FILTER_STATE, exportedKeys: null };

// Whether an enrichment pass is currently in flight. Kept outside `state`
// because it is UI-only bookkeeping, never sent to the worker: the worker
// tracks its own concurrency slot (activeEnrich) independently, this only
// drives which controls are enabled and visible.
let enriching = false;
let reviewRunning = false;
// Where the next pass should pick up. Survives a stop, which is the point.
let reviewResumeAt = 0;

const $ = (sel) => document.querySelector(sel);

async function send(type, payload) {
  const response = await chrome.runtime.sendMessage(makeRequest(type, payload));
  if (!response?.ok) throw new Error(response?.error ?? 'no response from the extension worker');
  return response.data;
}

function stripeColor(score) {
  if (score >= 80) return 'var(--opportunity)';
  if (score >= 60) return 'var(--accent)';
  return 'var(--sorted)';
}

/**
 * Escape for HTML. Covers quotes as well as angle brackets.
 *
 * Nothing here currently lands inside a quoted attribute, so quote escaping is not
 * load-bearing today. It is included because the day someone writes
 * href="${esc(d.website)}" this becomes the only thing between a business name and
 * script execution in the extension's own privileged origin, and that edit will not
 * come with a reminder. Lead data comes from Maps listings, which anyone can register.
 */
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRows(leads) {
  const tbody = $('#mp-rows');

  if (leads.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="11" style="padding:26px;text-align:center;color:var(--ink-3)">' +
      'No businesses match. Loosen a filter, or run a harvest from the side panel.</td></tr>';
    return;
  }

  tbody.innerHTML = leads.map((d) => {
    const why = d.reasons.map((r) => `<b>${esc(r)}</b>`).join('');
    const colour = stripeColor(d.score);
    const cell = (v, fallback) =>
      v === null || v === undefined ? `<span class="mp-none">${fallback}</span>` : esc(v);

    return `<tr class="${d.score < 60 ? 'dim' : ''}">
      <td><div class="mp-scorecell">
        <span class="mp-stripe" style="background:${colour}"></span>
        <span class="mp-scoreno" style="color:${colour}">${d.score}</span>
        <span class="mp-meter"><i style="width:${d.score}%;background:${colour}"></i></span>
      </div></td>
      <td><div class="mp-name">${esc(d.name)}</div>
        <div class="mp-cat">${esc(d.categories.join(', '))}${d.provisional ? ' (score provisional)' : ''}</div>
        <div class="mp-why">${why}</div></td>
      <td class="num mp-num">${d.rating === null ? '' : d.rating.toFixed(1)}</td>
      <td class="num mp-num">${d.reviewCount ?? ''}</td>
      <td class="mp-sub mp-nowrap">${cell(d.phone, 'none')}</td>
      <td class="mp-sub">${cell(d.website, 'no website')}</td>
      <td class="mp-sub">${d.websiteTech === 'none' ? '<span class="mp-none">no site</span>' : esc(d.websiteTech ?? 'unknown')}</td>
      <td class="mp-sub">${d.mobileFriendly === null ? '<span style="color:var(--ink-3)">n/a</span>'
        : d.mobileFriendly ? '<span class="mp-has">passes</span>' : '<span class="mp-none">fails</span>'}</td>
      <td class="mp-sub">${d.hasBooking === null ? '<span style="color:var(--ink-3)">n/a</span>'
        : d.hasBooking ? '<span class="mp-has">live</span>' : '<span class="mp-none">missing</span>'}</td>
      <td class="mp-sub">${cell(d.email, 'none')}</td>
      <td class="mp-sub">${d.lastReviewDays === null ? '' : `${d.lastReviewDays} d`}</td>
    </tr>`;
  }).join('');
}

function renderStats(leads, totalStored, hiddenAsDuplicates = 0) {
  const scores = leads.map((l) => l.score).sort((a, b) => a - b);
  const median = scores.length
    ? (scores.length % 2
      ? scores[(scores.length - 1) / 2]
      : Math.round((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2))
    : 0;

  $('#s-harv').textContent = totalStored;
  $('#s-pass').textContent = leads.length;
  $('#s-hot').textContent = leads.filter((l) => l.score >= 80).length;
  $('#s-med').textContent = median;
  $('#s-nosite').innerHTML = `${leads.filter((l) => !l.hasRealWebsite).length}<small> of pass</small>`;
  // Only meaningful while the toggle is on; with it off nothing is being hidden.
  $('#s-dupe').textContent = state.skipExported ? hiddenAsDuplicates : 0;
  $('#e-count').textContent = leads.length;
}

/**
 * How many of the CURRENTLY DISPLAYED leads enrichment would actually fetch.
 * Not `leads.length`: a lead with no real website, or only a Facebook page, has
 * nothing to fetch. The button must say what will happen, not how many rows
 * happen to be on screen, or the operator has no way to judge the cost of a
 * click before making it. background.js's enrichLeads filters candidates the
 * same way, so this figure and the run it starts always agree.
 */
function enrichCandidateCount(leads) {
  return leads.filter((l) => l.hasRealWebsite && l.website).length;
}

function renderEnrichButton(leads) {
  const count = enrichCandidateCount(leads);
  $('#enrich-count').textContent = count;
  // "Enrich 1 leads" is the kind of thing that makes a tool feel unfinished. The
  // noun is "websites" rather than "leads" for a second reason: only leads that
  // HAVE a site are fetched, so counting leads would overstate the work about
  // sevenfold on a real harvest.
  $('#enrich-noun').textContent = count === 1 ? 'website' : 'websites';
  $('#enrich-go').disabled = enriching;
}

/**
 * Toggle every control tied to a run in flight. The worker refuses a second
 * concurrent enrichment on its own (activeEnrich in background.js), but a
 * disabled button says so up front instead of making the operator discover it
 * through an error toast after clicking anyway.
 */
function setEnriching(running) {
  enriching = running;
  $('#enrich-go').disabled = running;
  $('#enrich-progress').hidden = !running;
  if (!running) {
    $('#enrich-bar').style.width = '0%';
    $('#enrich-done').textContent = '0';
    $('#enrich-total').textContent = '0';
  }
}

function updateEnrichProgress({ done, total }) {
  $('#enrich-done').textContent = done;
  $('#enrich-total').textContent = total;
  $('#enrich-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

/**
 * State the run's real outcome, from `stats`, never a guess: how many sites
 * actually answered, how many domains are dead, how many could not be resolved
 * either way. All three come straight off enrichLeads' own tally.
 */
function reportEnrichOutcome(stats) {
  const parts = [`${stats.enriched} enriched`];
  if (stats.dead) parts.push(`${stats.dead} dead domain${stats.dead === 1 ? '' : 's'}`);
  if (stats.unresolved) parts.push(`${stats.unresolved} could not be resolved`);
  $('#enrich-result').textContent = `${parts.join(', ')}.`;
}

function showError(message) {
  const toast = $('#e-toast');
  toast.textContent = message;
  toast.classList.add('on');
}

function clearError() {
  $('#e-toast').classList.remove('on');
}

/**
 * State the real number of already-exported businesses.
 *
 * The markup shipped with "1,284" baked in from the mockup and nothing ever
 * replaced it, so the control asserted a specific false fact on every load.
 */
function renderExportedCount(count) {
  const el = $('#f-dupe-hint');
  if (!el) return;
  const n = Number.isFinite(count) ? count : 0;
  el.textContent = n === 1
    ? 'Hide the 1 business already exported in past runs'
    : `Hide the ${n.toLocaleString('en-GB')} businesses already exported in past runs`;
}

/**
 * State what a review pass will cost BEFORE it is started.
 *
 * The operator chose to run this over every harvested lead, and at the measured 13
 * seconds each that is nearly two hours for 500. A button that starts a two-hour job
 * without saying so is the kind of thing you only forgive once.
 */
function renderReviewButton(totalStored) {
  const count = Number.isFinite(totalStored) ? totalStored : 0;
  $('#review-count').textContent = count;
  $('#review-noun').textContent = count === 1 ? 'lead' : 'leads';
  $('#review-estimate').textContent = count === 0
    ? ''
    : `About ${estimateMinutes(count)} minutes, and it can be stopped and resumed.`;
  $('#review-go').disabled = reviewRunning;
}

function setReviewRunning(running) {
  reviewRunning = running;
  $('#review-go').disabled = running;
  $('#review-progress').hidden = !running;
  if (!running) {
    $('#review-bar').style.width = '0%';
    $('#review-done').textContent = '0';
    $('#review-total').textContent = '0';
  }
}

function updateReviewProgress({ index, total, name, status }) {
  const done = index + 1;
  $('#review-done').textContent = done;
  $('#review-total').textContent = total;
  $('#review-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  // Naming the business is what distinguishes a slow job from a hung one over two hours.
  $('#review-current').textContent = name ? `${status === 'fresh' ? 'Skipping' : 'Reading'} ${name}` : 'Reading\u2026';
}

/**
 * Report what the pass actually did, and whether there is more to do.
 *
 * A pass that stopped early must say so plainly. The operator chose to run this over
 * everything, so "stopped at 40 of 500" is the difference between resuming and
 * assuming it finished.
 */
function reportReviewOutcome(out) {
  const parts = [`${out.read} read`];
  if (out.skipped) parts.push(`${out.skipped} already fresh`);
  // Named, not just counted. A failed lead is retried by the next pass automatically,
  // because it never got a read timestamp, so this is information rather than a chore.
  if (out.failedLeads?.length) {
    parts.push(`${out.failedLeads.length} could not be read, and the next pass will retry them`);
  }

  if (out.stopReason === 'blocked') {
    parts.push('STOPPED: Google served an interstitial. Leave it a while before resuming.');
  } else if (out.stopReason === 'selector_drift') {
    parts.push('STOPPED: the Maps markup has changed and the reader needs updating.');
  } else if (out.stopReason === 'aborted') {
    parts.push(`stopped at ${out.completedLeads}, press again to resume from there`);
  } else if (out.stopReason === 'completed_with_errors') {
    parts.push(`some leads could not be read, resuming picks up at ${out.completedLeads}`);
  }
  $('#review-result').textContent = `${parts.join('. ')}.`;
}

async function refresh() {
  try {
    const { leads, totalStored, exportedCount, hiddenAsDuplicates } = await send(MSG.GET_LEADS, state);
    clearError();
    renderRows(leads);
    renderStats(leads, totalStored, hiddenAsDuplicates);
    renderExportedCount(exportedCount);
    renderReviewButton(totalStored);
    renderEnrichButton(leads);
  } catch (error) {
    // Clear the table as well as showing the message. Leaving the previous rows
    // and counts under an error toast lets the operator read stale numbers as
    // current ones, which is worse than showing nothing.
    $('#mp-rows').innerHTML =
      '<tr><td colspan="11" style="padding:26px;text-align:center;color:var(--ink-3)">'
      + 'Could not reach the extension. The counts below are cleared rather than left stale.</td></tr>';
    renderStats([], 0);
    renderEnrichButton([]);
    showError(error.message);
  }
}

// Bind the rail controls to filter state. Each writes one key and refreshes.
function bind() {
  document.querySelectorAll('.mp-seg').forEach((group) => {
    group.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        button.setAttribute('aria-pressed', 'true');
        const map = { web: 'website', phone: 'hasPhone', mob: 'mobileFriendly', book: 'hasBooking', mail: 'hasEmail' };
        for (const [attr, key] of Object.entries(map)) {
          if (button.dataset[attr]) state[key] = button.dataset[attr];
        }
        refresh();
      });
    });
  });

  document.querySelectorAll('.mp-chip[data-tech]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') === 'true';
      chip.setAttribute('aria-pressed', on ? 'false' : 'true');
      const tech = chip.dataset.tech.toLowerCase();
      state.tech = on ? state.tech.filter((t) => t !== tech) : [...state.tech, tech];
      refresh();
    });
  });

  $('#f-score').addEventListener('input', (e) => {
    state.minScore = Number(e.target.value);
    $('#f-scoreval').textContent = state.minScore;
    refresh();
  });
  // Parsed explicitly rather than with `|| fallback`, because 0 is falsy: typing a
  // max of 0 meant "no limit" instead of "cap at zero", which is the opposite.
  const numberOr = (raw, fallback) => {
    const value = Number(raw);
    return raw.trim() === '' || !Number.isFinite(value) ? fallback : value;
  };
  $('#f-minrev').addEventListener('input', (e) => {
    state.minReviews = numberOr(e.target.value, 0); refresh();
  });
  $('#f-maxrev').addEventListener('input', (e) => {
    state.maxReviews = numberOr(e.target.value, null); refresh();
  });
  $('#f-lastrev').addEventListener('change', (e) => { state.lastReviewWithinDays = Number(e.target.value); refresh(); });
  $('#f-rating').addEventListener('change', (e) => { state.minRating = Number(e.target.value); refresh(); });
  $('#f-dupe').addEventListener('change', (e) => { state.skipExported = e.target.checked; refresh(); });

  $('#e-go').addEventListener('click', async () => {
    const toast = $('#e-toast');
    try {
      const { csv, count, keys, filename } = await send(MSG.EXPORT, state);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
      anchor.click();
      URL.revokeObjectURL(url);

      // Only now record them as exported. Confirming before the download exists
      // would permanently skip these businesses on every later sweep if the save
      // never happened, and nothing would tell the operator which ones went.
      await send(MSG.CONFIRM_EXPORT, { keys });

      toast.textContent = `→ exported ${count} leads`;
      toast.classList.add('on');
      setTimeout(() => toast.classList.remove('on'), 3000);
      await refresh();
    } catch (error) {
      // Errors persist until the next successful refresh clears them, rather than
      // fading after three seconds like a success message.
      showError(error.message);
    }
  });

  // Enrichment runs over the currently filtered set: `state` is the same
  // filter object refresh() already sends to GET_LEADS, so ENRICH fetches
  // exactly the leads on screen, never the whole store.
  $('#enrich-go').addEventListener('click', async () => {
    if (enriching) return;
    clearError();
    $('#enrich-result').textContent = '';
    setEnriching(true);
    try {
      const { stats } = await send(MSG.ENRICH, state);
      reportEnrichOutcome(stats);
      // Re-fetch so the new scores, platforms and provisional flags the run
      // just wrote to the store actually appear in the table.
      await refresh();
    } catch (error) {
      showError(error.message);
    } finally {
      setEnriching(false);
    }
  });

  $('#enrich-stop').addEventListener('click', async () => {
    try {
      await send(MSG.ABORT_ENRICH, {});
    } catch (error) {
      showError(error.message);
    }
  });

  $('#review-go').addEventListener('click', async () => {
    if (reviewRunning) return;
    clearError();
    $('#review-result').textContent = '';
    setReviewRunning(true);
    try {
      // `startAt` is the resume point the last pass returned. A two-hour job that
      // restarts from zero after an interruption is a job nobody ever finishes.
      const out = await send(MSG.REVIEW_PASS, { startAt: reviewResumeAt });
      reviewResumeAt = out.stopReason === 'completed' ? 0 : out.completedLeads;
      reportReviewOutcome(out);
      await refresh();
    } catch (error) {
      showError(error.message);
    } finally {
      setReviewRunning(false);
    }
  });

  $('#review-stop').addEventListener('click', async () => {
    try {
      await send(MSG.ABORT_REVIEW_PASS, {});
    } catch (error) {
      showError(error.message);
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.RUN_PROGRESS) refresh();
  if (message?.type === MSG.ENRICH_PROGRESS) updateEnrichProgress(message.payload);
  if (message?.type === MSG.REVIEW_PASS_PROGRESS) updateReviewProgress(message.payload);
});

bind();
refresh();
