import { MSG, makeRequest } from '../../core/messages.js';
import { parseMapsUrl, searchPlaces } from './geocode.js';
import { pbOrigin } from '../../sources/google-payload.js';
import { haversineKm } from '../../pipeline/tiling.js';
import { CONFIG } from '../../core/config.js';

/**
 * The location the harvest will use.
 *
 * Named searchArea rather than the obvious `location`, which would shadow the global
 * `window.location` for this whole module and break anything that later reaches for
 * it, in a way that reads as correct right up until it does not.
 *
 * Held here rather than in two text inputs. Raw coordinates were a form the operator
 * had to fill correctly, in the right order, for a tool whose whole job is to find
 * them: the place box and a pasted Maps link both produce them, so typing them by
 * hand was the one path that could put a search in the wrong hemisphere.
 *
 * Seeded with Attock, the operator's own market, so the panel is usable the moment it
 * opens. Every later value comes from a resolved place or a pasted link, both of
 * which are range checked before they get here.
 */
const searchArea = { lat: 33.7609824, lng: 72.342874, label: 'Attock / Hazro, PB' };

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

  // A captured search belongs to the place it came from. Retargeting one across the
  // world does not fail cleanly: it returns real businesses from the requested city
  // AND from the captured one, which is worse than failing, because the export looks
  // full. Checked here so the operator is told before the run rather than by a canary
  // abort halfway through.
  const stored = await chrome.storage.session.get('latestPb');
  const origin = pbOrigin(stored?.latestPb);
  if (origin) {
    const drift = haversineKm(origin, { lat: searchArea.lat, lng: searchArea.lng });
    if (drift > CONFIG.capture.maxDriftFromCaptureKm) {
      write(`the captured Maps search is about ${Math.round(drift)} km from ${searchArea.label}. `
        + 'Click Open Maps to run one search there first, then start the harvest. '
        + 'Harvesting across that distance mixes both places into one list.', true);
      runButton.disabled = false;
      return;
    }
  }

  const config = {
    keywords: document.getElementById('kw').value.split(',').map((k) => k.trim()).filter(Boolean),
    lat: searchArea.lat,
    lng: searchArea.lng,
    radiusKm: Number(document.getElementById('radius').value),
    zoom: 14,
  };

  // The place is named in the log, not just the numbers. A run that searched the
  // wrong city used to be indistinguishable from a run that found nothing.
  write(`starting: ${config.keywords.join(', ')} within ${config.radiusKm} km of ${searchArea.label}`);

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

function setLocation(lat, lng, label) {
  searchArea.lat = lat;
  searchArea.lng = lng;
  searchArea.label = label;
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
      setLocation(opt.lat, opt.lng, opt.label);
      placeHint.textContent = `searching ${opt.label}  (${opt.lat.toFixed(5)}, ${opt.lng.toFixed(5)})`;
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
    setLocation(fromUrl.lat, fromUrl.lng, fromUrl.label ?? 'the pasted link');
    // A link copied from a search the operator already ran carries what they were
    // looking for, so offer it rather than making them type it again.
    let note = `searching ${fromUrl.label ?? 'the pasted link'}`
      + `  (${fromUrl.lat.toFixed(5)}, ${fromUrl.lng.toFixed(5)})`;
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
      setLocation(only.lat, only.lng, only.label);
      placeHint.textContent = `searching ${only.label}  (${only.lat.toFixed(5)}, ${only.lng.toFixed(5)})`;
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

// State the starting area on load. An invisible default is worse than a visible one:
// the operator should never have to guess where a run is about to go.
placeHint.textContent = `searching ${searchArea.label}  (${searchArea.lat.toFixed(5)}, ${searchArea.lng.toFixed(5)})`;

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
  // Centred on the RESOLVED coordinates, never on the text in the box.
  //
  // This used to build "<keyword> in <whatever is typed>", which turned a pasted link
  // into the search `dentist in https://www.google.com/maps/place/Kansas+City,...`.
  // Google matched nothing, so the capture came from a failed search, which is the one
  // thing this button exists to prevent.
  //
  // Coordinates also beat a place name outright: the capture lands exactly where the
  // harvest will run, which is what the distance guard below then checks for.
  const keyword = (document.getElementById('kw').value.split(',')[0] || 'dentist').trim();
  const url = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}`
    + `/@${searchArea.lat},${searchArea.lng},13z`;
  chrome.tabs.create({ url });
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
