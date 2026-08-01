import { MSG, makeRequest } from '../../core/messages.js';
import { parseMapsUrl, searchPlaces } from './geocode.js';

const log = document.getElementById('log');
const write = (text, warn = false) => {
  const line = document.createElement('div');
  if (warn) line.className = 'warn';
  line.textContent = text;
  log.prepend(line);
};

const runButton = document.getElementById('run');

runButton.addEventListener('click', async () => {
  // Disabled for the duration. The worker also refuses a second run, but a guard
  // there cannot stop the operator queueing clicks, and a disabled button says
  // plainly that something is already happening.
  if (runButton.disabled) return;
  runButton.disabled = true;

  const config = {
    keywords: document.getElementById('kw').value.split(',').map((k) => k.trim()).filter(Boolean),
    lat: Number(document.getElementById('lat').value),
    lng: Number(document.getElementById('lng').value),
    radiusKm: Number(document.getElementById('radius').value),
    zoom: 14,
  };

  write(`starting: ${config.keywords.join(', ')} within ${config.radiusKm} km`);

  let response;
  try {
    response = await chrome.runtime.sendMessage(makeRequest(MSG.START_RUN, config));
  } catch (error) {
    // Without this the button stays disabled forever on a rejected message and the
    // operator has to reload the panel to try again.
    write(`could not reach the extension: ${error?.message ?? error}`, true);
    return;
  } finally {
    runButton.disabled = false;
  }

  if (!response.ok) { write(response.error, true); return; }

  // Repeated at the end as well as broadcast at the start, so it is on screen
  // beside the final count rather than scrolled away.
  writeCoverage(response.data.coverage);

  write(`finished: ${response.data.stopReason}, ${response.data.total} unique businesses`);
  if (response.data.problems?.length) response.data.problems.forEach((p) => write(p, true));
});

document.getElementById('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage(makeRequest(MSG.ABORT_RUN, {}));
  write('stop requested, finishing the current leg');
});

document.getElementById('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard/index.html') });
});

// ---- Place search: type a city, fill lat/lng, so the operator never hand-looks-up
// coordinates. The lat/lng fields stay editable for anyone who prefers them raw. ----
const placeInput = document.getElementById('place');
const findButton = document.getElementById('find');
const placeHint = document.getElementById('placeHint');

const placeOptions = document.getElementById('placeOptions');

function setCoords(lat, lng) {
  document.getElementById('lat').value = lat;
  document.getElementById('lng').value = lng;
}

function clearOptions() {
  placeOptions.hidden = true;
  placeOptions.textContent = '';
}

/**
 * Offer every candidate rather than picking one.
 *
 * "Kansas City" is two cities in two different states, and choosing for the operator
 * means silently harvesting the wrong market. Photon returns both, so both are shown.
 */
function showOptions(options) {
  placeOptions.textContent = '';
  for (const opt of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = opt.label;
    if (opt.kind) {
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = opt.kind.replace(/_/g, ' ');
      button.appendChild(kind);
    }
    button.addEventListener('click', () => {
      setCoords(opt.lat, opt.lng);
      placeHint.textContent = `set to ${opt.lat.toFixed(5)}, ${opt.lng.toFixed(5)} (${opt.label})`;
      clearOptions();
    });
    placeOptions.appendChild(button);
  }
  placeOptions.hidden = options.length === 0;
}

/**
 * One box, two kinds of input.
 *
 * A pasted Maps link is answered without any lookup at all, because the coordinates
 * are already in it: no network, no geocoder, and no question about which place was
 * meant. Anything else is treated as a name and looked up.
 */
