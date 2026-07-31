import { MSG, makeRequest } from '../../core/messages.js';

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
