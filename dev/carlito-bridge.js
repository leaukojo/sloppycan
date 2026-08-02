// ── carlito-bridge.js - host shims for the standalone Carlito↔RAMN bridge ───────
// This page reuses three SloppyCAN files unchanged: can-link.js (CAN transport),
// ramn.js (RAMN frame decode → window.ramnGetState), and carlito.js (the floating
// Carlito game + control push + telemetry return). Those files reference a handful of
// "host" globals that the full app gets from sloppycan.js; here we provide minimal
// stand-ins. Everything below lives in the shared classic-script global scope so the
// transport primitives in can-link.js resolve these names at call time.

// ── Host globals expected by can-link.js (RX/parse/write paths) ─────────────────
let paused = false;          // bridge never pauses capture
let demoMode = false;        // no demo here - writes always go to the wire
let terminalMode = false;    // no SLCAN terminal
let parseErrors = 0;
let totalFrames = 0;
let bytesReceived = 0;
let frameRateBuffer = [];
function termLog() {}                       // SLCAN terminal sink - unused
function escHtml(s) {                        // only used for raw-line diagnostics
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Status-line + console logger.
// 'warn' is throttled: SLCAN parse errors (raw-unparsed / desync) fire at 'warn' and can arrive in
// floods during a burst - the console.* + DOM write per message is itself main-thread load that
// worsens the very contention causing them. Collapse rapid warns to ≤2/s with a dropped-count suffix.
// 'ok'/'err'/default always pass through.
let lastWarnLog = 0, warnSuppressed = 0;
function log(msg, level) {
  if (level === 'warn') {
    const now = performance.now();
    if (now - lastWarnLog < 500) { warnSuppressed++; return; }
    if (warnSuppressed) { msg += ` (+${warnSuppressed} more)`; warnSuppressed = 0; }
    lastWarnLog = now;
  }
  const s = document.getElementById('status');
  if (s) { s.textContent = msg; s.className = level === 'err' ? 'err' : level === 'ok' ? 'ok' : ''; }
  if (level === 'err') console.error(msg); else console.log(msg);
}

// Sink for every parsed RX frame: feed the RAMN decoder so ramnGetState() (which Carlito
// reads each tick) stays current. Non-RAMN ids (incl. Carlito's own 0x520–0x528 echo) are
// ignored by ramnIngestFrame, so this is safe for all traffic. Exposed on window too because
// carlito.js's telemetry path early-returns unless window.ingestFrame exists.
let rxCount = 0, txCount = 0, dropCount = 0;   // live health counters (shown in the bar)
function ingestFrame(frame) { rxCount++; if (window.ramnIngestFrame) window.ramnIngestFrame(frame); }
window.ingestFrame = ingestFrame;

// ── Connection (thin connectSerial/disconnectSerial, no SloppyCAN UI) ───────────
const delay = ms => new Promise(r => setTimeout(r, ms));

async function bridgeConnect() {
  const adapter = document.getElementById('adapterType').value; // 'serial' | 'gsusb'
  log('Connecting…');
  try {
    if (adapter === 'gsusb') {
      connMode = 'gsusb';
      const { dev, inEp, outEp, name } = await openGsUsb();
      usbSerDev = dev; usbSerIn = inEp; usbSerOut = outEp;
      await gsSetBitTiming(getBitrateHz());
      document.getElementById('deviceInfo').textContent = name;
      gsUsbPump();
    } else if (_onAndroid && navigator.usb) {
      connMode = 'serial';
      const { dev, inEp, outEp } = await openWebUSBCDC();
      usbSerDev = dev; usbSerIn = inEp; usbSerOut = outEp;
      usbSerialPump();
    } else {
      connMode = 'serial';
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      readLoop();
    }

    if (connMode !== 'gsusb') {        // let the UART settle, then probe version/serial (SLCAN)
      await delay(150); await sendCommand('V');
      await delay(100); await sendCommand('N');
      await delay(100);
    }

    setConnectedUI(true);
    const lo = document.getElementById('listenOnly').checked;
    log('Connected - loading game…' + (lo ? ' (listen-only)' : ''), 'ok');

    // Open Carlito FIRST (starts the heavy WebGL/WASM boot), then DEFER opening the CAN bus until the
    // game reports it's booted (first telemetry) - see armDeferredBusOpen. Opening the bus now would
    // stream CAN into the adapter buffer during the boot freeze, draining later as a corrupting burst.
    if (window.carlitoToggle && !(window.carlitoIsOpen && window.carlitoIsOpen())) window.carlitoToggle();
    armDeferredBusOpen();
  } catch (e) {
    if (e.name !== 'NotFoundError') log('Connection error: ' + e.message, 'err');
    try { if (port) await port.close(); } catch (_) {}
    port = null; usbSerDev = null; connMode = 'serial';
  }
}

async function bridgeBusOpen() {
  const listenOnly = document.getElementById('listenOnly').checked;
  if (connMode === 'gsusb') {
    await gsSetMode(true, listenOnly);
  } else {
    await sendCommand(document.getElementById('baudRate').value); // S0–S8
    await sendCommand(listenOnly ? 'L' : 'O');
  }
  busIsOpen = true;
}

// ── Deferred bus open ───────────────────────────────────────────────────────────
// Hold off the SLCAN open ('O'/'L') / gs_usb START until the Carlito game has booted, signalled by
// its first telemetry postMessage. The game's WASM boot freezes the main thread for seconds; with the
// bus already open the adapter streams CAN into its buffer during that freeze, then dumps it in one
// corrupting burst (spliced SLCAN lines → parse errors) the moment the thread frees. A fallback timer
// opens the bus anyway if no telemetry arrives (stale / no-bridge game build) so the bridge still
// works as a plain monitor.
let pendingBusOpen = false, busOpenTimer = null;
function armDeferredBusOpen() {
  pendingBusOpen = true;
  clearTimeout(busOpenTimer);
  busOpenTimer = setTimeout(fireDeferredBusOpen, 10000);   // fallback if the game never reports
}
async function fireDeferredBusOpen() {
  if (!pendingBusOpen) return;
  pendingBusOpen = false;
  clearTimeout(busOpenTimer); busOpenTimer = null;
  if (!port && !usbSerDev) return;          // disconnected before the game booted
  try {
    await bridgeBusOpen();
    const lo = document.getElementById('listenOnly').checked;
    log('Connected' + (lo ? ' (listen-only)' : ''), 'ok');
  } catch (e) { log('Bus open failed: ' + e.message, 'err'); }
}
// First telemetry frame from the game = it has booted → safe to open the bus. Gated on BOTH the
// message source being our actual game iframe (via carlito.js's validator) AND the payload type, so
// an unrelated window from the same origin can't trip the early bus-open. carlito.js owns the trust
// definition of "our game frame" (incl. any safe carlitoUrl override) - this stays consistent with it.
window.addEventListener('message', (e) => {
  if (pendingBusOpen && window.carlitoIsGameFrame && window.carlitoIsGameFrame(e.source) &&
      e.data && e.data.type === 'carlitoOutput') fireDeferredBusOpen();
});

// Named disconnectSerial so the transport pumps (which call it on read error) reach it.
async function disconnectSerial() {
  pendingBusOpen = false; clearTimeout(busOpenTimer); busOpenTimer = null;   // cancel any deferred bus open
  if (usbSerDev) {
    if (connMode === 'gsusb') { try { await gsSetMode(false, false); } catch (e) {} }
    const dev = usbSerDev; usbSerDev = null; usbSerIn = null; usbSerOut = null;
    try { await dev.close(); } catch (e) {}
  } else {
    try { if (reader) await reader.cancel(); } catch (_) {}
    try { if (port) await port.close(); } catch (_) {}
    port = null; reader = null;
  }
  busIsOpen = false; frameBuffer = ''; termBuffer = ''; bytesReceived = 0;
  connMode = 'serial';
  if (window.ramnStop) window.ramnStop();
  // Close Carlito so the game (audio + CPU) stops.
  if (window.carlitoIsOpen && window.carlitoIsOpen() && window.carlitoToggle) window.carlitoToggle();
  setConnectedUI(false);
  log('Disconnected');
}

let statsTimer = null;
function setConnectedUI(connected) {
  document.getElementById('connectBtn').style.display = connected ? 'none' : '';
  document.getElementById('disconnectBtn').style.display = connected ? '' : 'none';
  ['adapterType', 'baudRate', 'listenOnly'].forEach(id => { document.getElementById(id).disabled = connected; });
  document.getElementById('zenBtn').disabled = !connected; // fullscreen only makes sense with a live game
  // Live health readout: RX rate confirms uplink is alive (frames still decoding); TX rate +
  // dropped count show the coalesced downlink. A rising dropped count just means the game emits
  // faster than the link drains (stale frames coalesced) - expected, not an error.
  const stats = document.getElementById('stats');
  if (connected && !statsTimer) {
    let pr = rxCount, pt = txCount;
    statsTimer = setInterval(() => {
      stats.textContent = `RX ${rxCount - pr}/s · TX ${txCount - pt}/s` + (dropCount ? ` · dropped ${dropCount}` : '');
      pr = rxCount; pt = txCount;
    }, 1000);
  } else if (!connected && statsTimer) {
    clearInterval(statsTimer); statsTimer = null; stats.textContent = '';
  }
}

// ── Carlito return channel: telemetry → wire, SERIALIZED + COALESCING ───────────
// Downlink flow control: keep only the LATEST frame per ID (drop stale telemetry, never queue a
// backlog) and send ONE transfer at a time, awaiting each. This self-paces to the link's real drain
// rate - at 115200 baud SLCAN tops out ~500 frames/s and RAMN RX already uses most of it, so a
// faster-emitting game can't build TX latency: we always ship the freshest values and drop
// superseded ones. (The byte-level corruption this once worked around was an STM32L5 USB PMA
// buffer-overlap bug in the RAMN firmware, since fixed - see RAMN_TOFIX.md; this stays as plain
// backpressure.) gs_usb is covered too (only the SLCAN sendCommand path was serialized before).
const txLatest = new Map();   // id → newest frame awaiting send
let txDraining = false;

window.canForward = function (frame) {
  const txReady = busIsOpen && (port || usbSerDev) && !document.getElementById('listenOnly').checked;
  // NOTE: do NOT ingestFrame() here. Telemetry ids (0x520+) aren't RAMN signals (the decoder
  // ignores them) and this page has no dashboards, so ingesting them did nothing except inflate the
  // RX counter - making the bar's "RX n/s" look alive when the adapter was actually sending nothing.
  // rxCount now reflects ONLY real frames received from the bus (via parseSLCAN / gsUsbPump).
  if (!txReady) return;            // listen-only / no bus → forward nothing
  if (txLatest.has(frame.id)) dropCount++;   // overwriting an un-sent frame = dropped stale telemetry
  txLatest.set(frame.id, frame);
  if (!txDraining) drainDownlink();
};

async function drainDownlink() {
  txDraining = true;
  try {
    while (txLatest.size && busIsOpen && (port || usbSerDev)) {
      const id = txLatest.keys().next().value;   // oldest pending id (Map keeps insertion order)
      const frame = txLatest.get(id);
      txLatest.delete(id);
      try {
        if (connMode === 'gsusb') {
          if (!usbSerDev) break;
          const r = await usbSerDev.transferOut(usbSerOut, gsUsbPackFrame(frame.id, !!frame.isExt, !!frame.isRtr, frame.data));
          if (r && r.status !== 'ok') { log('gs_usb TX ' + r.status, 'err'); continue; }
        } else {
          await sendCommand(buildSlcan(frame));   // already serialized in can-link.js
        }
        txCount++;
      } catch (e) { break; }   // device closed / stalled mid-send - stop; a later frame restarts us
    }
  } finally {
    txDraining = false;
    if (txLatest.size && busIsOpen && (port || usbSerDev)) drainDownlink();   // frames arrived during await
  }
}

// Minimal SLCAN encoder for an outbound frame (txBuildSlcan stays in sloppycan.js).
function buildSlcan(frame) {
  const id = frame.id >>> 0;
  const idHex = id.toString(16).toUpperCase().padStart(frame.isExt ? 8 : 3, '0');
  const dlc = frame.dlc != null ? frame.dlc : frame.data.length;
  const type = frame.isExt ? (frame.isRtr ? 'R' : 'T') : (frame.isRtr ? 'r' : 't');
  const dataHex = frame.isRtr ? '' : frame.data.map(b => (b & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join('');
  return type + idHex + (dlc & 0xF).toString(16).toUpperCase() + dataHex;
}

// ── Carlito glue + wiring (after ramn.js / carlito.js have run) ──────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Carlito needs a live bus to open - on this page that gate is always satisfied once
  // connected (we call carlitoToggle from bridgeConnect), so report ready.
  window.requireBusForCarlito = () => true;
  window.updateTermTrafficWarn = () => {};
  // Suppress Carlito's auto-open of the RAMN dashboard - this page has no dashboards.
  window.ramnIsOpen = () => true;

  document.getElementById('connectBtn').addEventListener('click', bridgeConnect);
  document.getElementById('disconnectBtn').addEventListener('click', disconnectSerial);
  // Fullscreen / zen: hide all chrome, leave only the game. Refresh to exit.
  document.getElementById('zenBtn').addEventListener('click', () => document.body.classList.add('zen'));
});