async function findPlace() {
  const query = placeInput.value.trim();
  clearOptions();
  if (!query) {
    placeHint.textContent = 'Type a place, or paste a Google Maps link';
    return;
  }

  const fromUrl = parseMapsUrl(query);
  if (fromUrl) {
    setCoords(fromUrl.lat, fromUrl.lng);
    // A link copied from a search the operator already ran carries what they were
    // looking for, so offer it rather than making them type it again.
    let note = `set to ${fromUrl.lat.toFixed(5)}, ${fromUrl.lng.toFixed(5)} from the link`;
    if (fromUrl.keyword) {
      const kwField = document.getElementById('kw');
      note += `. Keyword in that link: "${fromUrl.keyword}"`;
      if (!kwField.value.trim()) {
        kwField.value = fromUrl.keyword;
        note += ', used as your keyword';
      }
    }
    placeHint.textContent = note;
    return;
  }

  findButton.disabled = true;
  placeHint.textContent = 'looking up...';
  try {
    const options = await searchPlaces(query);
    if (options.length === 1) {
      const only = options[0];
      setCoords(only.lat, only.lng);
      placeHint.textContent = `set to ${only.lat.toFixed(5)}, ${only.lng.toFixed(5)} (${only.label})`;
    } else {
      placeHint.textContent = `${options.length} places match. Pick one:`;
      showOptions(options);
    }
  } catch (error) {
    placeHint.textContent = error?.message ?? String(error);
  } finally {
    findButton.disabled = false;
  }
}

findButton.addEventListener('click', findPlace);
placeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); findPlace(); }
});
// Pasting a link is the one case where pressing Find as well is pure friction.
placeInput.addEventListener('paste', () => {
  setTimeout(() => { if (parseMapsUrl(placeInput.value)) findPlace(); }, 0);
});

// ---- Capture status: the harvest refuses to start until a pb is captured from a
// live Maps search, and that state was invisible. Surface it, and offer one click
// that opens the right search so capturing it is not a hunt. ----
const captureBox = document.getElementById('capture');
const captureMsg = document.getElementById('captureMsg');

function renderCapture(pb) {
  const ready = typeof pb === 'string' && pb.length > 50;
  captureBox.classList.toggle('ready', ready);
  captureMsg.textContent = ready
    ? 'Maps search captured. Ready to harvest.'
    : 'No Maps search captured yet. Click Open Maps, run one search, then return here.';
}

async function refreshCapture() {
  try {
    const stored = await chrome.storage.session.get('latestPb');
    renderCapture(stored?.latestPb);
  } catch {
    renderCapture(null);
  }
}

// Live update: background.js writes latestPb into session storage the moment the
// content script captures one, so the pill flips to ready without a manual refresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.latestPb) renderCapture(changes.latestPb.newValue);
});
refreshCapture();

document.getElementById('capOpen').addEventListener('click', () => {
  // Seed the search with the operator's first keyword and the place they typed, so
  // the captured pb comes from the area they are about to harvest.
  const keyword = (document.getElementById('kw').value.split(',')[0] || 'dentist').trim();
  const place = placeInput.value.trim();
  const query = place ? `${keyword} in ${place}` : keyword;
  chrome.tabs.create({ url: `https://www.google.com/maps/search/${encodeURIComponent(query)}` });
});

function writeCoverage(c) {
  if (c?.tilesTruncated) {
    write(`COVERAGE CUT: asked for ${c.requestedRadiusKm} km, actually searching about `
      + `${c.effectiveRadiusKm.toFixed(1)} km. ${c.tilesPlanned} tiles needed, only `
      + `${c.tilesUsed} allowed. Raise maxTiles in config or use a smaller radius.`, true);
  }
  if (c?.legsTruncated) {
    write(`COVERAGE CUT: ${c.legsPlanned} query legs planned, only ${c.legsUsed} will run. `
      + `Use fewer keywords or raise maxLegsPerRun.`, true);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.RUN_COVERAGE) writeCoverage(message.payload);
  if (message?.type === MSG.RUN_NOTICE) write(message.payload.message, true);
  if (message?.type === MSG.RUN_PROGRESS) {
    const p = message.payload;
    write(`leg ${p.legIndex + 1}/${p.totalLegs}: +${p.freshLeads} new, ${p.uniqueLeads} unique`);
  }
  if (message?.type === MSG.RUN_BLOCKED) {
    write(`PAUSED: ${message.payload.stopReason}. ${message.payload.problems.join('; ')}`, true);
  }
});
