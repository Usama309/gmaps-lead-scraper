import { MSG, makeRequest } from '../../core/messages.js';
import { DEFAULT_FILTER_STATE } from '../../pipeline/filter.js';

const state = { ...DEFAULT_FILTER_STATE, exportedKeys: null };
let currentLeads = [];

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

function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function renderStats(leads, totalStored) {
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
  $('#e-count').textContent = leads.length;
}

async function refresh() {
  try {
    const { leads, totalStored } = await send(MSG.GET_LEADS, state);
    currentLeads = leads;
    renderRows(leads);
    renderStats(leads, totalStored);
  } catch (error) {
    $('#e-toast').textContent = error.message;
    $('#e-toast').classList.add('on');
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
  $('#f-minrev').addEventListener('input', (e) => { state.minReviews = Number(e.target.value) || 0; refresh(); });
  $('#f-maxrev').addEventListener('input', (e) => { state.maxReviews = Number(e.target.value) || Infinity; refresh(); });
  $('#f-lastrev').addEventListener('change', (e) => { state.lastReviewWithinDays = Number(e.target.value); refresh(); });
  $('#f-rating').addEventListener('change', (e) => { state.minRating = Number(e.target.value); refresh(); });
  $('#f-dupe').addEventListener('change', (e) => { state.skipExported = e.target.checked; refresh(); });

  $('#e-go').addEventListener('click', async () => {
    const toast = $('#e-toast');
    try {
      const { csv, count, filename } = await send(MSG.EXPORT, state);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
      anchor.click();
      URL.revokeObjectURL(url);
      toast.textContent = `→ exported ${count} leads`;
      await refresh();
    } catch (error) {
      toast.textContent = error.message;
    }
    toast.classList.add('on');
    setTimeout(() => toast.classList.remove('on'), 3000);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.RUN_PROGRESS) refresh();
});

bind();
refresh();
