import { MSG, makeRequest } from '../../core/messages.js';

const log = document.getElementById('log');
const write = (text, warn = false) => {
  const line = document.createElement('div');
  if (warn) line.className = 'warn';
  line.textContent = text;
  log.prepend(line);
};

document.getElementById('run').addEventListener('click', async () => {
  const config = {
    keywords: document.getElementById('kw').value.split(',').map((k) => k.trim()).filter(Boolean),
    lat: Number(document.getElementById('lat').value),
    lng: Number(document.getElementById('lng').value),
    radiusKm: Number(document.getElementById('radius').value),
    zoom: 14,
  };

  write(`starting: ${config.keywords.join(', ')} within ${config.radiusKm} km`);
  const response = await chrome.runtime.sendMessage(makeRequest(MSG.START_RUN, config));

  if (!response.ok) { write(response.error, true); return; }

  // Coverage caps shrink the area actually searched. Say so, loudly, or the
  // operator reads a short list as a complete one.
  const c = response.data.coverage;
  if (c?.tilesTruncated) {
    write(`COVERAGE CUT: asked for ${c.requestedRadiusKm} km, actually searched about `
      + `${c.effectiveRadiusKm.toFixed(1)} km. ${c.tilesPlanned} tiles needed, only `
      + `${c.tilesUsed} allowed. Raise maxTiles in config or use a smaller radius.`, true);
  }
  if (c?.legsTruncated) {
    write(`COVERAGE CUT: ${c.legsPlanned} query legs planned, only ${c.legsUsed} run. `
      + `Use fewer keywords or raise maxLegsPerRun.`, true);
  }

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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.RUN_PROGRESS) {
    const p = message.payload;
    write(`leg ${p.legIndex + 1}/${p.totalLegs}: +${p.freshLeads} new, ${p.uniqueLeads} unique`);
  }
  if (message?.type === MSG.RUN_BLOCKED) {
    write(`PAUSED: ${message.payload.stopReason}. ${message.payload.problems.join('; ')}`, true);
  }
});
