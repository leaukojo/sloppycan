// ── sloppyCAN - Architecture Overview ───────────────────────────────────────
// Single-file HTML app using the Web Serial API (Chrome/Edge only).
//
// SERIAL LAYER
//   connectSerial() opens the port at 115200 baud, sends V/N for version,
//   then opens the CAN bus (O or L). readLoop() reads bytes into frameBuffer
//   (CAN mode) or termBuffer (terminal mode). processBuffer() parses SLCAN
//   lines; parseSLCAN() converts them into frame objects fed to ingestFrame().
//
// DATA MODEL
//   frames      - Map<key, frame>: one entry per unique CAN ID, updated live.
//   dumpLog     - RingBuffer(DUMP_MAX, default 100000): every received/sent frame in order.
//   frameNotes  - Map<key, string>: user notes, persists across clear.
//   notchedBytes / stableBytes - set after a Notch run; drive byte colouring.
//   notchSnapshot - Map<key, {ts, data}> taken at notch start.
//
// RENDERING
//   Single RAF loop throttled to 100ms. Calls rerenderTable() (ID List) or
//   renderDump() (Traffic Dump) depending on active tab. Terminal tab pauses
//   CAN rendering. updateStats() runs every tick regardless of tab.
//
// BYTE COLOURS (ID List only, RX frames only)
//   Green  - hot: changed within hotMs (configurable, default 500ms)
//   Amber  - noisy: changed during notch window
//   Grey   - stable: unchanged during notch, current value = snapshot value
//   White  - unclassified: not notched, not recently changed
//   (TX-only frames have no byte colouring)
//
// FILTERS (toolbar)
//   Frame type (STD/EXT), Data type (DATA/RTR), ID list with ranges
//   (e.g. "024, 100-1FF"), Exclude toggle, Data substring (hex/ASCII),
//   Only unseen (white/green bytes), Only highlighted (green only, subset),
//   Only RX (hides TX-only frames).
//
// TABS (main view)
//   ID List | Traffic Dump | Frame Inspector | Serial Terminal
//   Switching to Serial Terminal closes the bus (sends C) and sets terminalMode.
//   Switching back flushes buffers and resumes CAN parsing.
//
// KEY IDs
//   frameKey(f) = "E:<id>" (EXT) or "S:<id>" (STD) - used in all Maps.

// port, reader → can-link.js (shared transport)
let paused = false;
let frames = new Map(); // frameKey → {id, isExt, isRtr, dlc, data, byteChangedAt, count, firstSeen, lastSeen, timestamps, hasRx, hasTx}
let totalFrames = 0;
let parseErrors = 0;
// frameBuffer, termBuffer → can-link.js (shared transport)
let sortKey = 'id';
let sortAsc = true;
let terminalMode = false;
let frameRateBuffer = []; // timestamps
let bytesReceived = 0;
let lastRenderTime = 0;
let changedIds = new Set();
// notchedBytes: Map<frameKey, Set<byteIndex>> - bytes that changed during the notch window (shown amber)
let notchedBytes = new Map();
// stableBytes: Map<frameKey, Map<byteIndex, value>> - bytes unchanged during notch at their observed value (shown grey)
// Grey only applies while the current byte value matches the snapshotted value.
let stableBytes  = new Map();
let notching = false;
let notchTimer = null;
let notchTicker = null;
let notchSnapshot = null;
// When "Filter out" applies the notch IDs, remember what we set + the prior filter so a
// second press can revert. null = nothing applied by Filter out.
let filterOutState = null; // { applied, prevValue, prevExclude }
let hotMs = 500; // configurable highlight duration (log slider pos=25 → 500ms)

// Connection/protocol state + gs_usb constants → can-link.js (shared transport):
//   port, reader, usbSerDev/In/Out, connMode, gsFclk/gsIface/gsEchoId/gsBtConst,
//   SERIAL_USB_FILTERS, _onAndroid, GSUSB_FILTERS, GS_BREQ, GS_MODE, GS_MODE_LISTEN_ONLY,
//   CAN_EFF_FLAG/CAN_RTR_FLAG/CAN_ERR_FLAG/CAN_SFF_MASK/CAN_EFF_MASK.

// Hard-clamp a CAN-ID text input in place: strip non-hex, uppercase, cap to the
// fixed hex width the hardware expects (3 for 11-bit, 8 for 29-bit), and clamp the
// value to range (0x7FF / 0x1FFFFFFF). Leading zeros are preserved as typed.
// Marks the field .invalid when empty. Returns the numeric value (0 when empty).
function clampIdInput(el, ext) {
  if (!el) return 0;
  const maxHex = ext ? 8 : 3;
  const mask = ext ? CAN_EFF_MASK : CAN_SFF_MASK;
  let s = String(el.value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, maxHex);
  if (s !== '' && parseInt(s, 16) > mask) s = mask.toString(16).toUpperCase();
  if (el.value !== s) el.value = s;
  el.maxLength = maxHex;
  el.classList.toggle('invalid', s === '');
  return s === '' ? 0 : parseInt(s, 16);
}
window.clampIdInput = clampIdInput;
// SLCAN_BITRATE_HZ + getBitrateHz() → can-link.js (shared transport)

const pinnedKeys = new Set(); // frameKeys pinned to the top of the ID List
const frameColors = new Map(); // frameKey → CSS hex color string, shown as row left-border
let lastInspectedFrame = null; // used to refresh the inspector after a color change

// Repurposed "Reset prefs": resets the ACTIVE workspace to factory defaults
// (pins, colours, notes, filters, notch, baud, TX rows, ISO-TP). Theme is global
// and is left untouched. Other workspaces are unaffected.
function togglePin(key) {
  if (pinnedKeys.has(key)) pinnedKeys.delete(key);
  else pinnedKeys.add(key);
  scheduleSave(); // persist into the active workspace
  changedIds.clear(); // prevent stale changedIds from triggering flash animations
  rerenderTable();
}

function setFrameColor(key, color) {
  if (color) frameColors.set(key, color);
  else frameColors.delete(key);
  scheduleSave(); // persist into the active workspace
  refreshFrameColorInDump(key);
  rerenderTable();
  // Update the inspector ID text color in-place - avoid full re-render which resets the view
  const idEl = document.getElementById('inspectIdDisplay');
  if (idEl && lastInspectedFrame && frameKey(lastInspectedFrame) === key) {
    idEl.style.color = color || 'var(--text)';
  }
}

function refreshFrameColorInDump(key) {
  const color = frameColors.get(key) || '';
  dumpRowEls.forEach(tr => {
    if (tr.dataset.frameKey === key) tr.style.borderLeft = `3px solid ${color || 'transparent'}`;
  });
}

function snapMs(ms) {
  if (ms < 100)  return Math.round(ms / 10) * 10;
  if (ms < 1000) return Math.round(ms / 50) * 50;
  return Math.round(ms / 1000) * 1000;
}
function snapSeconds(s) {
  if (s < 1)  return Math.round(s * 10) / 10;
  if (s < 10) return Math.round(s * 2) / 2;
  return Math.round(s);
}

let _notchCloseHandler = null;
function toggleNotchPanel() {
  const panel = document.getElementById('notchPanel');
  const open = panel.style.display !== 'none';
  // Always drop any prior outside-click listener first. Closing via the arrow button re-enters here
  // (the old code only self-removed on an *outside* click), so without this listeners stacked on
  // every open/close cycle.
  if (_notchCloseHandler) { document.removeEventListener('click', _notchCloseHandler); _notchCloseHandler = null; }
  panel.style.display = open ? 'none' : 'flex';
  if (!open) {
    // Close on outside click
    setTimeout(() => {
      _notchCloseHandler = (e) => {
        if (!panel.contains(e.target) && e.target.id !== 'notchArrowBtn') {
          panel.style.display = 'none';
          document.removeEventListener('click', _notchCloseHandler);
          _notchCloseHandler = null;
        }
      };
      document.addEventListener('click', _notchCloseHandler);
    }, 0);
  }
}
const frameNotes = new Map(); // key → note string

function saveNotes() {
  scheduleSave(); // persist into the active workspace
}

// ── Ring buffer - O(1) push and oldest-first iteration ──────────────────────
class RingBuffer {
  constructor(capacity) {
    this.buf  = new Array(capacity);
    this.cap  = capacity;
    this.head = 0; // points to oldest entry
    this.size = 0;
  }
  push(item) {
    if (this.size < this.cap) {
      this.buf[(this.head + this.size) % this.cap] = item;
      this.size++;
    } else {
      // Overwrite oldest
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.cap;
    }
  }
  get(i) { // i=0 is oldest
    return this.buf[(this.head + i) % this.cap];
  }
  clear() { this.head = 0; this.size = 0; }
  // Return filtered subset as array (only allocates result, not a copy of full buffer)
  filter(fn) {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const item = this.buf[(this.head + i) % this.cap];
      if (fn(item)) out.push(item);
    }
    return out;
  }
}

// Dump view - ring buffer of raw frames
let DUMP_MAX = 100000; // max entries kept in memory (user-configurable)
const DUMP_ROW_H = 26;  // px per row (must match CSS)
const DUMP_VISIBLE = 60; // rows rendered at a time
let dumpLog = new RingBuffer(DUMP_MAX);
let dumpViewActive = false;
let dumpRowEls = new Map(); // absIndex → <tr> element, for incremental rendering
let dumpRowElsDirty = false; // true = clear all cached rows on next renderDump

function setBufferSize(size) {
  DUMP_MAX = size;
  const newLog = new RingBuffer(size);
  // Copy existing entries that fit
  const keep = Math.min(dumpLog.size, size);
  const offset = dumpLog.size - keep;
  for (let i = 0; i < keep; i++) newLog.push(dumpLog.get(offset + i));
  dumpLog = newLog;
  dumpStartTs = dumpLog.size > 0 ? dumpLog.get(0).ts : null;
  dumpLastFirst = -1; dumpLastLast = -1; dumpLastSize = -1; dumpLastHead = -1;
  dumpFilterDirty = true; dumpFilterCache = null;
  dumpRowElsDirty = true;
  document.getElementById('dumpBody').innerHTML = '';
  dumpRowEls.clear();
  if (dumpViewActive) renderDump();
}

let RENDER_INTERVAL = 100; // ms - changed by setFpsLimit()
function setFpsLimit(fps) {
  RENDER_INTERVAL = fps === 0 ? 16 : Math.round(1000 / fps);
}

// Check Web Serial API
if (!navigator.serial && !(_onAndroid && navigator.usb)) {
  document.getElementById('noSerialBanner').style.display = 'block';
  document.getElementById('connectBtn').disabled = true;
}
// gs_usb is WebUSB-only - disable the option if WebUSB is unavailable
if (!navigator.usb) {
  const opt = document.querySelector('#adapterType option[value="gsusb"]');
  if (opt) opt.disabled = true;
}

// ── TX Scheduler ──────────────────────────────────────────────────────────────
// Periodic CAN frame transmission. Each message has: ID, STD/EXT, RTR, DLC, data (hex),
// period (ms, min 10), enable checkbox, and a Send Once button.
// Data field validated live: must be correct byte count in hex (spaced or concatenated).
// Enable checkbox disabled while data is invalid or period < 10ms.
// "Suspend All" button pauses all timers without losing enabled state.
// Pause (bus close) also triggers Suspend All; Resume re-enables.
// TX frames appear in ID List and Traffic Dump with an orange TX badge.
// TX-only frames are not subject to notch/highlight logic.
let txMessages = [];
let txSeq = 0;
let txSuspended = false;

function toggleTxPanel() {
  const content = document.getElementById('txContent');
  const chevron = document.getElementById('txChevron');
  const open    = content.style.display !== 'none';
  content.style.display = open ? 'none' : '';
  chevron.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
  scheduleSave(); // panel state is a global UI pref
}

// Expand the scheduler if collapsed - called when transmission starts.
function txAutoExpand() {
  const content = document.getElementById('txContent');
  if (content && content.style.display === 'none') toggleTxPanel();
}

window.txAutoExpand = txAutoExpand;   // modules (fuzz.js) expand the panel when they start sending

// Collapse/expand the automatic (module-driven) message section independently.
function toggleTxModule() {
  const body = document.getElementById('txModuleBody');
  const chev = document.getElementById('txModuleChevron');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (chev) chev.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
}

function addTxMessage() {
  txAutoExpand();
  const msg = { seq: txSeq++, enabled: false, ext: false, rtr: false,
                id: '000', dlc: 8, data: '00 00 00 00 00 00 00 00', period: 100, timer: null, note: '' };
  txMessages.push(msg);
  renderTxRows();
  scheduleSave();
}

function removeTxMessage(seq) {
  const msg = txMessages.find(m => m.seq === seq);
  if (msg) { clearInterval(msg.timer); msg.timer = null; }
  txMessages = txMessages.filter(m => m.seq !== seq);
  renderTxRows();
  scheduleSave();
}

function renderTxRows() {
  const body = document.getElementById('txBody');
  body.innerHTML = txMessages.map(msg => {
    const maxIdLen = msg.ext ? 8 : 3;
    return `<div class="tx-row" data-seq="${msg.seq}">
      <button class="btn" style="padding:2px 7px;font-size:11px;color:var(--red);border-color:transparent;margin-right:2px"
        onclick="removeTxMessage(${msg.seq})" title="Remove">✕</button>
      <span class="tx-sep"></span>
      <span class="tx-lbl">ID</span>
      <input type="text" style="width:${msg.ext?80:50}px" maxlength="${maxIdLen}"
        value="${msg.id.toUpperCase().padStart(maxIdLen,'0')}"
        oninput="txSyncField(${msg.seq},'id',this.value)"
        placeholder="${msg.ext?'00000000':'000'}">
      <select onchange="txSetExt(${msg.seq}, this.value==='EXT')">
        <option ${!msg.ext?'selected':''}>STD</option>
        <option ${msg.ext?'selected':''}>EXT</option>
      </select>
      <span class="tx-sep"></span>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
        <input type="checkbox" ${msg.rtr?'checked':''} onchange="txSyncField(${msg.seq},'rtr',this.checked)">
        <span class="tx-lbl">RTR</span>
      </label>
      <span class="tx-sep"></span>
      <span class="tx-lbl">DLC</span>
      <select style="width:44px" onchange="txSetDlc(${msg.seq}, parseInt(this.value))">
        ${[0,1,2,3,4,5,6,7,8].map(n=>`<option ${msg.dlc===n?'selected':''}>${n}</option>`).join('')}
      </select>
      <span class="tx-sep"></span>
      <span class="tx-lbl">Data (hex)</span>
      <input type="text" style="width:${Math.max(80, msg.dlc*27)}px" maxlength="${msg.dlc*3}"
        value="${msg.data}" placeholder="hex bytes"
        oninput="txSyncField(${msg.seq},'data',this.value)"
        class="${!msg.rtr && !txValidateData(msg) ? 'tx-data-invalid' : ''}"
        ${msg.rtr ? 'disabled' : ''}>
      <span class="tx-sep"></span>
      <span class="tx-lbl">Period</span>
      <input type="number" style="width:64px;${msg.period < 10 ? 'border-color:var(--red);background:#f8717115;' : ''}" min="10" max="60000" step="10"
        value="${msg.period}" onchange="txSetPeriod(${msg.seq}, parseInt(this.value))">
      <span class="tx-lbl" style="${msg.period < 10 ? 'color:var(--red)' : ''}">ms</span>
      <span class="tx-sep"></span>
      <input type="checkbox" title="Enable - send periodically" ${msg.enabled ? 'checked' : ''}
        ${!txValidateData(msg) || msg.period < 10 ? 'disabled' : ''}
        onchange="txSetEnabled(${msg.seq}, this.checked)">
      <span class="tx-lbl">Enable</span>
      <span class="tx-sep"></span>
      <button class="btn" id="txonce-${msg.seq}" style="padding:2px 8px;font-size:11px;"
        onclick="txSendOnce(this,${msg.seq})" title="Send once" ${!txValidateData(msg) ? 'disabled' : ''}>
        ▶
      </button>
      <span class="tx-sep"></span>
      <span class="tx-status ${msg.enabled ? (txSuspended ? 'paused' : 'running') : 'stopped'}" id="txstat-${msg.seq}">
        ${msg.enabled ? (txSuspended ? 'Paused' : 'ON') : 'OFF'}
      </span>
      <span class="tx-sep"></span>
      <input type="text" class="note-input" placeholder="note…" maxlength="120"
        value="${escHtml(msg.note || '')}"
        oninput="(txMessages.find(m=>m.seq===${msg.seq})||{}).note=this.value"
        style="flex:1;min-width:80px;width:auto">
    </div>`;
  }).join('') || '<div style="padding:8px 16px;font-size:12px;color:var(--text3);font-family:var(--sans)">No messages. Click Add to create one.</div>';
  updateTxIndicator();
  renderTxModuleRows();
}

// Tokenize the data field into byte strings. Accepts "AA BB CC"
// (space-separated) or "AABBCC" (concatenated); a trailing half-byte is dropped.
function txDataTokens(raw) {
  const s = raw.trim();
  if (s === '') return [];
  return s.includes(' ') ? s.split(/\s+/).filter(Boolean) : (s.match(/.{2}/g) || []);
}

// Numeric data bytes for a TX message, padded/truncated to its DLC.
function txDataBytes(msg) {
  const tokens = txDataTokens(msg.data).slice(0, msg.dlc);
  while (tokens.length < msg.dlc) tokens.push('00');
  return tokens.map(b => (parseInt(b, 16) || 0) & 0xFF);
}

function txValidateData(msg) {
  if (msg.rtr) return true; // RTR doesn't use data
  if (msg.dlc === 0) return true;
  const raw = msg.data.trim();
  if (raw === '') return false;
  // Concatenated form must be an even number of hex digits
  if (!raw.includes(' ') && raw.length % 2 !== 0) return false;
  const bytes = txDataTokens(raw);
  if (bytes.length !== msg.dlc) return false;
  return bytes.every(b => /^[0-9A-Fa-f]{2}$/.test(b));
}

function txAutoDisable(seq) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg || !msg.enabled) return;
  msg.enabled = false;
  clearInterval(msg.timer); msg.timer = null;
  const el = document.getElementById(`txstat-${seq}`);
  if (el) { el.textContent = 'OFF'; el.className = 'tx-status stopped'; }
  // Uncheck the enable checkbox if still in DOM
  const cb = document.querySelector(`.tx-row[data-seq="${seq}"] input[type=checkbox][title]`);
  if (cb) cb.checked = false;
  updateTxIndicator();
}

function txSyncField(seq, field, val) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg) return;
  txAutoDisable(seq);
  if (field === 'id') {
    const idInput = document.querySelector(`.tx-row[data-seq="${seq}"] input[oninput*="'id'"]`);
    if (idInput) { clampIdInput(idInput, msg.ext); val = idInput.value; }
  }
  msg[field] = val;
  if (field === 'data') {
    const input = document.querySelector(`.tx-row[data-seq="${seq}"] input[oninput*="'data'"]`);
    const enableCb = document.querySelector(`.tx-row[data-seq="${seq}"] input[type=checkbox][title]`);
    const valid = txValidateData(msg);
    if (input) input.classList.toggle('tx-data-invalid', !valid);
    if (enableCb) enableCb.disabled = !valid || msg.period < 10;
    const onceBtn = document.getElementById(`txonce-${seq}`);
    if (onceBtn) onceBtn.disabled = !valid;
    if (!valid && msg.enabled) {
      msg.enabled = false;
      clearInterval(msg.timer); msg.timer = null;
      const el = document.getElementById(`txstat-${seq}`);
      if (el) { el.textContent = 'OFF'; el.className = 'tx-status stopped'; }
    }
  }
  if (field === 'rtr') {
    const dataInput = document.querySelector(`.tx-row[data-seq="${seq}"] input[placeholder="hex bytes"]`);
    if (dataInput) {
      dataInput.disabled = val;
      dataInput.classList.toggle('tx-data-invalid', !val && !txValidateData(msg));
    }
    const enableCb = document.querySelector(`.tx-row[data-seq="${seq}"] input[type=checkbox][title]`);
    if (enableCb) enableCb.disabled = !txValidateData(msg) || msg.period < 10;
    const onceBtn = document.getElementById(`txonce-${seq}`);
    if (onceBtn) onceBtn.disabled = !txValidateData(msg);
    const el = document.getElementById(`txstat-${seq}`);
    if (el) { el.textContent = 'OFF'; el.className = 'tx-status stopped'; }
  }
}

function txSetExt(seq, isExt) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg) return;
  txAutoDisable(seq);
  msg.ext = isExt;
  msg.id = msg.id.padStart(isExt ? 8 : 3, '0').slice(-(isExt ? 8 : 3));
  renderTxRows();
}

function txSetDlc(seq, dlc) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg) return;
  txAutoDisable(seq);
  msg.dlc = dlc;
  const bytes = txDataTokens(msg.data);
  while (bytes.length < dlc) bytes.push('00');
  msg.data = bytes.slice(0, dlc).join(' ');
  // Re-validate after adjusting data
  if (!txValidateData(msg) && msg.enabled) {
    msg.enabled = false;
    clearInterval(msg.timer); msg.timer = null;
  }
  renderTxRows();
}

function txSetPeriod(seq, ms) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg) return;
  txAutoDisable(seq); // editing the period disables the message until re-enabled
  msg.period = ms || 0;
  // Update period input border and enable checkbox in-place (no full re-render)
  const valid = msg.period >= 10;
  const periodInput = document.querySelector(`.tx-row[data-seq="${seq}"] input[type=number]`);
  if (periodInput) {
    periodInput.style.borderColor = valid ? '' : 'var(--red)';
    periodInput.style.background  = valid ? '' : '#f8717115';
  }
  const msLbl = periodInput && periodInput.nextElementSibling;
  if (msLbl && msLbl.classList.contains('tx-lbl')) {
    msLbl.style.color = valid ? '' : 'var(--red)';
  }
  const enableCb = document.querySelector(`.tx-row[data-seq="${seq}"] input[type=checkbox][title]`);
  if (enableCb) enableCb.disabled = !txValidateData(msg) || !valid;
}

function txSetEnabled(seq, enabled) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg) return;
  if (enabled && !txValidateData(msg)) {
    const cb = document.querySelector(`.tx-row[data-seq="${seq}"] input[type=checkbox][title]`);
    if (cb) cb.checked = false;
    return;
  }
  msg.enabled = enabled;
  if (enabled) txAutoExpand();
  if (enabled && !txSuspended) {
    txSendOne(msg);   // immediate first send
    txArm(msg);       // then a self-rescheduling loop
  } else {
    clearInterval(msg.timer); msg.timer = null;
  }
  const el = document.getElementById(`txstat-${seq}`);
  if (el) {
    el.textContent = enabled ? (txSuspended ? 'Paused' : 'ON') : 'OFF';
    el.className = `tx-status ${enabled ? (txSuspended ? 'paused' : 'running') : 'stopped'}`;
  }
  updateTxIndicator();
}

// Arm a TX message's periodic send as a self-rescheduling timeout: the next send is queued only
// AFTER the current one resolves, so on a slow/stalled bus (write latency > period) sends can't
// pile up in the serialized write queue the way setInterval-over-an-async-callback would. Cancel
// the usual way - clearInterval/clearTimeout(msg.timer) (interchangeable) + msg.timer = null. The
// re-arm guard mirrors the enable/suspend flags the cancel sites set, so a disable or suspend that
// lands during the await simply skips the next re-arm.
function txArm(msg) {
  const tick = async () => {
    msg.timer = null;                 // this firing consumed the handle
    await txSendOne(msg);
    if (msg.enabled && !txSuspended) msg.timer = setTimeout(tick, msg.period);
  };
  msg.timer = setTimeout(tick, msg.period);
}

function txBuildSlcan(msg) {
  const id     = msg.id.trim().toUpperCase().padStart(msg.ext ? 8 : 3, '0');
  const prefix = msg.rtr ? (msg.ext ? 'R' : 'r') : (msg.ext ? 'T' : 't');
  let frame = prefix + id + msg.dlc;
  if (!msg.rtr) {
    frame += txDataBytes(msg).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return frame;
}

// Throttled TX-error log: a persistently failing bus (adapter unplugged) would otherwise show only a
// tiny status badge with nothing in the console. Throttle so a fast TX loop can't flood the log.
let _lastTxErrLog = 0;
function logTxErr(e) {
  const t = Date.now();
  if (t - _lastTxErrLog > 2000) { _lastTxErrLog = t; log(`TX failed: ${e.message}`, 'err'); }
}

// Raw wire-send only - no dump/frames-map recording. Shared by txSendOne and window.canForward.
async function txTransmitRaw(msg) {
  if (connMode === 'gsusb') {
    // NOTE: unlike the SLCAN branch (serialized via sendCommand), this transferOut is NOT serialized.
    // Un-awaited bursts (e.g. canForward telemetry) can overlap on the OUT endpoint. Lower risk than
    // SLCAN (one URB per binary frame, no byte-interleave), but if gs_usb TX ever drops/reorders
    // frames, route it through the same write-queue. See memory: slcan-write-serialization.
    if (!usbSerDev) return;   // disconnect can null the device between scheduling and here
    const r = await usbSerDev.transferOut(usbSerOut, gsUsbBuildFrame(msg));
    if (r && r.status !== 'ok') log(`gs_usb TX ${r.status}`, 'err');
  } else await sendCommand(txBuildSlcan(msg));
}

// Record a transmitted frame into the dump log + frames map. Shared by txSendOne, fuzzTxFrame and
// isotpTxCan. `data` is stored by reference - pass a caller-owned array that won't be mutated after.
function recordTxFrame(id, isExt, isRtr, dlc, data) {
  const now = Date.now();
  dumpLog.push({ ts: now, isTx: true, id, isExt, isRtr, dlc, data });
  dumpFilterDirty = true;
  const key = frameKey({ isExt, id });
  if (frames.has(key)) {
    const ex = frames.get(key);
    ex.hasTx = true; ex.count++; ex.lastSeen = now; ex.timestamps.push(now);
    if (ex.timestamps.length > 120) ex.timestamps.splice(0, 20);
    if (!ex.hasRx) { ex.data = data; ex.dlc = dlc; ex.isRtr = isRtr; } // ID list shows latest TX payload
  } else {
    frames.set(key, { id, isExt, isRtr, dlc, data,
      byteChangedAt: [], count: 1, firstSeen: now, lastSeen: now, timestamps: [now],
      hasRx: false, hasTx: true });
  }
}

async function txSendOne(msg) {
  if (!busIsOpen || (!port && !usbSerDev && !demoMode)) {
    const el = document.getElementById(`txstat-${msg.seq}`);
    if (el) { el.textContent = 'NO BUS'; el.className = 'tx-status error'; }
    return;
  }
  try {
    await txTransmitRaw(msg);
    const id = parseInt(msg.id, 16);
    const dataBytes = txDataBytes(msg);
    recordTxFrame(id, msg.ext, msg.rtr, msg.dlc, dataBytes);
    // Mirror the transmitted frame into the RAMN decoder, as an RX frame would, so the
    // corresponding dashboard control updates. Carlito picks it up via ramnGetState next tick.
    if (window.ramnIngestFrame)
      ramnIngestFrame({ id, isExt: msg.ext, isRtr: msg.rtr, dlc: msg.dlc, data: dataBytes });
    if (msg.enabled) {
      const el = document.getElementById(`txstat-${msg.seq}`);
      if (el) {
        el.textContent = txSuspended ? 'Paused' : 'ON';
        el.className = `tx-status ${txSuspended ? 'paused' : 'running'}`;
      }
    }
  } catch(e) {
    logTxErr(e);
    const el = document.getElementById(`txstat-${msg.seq}`);
    if (el) { el.textContent = 'ERR'; el.className = 'tx-status error'; }
  }
}

function txSendOnce(btn, seq) {
  const msg = txMessages.find(m => m.seq === seq);
  if (!msg) return;
  if (!txValidateData(msg)) return; // never transmit an invalid/short data field
  txSendOne(msg);
  btn.classList.add('flash-green');
  setTimeout(() => btn.classList.remove('flash-green'), 250);
}

function stopAllTx() {
  txMessages.forEach(m => { clearInterval(m.timer); m.timer = null; m.enabled = false; });
  txSuspended = false;
  const btn = document.getElementById('txSuspendBtn');
  if (btn) {
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Suspend All`;
    btn.classList.remove('active-notch');
  }
  renderTxRows();
}

// TX Scheduler "Transmitting" indicator - visible whenever timers are actively
// sending (≥1 enabled message and not suspended). Lives on the panel header so
// the feedback is right next to the controls, and tints the header to draw the eye.
function updateTxIndicator() {
  const active = !txSuspended && txMessages.some(m => m.enabled);
  const badge = document.getElementById('txActiveBadge');
  if (badge) badge.style.display = active ? 'inline-flex' : 'none';
  const panel = document.getElementById('txPanel');
  if (panel) panel.classList.toggle('transmitting', active);
}

// One read-only TX-scheduler row mirroring a frame driven by another module
// (Quick Watch, Fuzzer). Non-editable - purely informational - and tinted with
// the TX warning colour so it reads as "this is being transmitted, not by you".
function txModuleRowHtml(module, idText, ext, dataText, periodText, note) {
  return `<div class="tx-row tx-module-row" title="Sent by ${escHtml(module)} - read-only">
    <span class="tx-module-tag">${escHtml(module)}</span>
    <span class="tx-sep"></span>
    <span class="tx-lbl">ID</span><span class="tx-module-val">${escHtml(idText)}</span>
    <span class="tx-module-type">${ext ? 'EXT' : 'STD'}</span>
    <span class="tx-sep"></span>
    <span class="tx-lbl">Data</span><span class="tx-module-val">${escHtml(dataText)}</span>
    <span class="tx-sep"></span>
    <span class="tx-lbl">Period</span><span class="tx-module-val">${escHtml(periodText)}</span>
    <span class="tx-sep"></span>
    <span class="tx-module-note">${escHtml(note || '')}</span>
  </div>`;
}

// Refresh the read-only module-driven rows beneath the editable TX rows.
function renderTxModuleRows() {
  const body = document.getElementById('txModuleBody');
  const section = document.getElementById('txModuleSection');
  if (!body || !section) return;
  const rows = [];
  // OBD-II Quick Watch - one round-robin poll per watched PID on the ISO-TP Tx ID.
  if (obdWatchOn && obdWatch.length) {
    const cfg = isotpCfg();
    const idHex = (cfg.txId >>> 0).toString(16).toUpperCase().padStart(cfg.isExt ? 8 : 3, '0');
    const eff = Math.max(60, obdPollMs) * obdWatch.length;       // effective per-PID interval
    const periodText = txSuspended ? 'paused' : `~${eff} ms`;
    obdWatch.forEach(pid => {
      const ph = pid.toString(16).toUpperCase().padStart(2, '0');
      const name = OBD_PID01[pid] ? ` · ${OBD_PID01[pid]}` : '';
      rows.push(txModuleRowHtml('Quick Watch', idHex, cfg.isExt, `01 ${ph}`, periodText, `Mode 01 PID ${ph}${name}`));
    });
  }
  // Fuzzer - randomized frames; show a single summary row.
  const fz = window.fuzzModuleSummary ? window.fuzzModuleSummary() : null;
  if (fz) rows.push(txModuleRowHtml('Fuzzer', fz.idText, fz.ext, fz.dataText, fz.periodText, fz.note));

  body.innerHTML = rows.join('');
  section.style.display = rows.length ? '' : 'none';   // body's own collapse is via toggleTxModule
  const cnt = document.getElementById('txModuleCount');
  if (cnt) cnt.textContent = rows.length;
}
window.renderTxModuleRows = renderTxModuleRows;   // fuzz.js refreshes its summary row through this

// ── Fuzzer hooks (used by fuzz.js) ────────
// Single seam the fuzzer calls to put a raw frame on the wire. Mirrors the
// transport branch + dumpLog/frames bookkeeping in txSendOne, but takes raw
// values (id number, byte array) instead of a scheduler row object.
window.fuzzBusReady = () => busIsOpen && (port || usbSerDev || demoMode);
// TX allowed only on an open bus that isn't listen-only. Single accessor so modules don't each
// reach into the #listenOnly DOM id (which throws if renamed). Mirrors obdBusReady's intent.
window.txReady = () => !!window.fuzzBusReady() && !document.getElementById('listenOnly').checked;
window.fuzzBusPaused = () => paused;

// IDs currently observed in the ID list (numbers) for idMode:'observed'.
window.fuzzObservedIds = (wantExt) => {
  const out = [];
  for (const f of frames.values()) if (!!f.isExt === !!wantExt) out.push(f.id);
  return out;
};

// Cross-module TX arbiter. fuzz/xcp/canopen all transmit through window.fuzzTxFrame; without
// serialization a running fuzzer + an XCP transaction + a CANopen SDO could interleave their
// transferOut/sendCommand writes on the bus. withTxLock chains transactions so only one is in
// flight at a time. The fuzzer acquires the lock per frame and releases between interval ticks,
// so it can't starve the request→response modules. (SLCAN byte-writes are already serialized in
// sendCommand; this is the higher-level mutual exclusion across the shared fuzzTxFrame seam.
// Manual TX / ISO-TP are separate single-user flows and don't share this lock.)
let txLockChain = Promise.resolve();
window.withTxLock = (fn) => {
  const run = txLockChain.then(fn, fn);          // run after the prior tx settles (success or failure)
  txLockChain = run.then(() => {}, () => {});     // keep the chain alive; one failure doesn't poison it
  return run;
};

window.fuzzTxFrame = (id, isExt, dlc, bytes) => window.withTxLock(async () => {
  if (!window.fuzzBusReady()) return false;
  try {
    if (connMode === 'gsusb') {
      const r = await usbSerDev.transferOut(usbSerOut, gsUsbPackFrame(id, isExt, false, bytes));
      if (r && r.status !== 'ok') log(`gs_usb TX ${r.status}`, 'err');
    } else if (!demoMode) {
      const idHex = (id & (isExt ? CAN_EFF_MASK : CAN_SFF_MASK)).toString(16).toUpperCase().padStart(isExt ? 8 : 3, '0');
      await sendCommand((isExt ? 'T' : 't') + idHex + dlc + bytes.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(''));
    }
    recordTxFrame(id, isExt, false, dlc, [...bytes]);
    return true;
  } catch(e) { logTxErr(e); return false; }
});

// ── Utilities ────────────────────────────────────────────────────────────────
function frameKey(f) {
  return `${f.isExt ? 'E' : 'S'}:${f.id}`;
}

// Shared formatters used by several modules (j1939/chademo/xcp/canopen). Defined once
// here and aliased in each module (sloppycan.js runs before the deferred modules) instead
// of re-implementing the same logic per file.
window.canRelTs = (ts) => {
  const s = (Date.now() - ts) / 1000;
  return s < 1 ? 'now' : s < 60 ? s.toFixed(1) + 's ago' : Math.round(s / 60) + 'm ago';
};
window.canHexBytes = (data) => Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
window.canParseIntAuto = (str) => {
  const t = (str || '').trim();
  const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, /^[0-9a-f]+$/i.test(t) && /[a-f]/i.test(t) ? 16 : 10);
  return Number.isFinite(v) ? v >>> 0 : NaN;
};

// Shared "stacked log tab" factory used by the chademo / xcp / canopen modules. Each of those
// tabs is a top panel (session/nodes) stacked over a scrolling frame-log table, driven by an
// identical rAF render loop with dirty/visibility gating + ~15 fps throttle, and an identical
// log ring (append + cap + optional same-id coalesce) + table builder (empty-state, near-bottom
// scroll-follow). This owns all of that; the module supplies only its decode/session/TX specifics.
//
// cfg: { wrapId, logElId, tableClass, theadHtml, emptyHtml, rowHtml(e), renderTop(),
//        onTick?, coalesce?(prev,e), renderMs=67, logMax=600, readoutElId?, txHintElId? }
// returns: { markDirty, pushLog, clearLog, render, ready, showTxHint, readout }
window.makeStackedLogTab = function (cfg) {
  const renderMs = cfg.renderMs || 67;     // ~15 fps cap on the full-table innerHTML rebuild
  const logMax   = cfg.logMax   || 600;
  let log = [];
  let dirty = false, wasHidden = true, lastRender = 0, lastTick = 0;

  function markDirty() { dirty = true; }

  // Append to the ring, coalescing a consecutive same-stream entry into the previous row (so a
  // fast DAQ/PDO burst updates one row + a ×N badge instead of flooding the DOM).
  function pushLog(e) {
    const prev = log[log.length - 1];
    if (prev && cfg.coalesce && cfg.coalesce(prev, e)) {
      prev.ts = e.ts; prev.data = e.data; prev.summary = e.summary;
      prev.count = (prev.count || 1) + 1; dirty = true; return;
    }
    log.push(e);
    if (log.length > logMax) log.shift();
    dirty = true;
  }

  function clearLog() { log = []; dirty = true; }

  // Rebuild the frame-log table, preserving scroll: stick to the bottom if already near it,
  // else hold the prior scroll position (an innerHTML rebuild otherwise resets scrollTop to 0).
  function renderLog() {
    const el = document.getElementById(cfg.logElId);
    if (!el) return;
    if (!log.length) { el.innerHTML = cfg.emptyHtml; return; }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const prevTop = el.scrollTop;
    el.innerHTML = `<table class="${cfg.tableClass}"><thead>${cfg.theadHtml}</thead><tbody>` +
      log.map(cfg.rowHtml).join('') + '</tbody></table>';
    if (nearBottom) el.scrollTop = el.scrollHeight; else el.scrollTop = prevTop;
  }

  function render() {
    const wrap = document.getElementById(cfg.wrapId);
    if (!wrap || wrap.style.display === 'none') { wasHidden = true; return; }
    if (wasHidden) { wasHidden = false; dirty = true; }
    if (cfg.onTick) cfg.onTick();                 // unthrottled per-frame (e.g. button enable state)
    if (!dirty) return;
    // Throttle the full-table rebuild; don't clear dirty while throttled so the next RAF still
    // renders once the window elapses.
    const now = Date.now();
    if (now - lastRender < renderMs) return;
    lastRender = now;
    dirty = false;
    cfg.renderTop();
    renderLog();
  }

  function loop() {
    const now = Date.now();
    if (now - lastTick >= 1000) { dirty = true; lastTick = now; }   // tick relative timestamps
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);   // first tick on the next frame, after the caller's `const tab = …` settles

  // Opt-in active-TX helpers (xcp/co). Bus-ready test is identical across modules.
  const ready = () => window.txReady ? window.txReady()
    : (!!(window.fuzzBusReady && window.fuzzBusReady()) && !document.getElementById('listenOnly').checked);
  const showTxHint = () => { const h = cfg.txHintElId && document.getElementById(cfg.txHintElId); if (h) h.style.display = ''; };
  const readout = (msg, isErr) => { const el = cfg.readoutElId && document.getElementById(cfg.readoutElId); if (el) { el.textContent = msg; el.classList.toggle('err', !!isErr); } };

  return { markDirty, pushLog, clearLog, render, ready, showTxHint, readout };
};

// ── Connection / bus state reset ──────────────────────────────────────────────
function resetConnectionState() {
  frameBuffer  = '';
  termBuffer   = '';
  terminalMode = false;
  busIsOpen    = false;
  notchedBytes.clear();
  stableBytes.clear();
  notching      = false;
  notchSnapshot = null;
}

// Keep the Data-filter placeholder in step with the Display format, so it's clear
// which representation the search matches (Hex+ASCII searches both).
function syncDataPlaceholder() {
  const el = document.getElementById('filterData');
  if (!el) return;
  el.placeholder = 'FILTER DATA';
}

function getFilter() {
  const frameType  = document.getElementById('filterFrameType').value;
  const dataType   = document.getElementById('filterDataType').value;
  const idsRaw     = document.getElementById('filterIds').value.trim();
  const idsExclude = document.getElementById('filterIdsExclude').checked;
  const dataRaw    = document.getElementById('filterData').value.trim().toLowerCase();
  const ids = idsRaw ? idsRaw.split(',').map(s => {
    const t = s.trim();
    const range = t.match(/^([0-9A-Fa-f]+)\s*-\s*([0-9A-Fa-f]+)$/);
    if (range) {
      const lo = parseInt(range[1], 16), hi = parseInt(range[2], 16);
      return isNaN(lo) || isNaN(hi) ? null : { range: true, lo: Math.min(lo,hi), hi: Math.max(lo,hi) };
    }
    const v = parseInt(t, 16);
    return isNaN(v) ? null : { range: false, val: v };
  }).filter(Boolean) : [];
  const onlyHighlighted = document.getElementById('filterOnlyHighlighted').checked;
  const onlyUnseen      = document.getElementById('filterOnlyUnseen').checked;
  const onlyRx          = document.getElementById('filterOnlyRx').checked;
  const dataFmt         = document.getElementById('byteFormat').value; // scope the Data search to the Display format
  return { frameType, dataType, ids, idsExclude, dataRaw, dataFmt, onlyHighlighted, onlyUnseen, onlyRx };
}

// Red-outline the Filter IDs field when any comma-separated token is not a valid
// hex ID or hex range (e.g. "024", "000-02F").
function validateFilterIds() {
  const el = document.getElementById('filterIds');
  const raw = el.value.trim();
  const bad = raw && raw.split(',').some(s => {
    const t = s.trim();
    if (!t) return false;
    if (/^[0-9A-Fa-f]+\s*-\s*[0-9A-Fa-f]+$/.test(t)) return false;
    return isNaN(parseInt(t, 16)) || !/^[0-9A-Fa-f]+$/.test(t);
  });
  el.classList.toggle('invalid', !!bad);
  syncFilterOutState();
}

// If the user manually edits the ID filter / Exclude away from what "Filter out"
// applied, the second-press revert no longer applies - drop the state so the
// button label flips back from "Undo filter" to "Filter out".
function syncFilterOutState() {
  if (!filterOutState) return;
  const field = document.getElementById('filterIds');
  const excl  = document.getElementById('filterIdsExclude');
  if (!field || field.value !== filterOutState.applied || !excl || !excl.checked) {
    filterOutState = null;
    updateFilterOutBtn();
  }
}

function applyFilter(f, flt) {
  if (flt.frameType === 'std' && f.isExt) return false;
  if (flt.frameType === 'ext' && !f.isExt) return false;
  if (flt.dataType === 'data' && f.isRtr) return false;
  if (flt.dataType === 'rtr'  && !f.isRtr) return false;
  if (flt.ids.length > 0) {
    const match = flt.ids.some(e => e.range ? (f.id >= e.lo && f.id <= e.hi) : f.id === e.val);
    if (flt.idsExclude ? match : !match) return false;
  }
  if (flt.dataRaw) {
    // Search the representation that matches the current Display format:
    // Hex → hex only, ASCII → ASCII only, Binary → bits only, Hex+ASCII → either.
    const data   = f.data || [];
    const needle = flt.dataRaw.replace(/\s+/g, '');           // hex/bin ignore whitespace
    const hexStr = () => data.map(b => b.toString(16).padStart(2,'0')).join('');
    const binStr = () => data.map(b => b.toString(2).padStart(8,'0')).join('');
    const ascStr = () => data.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('').toLowerCase();
    let match;
    switch (flt.dataFmt) {
      case 'hex':   match = hexStr().includes(needle); break;
      case 'bin':   match = binStr().includes(needle); break;
      case 'ascii': match = ascStr().includes(flt.dataRaw); break;            // keep internal spaces
      default:      match = hexStr().includes(needle) || ascStr().includes(flt.dataRaw); // hexascii
    }
    if (!match) return false;
  }
  // Only RX: exclude frames that are TX-only (hasTx true, hasRx false); for dump entries use isTx
  if (flt.onlyRx) {
    if (f.isTx === true) return false;          // dump entry: explicitly TX
    if (f.hasTx && !f.hasRx) return false;       // ID list: TX-only frame
  }
  if (flt.onlyHighlighted || flt.onlyUnseen) {
    // TX frames are not subject to notch/highlight logic - skip these filters for them
    const isTxFrame = f.isTx === true || (f.hasTx && !f.hasRx);
    if (!isTxFrame) {
      const now = Date.now();
      const key = frameKey(f);
      const isNewId   = notchSnapshot !== null && !notchSnapshot.has(key);
      const noisySet  = notchedBytes.get(key) || null;
      const stableMap = stableBytes.get(key)  || null;
      // Dump entries have no byteChangedAt; use data array for byte-level checks
      const isDumpEntry = f.byteChangedAt === undefined;

      if (flt.onlyHighlighted && !isDumpEntry) {
        // "Only highlighted" relies on per-byte timestamps - only meaningful in ID List
        if (isNewId) return true;
        const hot = (f.byteChangedAt || []).some((t, i) => {
          if (noisySet  && noisySet.has(i))  return false;
          if (stableMap && stableMap.has(i) && f.data[i] === stableMap.get(i)) return false;
          return (now - t) < hotMs;
        });
        if (!hot) return false;
      }

      if (flt.onlyUnseen) {
        if (isNewId) return true;
        // For dump entries use f.data directly; for ID List use byteChangedAt indices
        const bytes = isDumpEntry ? (f.data || []) : (f.byteChangedAt || []);
        const hasUnnotched = bytes.some((_, i) => {
          if (noisySet  && noisySet.has(i))  return false;
          if (stableMap && stableMap.has(i) && (f.data || [])[i] === stableMap.get(i)) return false;
          return true;
        });
        if (!hasUnnotched) return false;
      }
    }
  }
  return true;
}

// ── "All frames filtered out" notice ──────────────────────────────────────
// Map each active filter dimension to the toolbar control(s) the user should
// look at, so attention follows the real cause (not always the ID field).
function activeFilterEls(flt) {
  const by = id => document.getElementById(id);
  const els = [];
  if (flt.frameType !== 'all') els.push(by('filterFrameType'));
  if (flt.dataType  !== 'all') els.push(by('filterDataType'));
  if (flt.ids.length > 0) {
    els.push(by('filterIds'));
    if (flt.idsExclude) els.push(by('filterIdsExclude').closest('label'));
  }
  if (flt.dataRaw)         els.push(by('filterData'));
  if (flt.onlyRx)          els.push(by('filterOnlyRx').closest('label'));
  if (flt.onlyHighlighted) els.push(by('filterOnlyHighlighted').closest('label'));
  if (flt.onlyUnseen)      els.push(by('filterOnlyUnseen').closest('label'));
  return els.filter(Boolean);
}

// True when at least one filter dimension is narrowing results.
function hasActiveFilter(flt) {
  return activeFilterEls(flt).length > 0;
}

const filterEmptyOn = { ids: false, dump: false };
let filterAttentionOn = false;

// Drive the amber highlight on the active filter controls. Pulse once on first
// entry into the empty state, then hold a steady border until results return.
function refreshFilterAttention(flt) {
  // Only one view is visible at a time - let it own the shared toolbar highlight.
  const anyEmpty = dumpViewActive ? filterEmptyOn.dump : filterEmptyOn.ids;
  document.querySelectorAll('.filter-attention').forEach(el => el.classList.remove('filter-attention'));
  if (anyEmpty) {
    const els = activeFilterEls(flt);
    els.forEach(el => el.classList.add('filter-attention'));
    if (!filterAttentionOn) {
      els.forEach(el => {
        el.classList.remove('filter-pulse');
        void el.offsetWidth; // restart the animation
        el.classList.add('filter-pulse');
        el.addEventListener('animationend', () => el.classList.remove('filter-pulse'), { once: true });
      });
    }
  } else {
    document.querySelectorAll('.filter-pulse').forEach(el => el.classList.remove('filter-pulse'));
  }
  filterAttentionOn = anyEmpty;
}

// Show/hide the centered notice for one view, then refresh the shared attention.
function setFilterEmptyState(view, show, flt) {
  const notice = document.getElementById(view === 'ids' ? 'idsFilterEmpty' : 'dumpFilterEmpty');
  if (!notice) return;
  notice.style.display = show ? 'flex' : 'none';
  filterEmptyOn[view] = show;
  refreshFilterAttention(flt);
}

// Reset every filter control to its default and re-render both views.
function clearAllFilters() {
  document.getElementById('filterFrameType').value = 'all';
  document.getElementById('filterDataType').value  = 'all';
  document.getElementById('filterIds').value  = '';
  document.getElementById('filterData').value = '';
  document.getElementById('filterIdsExclude').checked      = false;
  document.getElementById('filterOnlyRx').checked          = false;
  document.getElementById('filterOnlyHighlighted').checked = false;
  document.getElementById('filterOnlyUnseen').checked      = false;
  validateFilterIds();
  filterOutState = null;
  if (typeof updateFilterOutBtn === 'function') updateFilterOutBtn();
  document.querySelectorAll('.filter-attention').forEach(el => el.classList.remove('filter-attention'));
  document.querySelectorAll('.filter-pulse').forEach(el => el.classList.remove('filter-pulse'));
  dumpFilterDirty = true; dumpLastSize = -1;
  rerenderTable(); renderDump();
}

function toggleConsole() {
  const panel   = document.getElementById('logPanel');
  const pane    = document.getElementById('pane-console');
  const chevron = document.getElementById('consoleChevron');
  const open    = pane.style.display !== 'none';
  pane.style.display = open ? 'none' : '';
  panel.style.height  = open ? '28px' : '200px';
  chevron.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
  scheduleSave(); // panel state is a global UI pref
}

function log(msg, cls = '') {
  const body = document.getElementById('pane-console');
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = `<span class="log-ts">${ts}</span><span class="log-msg ${cls}">${escHtml(String(msg))}</span>`;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 500) body.removeChild(body.firstChild);
  // Auto-expand console on errors - only when opted in (off by default, so a burst of errors
  // doesn't keep popping the console open while the user works).
  if (cls === 'err' && body.style.display === 'none' && document.getElementById('autoExpandErr')?.checked) toggleConsole();
}

function escHtml(s) {
  // Escapes quotes too, so output is safe in double/single-quoted attribute contexts
  // (e.g. value="${escHtml(note)}") and not just element-text contexts. User notes persist
  // in workspaces and can be imported, so an un-escaped quote would be stored XSS.
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Transient toast (top-right). type: 'err' | 'warn' | 'ok'. Click to dismiss.
function showToast(msg, type = 'err', ms = 5000) {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = String(msg);
  const dismiss = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 200); };
  el.onclick = dismiss;
  host.appendChild(el);
  setTimeout(dismiss, ms);
}

function termLog(direction, text) {
  const body = document.getElementById('termBody');
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
  const el = document.createElement('div');
  el.className = 'log-entry';
  const dirColor = direction === 'tx' ? 'var(--amber)' : 'var(--green)';
  const dirLabel = direction === 'tx' ? 'TX' : 'RX';
  el.innerHTML = `<span class="log-ts">${ts}</span><span style="color:${dirColor};font-weight:500;min-width:20px">${dirLabel}</span><span class="log-msg" style="color:var(--text)">${escHtml(text)}</span>`;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 1000) body.removeChild(body.firstChild);
}

function termKeydown(e) {
  if (e.key === 'Enter') { termSend(); return; }
  // ArrowUp/Down walk the command history with a cursor (mirrors isotpKeydown), instead of
  // always jumping to the last entry.
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!termHistory.length) return;
    if (termHistoryIdx === -1) termHistoryIdx = termHistory.length - 1;
    else if (termHistoryIdx > 0) termHistoryIdx--;
    e.target.value = termHistory[termHistoryIdx];
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (termHistoryIdx === -1) return;
    if (termHistoryIdx < termHistory.length - 1) {
      e.target.value = termHistory[++termHistoryIdx];
    } else {
      termHistoryIdx = -1;
      e.target.value = '';
    }
  }
}

const termHistory = [];
let termHistoryIdx = -1;
async function termSend() {
  const input = document.getElementById('termInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  termHistory.push(cmd);
  termHistoryIdx = -1;
  input.value = '';
  await sendCommand(cmd);
}

// encodeCmd, sendCommand/sendCommandRaw (serialized SLCAN write), recentTx/recentTxPush,
// and busIsOpen → can-link.js (shared transport).

function getOpenCmd() {
  return document.getElementById('listenOnly').checked ? 'L' : 'O';
}
function getBaudCmd() {
  return document.getElementById('baudRate').value; // S0–S8
}

async function busOpen() {
  const listenOnly = document.getElementById('listenOnly').checked;
  try {
    if (connMode === 'gsusb') {
      await gsSetMode(true, listenOnly);
      log(`Bus opened (gs_usb ${getBitrateHz()/1000}k${listenOnly ? ', listen-only' : ''})`, 'ok');
    } else {
      const baudCmd = getBaudCmd();
      await sendCommand(baudCmd);
      const cmd = getOpenCmd();
      await sendCommand(cmd);
      log(`Bus opened (${baudCmd}, ${cmd})`, 'ok');
    }
    busIsOpen = true;   // only mark open if the open commands actually went out
    paused = false;
    updateBusPauseBtn();
    if (window.carlitoBusReady) window.carlitoBusReady(); // ← open Carlito if it was requested before a bus existed
  } catch (e) {
    log(`Bus open failed: ${e.message}`, 'err');
  }
}

function toggleTxSuspend() {
  txSuspended = !txSuspended;
  const btn = document.getElementById('txSuspendBtn');
  if (txSuspended) {
    // Stop all running timers
    txMessages.forEach(m => { if (m.timer) { clearInterval(m.timer); m.timer = null; } });
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume All`;
    btn.classList.add('active-notch'); // amber highlight
    log('TX suspended', 'warn');
  } else {
    // Restart timers for all enabled messages
    txMessages.forEach(m => {
      if (m.enabled && !m.timer) txArm(m);
    });
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Suspend All`;
    btn.classList.remove('active-notch');
    log('TX resumed', 'ok');
  }
  obdWatchUpdateIndicator();
  renderTxRows();
}

// openWebUSBCDC (Android CDC-ACM open) → can-link.js (shared transport)

// ── gs_usb transport ───────────────────────────────────────────────────────────
// Device/protocol primitives → can-link.js (shared transport): openGsUsb,
// gsBitTimingPass, gsCalcBitTiming, gsSetBitTiming, gsSetMode, usbRecoverStall,
// gsUsbPump, gsUsbPackFrame. gsUsbBuildFrame (TX-scheduler glue) stays below.

// gsBitTimingPass, gsCalcBitTiming, gsSetBitTiming, gsSetMode, USB_MAX_STALLS,
// usbRecoverStall, gsUsbPump, gsUsbPackFrame → can-link.js (shared transport).

function gsUsbBuildFrame(msg) {
  return gsUsbPackFrame(parseInt(msg.id, 16), msg.ext, msg.rtr, txDataBytes(msg));
}

// dispatchSerialText + usbSerialPump (Android WebUSB RX) → can-link.js (shared transport)

// Hardware-connection warning. Returns a Promise<bool> (true = proceed).
// Offers a "don't show again for this workspace" checkbox, persisted on the
// workspace. The dismissal is cleared when the workspace is reset.
function hwConnectWarning() {
  const ws = workspaces.find(w => w.id === activeWsId);
  if (ws && ws.hwWarnDismissed) return Promise.resolve(true);

  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;'
      + 'justify-content:center;background:#0008;backdrop-filter:blur(2px)';
    ov.innerHTML =
      `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;`
      + `max-width:440px;padding:22px 24px;font-family:var(--sans);color:var(--text);box-shadow:0 8px 40px #000a">`
      + `<div style="font-weight:600;font-size:15px;margin-bottom:10px;color:var(--amber)">Connect to hardware?</div>`
      + `<div style="font-size:13px;line-height:1.5;color:var(--text2)">This AI-built tool is for education only. `
      + `Use it only with testbeds and simulators. Connecting to a real vehicle is dangerous, strongly discouraged, `
      + `and against SloppyCAN's license.</div>`
      + `<label style="display:flex;align-items:center;gap:8px;margin-top:16px;font-size:12px;color:var(--text2);cursor:pointer">`
      + `<input type="checkbox" id="hwWarnDismiss"> Don't show again for this workspace</label>`
      + `<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">`
      + `<button id="hwWarnCancel" style="padding:7px 14px;border-radius:6px;border:1px solid var(--border2);`
      + `background:var(--bg3);color:var(--text);cursor:pointer;font-family:var(--sans)">Cancel</button>`
      + `<button id="hwWarnOk" style="padding:7px 14px;border-radius:6px;border:1px solid var(--amber);`
      + `background:var(--amber-dim);color:var(--amber);cursor:pointer;font-family:var(--sans)">Continue</button></div></div>`;
    document.body.appendChild(ov);
    const close = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('#hwWarnCancel').onclick = () => close(false);
    ov.querySelector('#hwWarnOk').onclick = () => {
      if (ws && ov.querySelector('#hwWarnDismiss').checked) {
        ws.hwWarnDismissed = true;
        saveWorkspaces();
      }
      close(true);
    };
    ov.addEventListener('click', e => { if (e.target === ov) close(false); });
  });
}

async function connectSerial() {
  const adapter = document.getElementById('adapterType').value; // 'serial' | 'gsusb'
  if (!await hwConnectWarning()) return;
  try {
    if (adapter === 'gsusb') {
      connMode = 'gsusb';
      const {dev, inEp, outEp, name} = await openGsUsb();
      usbSerDev = dev; usbSerIn = inEp; usbSerOut = outEp;
      await gsSetBitTiming(getBitrateHz());
      log(`gs_usb device opened (${name})`, 'ok');
      document.getElementById('deviceInfo').textContent = `${name} (gs_usb)`;
      if (terminalMode) switchViewTab('ids'); // terminal tab is hidden in gs_usb mode
      gsUsbPump();
    } else if (_onAndroid && navigator.usb) {
      connMode = 'serial';
      const {dev, inEp, outEp} = await openWebUSBCDC();
      usbSerDev = dev; usbSerIn = inEp; usbSerOut = outEp;
      log('USB serial opened (Android WebUSB path)', 'ok');
      usbSerialPump();
    } else {
      connMode = 'serial';
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      log('Port opened successfully', 'ok');
      readLoop();
    }

    if (connMode !== 'gsusb') {
      // Query version - give the UART a moment to settle (SLCAN only)
      await new Promise(r => setTimeout(r, 150));
      await sendCommand('V');
      await new Promise(r => setTimeout(r, 100));
      await sendCommand('N');
      await new Promise(r => setTimeout(r, 100));
    }

    // Auto-open the bus if checked (shares busOpen() so the open sequence isn't duplicated)
    if (document.getElementById('autoOpen').checked) {
      await busOpen();
    }

    closeConnectPopover();
    document.getElementById('connectBtn').style.display = 'none';
    document.getElementById('demoBtn').style.display = 'none';
    document.getElementById('disconnectBtn').style.display = '';
    document.getElementById('listenOnly').disabled = true;
    document.getElementById('baudRate').disabled = true;
    document.getElementById('adapterType').disabled = true;
    document.getElementById('autoOpen').disabled = true;
    if (document.getElementById('listenOnly').checked) {
      document.getElementById('vtab-isotp').disabled = true;
      document.getElementById('txPanel').style.opacity = '0.4';
      document.getElementById('txPanel').style.pointerEvents = 'none';
    }
    // gs_usb has no SLCAN text terminal
    const termAvail = connMode !== 'gsusb';
    document.getElementById('termInput').disabled = !termAvail;
    document.getElementById('termInput').style.opacity = termAvail ? '1' : '0.4';
    updateBusPauseBtn();
    setStatus(true);
    startRenderLoop();
    reflowHeader();
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      log(`Connection error: ${e.message}`, 'err');
      log('Connection failed - make sure the adapter is not already open in another program or browser tab, then review your settings (Adapter, Baudrate, Advanced).', 'warn');
      showToast('Connection failed - is the adapter already in use by another app or tab? Otherwise check your adapter settings.', 'err');
      flashSettingsHint();
    }
    // gs_usb that opened but failed later setup (bit-timing / busOpen): take it back out of START
    // and close it. Null ALL transport refs (usbSerIn/usbSerOut were left set before) so a retry
    // starts from clean state.
    try { if (connMode === 'gsusb' && usbSerDev) await gsSetMode(false, false); } catch(_) {}
    try { if (port) await port.close(); } catch(_) {}
    try { if (usbSerDev) await usbSerDev.close(); } catch(_) {}
    port = null;
    usbSerDev = null; usbSerIn = null; usbSerOut = null;
    connMode = 'serial';
  }
}

// Transform the Demo button into a page-reload button (used after demo start and
// after a hardware disconnect, so the stale Demo entry point isn't offered).
function makeReloadBtn() {
  const demoBtn = document.getElementById('demoBtn');
  demoBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-3.49"/></svg> <span>Reload</span>`;
  demoBtn.style.borderColor = 'var(--border2)';
  demoBtn.style.color = 'var(--text2)';
  demoBtn.onclick = () => location.reload();
}

// Briefly pulse one or more elements (amber ring) to draw the eye to them.
function flashEls(...ids) {
  ids.forEach(id => {
    const n = typeof id === 'string' ? document.getElementById(id) : id;
    if (n) { n.classList.add('settings-flash'); setTimeout(() => n.classList.remove('settings-flash'), 2400); }
  });
}

// After a failed connection attempt: re-open the Connect popover and pulse the
// adapter dropdown so the user reviews the settings that now live there.
function flashSettingsHint() {
  toggleConnectPopover(true);
  flashEls('adapterType');
}

// Carlito needs a live traffic source (#6). Returns true if a bus/demo is active;
// otherwise nudges the user toward Connect/Demo (flash + top-right toast) and returns false.
function requireBusForCarlito() {
  if (window.fuzzBusReady && window.fuzzBusReady()) return true;
  flashEls('connectBtn', 'demoBtn');
  showToast('Connect to a CAN bus or start Demo first - Carlito needs a live bus to drive.', 'warn');
  return false;
}
window.requireBusForCarlito = requireBusForCarlito;

async function disconnectSerial() {
  if (usbSerDev) {
    if (connMode === 'gsusb') { try { await gsSetMode(false, false); } catch(e) {} }
    const dev = usbSerDev;
    usbSerDev = null; usbSerIn = null; usbSerOut = null;
    try { await dev.close(); } catch(e) {}
  } else {
    try { if (reader) { await reader.cancel(); } } catch(_) {}
    try { if (port) { await port.close(); } } catch(_) {}
    port = null;
    reader = null;
  }
  resetConnectionState();
  stopAllTx();
  if (window.fuzzStop) window.fuzzStop();
  if (window.obdStop) window.obdStop();
  if (window.xcpStop) window.xcpStop();
  if (window.canopenStop) window.canopenStop();
  if (window.ramnStop) window.ramnStop(); // ← RAMN dashboard hook
  bytesReceived = 0;
  document.getElementById('statBytes').textContent = '0';
  setStatus(false);
  stopRenderLoop();
  document.getElementById('connectBtn').style.display = '';
  document.getElementById('demoBtn').style.display = '';
  makeReloadBtn(); // after a disconnect, offer Reload rather than Demo
  document.getElementById('disconnectBtn').style.display = 'none';
  document.getElementById('notchBtn').disabled = true;
  document.getElementById('notchArrowBtn').disabled = true;
  document.getElementById('notchBtn').classList.remove('active-notch');
  document.getElementById('notchLabel').textContent = 'Notch';
  document.getElementById('listenOnly').disabled = false;
  document.getElementById('baudRate').disabled = false;
  document.getElementById('adapterType').disabled = false;
  document.getElementById('autoOpen').disabled = false;
  document.getElementById('vtab-isotp').disabled = false;
  document.getElementById('txPanel').style.opacity = '';
  document.getElementById('txPanel').style.pointerEvents = '';
  document.getElementById('termInput').disabled = true;
  document.getElementById('termInput').style.opacity = '0.4';
  document.getElementById('deviceInfo').textContent = '';
  connMode = 'serial';
  updateBusPauseBtn();
  reflowHeader();
  log('Disconnected', 'warn');
}

// The "Connected" status pill was removed (#2) - live traffic already conveys state.
// Kept as a no-op so existing call sites don't need touching.
function setStatus(_connected) {}

// readLoop (Web Serial RX), processBuffer, escRawLine, parseSLCAN, HEX_STR_RE/isHexStr,
// hexToBytes → can-link.js (shared transport).

// Re-entrancy guard: demo replay and Carlito telemetry inject frames back through
// window.ingestFrame, which re-runs the whole module hook chain. A hook that re-injects
// (directly or via a feedback loop) could recurse without bound - cap the depth and drop
// frames past it (throttled warn) rather than overflow the stack.
let ingestDepth = 0;
const INGEST_MAX_DEPTH = 8;
let ingestLoopWarnedAt = 0;
function ingestFrame(frame, opts) {
  if (ingestDepth >= INGEST_MAX_DEPTH) {
    const t = Date.now();
    if (t - ingestLoopWarnedAt > 2000) { ingestLoopWarnedAt = t; log('Ingest re-entrancy limit hit - dropping injected frame', 'err'); }
    return;
  }
  ingestDepth++;
  try { ingestFrameBody(frame, opts); }
  finally { ingestDepth--; }
}
function ingestFrameBody(frame, opts) {
  const key = frameKey(frame);
  const now = Date.now();
  const fwd = !!(opts && opts.fwd);   // forwarded onto the bus (Carlito gateway) → counts as RX+TX, shows once as "FW"

  // Always append to dump log (ring buffer - O(1), no GC pressure)
  dumpLog.push({ ts: now, isTx: false, isFwd: fwd, id: frame.id, isExt: frame.isExt, isRtr: frame.isRtr, dlc: frame.dlc, data: frame.data.slice() });
  dumpFilterDirty = true;

  if (frames.has(key)) {
    const existing = frames.get(key);
    const prevData = existing.data;
    const newByteChangedAt = frame.data.map((b, i) =>
      b !== prevData[i] ? now : (existing.byteChangedAt[i] || 0)
    );
    for (let i = prevData.length; i < frame.data.length; i++) newByteChangedAt[i] = now;
    // Only flash the row if at least one byte that changed is not noisy (amber)
    const noisySet = notchedBytes.get(key) || null;
    const anyNonNoisyChanged = frame.data.some((b, i) => {
      if (b === prevData[i]) return false;
      if (noisySet && noisySet.has(i)) return false;
      return true;
    });
    if (anyNonNoisyChanged) changedIds.add(key);
    existing.data = frame.data;
    existing.byteChangedAt = newByteChangedAt;
    existing.dlc = frame.dlc;
    existing.isRtr = frame.isRtr;
    existing.count++;
    existing.lastSeen = now;
    existing.hasRx = true;
    if (fwd) { existing.hasTx = true; existing.isFwd = true; }
    existing.timestamps.push(now);
    if (existing.timestamps.length > 120) existing.timestamps.splice(0, 20);
  } else {
    frames.set(key, {
      id: frame.id, isExt: frame.isExt, isRtr: frame.isRtr,
      dlc: frame.dlc, data: frame.data,
      byteChangedAt: frame.data.map(() => now),
      count: 1, firstSeen: now, lastSeen: now, timestamps: [now],
      hasRx: true, hasTx: fwd, isFwd: fwd
    });
    changedIds.add(key);
  }
  // Pass every received frame to the ISO-TP engine (no-op unless a request is pending)
  isotpIngestFrame(frame);
  if (window.j1939IngestFrame) j1939IngestFrame(frame); // ← J1939 hook
  if (window.chademoIngestFrame) chademoIngestFrame(frame); // ← CHAdeMO hook
  if (window.xcpIngestFrame) xcpIngestFrame(frame); // ← XCP hook
  if (window.canopenIngestFrame) canopenIngestFrame(frame); // ← CANopen hook
  if (window.graphIngestFrame) graphIngestFrame(frame); // ← Graph hook
  if (window.ramnIngestFrame) ramnIngestFrame(frame); // ← RAMN dashboard hook
}

function updateStats() {
  const now = Date.now();
  while (frameRateBuffer.length > 0 && now - frameRateBuffer[0] > 1000) frameRateBuffer.shift();
  document.getElementById('statIds').textContent    = frames.size;
  document.getElementById('statTotal').textContent  = totalFrames.toLocaleString();
  document.getElementById('statRate').textContent   = frameRateBuffer.length;
  document.getElementById('statErrors').textContent = parseErrors;
  const pct = Math.round(dumpLog.size / DUMP_MAX * 100);
  document.getElementById('statDumpBuf').textContent = pct + '%';
  document.getElementById('statDumpBuf').style.color =
    dumpLog.size >= DUMP_MAX ? 'var(--red)' : pct > 80 ? 'var(--amber)' : '';
}

// Single RAF render loop - runs continuously, throttled to RENDER_INTERVAL
let rafId = null;
function startRenderLoop() {
  if (rafId) return;
  function loop(ts) {
    if (ts - lastRenderTime >= RENDER_INTERVAL) {
      lastRenderTime = ts;
      updateStats();
      if (!terminalMode) {
        if (dumpViewActive) renderDump();
        else rerenderTable();
      }
    }
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}
function stopRenderLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ── Responsive header: collapsible stats + icons-only fallback (#4) ───────────────
// Stats default to COLLAPSED (only the Memory tile shows) - the live counters expand on demand
// via the chevron. The icons-only fallback is decided against the *current* stats state, so a
// collapsed default leaves plenty of room and button labels stay visible.
let _statsCollapsed = true; // persisted; default collapsed
try { const s = localStorage.getItem('slcanStatsCollapsed'); if (s !== null) _statsCollapsed = s === '1'; } catch(_) {}

function applyStatsCollapse() {
  document.getElementById('headerStats').classList.toggle('stats-collapsed', _statsCollapsed);
}

function toggleStatsCollapse() {
  _statsCollapsed = !_statsCollapsed;
  try { localStorage.setItem('slcanStatsCollapsed', _statsCollapsed ? '1' : '0'); } catch(_) {}
  applyStatsCollapse();
  reflowHeader(); // expanding may force icons-only; collapsing may restore labels
}

// Do the action buttons wrap onto more than one row? (Uses viewport-relative tops so
// it's correct even though the buttons have different positioned offsetParents. The
// deliberate full-width .header-sep break at ≤1200px is intentionally NOT counted.)
function _buttonsWrap() {
  const ids = ['connectBtn', 'demoBtn', 'ramnBtn', 'carlitoBtn', 'busPauseBtn', 'clearMainBtn', 'disconnectBtn'];
  const tops = ids.map(id => document.getElementById(id))
                  .filter(b => b && b.offsetParent !== null)
                  .map(b => Math.round(b.getBoundingClientRect().top));
  if (tops.length < 2) return false;
  const t0 = tops[0];
  return tops.some(t => t > t0 + 2);
}

// Go icons-only only when the action buttons would otherwise wrap (measured against the
// current stats state - collapsed by default, so this rarely fires).
let _reflowing = false;
function reflowHeader() {
  if (_reflowing) return;
  _reflowing = true;
  const h = document.querySelector('header');
  h.classList.remove('header-compact');
  applyStatsCollapse();
  if (_buttonsWrap()) h.classList.add('header-compact');
  _reflowing = false;
}

(function initHeaderReflow() {
  applyStatsCollapse();
  let raf = 0;
  const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; reflowHeader(); }); };
  window.addEventListener('resize', schedule);
  schedule();
})();

function rerenderTable() {
  const flt = getFilter();
  const fmt = document.getElementById('byteFormat').value;

  // Pinned IDs stay visible in the ID List even when the filter would hide them.
  // (The Traffic Dump filter is separate and still applies to everything there.)
  let rows = Array.from(frames.values()).filter(f => applyFilter(f, flt) || pinnedKeys.has(frameKey(f)));

  // Sort each group (pinned / unpinned) independently, then concat
  const cmp = (a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'id': va = a.id; vb = b.id; break;
      case 'type': va = (a.isExt ? 1 : 0); vb = (b.isExt ? 1 : 0); break;
      case 'len': va = a.dlc; vb = b.dlc; break;
      case 'count': va = a.count; vb = b.count; break;
      case 'rate': va = a.timestamps.length; vb = b.timestamps.length; break;
      case 'age': va = a.lastSeen; vb = b.lastSeen; break;
      default: va = a.id; vb = b.id;
    }
    return sortAsc ? (va > vb ? 1 : va < vb ? -1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0);
  };
  const pinned   = rows.filter(f => pinnedKeys.has(frameKey(f))).sort(cmp);
  const unpinned = rows.filter(f => !pinnedKeys.has(frameKey(f))).sort(cmp);
  rows = [...pinned, ...unpinned];

  // HEX+ASCII: pad every hex block to a constant slot count so the ASCII column
  // starts at the same x for every row (#11). 8 bytes min; widen for CAN-FD frames.
  const hexSlots = Math.max(8, rows.reduce((m, f) => Math.max(m, f.isRtr ? 0 : f.data.length), 0));

  const tbody = document.getElementById('frameBody');
  const now2 = Date.now();

  if (frames.size === 0) {
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('frameTable').style.display = 'none';
    setFilterEmptyState('ids', false, flt);
    return;
  }
  // Frames exist but the filter hides them all → show the "filtered out" notice.
  const filterEmpty = rows.length === 0;
  setFilterEmptyState('ids', filterEmpty, flt);
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('frameTable').style.display = filterEmpty ? 'none' : 'table';

  // Build key→row index map
  const existingRows = {};
  Array.from(tbody.rows).forEach(row => { existingRows[row.dataset.key] = row; });

  // Remove rows no longer visible
  const visibleKeys = new Set(rows.map(f => frameKey(f)));
  Array.from(tbody.rows).forEach(row => {
    if (!visibleKeys.has(row.dataset.key)) tbody.removeChild(row);
  });

  rows.forEach((f, i) => {
    const key = frameKey(f);
    const idHex = f.isExt
      ? f.id.toString(16).toUpperCase().padStart(8, '0')
      : f.id.toString(16).toUpperCase().padStart(3, '0');
    const typeLabel = f.isRtr ? 'RTR' : f.isExt ? 'EXT' : 'STD';
    const typeClass = f.isRtr ? 'rtr' : f.isExt ? 'ext' : 'std';
    const rxBadge  = f.isFwd ? ' <span class="td-type fw">FW</span>' : f.hasRx ? ' <span class="td-type rx">RX</span>' : '';
    const txBadge  = f.isFwd ? '' : f.hasTx ? ' <span class="td-type tx">TX</span>' : '';
    const byteChangedAt = f.byteChangedAt || [];
    const noisySet  = f.hasRx ? (notchedBytes.get(key) || null) : null;
    const stableMap = f.hasRx ? (stableBytes.get(key)  || null) : null;
    const byteClass = (i) => {
      if (!f.hasRx) return ' tx-byte'; // TX-only frames: subtle blue tint
      if (noisySet && noisySet.has(i)) return ' noisy';
      // Stable only if current value still matches the snapshotted value
      if (stableMap && stableMap.has(i) && f.data[i] === stableMap.get(i)) return ' stable';
      if ((now2 - (byteChangedAt[i] || 0)) < hotMs) return ' hot';
      return '';
    };
    const dataHtml = f.isRtr
      ? '<span style="color:var(--text3)">-</span>'
      : fmt === 'hexascii'
        ? f.data.map((b, i) => `<span class="byte${byteClass(i)}">${b.toString(16).toUpperCase().padStart(2,'0')}</span>`).join('') +
          '<span class="byte byte-pad">00</span>'.repeat(Math.max(0, hexSlots - f.data.length)) +
          (f.data.length ? `<span class="byte ascii-str" style="margin-left:6px;color:var(--text2);letter-spacing:0.02em">${f.data.map((b, i) => (b >= 32 && b < 127) ? `<span style="${byteClass(i) === ' noisy' ? 'color:var(--amber)' : byteClass(i) === ' hot' ? 'color:var(--green)' : byteClass(i) === ' stable' ? 'color:var(--text3);opacity:0.55' : ''}">${escHtml(String.fromCharCode(b))}</span>` : `<span style="color:var(--text3)">.</span>`).join('')}</span>` : '')
        : f.data.map((b, i) => `<span class="byte${byteClass(i)}">${escHtml(formatByte(b, fmt))}</span>`).join('');
    const rate = f.timestamps.filter(t => now2 - t < 1000).length;
    const ageMs = now2 - f.lastSeen;
    const ageStr = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs/1000).toFixed(1)}s`;
    const fresh = ageMs < 500;

    let row = existingRows[key];
    if (!row) {
      // Create the row and ALL cells once - never use row.innerHTML again for this row.
      row = tbody.insertRow();
      row.dataset.key = key;
      row.style.cursor = 'pointer';
      row.title = 'Click to inspect';
      // cell[0]: pin button
      const c0 = row.insertCell(0);
      c0.style.cssText = 'width:28px;padding:2px 4px;text-align:center';
      // cell[1]: ID
      row.insertCell(1).className = 'td-id';
      // cell[2]: type badges
      row.insertCell(2);
      // cell[3]: DLC
      row.insertCell(3).className = 'td-len';
      // cell[4]: data bytes (always updated)
      row.insertCell(4).className = 'td-data';
      // cell[5]: count
      row.insertCell(5).className = 'td-count';
      // cell[6]: rate
      row.insertCell(6).className = 'td-rate';
      // cell[7]: age
      row.insertCell(7).className = 'td-age';
      // cell[8]: notes
      row.insertCell(8).style.cssText = 'min-width:100px;padding:4px 8px;color:var(--text3);font-family:var(--sans);font-size:11px;font-style:italic;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    }

    // ── Row-level state (always applied) ──────────────────────────────────────
    const changed = changedIds.has(key);
    if (changed) {
      row.classList.remove('changed');
      void row.offsetWidth; // force reflow to restart CSS animation
      row.classList.add('changed');
    }
    const isNewId  = notchSnapshot !== null && !notchSnapshot.has(key);
    const isPinned = pinnedKeys.has(key);
    const colorStr = frameColors.get(key) || '';
    row.classList.toggle('new-id', isNewId);
    row.classList.toggle('pinned-row', isPinned);
    row.style.borderLeft = `3px solid ${colorStr || 'transparent'}`;

    // ── cell[0]: pin button - only rebuild when pin state changes ─────────────
    if (row.dataset.pinned !== (isPinned ? '1' : '0')) {
      row.dataset.pinned = isPinned ? '1' : '0';
      const pinSvg = `<svg viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
      row.cells[0].innerHTML = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin onclick="togglePin('${key}');event.stopPropagation()" title="${isPinned ? 'Unpin' : 'Pin to top'}">${pinSvg}</button>`;
    }

    // ── cells[1-3, 8]: rarely-changing static content ─────────────────────────
    const noteStr = frameNotes.get(key) || '';
    const fp = f.dlc + '|' + typeClass + '|' + (f.hasRx?'R':'') + (f.hasTx?'T':'') + (f.isFwd?'F':'') +
               '|' + (isNewId ? 'N' : '') + '|' + noteStr + '|' + colorStr;
    if (row.dataset.fp !== fp) {
      row.dataset.fp = fp;
      row.cells[1].style.color = colorStr || 'var(--amber)';
      row.cells[1].textContent = '0x' + idHex;
      row.cells[2].innerHTML   = `<span class="td-type ${typeClass}">${typeLabel}</span>${rxBadge}${txBadge}`;
      row.cells[3].textContent = f.dlc;
      row.cells[8].textContent = noteStr;
      row.cells[8].title       = noteStr;
    }

    // ── cell[4]: data bytes - always update (byte colors are time-dependent) ──
    row.cells[4].innerHTML = dataHtml;

    // ── cells[5-7]: live counters - always update ─────────────────────────────
    row.cells[5].textContent = f.count.toLocaleString();
    row.cells[6].textContent = rate + '/s';
    row.cells[7].className   = 'td-age' + (fresh ? ' fresh' : '');
    row.cells[7].textContent = ageStr;

    // Re-position row
    if (tbody.children[i] !== row) {
      tbody.insertBefore(row, tbody.children[i] || null);
    }
  });

  changedIds.clear();
}

function formatByte(b, fmt) {
  switch (fmt) {
    case 'hex': return b.toString(16).toUpperCase().padStart(2, '0');
    case 'bin': return b.toString(2).padStart(8, '0');
    case 'ascii': return (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
    default: return b.toString(16).toUpperCase().padStart(2, '0');
  }
}

// Keyboard activation for the click-sortable <th> headers (they're <th>, not <button>, so Enter/
// Space don't fire onclick on their own). Keeps the ID-list headers operable without a mouse.
function thSortKey(e, key) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSort(key); } }

function setSort(key) {
  if (sortKey === key) {
    sortAsc = !sortAsc;
  } else {
    sortKey = key;
    sortAsc = true;
  }
  document.querySelectorAll('thead th').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
  });
  const th = document.getElementById(`th-${key}`);
  if (th) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
  rerenderTable();
}

// ── View tabs (ID List / Traffic Dump) ───────────────────────────────────────
function switchViewTab(name) {
  const wasTerminal = terminalMode;
  const goingTerminal = name === 'term';

  if (goingTerminal && !wasTerminal) {
    frameBuffer  = '';
    termBuffer   = '';
    terminalMode = true;
    updateBusPauseBtn(); // disable pause btn while in terminal
  } else if (!goingTerminal && wasTerminal) {
    frameBuffer  = '';
    termBuffer   = '';
    terminalMode = false;
    updateBusPauseBtn(); // re-enable pause btn
  }

  dumpViewActive = name === 'dump';

  document.getElementById('vtab-ids').classList.toggle('active', name === 'ids');
  document.getElementById('vtab-dump').classList.toggle('active', name === 'dump');
  document.getElementById('vtab-term').classList.toggle('active', name === 'term');
  document.getElementById('vtab-inspect').classList.toggle('active', name === 'inspect');
  document.getElementById('vtab-isotp').classList.toggle('active', name === 'isotp');
  document.getElementById('vtab-j1939').classList.toggle('active', name === 'j1939');
  document.getElementById('vtab-chademo').classList.toggle('active', name === 'chademo');
  document.getElementById('vtab-xcp').classList.toggle('active', name === 'xcp');
  document.getElementById('vtab-canopen').classList.toggle('active', name === 'canopen');
  document.getElementById('vtab-graph').classList.toggle('active', name === 'graph');
  document.getElementById('vtab-fuzz').classList.toggle('active', name === 'fuzz');
  // Mirror the active state to aria-selected for screen readers, and keep a roving tabindex so only
  // the selected tab is in the Tab order (arrow keys move between tabs - see onViewTabKey).
  document.querySelectorAll('.view-tabs .view-tab').forEach(t => {
    const on = t.classList.contains('active');
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  });

  const isIdsOrDump = name === 'ids' || name === 'dump';
  document.getElementById('sharedToolbar').style.display          = isIdsOrDump       ? 'flex'  : 'none';
  document.getElementById('dumpOnlyControls').style.display        = name === 'dump'  ? 'flex'  : 'none';
  document.getElementById('filterOnlyHighlightedLabel').style.display = name === 'dump' ? 'none' : '';
  document.getElementById('tableWrap').style.display       = name === 'ids'   ? ''      : 'none';
  document.getElementById('dumpHeader').style.display      = name === 'dump'  ? 'block' : 'none';
  document.getElementById('dumpWrap').style.display     = name === 'dump'    ? '' : 'none';
  document.getElementById('termWrap').style.display     = name === 'term'    ? 'flex' : 'none';
  document.getElementById('inspectWrap').style.display  = name === 'inspect' ? '' : 'none';
  document.getElementById('isotpWrap').style.display    = name === 'isotp'   ? 'flex' : 'none';
  document.getElementById('j1939Wrap').style.display    = name === 'j1939'   ? 'flex' : 'none';
  document.getElementById('chademoWrap').style.display  = name === 'chademo' ? 'flex' : 'none';
  document.getElementById('xcpWrap').style.display      = name === 'xcp'     ? 'flex' : 'none';
  document.getElementById('canopenWrap').style.display  = name === 'canopen' ? 'flex' : 'none';
  document.getElementById('graphWrap').style.display    = name === 'graph'   ? 'flex' : 'none';
  document.getElementById('fuzzWrap').style.display     = name === 'fuzz'    ? 'flex' : 'none';

  // In demo mode, opening a tab with its own base traffic offers to switch to it.
  if (name === 'j1939' && window.demoMaybeSwitch && window.j1939GetProto) {
    const m = window.j1939GetProto();
    const lbl = m === 'nmea2000' ? 'NMEA 2000' : m === 'iso11783' ? 'ISO 11783' : 'J1939';
    window.demoMaybeSwitch(m, lbl);
  }
  if (name === 'chademo' && window.demoMaybeSwitch) window.demoMaybeSwitch('chademo', 'CHAdeMO');
  if (name === 'canopen' && window.demoMaybeSwitch) window.demoMaybeSwitch('canopen', 'CANopen');

  if (name === 'dump')  renderDump();
  if (name === 'graph' && window.graphOnShow) window.graphOnShow();
  if (name === 'fuzz'  && window.fuzzOnShow)  window.fuzzOnShow();
  if (name === 'xcp'   && window.xcpOnShow)   window.xcpOnShow();
  if (name === 'canopen' && window.canopenOnShow) window.canopenOnShow();
  if (name === 'term')  { document.getElementById('termInput').focus(); updateTermTrafficWarn(); }
  if (name === 'isotp') { document.getElementById('isotpInput').focus(); obdOnShow(); }
  updateNotchBtn();
}

// Roving-focus keyboard nav for the tablist (WAI-ARIA tabs pattern): Arrow keys move focus between
// enabled tabs and activate them; Home/End jump to the first/last. Skips disabled tabs (e.g. the
// Serial Terminal tab before connect).
function onViewTabKey(e) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const tabs = [...document.querySelectorAll('.view-tabs .view-tab')].filter(t => !t.disabled);
  if (!tabs.length) return;
  const cur = tabs.indexOf(document.activeElement);
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else { const from = cur < 0 ? 0 : cur; next = (from + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; }
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();   // activate (switchViewTab updates aria-selected + roving tabindex)
}

// Shared "a filter control changed" handler - invalidates the dump filter cache and re-renders both
// tables. Extracted from ~7 identical multi-statement inline onchange/oninput handlers in index.html.
function onFilterChange() {
  dumpFilterDirty = true; dumpLastSize = -1;
  rerenderTable();
  renderDump();
}

// Byte-format select changed: also drops the per-row cache (dumpLastFirst) and re-syncs the data
// filter placeholder, then re-renders (dump only when its view is active).
function onByteFormatChange() {
  dumpFilterDirty = true; dumpLastSize = -1; dumpLastFirst = -1;
  syncDataPlaceholder();
  rerenderTable();
  if (dumpViewActive) renderDump();
}

// Highlight-duration slider: log-mapped slider position → hotMs (snapped), updating only the label.
function onHotDurationInput(sliderVal) {
  hotMs = snapMs(Math.round(Math.pow(10, sliderVal / 100 * 3 + 2)));
  document.getElementById('hotDurVal').textContent =
    hotMs >= 10000 ? (hotMs / 1000).toFixed(0) + 's' : hotMs >= 1000 ? (hotMs / 1000).toFixed(1) + 's' : hotMs + 'ms';
}

function formatDumpData(entry, fk) {
  const fmt = document.getElementById('byteFormat').value;
  if (entry.isRtr) return '<span style="color:var(--text3)">RTR</span>';
  if (!entry.data.length) return '';
  const noisy  = fk ? (notchedBytes.get(fk) || null) : null;
  const stable = fk ? (stableBytes.get(fk)  || null) : null;
  // Mirror ID List logic: stable only when byte value still matches the snapshot value
  const cls = (b, i) => {
    if (entry.isTx)                                 return 'byte tx-byte';
    if (noisy?.has(i))                              return 'byte noisy';
    if (stable?.has(i) && b === stable.get(i))      return 'byte stable';
    return 'byte';
  };
  if (fmt === 'hexascii') {
    const hex = entry.data.map((b, i) => `<span class="${cls(b,i)}">${b.toString(16).toUpperCase().padStart(2,'0')}</span>`).join('');
    // Pad the hex block to a constant slot count so the ASCII column aligns across rows (#11).
    // Dump rows are cached individually (no global re-render), so a fixed count - 8 = classic
    // CAN max DLC - keeps alignment stable while scrolling.
    const pad = '<span class="byte byte-pad">00</span>'.repeat(Math.max(0, 8 - entry.data.length));
    const asc = entry.data.map(b => (b >= 32 && b < 127) ? escHtml(String.fromCharCode(b)) : '<span style="color:var(--text3)">.</span>').join('');
    return hex + pad + `<span class="byte ascii-str" style="margin-left:6px;color:var(--text2)">${asc}</span>`;
  }
  return entry.data.map((b, i) => `<span class="${cls(b,i)}">${escHtml(formatByte(b, fmt))}</span>`).join('');
}

let dumpStartTs = null; // relative time base
let dumpAutoScroll = true; // follows new frames unless user scrolls up
let dumpScrollLocked = false; // user explicitly paused auto-scroll
let dumpLastFirst = -1, dumpLastLast = -1, dumpLastSize = -1, dumpLastHead = -1; // dirty-check
let dumpLastFilterSig = ''; // last applied filter predicate; change ⇒ index→entry map shifts, evict row cache
let dumpFilterDirty = true;  // set when filter changes or new frame arrives
let dumpFilterCache = null;  // cached filtered array; null = no active filter

function onDumpScroll() {
  const wrap = document.getElementById('dumpWrap');
  const spacerH = parseInt(document.getElementById('dumpSpacer').style.height) || 0;
  const distFromBottom = spacerH - wrap.scrollTop - wrap.clientHeight;
  if (!dumpScrollLocked) dumpAutoScroll = distFromBottom < DUMP_ROW_H * 2;
  dumpLastFirst = -1; // force redraw on scroll
  renderDump();
}

function toggleDumpScroll() {
  dumpScrollLocked = !dumpScrollLocked;
  const btn = document.getElementById('dumpScrollBtn');
  if (dumpScrollLocked) {
    dumpAutoScroll = false;
    btn.textContent = '▶ Resume scroll';
    btn.classList.add('active-notch');
  } else {
    dumpAutoScroll = true;
    btn.textContent = '⏸ Pause scroll';
    btn.classList.remove('active-notch');
    const wrap = document.getElementById('dumpWrap');
    wrap.scrollTop = wrap.scrollHeight;
    renderDump();
  }
}

function renderDump() {
  if (!dumpViewActive) return;
  const wrap   = document.getElementById('dumpWrap');
  const spacer = document.getElementById('dumpSpacer');
  const table  = document.getElementById('dumpTable');
  const tbody  = document.getElementById('dumpBody');
  const flt = getFilter();
  const hasFilter = hasActiveFilter(flt);

  // When the filter PREDICATE changes, the cached rows (keyed by viewport index) now map to
  // different entries, since index i indexes the filtered array. Evict the row cache. Gated on
  // the predicate itself - NOT on dumpFilterDirty (which also fires on every new frame, where
  // the filtered prefix stays stable and the cache is still valid).
  const filterSig = JSON.stringify(flt);
  if (filterSig !== dumpLastFilterSig) { dumpRowElsDirty = true; dumpLastFilterSig = filterSig; }

  // Apply filter using ring buffer's O(result) filter method; cache result until dirty
  if (!hasFilter) {
    dumpFilterCache = null;
    dumpFilterDirty = false;
  } else if (dumpFilterDirty) {
    dumpFilterCache = dumpLog.filter(e => applyFilter(e, flt));
    dumpFilterDirty = false;
    // The filtered array grows with a stable prefix (ring buffer only wraps after 100k
    // entries), so existing index→entry mappings stay valid - no full row eviction needed.
    // Genuine ring-wrap invalidation is handled below via dumpLog.head.
  }
  const filtered = dumpFilterCache; // null = use ring buffer directly

  const total = filtered ? filtered.length : dumpLog.size;
  const getEntry = filtered ? (i => filtered[i]) : (i => dumpLog.get(i));

  // Frames logged but the filter hides them all → show the "filtered out" notice.
  // Run before the skip-redraw early return so it updates even when the window is unchanged.
  setFilterEmptyState('dump', dumpLog.size > 0 && total === 0, flt);

  const totalH = total * DUMP_ROW_H;
  spacer.style.height = (totalH + 28) + 'px'; // +28 for thead

  // Auto-scroll: set scrollTop after updating spacer height
  if (dumpAutoScroll && !dumpScrollLocked && total > 0) {
    wrap.scrollTop = totalH + 28;
  }

  const scrollTop = wrap.scrollTop;
  const firstRow  = Math.max(0, Math.floor(scrollTop / DUMP_ROW_H) - 5);
  const lastRow   = Math.min(total - 1, firstRow + DUMP_VISIBLE + 10);

  // Skip redraw if the visible window and data size haven't changed
  if (firstRow === dumpLastFirst && lastRow === dumpLastLast && dumpLog.size === dumpLastSize && dumpLog.head === dumpLastHead) return;
  // When ring buffer wraps, head advances - cached rows now map to stale entries
  if (dumpLog.head !== dumpLastHead && dumpLastHead !== -1) dumpRowElsDirty = true;
  dumpLastFirst = firstRow;
  dumpLastLast  = lastRow;
  dumpLastSize  = dumpLog.size;
  dumpLastHead  = dumpLog.head;

  // Relative time base = oldest retained entry. Re-base when the 100k ring wraps: once the frame the
  // base pointed at is overwritten, get(0).ts moves past it, so without this dump-relative times drift.
  if (dumpLog.size > 0 && (dumpStartTs === null || dumpLog.get(0).ts > dumpStartTs)) dumpStartTs = dumpLog.get(0).ts;

  // Clear stale row cache when filter was just recomputed or externally invalidated
  if (dumpRowElsDirty) {
    dumpRowEls.forEach(tr => tbody.contains(tr) && tbody.removeChild(tr));
    dumpRowEls.clear();
    dumpRowElsDirty = false;
  }

  // Add missing rows for the current viewport
  for (let i = firstRow; i <= lastRow; i++) {
    if (dumpRowEls.has(i)) continue;
    const e = getEntry(i);
    const relMs  = e.ts - (dumpStartTs ?? e.ts);
    const relStr = (relMs / 1000).toFixed(3) + 's';
    const idHex  = '0x' + e.id.toString(16).toUpperCase().padStart(e.isExt ? 8 : 3, '0');
    const typeLabel = e.isRtr ? 'RTR' : e.isExt ? 'EXT' : 'STD';
    const typeClass = e.isRtr ? 'rtr' : e.isExt ? 'ext' : 'std';
    const dirBadge  = e.isFwd
      ? ' <span class="td-type fw">FW</span>'
      : e.isTx
        ? ' <span class="td-type tx">TX</span>'
        : ' <span class="td-type rx">RX</span>';
    const tr = document.createElement('tr');
    const fk = frameKey(e);
    const dumpColor = frameColors.get(fk) || '';
    const isNewDump = notchSnapshot !== null && !notchSnapshot.has(fk);
    tr.style.cssText = `transform:translateY(${i * DUMP_ROW_H}px);position:absolute;width:100%;cursor:pointer;border-left:3px solid ${dumpColor || 'transparent'}`;
    if (isNewDump) tr.classList.add('new-id');
    tr.title = 'Click to inspect';
    tr.dataset.frameKey = fk;
    tr.innerHTML = `
      <td style="color:var(--text3)">${relStr}</td>
      <td style="color:${dumpColor || 'var(--amber)'};font-weight:500;font-family:var(--mono)">${idHex}</td>
      <td><span class="td-type ${typeClass}">${typeLabel}</span>${dirBadge}</td>
      <td style="color:var(--text2);text-align:center">${e.dlc}</td>
      <td class="td-data">${formatDumpData(e, fk)}</td>
      <td style="color:var(--text3);font-family:var(--sans);font-size:11px;font-style:italic;padding:3px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px">${escHtml(frameNotes.get(frameKey(e)) || '')}</td>
    `;
    tr.addEventListener('click', () => inspectFrame(e));
    tbody.appendChild(tr);
    dumpRowEls.set(i, tr);
  }

  // Evict rows that scrolled far outside the viewport (keep a generous buffer)
  const evictBuffer = DUMP_VISIBLE * 2;
  dumpRowEls.forEach((tr, idx) => {
    if (idx < firstRow - evictBuffer || idx > lastRow + evictBuffer) {
      tbody.removeChild(tr);
      dumpRowEls.delete(idx);
    }
  });

  table.style.top = '0';
}

// ── Frame Inspector ───────────────────────────────────────────────────────────
// CAN bit helpers (module scope so they aren't re-created on every inspectFrame call).
// integer → bit array MSB first, padded to `len` bits
const toBits = (val, len) => Array.from({length: len}, (_, i) => (val >> (len-1-i)) & 1);
// CAN CRC-15 per ISO 11898 (poly = 0x4599)
const CAN_CRC15_POLY = 0x4599;
function computeCrc15(bitArray) {
  let crc = 0;
  for (const b of bitArray) {
    const feedback = ((crc >> 14) ^ b) & 1;
    crc = (crc << 1) & 0x7FFF;
    if (feedback) crc ^= CAN_CRC15_POLY;
  }
  return crc;
}

// Build the ordered bit-field model of a CAN frame (SOF → IFS), computing the CRC-15 over the
// SOF..data bits. Pure - depends only on the frame contents. Returns { fields, crcVal }.
//   Standard: SOF | ID(11) | RTR | IDE(0) | r0 | DLC(4) | DATA | CRC(15) | CRCDELIM | ACK | ACKDELIM | EOF(7) | IFS(3)
//   Extended: SOF | BASEID(11) | SRR | IDE(1) | EXTID(18) | RTR | r1 | r0 | DLC(4) | DATA | CRC(15) | …
function buildCanFields(id, isExt, isRtr, data, dlc) {
  let fields;
  if (!isExt) {
    fields = [
      { label: 'SOF',        cls: 'sof',  bits: [0] },
      { label: 'ID (11-bit)',cls: 'id',   bits: toBits(id, 11) },
      { label: 'RTR',        cls: 'ctrl', bits: [isRtr ? 1 : 0] },
      { label: 'IDE',        cls: 'ctrl', bits: [0] },
      { label: 'r0',         cls: 'ctrl', bits: [0] },
      { label: 'DLC',        cls: 'ctrl', bits: toBits(dlc, 4) },
    ];
  } else {
    const baseId = (id >> 18) & 0x7FF;
    const extId  = id & 0x3FFFF;
    fields = [
      { label: 'SOF',          cls: 'sof',  bits: [0] },
      { label: 'Base ID (11)', cls: 'id',   bits: toBits(baseId, 11) },
      { label: 'SRR',          cls: 'ctrl', bits: [1] },
      { label: 'IDE',          cls: 'ctrl', bits: [1] },
      { label: 'Ext ID (18)',  cls: 'id',   bits: toBits(extId, 18) },
      { label: 'RTR',          cls: 'ctrl', bits: [isRtr ? 1 : 0] },
      { label: 'r1',           cls: 'ctrl', bits: [0] },
      { label: 'r0',           cls: 'ctrl', bits: [0] },
      { label: 'DLC',          cls: 'ctrl', bits: toBits(dlc, 4) },
    ];
  }
  data.forEach((byte, idx) => fields.push({ label: `D${idx}`, cls: 'data', bits: toBits(byte, 8) }));

  // CRC-15 over SOF through end of data
  const crcVal = computeCrc15(fields.flatMap(fld => fld.bits));
  fields.push({ label: 'CRC (15)',  cls: 'crc', bits: toBits(crcVal, 15) });
  fields.push({ label: 'CRC Delim', cls: 'crc', bits: [1] });
  fields.push({ label: 'ACK',       cls: 'eof', bits: [0] });  // dominant = 0 (acknowledged)
  fields.push({ label: 'ACK Delim', cls: 'eof', bits: [1] });
  fields.push({ label: 'EOF',       cls: 'eof', bits: Array(7).fill(1) });
  fields.push({ label: 'IFS',       cls: 'eof', bits: Array(3).fill(1) });
  return { fields, crcVal };
}

// Map a field label to its frame section (for colour-coding the stuffed bitstream).
function inspectSectionOf(label) {
  if (label === 'SOF') return 'sof';
  if (['ID (11-bit)', 'Base ID (11)', 'Ext ID (18)'].includes(label)) return 'id';
  if (['RTR','IDE','SRR','r0','r1'].includes(label)) return 'flags';
  if (label === 'DLC') return 'dlc';
  if (/^D\d+$/.test(label)) return 'data';
  if (label === 'CRC (15)' || label === 'CRC Delim') return 'crc';
  if (label === 'ACK' || label === 'ACK Delim') return 'ack';
  if (label === 'EOF') return 'eof';
  if (label === 'IFS') return 'ifs';
  return 'other';
}

// CAN bit-stuffing simulation: from SOF through CRC, insert the opposite bit after any run of 5
// equal bits; post-CRC fields (CRC Delim, ACK, ACK Delim, EOF, IFS) are appended unstuffed. Each
// emitted bit is tagged { bit, stuffed, sec } for rendering. Returns { stuffed, stuffCount }.
const INSPECT_POST_STUFF_LABELS = ['CRC Delim','ACK','ACK Delim','EOF','IFS'];
function simulateBitStuffing(fields) {
  const stuffableFields = fields.filter(fld => !INSPECT_POST_STUFF_LABELS.includes(fld.label));
  // Raw stuffable bit array tagged with section
  const rawWithSec = stuffableFields.flatMap(fld =>
    fld.bits.map(b => ({ bit: b, sec: inspectSectionOf(fld.label) }))
  );
  // Apply stuffing - track lastEmittedBit to correctly handle runs after a stuff bit
  const stuffed = [];
  let runLen = 1, lastEmittedBit = -1;
  for (let i = 0; i < rawWithSec.length; i++) {
    const { bit: b, sec } = rawWithSec[i];
    stuffed.push({ bit: b, stuffed: false, sec });
    if (i === 0) { lastEmittedBit = b; continue; }
    if (b === lastEmittedBit) {
      runLen++;
      if (runLen === 5) {
        const sb = b ^ 1;
        stuffed.push({ bit: sb, stuffed: true, sec }); // inherit current section
        lastEmittedBit = sb;
        runLen = 1;
      } else {
        lastEmittedBit = b;
      }
    } else {
      runLen = 1;
      lastEmittedBit = b;
    }
  }
  // Append post-stuffing bits (CRC Delim, ACK, ACK Delim, EOF, IFS)
  fields.filter(fld => INSPECT_POST_STUFF_LABELS.includes(fld.label)).forEach(fld => {
    const sec = inspectSectionOf(fld.label);
    fld.bits.forEach(b => stuffed.push({ bit: b, stuffed: false, sec }));
  });
  return { stuffed, stuffCount: stuffed.filter(s => s.stuffed).length };
}

function inspectFrame(f) {
  switchViewTab('inspect');
  lastInspectedFrame = f;

  const isExt = f.isExt;
  const isRtr = f.isRtr;
  const id    = f.id;
  const data  = f.data || [];
  const dlc   = f.dlc;
  const noteKey = frameKey({ isExt, id });

  const { fields, crcVal } = buildCanFields(id, isExt, isRtr, data, dlc);

  // Split fields into 3 rows: [SOF..DLC], [Data bytes], [CRC..]
  const dlcIdx   = fields.findIndex(fld => fld.label === 'DLC');
  const crcIdx   = fields.findIndex(fld => fld.label === 'CRC (15)');
  const row1Fields = fields.slice(0, dlcIdx + 1);
  const row2Fields = fields.slice(dlcIdx + 1, crcIdx);
  const row3Fields = fields.slice(crcIdx);

  function renderFieldRow(flds) {
    return `<div class="bitfield" style="margin-bottom:6px">${flds.map(f => {
      const bitsHtml = f.bits.map(b => {
        if (b === 'x') return `<div class="bf-bit bx ${f.cls === 'data' ? 'data-b' : f.cls === 'crc' ? 'crc-b' : ''}">?</div>`;
        const cls  = b === 1 ? 'b1' : 'b0';
        const extra = f.cls === 'id' ? 'id' : f.cls === 'ctrl' ? 'ctrl' : f.cls === 'data' ? 'data-b' : f.cls === 'crc' ? 'crc-b' : '';
        return `<div class="bf-bit ${cls} ${extra}">${b}</div>`;
      }).join('');
      return `<div class="bf-field"><div class="bf-label ${f.cls}">${escHtml(f.label)}</div><div class="bf-bits">${bitsHtml}</div></div>`;
    }).join('')}</div>`;
  }

  const fieldHtml = renderFieldRow(row1Fields) +
    (row2Fields.length ? renderFieldRow(row2Fields) : '') +
    renderFieldRow(row3Fields);

  // Field table
  const idHex  = isExt ? f.id.toString(16).toUpperCase().padStart(8,'0') : f.id.toString(16).toUpperCase().padStart(3,'0');
  const idBin  = isExt ? f.id.toString(2).padStart(29,'0') : f.id.toString(2).padStart(11,'0');
  const idDec  = f.id.toString(10);
  const dataHexStr = data.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  const dataAscii  = data.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');

  const tableRows = [
    ['Frame type',   isExt ? 'Extended (29-bit ID)' : 'Standard (11-bit ID)'],
    ['Direction',    isRtr ? 'Remote (RTR)' : 'Data'],
    ['ID (hex)',     (isExt ? '0x' : '') + idHex],
    ['ID (binary)',  idBin.replace(/(.{4})/g,'$1 ').trim()],
    ['ID (decimal)', idDec],
    ['DLC',          `${dlc} byte${dlc !== 1 ? 's' : ''}`],
    ['Data (hex)',   dataHexStr || '-'],
    ['Data (ASCII)', dataAscii || '-'],
    ['CRC-15',       `0x${crcVal.toString(16).toUpperCase().padStart(4,'0')} (${crcVal.toString(2).padStart(15,'0')})`],
    ['Total bits', `${fields.reduce((s,f)=>s+f.bits.length,0)} (before stuffing)`],
  ].map(([label, val]) =>
    `<tr><td>${escHtml(label)}</td><td>${escHtml(String(val))}</td></tr>`
  ).join('');

  // ── Bit stuffing ────────────────────────────────────────────────────────────
  const { stuffed, stuffCount } = simulateBitStuffing(fields);

  const SECTION_COLORS = {
    sof: '#e2e8f0', id: '#60a5fa', flags: '#f59e0b', dlc: '#f97316',
    data: '#00e87a', crc: '#a78bfa', ack: '#f87171', eof: '#64748b', ifs: '#334155',
  };
  const SECTION_LABELS = [
    ['sof','SOF'],['id','ID'],['flags','Flags'],['dlc','DLC'],['data','Data'],
    ['crc','CRC+Delim'],['ack','ACK+Delim'],['eof','EOF'],['ifs','IFS'],
  ];

  const stuffBitsHtml = stuffed.map(s => {
    const color = SECTION_COLORS[s.sec] || '#8892a4';
    if (s.stuffed) return `<span class="stuff-bit" style="color:${color}">${s.bit}</span>`;
    return `<span style="color:${color}">${s.bit}</span>`;
  }).join('');

  const legendHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-bottom:10px;font-family:var(--sans);font-size:11px;color:var(--text2)">` +
    SECTION_LABELS.map(([sec, lbl]) =>
      `<span style="display:flex;align-items:center;gap:4px">` +
      `<span style="width:9px;height:9px;border-radius:2px;background:${SECTION_COLORS[sec]};flex-shrink:0"></span>${escHtml(lbl)}</span>`
    ).join('') +
    `<span style="display:flex;align-items:center;gap:4px">` +
    `<span class="stuff-bit" style="font-family:var(--mono);font-size:11px;color:var(--text2)">·</span>underlined = stuff bit</span>` +
    `</div>`;

  const currentColor = frameColors.get(noteKey) || '';
  const colorPickerVal = currentColor || '#3b82f6';

  const html = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap">
      <div style="display:flex;align-items:baseline;gap:6px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text3);font-family:var(--sans)">ID</span>
        <div id="inspectIdDisplay" style="font-size:20px;font-weight:600;font-family:var(--mono);color:${currentColor || 'var(--text)'}">${(isExt ? '0x' : '') + idHex}</div>
      </div>
      <span class="td-type ${isRtr ? 'rtr' : isExt ? 'ext' : 'std'}">${isRtr ? 'RTR' : isExt ? 'EXT' : 'STD'}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap" title="Sets the highlight colour for this ID across the ID List, Traffic Dump, and Graph tabs.">
        <span style="font-size:11px;color:var(--text3);font-family:var(--sans)">ID Color</span>
        ${['#f87171','#fb923c','#f59e0b','#a3e635','#00e87a','#22d3ee','#60a5fa','#818cf8','#a78bfa','#f472b6'].map(c =>
          `<span title="${c}" onclick="setFrameColor('${noteKey}','${c}')"
            style="width:14px;height:14px;border-radius:3px;background:${c};cursor:pointer;flex-shrink:0;${currentColor===c?'outline:2px solid #fff;outline-offset:1px':'opacity:0.75'}"></span>`
        ).join('')}
        <input type="color" value="${colorPickerVal}"
          style="width:26px;height:22px;padding:1px 2px;border:1px solid var(--border2);border-radius:4px;cursor:pointer;background:transparent;${currentColor && !['#f87171','#fb923c','#f59e0b','#a3e635','#00e87a','#22d3ee','#60a5fa','#818cf8','#a78bfa','#f472b6'].includes(currentColor) ? `outline:2px solid ${currentColor};outline-offset:2px` : ''}"
          oninput="setFrameColor('${noteKey}',this.value)">
        ${currentColor ? `<button class="btn" style="padding:2px 7px;font-size:11px" onclick="setFrameColor('${noteKey}','')">Clear</button>` : ''}
      </div>
    </div>

    <div class="inspect-title">Notes</div>
    <input id="inspectNoteArea" type="text"
      style="width:100%;margin-bottom:8px;background:var(--bg2);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:var(--sans);font-size:13px;padding:8px 12px;outline:none;box-sizing:border-box"
      placeholder="Add notes about this frame ID…"
      value="${escHtml(frameNotes.get(noteKey) || '')}"
      oninput="frameNotes.set('${noteKey}', this.value);saveNotes();rerenderTable()">

    <div class="inspect-title">Bit Field Layout <span style="font-size:10px;font-weight:400;color:var(--text3);letter-spacing:0;text-transform:none">- without bit stuffing</span></div>
    <div class="bitfield-wrap">
      ${fieldHtml}
    </div>

    <div class="inspect-title">Bitstream with Bit Stuffing
      <span style="font-size:10px;font-weight:400;color:var(--text3);letter-spacing:0;text-transform:none">
        - ${stuffed.length} bits total, ${stuffCount} stuff bit${stuffCount !== 1 ? 's' : ''} inserted
      </span>
      <a href="explainers/can-signals-explainer.html?bits=${stuffed.map(s => s.bit).join('')}" target="_blank"
        style="font-size:11px;font-weight:400;color:var(--accent,#60a5fa);text-decoration:none;letter-spacing:0;text-transform:none;margin-left:8px"
        title="See these bits as CAN_H / CAN_L oscilloscope waveforms">↗ View as oscilloscope signals</a>
    </div>
    <div class="stuff-wrap">
      ${legendHtml}
      <div style="font-family:var(--mono);font-size:13px;letter-spacing:0.1em;overflow-x:auto;white-space:nowrap">${stuffBitsHtml}</div>
    </div>

    <div class="inspect-title">Field Details</div>
    <table class="inspect-table">
      <thead><tr><th>Field</th><th>Value</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;

  document.getElementById('inspectContent').innerHTML = html;
}

// States: 'closed' → 'open' → 'paused'
// Button shows the *current action* (what clicking will do):
//   bus closed  → "Open Bus"   (sends O or L depending on listen-only checkbox)
//   bus open    → "Pause"      (sends C, suspends TX scheduler)
//   paused      → "Resume"     (sends O/L, resumes TX scheduler)

function updateBusPauseBtn() {
  const btn   = document.getElementById('busPauseBtn');
  const icon  = document.getElementById('busPayIcon');
  const label = document.getElementById('busPayLabel');
  const badge = document.getElementById('pausedBadge');

  // Pause button is disabled only when there is no connection (#8 - no terminal-mode conflict gating).
  const hasConnection = demoMode || (port !== null) || (usbSerDev !== null);
  btn.disabled = !hasConnection;

  if (!busIsOpen) {
    icon.innerHTML    = '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/>';
    label.textContent = 'Open Bus';
    badge.style.display = 'none';
    btn.classList.remove('term-open');
  } else if (paused) {
    icon.innerHTML    = '<polygon points="5 3 19 12 5 21 5 3"/>';
    label.textContent = 'Resume';
    badge.style.display = 'inline-flex';
    btn.classList.remove('term-open');
  } else {
    icon.innerHTML    = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    label.textContent = 'Pause';
    badge.style.display = 'none';
  }
  updateNotchBtn();
  updateTerminalTab();
}

// Enable/disable the Serial Terminal tab. Usable once connected or in demo.
function updateTerminalTab() {
  const tab = document.getElementById('vtab-term');
  // gs_usb has no SLCAN text channel - hide the terminal tab entirely.
  if (connMode === 'gsusb') { tab.style.display = 'none'; return; }
  tab.style.display = '';
  const connected = demoMode || !!port || !!usbSerDev;
  tab.disabled = !connected;
  tab.title = connected ? '' : 'Connect or start demo to use the Serial Terminal';
  updateTermTrafficWarn();
}

// Serial-tab warning (#9): show whenever live traffic is streaming - an open bus (RX) and/or
// Carlito telemetry - while not paused, since that muddies the raw command console.
// Called from updateTerminalTab() + on Carlito open/close.
function updateTermTrafficWarn() {
  const warn = document.getElementById('termTrafficWarn');
  if (!warn) return;
  const carlitoOpen = window.carlitoIsOpen && window.carlitoIsOpen();
  const live = !paused && (busIsOpen || carlitoOpen);
  warn.style.display = live ? 'block' : 'none';
}
window.updateTermTrafficWarn = updateTermTrafficWarn;

async function busPauseClick() {
  if (!busIsOpen) {
    // Open bus
    if (demoMode) {
      busIsOpen = true;
      paused = false;
      demoStartBaseTimers();
      if (txSuspended) toggleTxSuspend();
      updateBusPauseBtn();
    } else {
      await busOpen();
    }
  } else if (!paused) {
    paused = true;
    if (demoMode) {
      demoStopBaseTimers();
    } else if (connMode === 'gsusb') {
      await gsSetMode(false, false);
    } else {
      await sendCommand('C');
    }
    if (!txSuspended) toggleTxSuspend();
    log('Bus closed (paused)', 'warn');
    updateBusPauseBtn();
  } else {
    paused = false;
    if (demoMode) {
      demoStartBaseTimers();
    } else if (connMode === 'gsusb') {
      await gsSetMode(true, document.getElementById('listenOnly').checked);
      log('Bus opened (gs_usb, resumed)', 'ok');
    } else {
      const cmd = getOpenCmd();
      await sendCommand(cmd);
      log(`Bus opened (resumed, ${cmd})`, 'ok');
    }
    if (txSuspended) toggleTxSuspend();
    updateBusPauseBtn();
    rerenderTable();
  }
}

function updateNotchBtn() {
  const onIds = document.getElementById('vtab-ids').classList.contains('active');
  const onDump = document.getElementById('vtab-dump').classList.contains('active');
  const enabled = busIsOpen && !paused && (onIds || onDump);
  document.getElementById('notchBtn').disabled = !enabled;
  document.getElementById('notchArrowBtn').disabled = !enabled;
}

function clearInspector() {
  document.getElementById('inspectContent').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:200px;gap:14px;color:var(--text3)">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M9 5v14"/></svg>
      <div style="font-size:15px;font-weight:500;color:var(--text2)">No frame selected</div>
      <div style="font-size:13px;">Click a frame in the ID List or Traffic Dump to inspect it here.</div>
    </div>`;
}

function clearFrames() {
  frames.clear();
  changedIds.clear();
  if (notching) {
    clearInterval(notchTicker); notchTicker = null;
    clearTimeout(notchTimer);  notchTimer  = null;
    notching = false;
  }
  notchedBytes.clear(); stableBytes.clear();
  notchSnapshot = null;
  dumpLog.clear();
  dumpStartTs = null;
  dumpAutoScroll = true;
  dumpLastFirst = -1; dumpLastLast = -1; dumpLastSize = -1; dumpLastHead = -1;
  dumpFilterDirty = true; dumpFilterCache = null;
  dumpRowElsDirty = true;
  document.getElementById('dumpBody').innerHTML = '';
  dumpRowEls.clear();
  document.getElementById('statDumpBuf').textContent = '0%';
  document.getElementById('statDumpBuf').style.color = '';
  document.getElementById('termBody').innerHTML = '';
  clearInspector();
  if (dumpViewActive) renderDump();
  document.getElementById('notchLabel').textContent = 'Notch';
  document.getElementById('notchBtn').classList.remove('active-notch');
  if (window.j1939Clear) j1939Clear(); // ← J1939 hook
  if (window.chademoClear) chademoClear(); // ← CHAdeMO hook
  if (window.xcpClear) xcpClear(); // ← XCP hook
  if (window.canopenClear) canopenClear(); // ← CANopen hook
  if (window.ramnClear) ramnClear(); // ← RAMN dashboard hook
  totalFrames = 0;
  parseErrors = 0;
  frameRateBuffer = [];
  bytesReceived = 0;
  document.getElementById('statBytes').textContent = '0';
  document.getElementById('statTotal').textContent = '0';
  document.getElementById('statRate').textContent = '0';
  document.getElementById('statErrors').textContent = '0';
  document.getElementById('statIds').textContent = '0';
  document.getElementById('frameBody').innerHTML = '';
  document.getElementById('frameTable').style.display = 'none';
  document.getElementById('emptyState').style.display = 'flex';
  log('Cleared', 'warn');
}

// ── Notch ────────────────────────────────────────────────────────────────────
// Observes traffic for a configurable duration (0.1s–100s, default 1s).
// Bytes that changed → amber (noisy). Bytes that didn't change → grey (stable, value-locked).
// New IDs appearing after a notch → cyan row background.
// Click during notch to interrupt early with results so far. Click again to clear.
function notchFinish(snapshot) {
  clearInterval(notchTicker); notchTicker = null;
  clearTimeout(notchTimer);  notchTimer = null;
  notching = false;

  notchedBytes.clear(); stableBytes.clear();
  frames.forEach((f, key) => {
    if (!snapshot.has(key)) return; // new frame - appeared after notch started
    const { ts: before, data: snapData, lastSeen: snapLastSeen } = snapshot.get(key);
    if (f.lastSeen <= snapLastSeen) return; // not received during the notch window
    const after  = f.byteChangedAt || [];
    const noisy  = new Set();
    const stable = new Map(); // idx → snapshotted value
    before.forEach((t, i) => {
      const changed = after[i] !== undefined && after[i] !== t;
      if (changed) noisy.add(i);
      else         stable.set(i, snapData[i]); // record the value observed
    });
    // New bytes (DLC grew during notch) are noisy
    for (let i = before.length; i < after.length; i++) noisy.add(i);
    if (noisy.size  > 0) notchedBytes.set(key, noisy);
    if (stable.size > 0) stableBytes.set(key, stable); // Map not Set
  });

  const noisyCount = Array.from(notchedBytes.values()).reduce((s, v) => s + v.size, 0);
  const btn   = document.getElementById('notchBtn');
  const label = document.getElementById('notchLabel');
  label.textContent = notchedBytes.size > 0 ? 'Clear Notch' : 'Notch';
  btn.disabled = false;
  document.getElementById('notchArrowBtn').disabled = false;
  if (notchedBytes.size > 0) btn.classList.add('active-notch');
  updateFilterOutBtn();
  log(`Notch complete - ${noisyCount} noisy byte(s) across ${notchedBytes.size} ID(s)`, 'ok');
  rerenderTable();
  dumpRowElsDirty = true; dumpLastHead = -1; renderDump();
}

function notchClick() {
  if (notching) {
    // Interrupt: finish immediately with results so far
    notchFinish(notchSnapshot);
    return;
  }
  if (notchedBytes.size > 0) {
    // Clear existing notch
    notchedBytes.clear(); stableBytes.clear();
    notchSnapshot = null;
    document.getElementById('notchLabel').textContent = 'Notch';
    document.getElementById('notchBtn').classList.remove('active-notch');
    updateFilterOutBtn();
    log('Notch cleared', 'warn');
    rerenderTable();
    dumpRowElsDirty = true; dumpLastHead = -1; renderDump();
    return;
  }

  notching = true;
  const btn   = document.getElementById('notchBtn');
  const label = document.getElementById('notchLabel');
  btn.disabled = false; // keep enabled so user can interrupt
  document.getElementById('notchArrowBtn').disabled = true;

  const durationS  = Math.min(100, Math.max(0.1, parseFloat(document.getElementById('notchDuration').value) || 1));
  const durationMs = Math.round(durationS * 1000);

  // Snapshot - store byteChangedAt timestamps, current data values, and lastSeen.
  // lastSeen is used in notchFinish to skip frames that weren't received during the window.
  notchSnapshot = new Map();
  frames.forEach((f, key) => {
    notchSnapshot.set(key, {
      ts:       (f.byteChangedAt || []).slice(),
      data:     (f.data || []).slice(),
      lastSeen: f.lastSeen
    });
  });

  // Countdown
  let elapsed = 0;
  label.textContent = `Stop (${durationS.toFixed(1)}s)`;
  notchTicker = setInterval(() => {
    elapsed += 100;
    const left = Math.max(0, durationS - elapsed / 1000);
    label.textContent = `Stop (${left.toFixed(1)}s)`;
  }, 100);

  notchTimer = setTimeout(() => notchFinish(notchSnapshot), durationMs);
}

// Toggle the notch IDs in/out of the ID filter. First press applies them as an Exclude
// filter (hiding the characterized baseline); a second press reverts to the prior filter.
function filterOutNotched() {
  const field = document.getElementById('filterIds');
  const excl  = document.getElementById('filterIdsExclude');

  // Second press - our applied filter is still in place: revert to what was there before.
  if (filterOutState && field.value === filterOutState.applied && excl.checked) {
    field.value   = filterOutState.prevValue;
    excl.checked  = filterOutState.prevExclude;
    filterOutState = null;
    filterOutApply(field, excl);
    return;
  }

  if (notchedBytes.size === 0 && stableBytes.size === 0) return;
  // Union of frame keys active during the notch window → numeric IDs → dedup → sorted hex.
  const idSet = new Set();
  [...notchedBytes.keys(), ...stableBytes.keys()].forEach(k => {
    const f = frames.get(k);
    idSet.add(f ? f.id : parseInt(k.split(':')[1], 10));
  });
  const applied = [...idSet].sort((a, b) => a - b)
                            .map(id => id.toString(16).toUpperCase().padStart(3, '0'))
                            .join(', ');

  if (field.value.trim() !== '' && field.value !== applied &&
      !confirm('This will overwrite the current ID filter with the IDs seen during the notch.\n\nProceed?')) {
    return;
  }
  filterOutState = { applied, prevValue: field.value, prevExclude: excl.checked };
  field.value  = applied;
  excl.checked = true;
  filterOutApply(field, excl);
}

// Re-apply the filter, flash the affected controls, and refresh the button state.
function filterOutApply(field, excl) {
  validateFilterIds();
  dumpFilterDirty = true; dumpLastSize = -1;
  rerenderTable(); renderDump();
  isotpFlashField(field);                  // flash the filter field
  isotpFlashField(excl.closest('label'));  // flash the Exclude checkbox's label
  updateFilterOutBtn();
}

function updateFilterOutBtn() {
  const b = document.getElementById('filterOutBtn');
  if (!b) return;
  // Stay enabled while a filter is applied so it can be reverted, even after the notch clears.
  b.disabled = notchedBytes.size === 0 && !filterOutState;
  b.classList.toggle('active-notch', !!filterOutState);
  const lbl = document.getElementById('filterOutLabel');
  if (lbl) lbl.textContent = filterOutState ? 'Undo filter' : 'Filter out';
}

// ── Resize handle ────────────────────────────────────────────────────────────
(function() {
  const handle = document.getElementById('resizeHandle');
  const panel  = document.getElementById('logPanel');
  const MIN_H  = 80;
  const MAX_H  = window.innerHeight * 0.75;
  let dragging = false, startY = 0, startH = 0;

  handle.addEventListener('mouseenter', () => handle.style.background = 'var(--border2)');
  handle.addEventListener('mouseleave', () => { if (!dragging) handle.style.background = 'transparent'; });

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = panel.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    // Dragging up = larger panel (delta is negative when moving up)
    const delta = startY - e.clientY;
    const newH  = Math.min(MAX_H, Math.max(MIN_H, startH + delta));
    panel.style.height = newH + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.style.background = 'transparent';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Demo Mode ────────────────────────────────────────────────────────────────
// Simulates 9 CAN IDs at configurable rates without a real serial device.
// Frame format: 2-byte payload (0x0000) + 2-byte counter (BE) + 4-byte CRC-32/ISO-HDLC (LE).
// IDs 0x024/0x039/0x062 at 10ms; others at 100ms.
// Demo mode is permanent for the session - reload the page to exit.
// sendCommand() is a no-op in demo mode except when the Serial Terminal tab is active.
let demoMode = false;
let demoTimers = [];
let demoCounters = {};
// Only one "base traffic" generator runs at a time. Starts on the traffic for the
// active tab (RAMN by default); switching to the J1939/N2K, CHAdeMO, or CANopen tab
// in demo mode prompts to change it. Returning to RAMN requires a page reload.
// 'ramn' | 'j1939' | 'nmea2000' | 'iso11783' (drive demoInjectN2k) | 'chademo' | 'canopen'.
let demoBaseTraffic = 'ramn';

const DEMO_CONFIG = [
  { id: 0x024, period: 10  },
  { id: 0x039, period: 10  },
  { id: 0x062, period: 10  },
  { id: 0x077, period: 100 },
  { id: 0x098, period: 100 },
  { id: 0x150, period: 100 },
  { id: 0x1A7, period: 100 },
  { id: 0x1BB, period: 100 },
  { id: 0x1B8, period: 100 },
  { id: 0x1D3, period: 100 },
];

// CRC-32/ISO-HDLC (polynomial 0xEDB88320, init 0xFFFFFFFF, XOR out 0xFFFFFFFF)
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function demoTick(id) {
  const cnt = (demoCounters[id] = ((demoCounters[id] || 0) + 1) & 0xFFFF);
  // RAMN Control Panel (demo only) supplies the payload bytes; default 0x0000.
  const payload = window.ramnCtrlPayload ? window.ramnCtrlPayload(id) : [0x00, 0x00];
  const counter = [(cnt >> 8) & 0xFF, cnt & 0xFF]; // 2-byte counter BE
  const head4 = [...payload, ...counter];
  const crcVal = crc32(head4);
  const crcBytes = [
    crcVal & 0xFF, (crcVal >> 8) & 0xFF,
    (crcVal >> 16) & 0xFF, (crcVal >> 24) & 0xFF
  ]; // 4-byte CRC LE
  const data = [...head4, ...crcBytes]; // 8 bytes total

  // Build a synthetic parsed frame and inject it
  const frame = { id, isExt: false, isRtr: false, dlc: 8, data };
  ingestFrame(frame);
  totalFrames++;
  frameRateBuffer.push(Date.now());
}

// Demo: inject J1939 / NMEA 2000 / ISOBUS frames for the active J1939-tab proto mode
// (j1939.js returns the frame set for whichever mode is selected).
function demoInjectN2k() {
  if (!window.j1939DemoFrames) return;
  for (const fr of window.j1939DemoFrames()) {
    ingestFrame(fr);
    totalFrames++;
    frameRateBuffer.push(Date.now());
  }
}

// ── Demo base-traffic engine ───────────────────────────────────────────────────
// Exactly one base-traffic generator is active at a time (tracked by demoBaseTraffic).
const DEMO_J1939_KINDS = ['j1939', 'nmea2000', 'iso11783'];

function demoStopBaseTimers() {
  demoTimers.forEach(t => clearInterval(t));
  demoTimers = [];
  if (window.chademoDemoLoopStop) window.chademoDemoLoopStop(); // safe no-ops if not running
  if (window.canopenDemoStop) window.canopenDemoStop();
}

function demoStartBaseTimers() {
  demoStopBaseTimers();
  if (demoBaseTraffic === 'ramn') {
    DEMO_CONFIG.forEach(({ id, period }) => {
      demoTimers.push(setInterval(() => demoTick(id), period));
    });
  } else if (demoBaseTraffic === 'chademo') {
    if (window.chademoDemoLoopStart) window.chademoDemoLoopStart();
  } else if (demoBaseTraffic === 'canopen') {
    if (window.canopenDemoStart) window.canopenDemoStart();
  } else { // j1939 / nmea2000 / iso11783
    demoTimers.push(setInterval(demoInjectN2k, 100));
  }
}

// Pick the base traffic to start demo with, based on the tab the user is viewing -
// pressing Demo while on the J1939/N2K, CHAdeMO, or CANopen tab starts that traffic
// directly (no prompt). Defaults to RAMN.
function demoInitialBaseTraffic() {
  const active = document.querySelector('.view-tabs .view-tab.active')?.id || '';
  if (active === 'vtab-j1939')   return window.j1939GetProto ? window.j1939GetProto() : 'j1939';
  if (active === 'vtab-chademo') return 'chademo';
  if (active === 'vtab-canopen') return 'canopen';
  return 'ramn';
}

// Switch the active base traffic (assumes demo mode + a confirmed choice).
function demoSetBaseTraffic(kind) {
  demoStopBaseTimers();
  demoBaseTraffic = kind;
  if (DEMO_J1939_KINDS.includes(kind) && window.j1939SetProto) window.j1939SetProto(kind);
  demoStartBaseTimers();
}

// Prompt the user before changing demo base traffic. Returns true if the requested
// kind is (now) the active base traffic. No-op outside demo mode.
function demoMaybeSwitch(kind, label) {
  if (!demoMode) return true;
  if (demoBaseTraffic === kind) return true;
  if (!confirm(`Switch demo traffic to ${label}?\n\nThis replaces the current demo traffic. You will need to reload the page to return to the default RAMN traffic.`))
    return false;
  if (confirm('Clear the frame buffer first?\n\nThis removes the previous demo traffic from the ID List, Traffic Dump, and decoder logs.'))
    clearFrames();
  demoSetBaseTraffic(kind);
  return true;
}
window.demoMaybeSwitch = demoMaybeSwitch;

// Simulate a "Service Not Supported" (NRC 0x11) ISO-TP response in demo mode.
// Injects a fake SF from rxId after a short random delay to mimic ECU latency.
// PIDs the demo ECU claims to support (Mode 01). The 0x20/0x40 entries are the
// "more supported PIDs follow" chain bits, so a probe walks all three blocks.
const DEMO_OBD_PIDS = new Set([
  0x01, 0x04, 0x05, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x1C, 0x1F,
  0x20, 0x2F, 0x40, 0x42, 0x46,
]);

// 4-byte supported-PID bitmask for the block whose first PID is base+1 (MSB = base+1).
function demoObdBitmask(base, pidSet = DEMO_OBD_PIDS) {
  let v = 0;
  for (let i = 1; i <= 0x20; i++) if (pidSet.has(base + i)) v |= (1 << (0x20 - i));
  return [(v>>>24)&0xFF, (v>>>16)&0xFF, (v>>>8)&0xFF, v&0xFF];
}

// A second demo ECU (transmission) that answers only a subset - used to demonstrate
// functional-broadcast multi-responder. Returns null for anything it doesn't handle.
const DEMO_OBD_PIDS2 = new Set([0x05, 0x1C]);
function demoObdResponse2(req) {
  const mode = req[0];
  if (mode === 0x01) {
    const pid = req[1];
    if (pid === 0x00) return [0x41, 0x00, ...demoObdBitmask(0x00, DEMO_OBD_PIDS2)];
    if (pid === 0x05) return [0x41, 0x05, 68 + 40];   // transmission fluid ~68 °C
    if (pid === 0x1C) return [0x41, 0x1C, 0x06];
    return null;
  }
  if (mode === 0x03 || mode === 0x07 || mode === 0x0A) return [mode + 0x40, 0x07, 0x00]; // P0700
  if (mode === 0x04) return [0x44];
  return null;
}

// Build a plausible, slowly-animated OBD response payload for a request, or null
// (null → no reply, i.e. a realistic timeout for unsupported asks).
function demoObdResponse(req) {
  const mode = req[0];
  const t = Date.now() / 1000;
  const osc = (lo, hi, period, phase=0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * 2*Math.PI/period + phase));
  if (mode === 0x01) {
    const pid = req[1];
    if (pid === 0x00 || pid === 0x20 || pid === 0x40 || pid === 0x60)
      return [0x41, pid, ...demoObdBitmask(pid)];
    if (!DEMO_OBD_PIDS.has(pid)) return null;
    const r = v => [0x41, pid, ...(Array.isArray(v) ? v : [v])];
    switch (pid) {
      case 0x01: return r([0x00, 0x07, 0xE5, 0x00]);                  // monitors, MIL off
      case 0x04: return r(Math.round(osc(20, 75, 11) * 255 / 100));   // load %
      case 0x05: return r(Math.round(osc(82, 98, 60)) + 40);          // coolant °C
      case 0x0B: return r(Math.round(osc(30, 95, 7)));                // MAP kPa
      case 0x0C: { const rpm = Math.round(osc(780, 3200, 9)) * 4; return r([(rpm>>8)&0xFF, rpm&0xFF]); }
      case 0x0D: return r(Math.round(osc(0, 120, 17)));               // speed km/h
      case 0x0E: return r(Math.round((osc(-5, 35, 9) + 64) * 2));     // timing advance
      case 0x0F: return r(Math.round(osc(20, 45, 90)) + 40);          // intake air °C
      case 0x10: { const maf = Math.round(osc(2, 60, 8) * 100); return r([(maf>>8)&0xFF, maf&0xFF]); }
      case 0x11: return r(Math.round(osc(12, 80, 11) * 255 / 100));   // throttle %
      case 0x1C: return r(0x06);                                       // OBD standard (EOBD+OBD+OBD II)
      case 0x1F: { const s = Math.floor(t) % 65536; return r([(s>>8)&0xFF, s&0xFF]); } // run time
      case 0x2F: return r(Math.round(osc(15, 90, 200) * 255 / 100));  // fuel level %
      case 0x42: { const mv = Math.round(osc(13600, 14200, 5)); return r([(mv>>8)&0xFF, mv&0xFF]); } // voltage
      case 0x46: return r(22 + 40);                                    // ambient °C
      default:   return r(0x00);
    }
  }
  if (mode === 0x03 || mode === 0x07 || mode === 0x0A) {
    // Stored / pending / permanent DTCs (pairs, no count byte - matches obdDecode)
    return [mode + 0x40, 0x01, 0x33, 0x04, 0x20]; // P0133, P0420
  }
  if (mode === 0x04) return [0x44];                                    // DTCs cleared
  if (mode === 0x09 && req[1] === 0x02) {
    // VIN - 0x49 0x02 <count=01> + 17 ASCII chars (multi-frame ISO-TP)
    const vin = 'SLOPPYCAN0DEMO001';
    return [0x49, 0x02, 0x01, ...vin.split('').map(c => c.charCodeAt(0))];
  }
  return null;
}

function demoIsoTpRespond(requestPayload, cfg) {
  const mode  = requestPayload[0];
  const isObd = mode >= 0x01 && mode <= 0x0A;

  // Functional broadcast → simulate two ECUs answering on their own IDs.
  if (isObd && isotpIsFunctional(cfg)) {
    const eng  = cfg.isExt ? 0x18DAF110 : 0x7E9; // engine
    const tcm  = cfg.isExt ? 0x18DAF11A : 0x7EA; // transmission
    const r1 = demoObdResponse(requestPayload);
    const r2 = demoObdResponse2(requestPayload);
    if (r1) demoInjectIsoTp(r1, eng, cfg);
    if (r2) demoInjectIsoTp(r2, tcm, cfg);
    return;
  }

  const respPayload = isObd
    ? demoObdResponse(requestPayload)
    : obdProtoMode === 'kwp'
      ? demoKwpResponse(requestPayload)
      : demoUdsResponse(requestPayload);
  if (!respPayload) return; // unsupported OBD ask → no reply (timeout)
  demoInjectIsoTp(respPayload, cfg.rxId, cfg);
}

// Demo KWP2000 responder - positive response (SID+0x40) for known SIDs, else
// NRC serviceNotSupported. Lets palette requests round-trip without hardware.
function demoKwpResponse(req) {
  const sid = req[0];
  const ascii = s => Array.from(s, c => c.charCodeAt(0));
  switch (sid) {
    case 0x81: return [0xC1, 0xEA, 0x8F];               // StartCommunication + key bytes
    case 0x82: return [0xC2];                           // StopCommunication
    case 0x3E: return [0x7E];                           // TesterPresent
    case 0x10: return [0x50, req[1] ?? 0x81];           // StartDiagnosticSession
    case 0x11: return [0x51, req[1] ?? 0x01];           // ECUReset
    case 0x1A: return [0x5A, req[1] ?? 0x9A, ...ascii('SLOPPYCAN-ECU')]; // ReadECUIdentification
    case 0x21: return [0x61, req[1] ?? 0xF0, 0x12, 0x34, 0x56, 0x78];    // ReadDataByLocalIdentifier
    default:   return [0x7F, sid, 0x11];               // serviceNotSupported
  }
}

// Demo UDS (ISO 14229) responder - positive response (SID+0x40) for the SIDs the
// UDS palette can send, else NRC serviceNotSupported. Mirrors demoKwpResponse so
// the tab's shortcuts round-trip without hardware.
function demoUdsResponse(req) {
  const sid = req[0];
  const ascii = s => Array.from(s, c => c.charCodeAt(0));
  switch (sid) {
    case 0x10: return [0x50, req[1] ?? 0x03, 0x00, 0x32, 0x01, 0xF4]; // DiagnosticSessionControl (+P2/P2*)
    case 0x11: return [0x51, req[1] ?? 0x01];                          // ECUReset
    case 0x3E: return [0x7E, req[1] ?? 0x00];                          // TesterPresent
    case 0x14: return [0x54];                                          // ClearDiagnosticInformation
    case 0x19: // ReadDTCInformation - for reportDTCByStatusMask, return two DTCs
      return (req[1] === 0x02)
        ? [0x59, 0x02, 0xFF, 0x01,0x33,0x04, 0x2F, 0x04,0x20,0x00, 0x08] // P0133, P0420
        : [0x59, req[1] ?? 0x02, 0xFF];
    case 0x22: return [0x62, req[1] ?? 0xF1, req[2] ?? 0x84, ...ascii('SLOPPYCAN0DEMO')]; // ReadDataByIdentifier
    case 0x27: { // SecurityAccess: odd level = requestSeed (returns seed), even = sendKey
      const lvl = req[1] ?? 0x01;
      return (lvl % 2 === 1) ? [0x67, lvl, 0x11, 0x22, 0x33, 0x44] : [0x67, lvl];
    }
    case 0x28: return [0x68, req[1] ?? 0x00];                          // CommunicationControl
    case 0x31: return [0x71, req[1] ?? 0x01, req[2] ?? 0xF0, req[3] ?? 0x0F, 0x00]; // RoutineControl
    case 0x85: return [0xC5, req[1] ?? 0x02];                          // ControlDTCSetting
    case 0x87: return [0xC7, req[1] ?? 0x01];                          // LinkControl
    default:   return [0x7F, sid, 0x11];                              // serviceNotSupported
  }
}

// Inject a full ISO-TP response (SF, or FF + CFs) as RX frames from one responder.
// One base latency for the whole sequence so frames keep their order (each CF must
// arrive after its FF) - a per-frame random delay could reorder them.
function demoInjectIsoTp(respPayload, respId, cfg) {
  const frames = isotpBuildFrames(respPayload, cfg);
  const base   = 50 + Math.random() * 60; // 50–110 ms simulated ECU latency
  frames.forEach((data, i) => {
    setTimeout(() => {
      ingestFrame({ id: respId, isExt: cfg.isExt, isRtr: false, dlc: data.length, data });
      totalFrames++;
      frameRateBuffer.push(Date.now());
    }, base + i * 12); // CFs staggered 12 ms apart, in order
  });
}

function startDemo() {
  if (demoMode) return;
  demoMode = true;

  busIsOpen = true;
  demoCounters = {};
  demoBaseTraffic = demoInitialBaseTraffic();
  demoStartBaseTimers();

  document.getElementById('connectBtn').style.display = 'none';
  document.getElementById('disconnectBtn').style.display = 'none';
  makeReloadBtn(); // transform Demo button into a page-reload button
  document.getElementById('listenOnly').disabled = true;
  document.getElementById('baudRate').disabled = true;
  document.getElementById('autoOpen').disabled = true;
  document.getElementById('notchBtn').disabled = false;
  document.getElementById('termInput').disabled = false;
  document.getElementById('termInput').style.opacity = '1';

  updateBusPauseBtn();
  updateNotchBtn();
  startRenderLoop();
  reflowHeader();
  if (window.ramnDemoStarted) window.ramnDemoStarted(); // ← RAMN demo hook
  if (window.carlitoBusReady) window.carlitoBusReady(); // ← open Carlito if it was requested before a bus existed
  log('Demo mode started - reload the page to exit demo mode.', 'ok');
}

// ── ISO-TP / UDS ─────────────────────────────────────────────────────────────
// Simplified ISO 15765-2 transport layer, client (tester) mode only.
// Supports: Single Frame (SF), First Frame (FF), Consecutive Frame (CF),
// Flow Control (FC). Addressing: Normal or Extended (+1 address byte).
//
// Request flow (tester → ECU):
//   SF  (payload ≤ maxSF bytes)  → arm timeout → await SF/FF response
//   FF + CFs                     → arm timeout → await FC from ECU → flush CFs
//                                              → arm timeout → await SF/FF response
//
// Response flow (ECU → tester):
//   SF  → complete
//   FF  → send FC → await CFs → complete when totalLen reached

let isotpHistory    = [];    // UP-arrow command history
let isotpHistoryIdx = -1;
let isotpRxState    = null;  // {totalLen, data[], seqExpected} - ongoing multi-frame rx
let isotpPendingEl  = null;  // DOM wrap element awaiting a response
let isotpTimer      = null;  // N_Bs / N_Cr timeout handle
let isotpTxQueue    = [];    // CF frames queued to send after FC
let isotpCfBlkCnt   = 0;     // frames sent since last FC
let isotpEpoch      = 0;     // bumped by isotpCancelAll so an in-flight CF flush can detect cancellation
let isotpEntrySeq   = 0;     // monotonic counter for unique decode-panel IDs
// Functional-addressing (0x7DF / 0x18DB33F1) multi-responder state. Active only for
// manual sends to a functional Tx ID; the single-responder path above is untouched.
let isotpFuncMode   = false; // true while aggregating responses from multiple ECUs
let isotpRxMap      = new Map(); // responderId -> {totalLen, data[], seqExpected, cfRxCount}
let isotpFuncCount  = 0;     // responders seen in the current functional window

const ISOTP_TIMEOUT = 1000;  // ms - simplified fixed timeout for all N_x timers

function isotpCfg() {
  const txId     = parseInt(document.getElementById('isotpTxId').value.trim(), 16);
  const rxId     = parseInt(document.getElementById('isotpRxId').value.trim(), 16);
  const isExt    = document.getElementById('isotpCanType').value === 'ext';
  const addrMode = document.getElementById('isotpAddrMode').value; // 'normal'|'extended'
  const addrByte = addrMode === 'extended'
    ? (parseInt(document.getElementById('isotpAddrByte').value.trim(), 16) & 0xFF)
    : -1;
  const blockSize = (parseInt(document.getElementById('isotpBlockSize').value.trim(), 16) || 0) & 0xFF;
  const stminDec  = isotpDecodeStmin(document.getElementById('isotpStmin').value.trim());
  const stmin     = stminDec.raw;
  const padStr    = document.getElementById('isotpPadding').value.trim();
  const padding   = /^[0-9A-Fa-f]{2}$/.test(padStr) ? parseInt(padStr, 16) : null;
  return { txId, rxId, isExt, addrMode, addrByte, blockSize, stmin, stminMs: stminDec.ms, padding };
}

function isotpPadFrame(bytes, padding) {
  if (padding === null || bytes.length >= 8) return bytes;
  const out = bytes.slice();
  while (out.length < 8) out.push(padding);
  return out;
}

// Build CAN data byte arrays for a complete ISO-TP message.
function isotpBuildFrames(payload, cfg) {
  const pfx    = cfg.addrMode === 'extended' ? [cfg.addrByte] : [];
  const maxSF  = 7 - pfx.length;   // max payload in a Single Frame
  const maxFF  = 6 - pfx.length;   // payload bytes packed in First Frame
  const maxCF  = 7 - pfx.length;   // payload bytes per Consecutive Frame
  const frames = [];

  if (payload.length <= maxSF) {
    frames.push(isotpPadFrame([...pfx, payload.length, ...payload], cfg.padding));
  } else {
    const len = payload.length;
    frames.push([...pfx, 0x10 | ((len >> 8) & 0x0F), len & 0xFF, ...payload.slice(0, maxFF)]);
    let off = maxFF, seq = 1;
    while (off < len) {
      frames.push(isotpPadFrame([...pfx, 0x20 | (seq & 0x0F), ...payload.slice(off, off + maxCF)], cfg.padding));
      off += maxCF;
      seq = (seq + 1) & 0x0F;
    }
  }
  return frames;
}

// Transmit one CAN data frame via SLCAN and record it in the dump log. `txIdOverride`
// lets the functional path send a Flow Control to a responder's physical ID instead of cfg.txId.
async function isotpTxCan(data, cfg, txIdOverride) {
  const txId = txIdOverride ?? cfg.txId;
  if (connMode === 'gsusb') {
    const r = await usbSerDev.transferOut(usbSerOut, gsUsbPackFrame(txId, cfg.isExt, false, data));
    if (r && r.status !== 'ok') log(`gs_usb TX ${r.status}`, 'err');
  } else {
    const idHex = txId.toString(16).toUpperCase().padStart(cfg.isExt ? 8 : 3, '0');
    const cmd   = (cfg.isExt ? 'T' : 't') + idHex + data.length +
                  data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    await sendCommand(cmd);
  }
  // Record in the frames Map / dump log so the request shows up in the ID list with a TX badge.
  recordTxFrame(txId, cfg.isExt, false, data.length, [...data]);
}

// Send a Flow Control frame (CTS) from tester to ECU.
async function isotpSendFC(cfg) {
  const pfx  = cfg.addrMode === 'extended' ? [cfg.addrByte] : [];
  const data = isotpPadFrame([...pfx, 0x30, cfg.blockSize, cfg.stmin], cfg.padding);
  await isotpTxCan(data, cfg);
}

// Same FC, but addressed to a specific responder's physical request ID (functional mode).
async function isotpSendFCTo(cfg, targetId) {
  const pfx  = cfg.addrMode === 'extended' ? [cfg.addrByte] : [];
  const data = isotpPadFrame([...pfx, 0x30, cfg.blockSize, cfg.stmin], cfg.padding);
  await isotpTxCan(data, cfg, targetId);
}

// ── Functional addressing helpers ────────────────────────────────────────────
// A request is functional (broadcast to all ECUs) when Tx is the OBD functional ID.
// Functional + extended addressing is exotic and stays on the single-responder path.
function isotpIsFunctional(cfg) {
  if (cfg.addrMode !== 'normal') return false;
  return (!cfg.isExt && cfg.txId === 0x7DF) || (cfg.isExt && cfg.txId === 0x18DB33F1);
}
// True if `id` is a valid OBD responder for a functional request (any ECU in the range).
function isotpIsResponder(id, isExt, cfg) {
  if (isExt !== cfg.isExt) return false;
  return cfg.isExt ? (id & 0xFFFFFF00) === 0x18DAF100
                   : (id >= 0x7E8 && id <= 0x7EF);
}
// Map a responder ID to the ECU's physical request ID (where its Flow Control must go).
function isotpPhysicalIdFor(rid, isExt) {
  return isExt ? (0x18DA0000 | ((rid & 0xFF) << 8) | 0xF1) : (rid - 8);
}

// Decode an ISO 15765-2 STmin byte into a millisecond gap. 0x00–0x7F = that many ms; 0xF1–0xF9 =
// 100–900 µs (sub-ms; floored to 1 ms since setTimeout can't do better); all else reserved → 127 ms.
function isotpStminToMs(b) {
  if (b <= 0x7F) return b;
  if (b >= 0xF1 && b <= 0xF9) return 1;
  return 127;
}

// Send queued CF frames, pacing by the RECEIVER-dictated BlockSize/STmin from its Flow Control
// (ISO 15765-2: the sender must honor the FC params). bs/stminMs come from the ECU's FC frame;
// when absent (short FC) we fall back to our own configured values.
async function isotpFlushCFs(cfg, bs, stminMs) {
  const blkSize = bs != null ? bs : cfg.blockSize;
  const gapMs   = stminMs != null ? stminMs : cfg.stminMs;
  const epoch   = isotpEpoch;   // snapshot - isotpCancelAll bumps this if we're torn down mid-flush
  while (isotpTxQueue.length > 0) {
    await isotpTxCan(isotpTxQueue.shift(), cfg);
    if (isotpEpoch !== epoch) return; // cancelled during the send - don't arm a timer against cleared state
    isotpCfBlkCnt++;
    if (blkSize > 0 && isotpCfBlkCnt >= blkSize) {
      isotpCfBlkCnt = 0;
      isotpArmTimer(); // block full - wait for next FC before continuing
      return;
    }
    if (gapMs > 0) await new Promise(r => setTimeout(r, gapMs));
  }
  if (isotpEpoch !== epoch) return; // queue emptied by isotpCancelAll during the final STmin gap
  isotpArmTimer(); // all CFs sent, now await response
}

function isotpArmTimer() {
  if (isotpTimer) clearTimeout(isotpTimer);
  isotpTimer = setTimeout(() => {
    isotpTimer = null;
    if (isotpFuncMode) { isotpFuncFinalize(); return; }
    if (isotpPendingEl) { isotpMarkTimeout(isotpPendingEl); isotpPendingEl = null; }
    isotpRxState  = null;
    isotpTxQueue  = [];
  }, ISOTP_TIMEOUT);
}

function isotpCancelAll() {
  if (isotpTimer) { clearTimeout(isotpTimer); isotpTimer = null; }
  isotpRxState  = null;
  isotpTxQueue  = [];
  isotpCfBlkCnt = 0;
  isotpRxMap.clear();
  isotpFuncMode = false;
  isotpEpoch++;  // signal any in-flight isotpFlushCFs that its state was torn down mid-flush
  // NOTE: obdCaptureCb is intentionally NOT cleared here - the success path calls isotpCancelAll()
  // *before* isotpMarkDone(), which needs the callback to still be live. A manual send clears it
  // itself at the top of isotpSend().
}

// ── RX state machine ─────────────────────────────────────────────────────────
// Called from ingestFrame() for every received CAN frame. Fast early-exit when
// there is no pending request, so there is no performance impact on normal use.
// Decode the ISO-TP PCI of a received frame into a structured descriptor (pure; no state).
// Returns null if the frame is too short for the addressing mode, else { kind, off, … } where
// kind ∈ 'sf' | 'ff' | 'cf' | 'fc' | 'unknown'. Shared by physical + functional RX.
function isotpDecodePci(d, addrMode) {
  const off = addrMode === 'extended' ? 1 : 0;
  if (d.length <= off) return null;
  const pciHi = (d[off] >> 4) & 0x0F;
  if (pciHi === 0) {
    const len     = d[off] & 0x0F;
    const payload = d.slice(off + 1, off + 1 + len);
    // NRC 0x78 - ResponsePending
    return { kind: 'sf', off, payload, pending: payload.length >= 3 && payload[0] === 0x7F && payload[2] === 0x78 };
  }
  if (pciHi === 1) return { kind: 'ff', off, totalLen: ((d[off] & 0x0F) << 8) | d[off + 1], data: [...d.slice(off + 2)] };
  if (pciHi === 2) return { kind: 'cf', off, seq: d[off] & 0x0F, data: d.slice(off + 1) };
  if (pciHi === 3) return { kind: 'fc', off, fs: d[off] & 0x0F, bs: d[off + 1], stmin: d[off + 2] }; // bs/stmin undefined on a short FC → caller falls back to cfg
  return { kind: 'unknown', off };
}

// Append a CF descriptor to a reassembly state ({ totalLen, data, seqExpected, cfRxCount }).
// Returns 'seqError' (drop), 'complete' (data ≥ totalLen), or 'continue'. cfRxCount tracks how
// many CFs have arrived in the current block so the caller knows when to send the next FC.
function isotpAppendCf(st, pci) {
  if (pci.seq !== st.seqExpected) return 'seqError';
  st.seqExpected = (st.seqExpected + 1) & 0x0F;
  st.data.push(...pci.data);
  st.cfRxCount++;
  return st.data.length >= st.totalLen ? 'complete' : 'continue';
}

function isotpIngestFrame(frame) {
  if (!isotpPendingEl && !isotpRxState && isotpTxQueue.length === 0 && isotpRxMap.size === 0) return;
  const cfg = isotpCfg();
  if (isotpFuncMode) { isotpIngestFunctional(frame, cfg); return; }
  if (isNaN(cfg.rxId) || frame.id !== cfg.rxId || frame.isExt !== cfg.isExt) return;

  const pci = isotpDecodePci(frame.data, cfg.addrMode);
  if (!pci) return;

  if (pci.kind === 'sf') {
    // ── Single Frame response ─────────────────────────────────────────────
    if (pci.pending) { // ResponsePending: annotate entry, reset timer, keep waiting
      if (isotpPendingEl) isotpAddPendingNote(isotpPendingEl, pci.payload);
      isotpArmTimer();
      return;
    }
    const el = isotpPendingEl;
    isotpCancelAll(); isotpPendingEl = null;
    if (el) isotpMarkDone(el, pci.payload);

  } else if (pci.kind === 'ff') {
    // ── First Frame response ──────────────────────────────────────────────
    // A malformed FF whose own payload already covers the declared length needs no CFs - complete
    // now instead of arming RX state and sending an FC, then waiting for a CF that never arrives.
    if (pci.data.length >= pci.totalLen) {
      const el = isotpPendingEl;
      isotpCancelAll(); isotpPendingEl = null;
      if (el) isotpMarkDone(el, pci.data.slice(0, pci.totalLen));
      return;
    }
    isotpRxState = { totalLen: pci.totalLen, data: pci.data, seqExpected: 1, cfRxCount: 0 };
    isotpSendFC(cfg).catch(e => log(`ISO-TP FC send failed: ${e.message}`, 'err')); // send initial Flow Control (CTS) - async, fire-and-forget
    isotpArmTimer();

  } else if (pci.kind === 'cf') {
    // ── Consecutive Frame response ────────────────────────────────────────
    if (!isotpRxState) return;
    const r = isotpAppendCf(isotpRxState, pci);
    if (r === 'seqError') {
      const el = isotpPendingEl;
      isotpCancelAll(); isotpPendingEl = null;
      if (el) isotpMarkError(el, 'CF sequence error');
      return;
    }
    if (r === 'complete') {
      const payload = isotpRxState.data.slice(0, isotpRxState.totalLen);
      const el      = isotpPendingEl;
      isotpCancelAll(); isotpPendingEl = null;
      if (el) isotpMarkDone(el, payload);
    } else if (cfg.blockSize > 0 && isotpRxState.cfRxCount >= cfg.blockSize) {
      // Block exhausted - send the next FC so ECU continues sending CFs
      isotpRxState.cfRxCount = 0;
      isotpSendFC(cfg).catch(e => log(`ISO-TP FC send failed: ${e.message}`, 'err'));    // async, fire-and-forget
      isotpArmTimer();     // restart N_Cr timeout waiting for next CF
    } else {
      isotpArmTimer(); // reset N_Cr timeout
    }

  } else if (pci.kind === 'fc') {
    // ── Flow Control (ECU → tester, for our multi-frame request) ──────────
    if (pci.fs === 0 && isotpTxQueue.length > 0) { // CTS - clear to send
      if (isotpTimer) { clearTimeout(isotpTimer); isotpTimer = null; }
      // Honor the ECU's FC BlockSize / STmin (undefined on a short FC → flush falls back to cfg).
      const fcBs = pci.bs != null ? pci.bs : undefined;
      const fcStminMs = pci.stmin != null ? isotpStminToMs(pci.stmin) : undefined;
      isotpFlushCFs(cfg, fcBs, fcStminMs).catch(e => log(`ISO-TP CF flush failed: ${e.message}`, 'err'));  // async, fire-and-forget
    } else if (pci.fs === 1 && isotpTxQueue.length > 0) { // Wait - ECU asks us to pause; hold CFs and re-arm N_Bs to await the next FC
      isotpArmTimer();
    } else if (pci.fs === 2) { // Overflow - ECU can't buffer our message; abort rather than time out
      const el = isotpPendingEl;
      isotpCancelAll(); isotpPendingEl = null;
      if (el) isotpMarkError(el, 'flow control: overflow - ECU cannot buffer the message');
    }
  }
}

// ── Functional-addressing RX (multiple ECUs, keyed per responder) ─────────────
// Active only while isotpFuncMode is true (a manual send to 0x7DF / 0x18DB33F1).
// Each responder gets its own reassembly state; the window stays open (rearming the
// timer) until ISOTP_TIMEOUT of silence, then isotpFuncFinalize() closes the entry.
function isotpIngestFunctional(frame, cfg) {
  if (!isotpIsResponder(frame.id, frame.isExt, cfg)) return;
  const pci = isotpDecodePci(frame.data, cfg.addrMode);
  if (!pci) return;
  const rid = frame.id;

  if (pci.kind === 'sf') {
    // ── Single Frame from this ECU ────────────────────────────────────────────
    if (pci.pending) {
      if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, pci.payload, { pending: true });
      isotpArmTimer();
      return;
    }
    if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, pci.payload);
    isotpFuncCount++;
    isotpArmTimer();

  } else if (pci.kind === 'ff') {
    // ── First Frame from this ECU - start its own reassembly, FC to its physical ID
    isotpRxMap.set(rid, { totalLen: pci.totalLen, data: pci.data, seqExpected: 1, cfRxCount: 0 });
    isotpSendFCTo(cfg, isotpPhysicalIdFor(rid, cfg.isExt)).catch(e => log(`ISO-TP FC send failed: ${e.message}`, 'err')); // async, fire-and-forget
    isotpArmTimer();

  } else if (pci.kind === 'cf') {
    // ── Consecutive Frame from this ECU ───────────────────────────────────────
    const st = isotpRxMap.get(rid);
    if (!st) return;
    const r = isotpAppendCf(st, pci);
    if (r === 'seqError') {
      isotpRxMap.delete(rid);
      if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, null, { error: 'CF sequence error' });
      isotpArmTimer();
      return;
    }
    if (r === 'complete') {
      const payload = st.data.slice(0, st.totalLen);
      isotpRxMap.delete(rid);
      if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, payload);
      isotpFuncCount++;
      isotpArmTimer();
    } else if (cfg.blockSize > 0 && st.cfRxCount >= cfg.blockSize) {
      st.cfRxCount = 0;
      isotpSendFCTo(cfg, isotpPhysicalIdFor(rid, cfg.isExt)).catch(e => log(`ISO-TP FC send failed: ${e.message}`, 'err'));
      isotpArmTimer();
    } else {
      isotpArmTimer();
    }
  }
  // 'fc' / 'unknown' are not expected - functional requests are Single Frame only.
}

// Close the functional collection window: mark any incomplete responders, replace the
// "listening…" line with a summary (or fall back to the normal timeout if nobody answered).
function isotpFuncFinalize() {
  const el = isotpPendingEl;
  for (const rid of isotpRxMap.keys()) {
    if (el) isotpFuncAppendResponse(el, rid, null, { error: 'incomplete - timeout' });
  }
  const seen = isotpFuncCount;
  isotpRxMap.clear();
  isotpFuncMode = false;
  isotpPendingEl = null;
  if (!el) return;
  const wt = el.querySelector('.isotp-rx-waiting');
  if (seen === 0) {
    if (wt) { wt.style.fontStyle = 'normal'; wt.innerHTML = `<span style="min-width:22px;flex-shrink:0"></span><span style="color:var(--red)">no response - timeout (${ISOTP_TIMEOUT} ms)</span>`; }
    el.style.borderLeftColor = 'var(--red)';
    isotpShowTimeoutBanner();
  } else {
    if (wt) wt.remove();
    el.style.borderLeftColor = 'var(--green)';
  }
}

// Append one ECU's decoded response as a tagged sub-row under the request entry.
function isotpFuncAppendResponse(wrap, rid, payload, opts) {
  opts = opts || {};
  if (!wrap.isConnected) return;
  const rx = wrap.querySelector('.isotp-rx');
  const wt = wrap.querySelector('.isotp-rx-waiting');
  const idHex = rid.toString(16).toUpperCase().padStart(rid > 0x7FF ? 8 : 3, '0');
  const div = document.createElement('div');
  div.style.cssText = 'margin-bottom:4px';
  if (opts.error) {
    div.innerHTML =
      `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px">` +
        `<span class="isotp-ecu-tag">${escHtml(idHex)}</span>` +
        `<span style="color:var(--red)">${escHtml(opts.error)}</span></div>`;
  } else if (opts.pending) {
    const hex = payload.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
    div.innerHTML =
      `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px">` +
        `<span class="isotp-ecu-tag">${escHtml(idHex)}</span>` +
        `<span style="color:var(--amber)">${escHtml(hex)}</span>` +
        `<span style="color:var(--amber);font-family:var(--sans);font-size:10px">Response Pending</span></div>`;
  } else {
    const id  = 'u' + (isotpEntrySeq++) + 'f';
    const hex = payload.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
    const isNeg = payload[0] === 0x7F;
    const color = isNeg ? 'var(--red)' : 'var(--green)';
    const dec = udsSection(decodePayload(payload), id);
    div.innerHTML =
      `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px">` +
        `<span class="isotp-ecu-tag">${escHtml(idHex)}</span>` +
        `<span style="color:${color};letter-spacing:0.05em;word-break:break-all">${escHtml(hex)}</span></div>` +
      (dec ? `<div style="padding-left:34px">${dec}</div>` : '');
    // Explainer link follows the RX-ID-prioritized responder only (a broadcast yields many).
    if (rid === isotpCfg().rxId) {
      const btn = wrap.querySelector('.isotp-explainer-btn');
      if (btn) btn.href = isotpExplainerUrl(wrap.dataset.txHex || '', hex);
    }
  }
  if (wt) rx.insertBefore(div, wt); else rx.appendChild(div);
  document.getElementById('isotpLog').scrollTop = document.getElementById('isotpLog').scrollHeight;
}

// ── OBD-II / UDS / KWP2000 parsers + tables → diag-parse.js ───────────────────
// Extracted to diag-parse.js (loaded immediately before this file). It defines the
// decoders and reference tables - OBD_MODE/OBD_PID*, UDS_*, KWP_*, obdDecode,
// udsDecode*, kwpDecode, decodePayload, udsSection/udsToggle, etc. - all globals,
// available here at call time. The DIAG-MODE palettes below (KWP_PALETTE /
// UDS_PALETTE) read those tables at eval time, which is why diag-parse.js loads first.

// ── DOM helpers ───────────────────────────────────────────────────────────────
function isotpTs() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}.${String(n.getMilliseconds()).padStart(3,'0')}`;
}

function isotpExplainerUrl(txHex, rxHex) {
  const p = new URLSearchParams({
    txId:      document.getElementById('isotpTxId').value.trim(),
    rxId:      document.getElementById('isotpRxId').value.trim(),
    canType:   document.getElementById('isotpCanType').value,
    addrMode:  document.getElementById('isotpAddrMode').value,
    addrByte:  document.getElementById('isotpAddrByte').value.trim(),
    testerBlockSize: document.getElementById('isotpBlockSize').value.trim().toUpperCase().padStart(2,'0'),
    testerStmin:     document.getElementById('isotpStmin').value.trim().toUpperCase().padStart(2,'0'),
    testerPadding:   document.getElementById('isotpPadding').value.trim(),
    theme:     document.body.classList.contains('light') ? 'light' : 'dark',
    reqPayload: txHex,
  });
  if (rxHex) p.set('respPayload', rxHex);
  return 'explainers/isotp-explainer.html?' + p.toString();
}

function isotpAppendEntry(payload) {
  const log  = document.getElementById('isotpLog');
  const id   = 'u' + (isotpEntrySeq++);
  const hex  = payload.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  const txD  = udsSection(decodePayload(payload), id + 't');
  const sendTs = Date.now();
  const wrap = document.createElement('div');
  wrap.dataset.entryId = id;
  wrap.dataset.txHex   = hex;
  wrap.style.cssText = 'margin-bottom:14px;border-left:2px solid var(--border2);padding-left:10px;transition:border-color 0.3s';
  wrap.innerHTML =
    `<div style="display:flex;gap:10px;align-items:baseline;margin-bottom:2px">` +
      `<span style="color:var(--amber);font-weight:700;font-size:11px;min-width:22px;flex-shrink:0">TX</span>` +
      `<span style="color:var(--text);letter-spacing:0.05em;word-break:break-all;font-size:12px">${escHtml(hex)}</span>` +
      `<span style="color:var(--text3);font-size:10px;margin-left:auto;white-space:nowrap;padding-left:12px">${isotpTs()}</span>` +
      `<button onclick="isotpSeeCanTraffic(${sendTs})"` +
        ` style="font-size:10px;color:var(--blue);background:none;border:none;cursor:pointer;white-space:nowrap;padding-left:8px;flex-shrink:0"` +
        ` title="Jump to this exchange in the Traffic Dump (pauses auto-scroll)">⊞ See CAN Traffic</button>` +
      `<a class="isotp-explainer-btn" href="${isotpExplainerUrl(hex, '')}" target="_blank"` +
        ` style="font-size:10px;color:var(--blue);text-decoration:none;white-space:nowrap;padding-left:8px;flex-shrink:0"` +
        ` title="Open in ISO-TP Explainer">↗ See ISO-TP traffic</a>` +
    `</div>` +
    (txD ? `<div style="padding-left:30px;margin-bottom:4px">${txD}</div>` : '') +
    `<div class="isotp-rx">` +
      `<div class="isotp-rx-waiting" style="display:flex;gap:10px;align-items:center;color:var(--text3);font-style:italic;font-size:11px">` +
        `<span style="min-width:22px;flex-shrink:0"></span><span>waiting…</span>` +
      `</div>` +
    `</div>`;
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return wrap;
}

function isotpAddPendingNote(wrap, payload) {
  if (!wrap.isConnected) return;
  const rx  = wrap.querySelector('.isotp-rx');
  const wt  = wrap.querySelector('.isotp-rx-waiting');
  const hex = payload.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:10px;align-items:baseline;margin-bottom:3px;font-size:12px';
  div.innerHTML =
    `<span style="color:var(--amber);font-weight:700;font-size:11px;min-width:22px;flex-shrink:0">RX</span>` +
    `<span style="color:var(--amber);letter-spacing:0.05em">${escHtml(hex)}</span>` +
    `<span style="color:var(--amber);font-family:var(--sans);font-size:10px;margin-left:8px">Response Pending - ECU still processing</span>`;
  rx.insertBefore(div, wt);
  document.getElementById('isotpLog').scrollTop = document.getElementById('isotpLog').scrollHeight;
}

function isotpMarkDone(wrap, payload) {
  if (obdCaptureCb) { const cb = obdCaptureCb; obdCaptureCb = null; cb(payload); }
  if (!wrap.isConnected) return;
  const id    = (wrap.dataset.entryId || 'u0') + 'r';
  const rx    = wrap.querySelector('.isotp-rx');
  const wt    = wrap.querySelector('.isotp-rx-waiting');
  const isNeg = payload[0] === 0x7F;
  const color = isNeg ? 'var(--red)' : 'var(--green)';
  const hex   = payload.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' ');
  const rxD   = udsSection(decodePayload(payload), id);
  const el    = document.createElement('div');
  el.innerHTML =
    `<div style="display:flex;gap:10px;align-items:baseline;margin-bottom:2px;font-size:12px">` +
      `<span style="color:${color};font-weight:700;font-size:11px;min-width:22px;flex-shrink:0">RX</span>` +
      `<span style="color:${color};letter-spacing:0.05em;word-break:break-all">${escHtml(hex)}</span>` +
    `</div>` +
    (rxD ? `<div style="padding-left:30px">${rxD}</div>` : '');
  if (wt) rx.replaceChild(el, wt); else rx.appendChild(el);
  wrap.style.borderLeftColor = isNeg ? 'var(--red)' : 'var(--green)';
  // Update the explainer link to include both TX and RX payloads
  const btn = wrap.querySelector('.isotp-explainer-btn');
  if (btn) btn.href = isotpExplainerUrl(wrap.dataset.txHex || '', hex);
  document.getElementById('isotpLog').scrollTop = document.getElementById('isotpLog').scrollHeight;
}

function isotpMarkTimeout(wrap) {
  if (obdCaptureCb) { const cb = obdCaptureCb; obdCaptureCb = null; cb(null); }
  if (!wrap.isConnected) return;
  const wt = wrap.querySelector('.isotp-rx-waiting');
  if (wt) { wt.style.fontStyle='normal'; wt.innerHTML=`<span style="min-width:22px;flex-shrink:0"></span><span style="color:var(--red)">no response - timeout (${ISOTP_TIMEOUT} ms)</span>`; }
  wrap.style.borderLeftColor = 'var(--red)';
  isotpShowTimeoutBanner();
}

function isotpShowTimeoutBanner() {
  const log = document.getElementById('isotpLog');
  if (log.querySelector('.isotp-timeout-banner')) return; // already shown
  const el = document.createElement('div');
  el.className = 'isotp-timeout-banner';
  el.style.cssText = 'position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;'
    + 'background:var(--bg2);border:1px solid var(--red);border-radius:6px;'
    + 'padding:7px 12px;margin-bottom:10px;font-size:11px;color:var(--red)';
  el.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
    `<span style="flex:1">No response received - the ECU did not reply within ${ISOTP_TIMEOUT} ms. Check IDs, addressing mode, and that the bus is not paused.</span>` +
    `<button onclick="clearIsotpLog()" style="background:var(--red);border:none;color:#fff;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:var(--sans);white-space:nowrap">Clear Window</button>` +
    `<button onclick="this.closest('.isotp-timeout-banner').remove()" style="background:transparent;border:1px solid var(--red);color:var(--red);border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--sans)">✕</button>`;
  log.insertBefore(el, log.firstChild);
}

function isotpMarkError(wrap, reason) {
  if (obdCaptureCb) { const cb = obdCaptureCb; obdCaptureCb = null; cb(null); }
  if (!wrap.isConnected) return;
  const wt = wrap.querySelector('.isotp-rx-waiting');
  if (wt) { wt.style.fontStyle='normal'; wt.innerHTML=`<span style="min-width:22px;flex-shrink:0"></span><span style="color:var(--red)">error - ${escHtml(reason)}</span>`; }
  wrap.style.borderLeftColor = 'var(--red)';
}

function isotpLogWarn(msg) {
  const log = document.getElementById('isotpLog');
  const el  = document.createElement('div');
  el.style.cssText = 'color:var(--red);margin-bottom:6px;font-family:var(--sans);font-size:11px';
  el.textContent = '⚠ ' + msg;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function clearIsotpLog() {
  document.getElementById('isotpLog').innerHTML = '';
  isotpCancelAll();
  isotpPendingEl = null;
}

function isotpFmtHex(el) {
  const clean = el.value.replace(/\s+/g, '');
  if (clean) el.value = clean.match(/.{1,2}/g).join(' ').toUpperCase();
}

function isotpDecodeStmin(hexStr) {
  const v = Math.max(0, Math.min(0xFF, parseInt(hexStr, 16) || 0));
  if (v <= 0x7F) return { raw: v, ms: v,        label: v + ' ms' };
  if (v >= 0xF1 && v <= 0xF9) { const us = (v - 0xF0) * 100; return { raw: v, ms: us / 1000, label: us + ' µs' }; }
  return { raw: v, ms: 0, label: 'reserved (→ 0)' };
}

function isotpValidateHex2(id) {
  const el = document.getElementById(id);
  const valid = /^[0-9A-Fa-f]{0,2}$/.test(el.value.trim()) && el.value.trim().length > 0;
  el.classList.toggle('invalid', !valid);
  return valid;
}

function isotpUpdateStminLabel() {
  const el = document.getElementById('isotpStmin');
  const val = el.value.trim();
  const valid = /^[0-9A-Fa-f]{1,2}$/.test(val);
  el.classList.toggle('invalid', !valid);
  const lbl = document.getElementById('isotpStminLabel');
  if (!valid) { lbl.textContent = 'invalid'; lbl.style.color = 'var(--red)'; return; }
  const d = isotpDecodeStmin(val);
  lbl.textContent = d.label + (d.label.includes('reserved') ? ' ⚠' : '');
  lbl.style.color = d.label.includes('reserved') ? 'var(--amber)' : 'var(--text2)';
}

function isotpAddrModeChanged() {
  const ext = document.getElementById('isotpAddrMode').value === 'extended';
  document.getElementById('isotpAddrByteWrap').style.display = ext ? 'flex' : 'none';
}

function isotpExplainerLink(e) {
  document.getElementById('isotpLearnLink').href = 'explainers/isotp-explainer.html';
}

// Clamp the Tx/Rx ID fields to range/width (red when empty) and flag a broadcast Tx (orange Rx + hint).
function isotpIdInput() {
  const txEl = document.getElementById('isotpTxId');
  const rxEl = document.getElementById('isotpRxId');
  const isExt = document.getElementById('isotpCanType').value === 'ext';
  const txId = clampIdInput(txEl, isExt);
  clampIdInput(rxEl, isExt);
  const broadcast = txEl.value !== '' && ((!isExt && txId === 0x7DF) || (isExt && txId === 0x18DB33F1));
  rxEl.classList.toggle('isotp-broadcast', broadcast && rxEl.value !== '' && !rxEl.classList.contains('invalid'));
  document.getElementById('isotpBroadcastHint').style.display = broadcast ? 'inline-flex' : 'none';
  // Remember the active mode's IDs while they're valid (per-field). An emptied field is
  // never written here, so switching away discards it and the last valid value survives.
  const mem = isotpModeIds[obdProtoMode];
  if (txEl.value !== '') mem.tx = txEl.value;
  if (rxEl.value !== '') mem.rx = rxEl.value;
}

// Warn when switching to/from KWP with a populated log (the decodes above won't match).
function isotpProtoSwitchWarn() {
  const log = document.getElementById('isotpLog');
  if (log.querySelector('.isotp-proto-warn')) return;
  const el = document.createElement('div');
  el.className = 'isotp-proto-warn';
  el.style.cssText = 'display:flex;align-items:center;gap:10px;background:var(--bg2);'
    + 'border:1px solid var(--amber);border-radius:6px;padding:7px 12px;margin-bottom:10px;'
    + 'font-size:11px;color:var(--amber)';
  el.innerHTML =
    `<span style="flex:1">⚠ Protocol switched - earlier entries above were decoded under a different protocol and may read incorrectly.</span>` +
    `<button onclick="clearIsotpLog()" style="background:var(--amber);border:none;color:#000;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:var(--sans);white-space:nowrap">Clear Window</button>` +
    `<button onclick="this.closest('.isotp-proto-warn').remove()" style="background:transparent;border:1px solid var(--amber);color:var(--amber);border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--sans)">✕</button>`;
  log.insertBefore(el, log.firstChild);
}

// "See CAN Traffic": jump to the Traffic Dump at this exchange's send time, paused.
function isotpSeeCanTraffic(targetTs) {
  switchViewTab('dump');
  dumpScrollLocked = true;
  dumpAutoScroll   = false;
  const sbtn = document.getElementById('dumpScrollBtn');
  if (sbtn) { sbtn.textContent = '▶ Resume scroll'; sbtn.classList.add('active-notch'); }
  // First dump entry at/after the send time (binary search - dumpLog is time-ordered).
  const n = dumpLog.size;
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (dumpLog.get(mid).ts < targetTs) lo = mid + 1; else hi = mid; }
  const idx  = Math.min(lo, Math.max(0, n - 1));
  const wrap = document.getElementById('dumpWrap');
  wrap.scrollTop = Math.max(0, idx * DUMP_ROW_H - DUMP_ROW_H * 3);
  renderDump();
}

// ── Send ─────────────────────────────────────────────────────────────────────
async function isotpSend() {
  const input = document.getElementById('isotpInput');
  const raw   = input.value.trim();
  if (!raw) return;

  // Accept both "22 F1 90" and "22F190"
  let parts;
  const noSpaces = raw.replace(/\s+/g, '');
  if (raw.includes(' ')) {
    parts = raw.split(/\s+/).filter(Boolean);
  } else {
    if (noSpaces.length % 2 !== 0) { isotpLogWarn('Odd number of hex digits'); return; }
    parts = noSpaces.match(/.{2}/g) || [];
  }
  if (parts.some(p => !/^[0-9A-Fa-f]{1,2}$/.test(p))) { isotpLogWarn('Invalid hex'); return; }
  const payload = parts.map(p => parseInt(p.padStart(2,'0'), 16));
  // ISO-TP (15765-2) First Frame length is a 12-bit field; >4095 B silently truncates here (no
  // 2016 escape support). Reject rather than send a corrupted length.
  if (payload.length > 4095) { isotpLogWarn(`Payload too large (${payload.length} B) - ISO-TP max is 4095 B`); return; }

  const cfg = isotpCfg();
  if (isNaN(cfg.txId) || isNaN(cfg.rxId)) { isotpLogWarn('Invalid Tx/Rx ID'); return; }
  if (!busIsOpen) { isotpLogWarn('Bus is not open'); return; }
  if (paused) { isotpLogWarn('Bus is paused - message will be sent but no response can be received while paused'); }

  // History
  if (raw !== isotpHistory[isotpHistory.length - 1]) isotpHistory.push(raw);
  isotpHistoryIdx = -1;
  input.value = '';

  // Cancel any in-flight state
  isotpCancelAll();
  isotpPendingEl = null;
  // A manual send preempts any in-flight watch/probe: drop its stale capture callback so this
  // response can't be delivered to (and pollute) a watched PID. (Cleared here, not in
  // isotpCancelAll, because the normal success path cancels *before* firing the callback.)
  obdCaptureCb = null;

  // Functional broadcast (0x7DF / 0x18DB33F1) → aggregate responses from every ECU.
  isotpFuncMode  = isotpIsFunctional(cfg);
  isotpFuncCount = 0;

  // Log TX entry (with UDS decode) and keep reference for inline RX update
  isotpPendingEl = isotpAppendEntry(payload);
  if (isotpFuncMode) {
    const wt = isotpPendingEl.querySelector('.isotp-rx-waiting span:last-child');
    if (wt) wt.textContent = 'listening for ECUs…';
  }

  const frames = isotpBuildFrames(payload, cfg);
  if (frames.length === 1) {
    await isotpTxCan(frames[0], cfg);
    isotpArmTimer();
  } else {
    // Multi-frame request: send FF, wait for FC, then send CFs
    await isotpTxCan(frames[0], cfg);
    isotpTxQueue  = frames.slice(1);
    isotpCfBlkCnt = 0;
    isotpArmTimer(); // waiting for FC from ECU
  }

  if (demoMode && !paused) demoIsoTpRespond(payload, cfg);
}

// ── OBD-II / SAE J1979 sub-mode (lives inside the ISO-TP/UDS tab) ──────────────
// Surfaces the existing obdDecode engine with one-click requests, a supported-PID
// probe, and a live polling dashboard. All TX rides the ISO-TP state machine, so
// requests serialize on the single in-flight transaction (isotpPendingEl).
let obdProtoMode = 'uds';      // 'uds' | 'obd' | 'kwp'
let obdInited    = false;      // palette/picker/watch DOM built once
let obdCaptureCb = null;       // tapped by isotpMarkDone/Timeout/Error with the RX payload
let obdSupported = null;       // Set<pid> from last probe (null = not probed)
let obdProbeQueue = [];        // remaining probe blocks (0x00/0x20/0x40/0x60)
let obdWatch     = [];         // ordered Mode-01 PIDs being watched
let obdWatchOn   = false;
let obdWatchIdx  = 0;          // round-robin cursor
let obdWatchVals = new Map();  // pid -> display text
let obdPollMs    = 500;
let obdPumpTimer = null;

// Request palette - common one-click asks.
const OBD_PALETTE = [
  { label:'Engine RPM',     bytes:[0x01,0x0C] },
  { label:'Vehicle speed',  bytes:[0x01,0x0D] },
  { label:'Coolant',        bytes:[0x01,0x05] },
  { label:'Throttle',       bytes:[0x01,0x11] },
  { label:'MAF',            bytes:[0x01,0x10] },
  { label:'Fuel level',     bytes:[0x01,0x2F] },
  { label:'Monitors/MIL',   bytes:[0x01,0x01] },
  { label:'Stored DTCs',    bytes:[0x03] },
  { label:'Pending DTCs',   bytes:[0x07] },
  { label:'Permanent DTCs', bytes:[0x0A] },
  { label:'Clear DTCs',     bytes:[0x04], danger:true },
  { label:'VIN',            bytes:[0x09,0x02] },
  { label:'CalID',          bytes:[0x09,0x04] },
];
// Curated, watchable Mode-01 PIDs (short label).
const OBD_WATCHABLE = [
  [0x0C,'RPM'], [0x0D,'Speed'], [0x05,'Coolant'], [0x11,'Throttle'],
  [0x10,'MAF'], [0x2F,'Fuel level'], [0x0F,'Intake temp'], [0x04,'Engine load'],
  [0x42,'Voltage'], [0x0E,'Timing'], [0x0B,'MAP'], [0x46,'Ambient'],
];

function obdHex(bytes) { return bytes.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(' '); }
function obdBusReady() { return window.fuzzBusReady() && !document.getElementById('listenOnly').checked; }

// Toggle UDS <-> OBD sub-mode. On first entry to OBD, adopt OBD default IDs only if
// the fields still hold the UDS defaults (don't clobber a user's custom IDs).
// Briefly highlight a field so the user notices its value changed on a mode switch.
function isotpFlashField(el) {
  el.classList.remove('field-flash');
  void el.offsetWidth;            // restart the animation
  el.classList.add('field-flash');
  setTimeout(() => el.classList.remove('field-flash'), 1000);
}

// Per-mode remembered Tx/Rx IDs (last valid value), seeded with each protocol's defaults.
// Kept fresh by isotpIdInput(); switching modes loads the entering mode's pair.
const isotpModeIdDefaults = () => ({ uds:{tx:'7E1',rx:'7E9'}, obd:{tx:'7DF',rx:'7E9'}, kwp:{tx:'7E5',rx:'7ED'} });
let isotpModeIds = isotpModeIdDefaults();
function isotpSetProtoMode(mode) {
  const next = ['obd', 'kwp'].includes(mode) ? mode : 'uds';
  const prev = obdProtoMode;
  // Warn when crossing the KWP boundary with a populated log (decodes won't match).
  if ((obdProtoMode === 'kwp') !== (next === 'kwp') &&
      document.getElementById('isotpLog').children.length > 0) {
    isotpProtoSwitchWarn();
  }
  obdProtoMode = next;
  // Load the entering mode's remembered IDs (last valid, or its default). A cleared/invalid
  // field in the leaving mode was never remembered, so it's discarded - not carried over.
  if (prev !== next) {
    const tx = document.getElementById('isotpTxId'), rx = document.getElementById('isotpRxId');
    const m = isotpModeIds[next];
    if (tx.value.trim().toUpperCase() !== m.tx) { tx.value = m.tx; isotpFlashField(tx); }
    if (rx.value.trim().toUpperCase() !== m.rx) { rx.value = m.rx; isotpFlashField(rx); }
  }
  document.getElementById('isotpModeUds').classList.toggle('active', obdProtoMode === 'uds');
  document.getElementById('isotpModeObd').classList.toggle('active', obdProtoMode === 'obd');
  document.getElementById('isotpModeKwp').classList.toggle('active', obdProtoMode === 'kwp');
  document.getElementById('obdWrap').style.display = obdProtoMode === 'obd' ? 'flex' : 'none';
  document.getElementById('kwpWrap').style.display = obdProtoMode === 'kwp' ? 'flex' : 'none';
  document.getElementById('udsWrap').style.display = obdProtoMode === 'uds' ? 'flex' : 'none';
  document.getElementById('isotpInputLabel').textContent =
    obdProtoMode === 'obd' ? 'OBD' : obdProtoMode === 'kwp' ? 'KWP' : 'UDS';
  // Per-mode example in the terminal input - match each protocol's own frame format.
  document.getElementById('isotpInput').placeholder =
    obdProtoMode === 'obd' ? 'hex bytes - e.g.  01 0C  or  03'
    : obdProtoMode === 'kwp' ? 'hex bytes - e.g.  21 F0  or  3E'
    : 'hex bytes - e.g.  22 F1 84  or  3E 00';
  // Active-protocol explainer link lives in the config strip (next to the ISO-TP one).
  const protoLink = document.getElementById('isotpProtoLearnLink');
  const protoInfo = obdProtoMode === 'obd' ? ['explainers/obd2-explainer.html', 'Learn how OBD-II works ↗']
    : obdProtoMode === 'kwp' ? ['explainers/kwp2000-explainer.html', 'Learn how KWP2000 works ↗']
    : ['explainers/uds-explainer.html', 'Learn how UDS works ↗'];
  protoLink.href = protoInfo[0];
  protoLink.textContent = protoInfo[1];
  if (obdProtoMode === 'obd') {
    obdInit();
    obdUpdateAvailability();
  } else {
    obdWatchStop();
  }
  if (obdProtoMode === 'kwp') kwpInit();   // leave Tx/Rx IDs untouched in KWP mode
  if (obdProtoMode === 'uds') udsInit();
  isotpIdInput();
  if (window.obdScheduleSave) window.obdScheduleSave();
}

// Service palettes (KWP + UDS). Each entry is either a plain fixed-byte button
// ({label,bytes}) or a split button with a ▾ caret panel ({label,sid,params:[...]}),
// where params are {kind:'select',map,def} or {kind:'hex',label,def}. Every send stuffs
// #isotpInput + calls isotpSend(), so it's logged like a manual send (mirrors obdSend).

// Parse a hex string (spaced or packed, 1-2 digits per byte) like isotpSend does.
function svcParseHex(s) {
  return s.trim().split(/[\s,]+/).filter(Boolean).map(t => {
    if (!/^[0-9A-Fa-f]{1,2}$/.test(t)) return NaN;
    return parseInt(t, 16);
  });
}
// Bytes for one param, read from its live DOM element.
function svcParamBytes(p, el) {
  if (p.kind === 'select') return [parseInt(el.value, 10)];
  return svcParseHex(el.value);
}
// Build a palette into a container, reused by KWP + UDS.
function buildSvcPalette(containerId, palette, sendFn) {
  const pal = document.getElementById(containerId);
  pal.innerHTML = '';
  palette.forEach(entry => {
    if (!entry.params) {                       // plain fixed-byte button
      const b = document.createElement('button');
      b.className = 'obd-btn';
      b.textContent = entry.label;
      b.title = obdHex(entry.bytes);
      b.onclick = () => sendFn(entry.bytes);
      pal.appendChild(b);
      return;
    }
    // Split button: face (sends defaults) + caret (opens param panel).
    const wrap = document.createElement('span');
    wrap.className = 'svc-split';
    const face = document.createElement('button');
    face.className = 'obd-btn';
    face.textContent = entry.label;
    const panel = document.createElement('div');
    panel.className = 'svc-panel';
    const els = [];
    entry.params.forEach(p => {
      const row = document.createElement('div');
      row.className = 'svc-prow';
      const lab = document.createElement('span');
      lab.className = 'svc-plabel';
      let input;
      if (p.kind === 'select') {
        lab.textContent = p.label || 'Sub-function';
        input = document.createElement('select');
        Object.keys(p.map).map(Number).sort((a,b)=>a-b).forEach(k => {
          const o = document.createElement('option');
          o.value = k; o.textContent = `${udsH(k)}  ${p.map[k]}`;
          if (k === p.def) o.selected = true;
          input.appendChild(o);
        });
      } else {
        lab.textContent = `${p.label} (hex)`;
        input = document.createElement('input');
        input.type = 'text'; input.value = p.def; input.className = 'svc-phex';
      }
      els.push({ p, el: input, row });
      row.appendChild(lab); row.appendChild(input);
      panel.appendChild(row);
    });
    // Hidden (conditionally-visible) params contribute no bytes.
    const assemble = () => [entry.sid, ...els.flatMap(({p,el,row}) =>
      row.style.display === 'none' ? [] : svcParamBytes(p, el))];
    // Some params (e.g. SecurityAccess key, LinkControl baudrate record) appear only
    // for certain sibling values - recompute their visibility on any change.
    const refreshVis = () => {
      els.forEach(({ p, row }) => { if (p.visibleWhen) row.style.display = p.visibleWhen(els) ? '' : 'none'; });
      face.title = obdHex(assemble());
    };
    els.forEach(({ el }) => { el.addEventListener('input', refreshVis); el.addEventListener('change', refreshVis); });
    refreshVis();
    face.title = obdHex(assemble());
    face.onclick = () => sendFn(assemble());
    const send = document.createElement('button');
    send.className = 'obd-btn'; send.textContent = 'Send';
    send.onclick = () => { sendFn(assemble()); panel.classList.remove('open'); };
    panel.appendChild(send);
    const caret = document.createElement('button');
    caret.className = 'svc-caret'; caret.textContent = '▾';
    caret.onclick = () => svcTogglePanel(panel, caret);
    wrap.appendChild(face); wrap.appendChild(caret); wrap.appendChild(panel);
    pal.appendChild(wrap);
  });
}
// Toggle a param panel; close others + close on outside click (mirrors toggleNotchPanel).
function svcTogglePanel(panel, caret) {
  const open = panel.classList.contains('open');
  document.querySelectorAll('.svc-panel.open').forEach(p => p.classList.remove('open'));
  if (open) return;
  panel.classList.add('open');
  setTimeout(() => {
    const close = (e) => {
      if (!panel.contains(e.target) && e.target !== caret) {
        panel.classList.remove('open');
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

const KWP_PALETTE = [
  { label:'StartComms',    bytes:[0x81] },
  { label:'StartSession',  sid:0x10, params:[{kind:'select', map:KWP_DIAG_MODE, def:0x81}] },
  { label:'TesterPresent', bytes:[0x3E] },
  { label:'ReadECUIdent',  sid:0x1A, params:[{kind:'hex', label:'Option', def:'9A'}] },
  { label:'ReadByLocalId', sid:0x21, params:[{kind:'hex', label:'Local ID', def:'F0'}] },
  { label:'ECUReset',      sid:0x11, params:[{kind:'hex', label:'Reset type', def:'01'}] },
  { label:'StopComms',     bytes:[0x82] },
];
let kwpInited = false;
function kwpInit() {
  if (kwpInited) return;
  kwpInited = true;
  buildSvcPalette('kwpPalette', KWP_PALETTE, kwpSend);
}
function kwpSend(bytes) {
  if (!obdBusReady()) { isotpLogWarn('KWP TX disabled - bus closed or listen-only'); return; }
  document.getElementById('isotpInput').value = obdHex(bytes);
  isotpSend();
}

// UDS service palette (ISO 14229) - mirrors KWP. Reuses the UDS_* decode tables for options.
const UDS_PALETTE = [
  { label:'DiagnosticSessionControl', sid:0x10, params:[{kind:'select', map:UDS_SESSION, def:0x03}] },
  { label:'ECUReset',                 sid:0x11, params:[{kind:'select', map:UDS_RESET, def:0x01}] },
  { label:'TesterPresent',            bytes:[0x3E,0x00] },
  { label:'ReadDTCInformation',       sid:0x19, params:[{kind:'select', map:UDS_DTC_SF, def:0x02},{kind:'hex', label:'Status mask', def:'FF'}] },
  { label:'ReadDataByIdentifier',     sid:0x22, params:[{kind:'hex', label:'DID', def:'F1 84'}] },
  { label:'ClearDiagnosticInformation', sid:0x14, params:[{kind:'hex', label:'Group', def:'FF FF FF'}] },
  { label:'SecurityAccess',           sid:0x27, params:[
      {kind:'hex', label:'Level', def:'01'},
      // Even level = sendKey: the key is appended after the level byte (ISO 14229).
      {kind:'hex', label:'Key', def:'', visibleWhen: els => {
        const lvl = parseInt((els[0].el.value || '').trim().split(/[\s,]+/)[0], 16);
        return Number.isFinite(lvl) && (lvl % 2 === 0);
      }} ] },
  { label:'CommunicationControl',     sid:0x28, params:[{kind:'select', map:UDS_COMM_SF, def:0x00},{kind:'hex', label:'Comm type', def:'01'}] },
  { label:'RoutineControl',           sid:0x31, params:[{kind:'select', map:UDS_RTN_SF, def:0x01},{kind:'hex', label:'Routine ID', def:'F0 0F'}] },
  { label:'ControlDTCSetting',        sid:0x85, params:[{kind:'select', map:UDS_DTC_ON, def:0x02}] },
  { label:'LinkControl',              sid:0x87, params:[
      {kind:'select', map:UDS_LNK_SF, def:0x01},
      // 0x03 transitionBaudrate carries no record - hide the field for that sub-function.
      {kind:'hex', label:'Baudrate record', def:'12', visibleWhen: els => parseInt(els[0].el.value, 10) !== 0x03} ] },
];
let udsInited = false;
function udsInit() {
  if (udsInited) return;
  udsInited = true;
  buildSvcPalette('udsPalette', UDS_PALETTE, udsSend);
}
function udsSend(bytes) {
  if (!obdBusReady()) { isotpLogWarn('UDS TX disabled - bus closed or listen-only'); return; }
  document.getElementById('isotpInput').value = obdHex(bytes);
  isotpSend();
}

// Build palette / picker / watch DOM once.
function obdInit() {
  if (obdInited) return;
  obdInited = true;

  // Request palette
  const pal = document.getElementById('obdPalette');
  pal.innerHTML = '';
  OBD_PALETTE.forEach(p => {
    const b = document.createElement('button');
    b.className = 'obd-btn' + (p.danger ? ' obd-btn-danger' : '');
    b.textContent = p.label;
    b.title = obdHex(p.bytes);
    b.dataset.pid = p.bytes[0] === 0x01 ? p.bytes[1] : '';
    b.onclick = () => {
      if (p.danger && !confirm('Clear all stored DTCs and reset the MIL? This affects the vehicle.')) return;
      obdSend(p.bytes);
    };
    pal.appendChild(b);
  });

  // Mode + PID picker
  const modeSel = document.getElementById('obdPickMode');
  const pidSel  = document.getElementById('obdPickPid');
  const fillPids = () => {
    const map = modeSel.value === '09' ? OBD_PID09 : OBD_PID01;
    pidSel.innerHTML = '';
    Object.keys(map).map(Number).sort((a,b)=>a-b).forEach(pid => {
      const o = document.createElement('option');
      o.value = pid;
      o.textContent = `${udsH(pid)}  ${map[pid]}`;
      pidSel.appendChild(o);
    });
  };
  modeSel.onchange = fillPids;
  fillPids();
  document.getElementById('obdPickSend').onclick = () =>
    obdSend([parseInt(modeSel.value, 16), parseInt(pidSel.value, 10)]);

  // Watch selector (checkboxes)
  const sel = document.getElementById('obdWatchSelect');
  sel.innerHTML = '';
  OBD_WATCHABLE.forEach(([pid, label]) => {
    const lab = document.createElement('label');
    lab.className = 'obd-watch-check';
    lab.innerHTML = `<input type="checkbox" data-pid="${pid}"><span>${label}</span>`;
    lab.querySelector('input').onchange = e => obdWatchToggle(pid, e.target.checked);
    sel.appendChild(lab);
  });

  document.getElementById('obdPollMs').onchange = e => { obdPollMs = parseInt(e.target.value,10) || 500; obdRestartPump(); };
  document.getElementById('obdProbeBtn').onclick = obdProbeStart;
  document.getElementById('obdWatchBtn').onclick = () => obdWatchOn ? obdWatchStop() : obdWatchStart();

  // Restore persisted watch selection
  (window._obdPending || []).forEach(pid => {
    const cb = sel.querySelector(`input[data-pid="${pid}"]`);
    if (cb) { cb.checked = true; obdWatch.push(pid); }
  });
  obdRenderWatch();
}

// Send a request that IS logged in the conversation (palette / picker / manual).
function obdSend(bytes) {
  if (!obdBusReady()) { isotpLogWarn('OBD TX disabled - bus closed or listen-only'); return; }
  document.getElementById('isotpInput').value = obdHex(bytes);
  isotpSend();
}

// Send a request programmatically (probe / watch). `opts.log` controls whether it
// appears in the conversation; `opts.onDone(payload|null)` receives the response.
// Returns false if the bus is busy (caller should retry on the next pump tick).
function obdRequest(payload, opts) {
  opts = opts || {};
  if (!obdBusReady()) return false;
  if (isotpPendingEl || isotpRxState || isotpTxQueue.length || isotpFuncMode || isotpRxMap.size) return false;
  const cfg = isotpCfg();
  if (isNaN(cfg.txId) || isNaN(cfg.rxId)) return false;
  isotpCancelAll(); isotpPendingEl = null;
  obdCaptureCb = opts.onDone || null;
  isotpPendingEl = opts.log ? isotpAppendEntry(payload) : document.createElement('div');
  const frames = isotpBuildFrames(payload, cfg);
  isotpTxCan(frames[0], cfg).catch(e => log(`ISO-TP send failed: ${e.message}`, 'err'));  // async, fire-and-forget
  if (frames.length > 1) { isotpTxQueue = frames.slice(1); isotpCfBlkCnt = 0; }
  isotpArmTimer();
  if (demoMode && !paused) demoIsoTpRespond(payload, cfg);
  return true;
}

// Drives the probe queue and the watch round-robin - one request at a time.
function obdPump() {
  if (!obdBusReady()) { obdWatchStop(); return; }
  if (isotpPendingEl || isotpRxState || isotpTxQueue.length || isotpFuncMode || isotpRxMap.size) return; // busy
  if (obdProbeQueue.length) {
    const blk = obdProbeQueue.shift();
    obdRequest([0x01, blk], { log:true, onDone: p => obdProbeDone(blk, p) });
    return;
  }
  if (obdWatchOn && obdWatch.length && !txSuspended) {
    const pid = obdWatch[obdWatchIdx % obdWatch.length];
    obdWatchIdx++;
    obdRequest([0x01, pid], { log:false, onDone: p => obdWatchDone(pid, p) });
  }
}

function obdEnsurePump() {
  if (!obdPumpTimer) obdPumpTimer = setInterval(obdPump, Math.max(60, obdPollMs));
}
function obdRestartPump() {
  if (obdPumpTimer) { clearInterval(obdPumpTimer); obdPumpTimer = null; obdEnsurePump(); }
}
function obdMaybeStopPump() {
  if (!obdPumpTimer) return;
  if (obdWatchOn || obdProbeQueue.length) return;
  clearInterval(obdPumpTimer); obdPumpTimer = null;
}

// ── Supported-PIDs probe ──────────────────────────────────────────────────────
function obdProbeStart() {
  if (!obdBusReady()) { isotpLogWarn('Probe disabled - bus closed or listen-only'); return; }
  obdSupported = new Set();
  obdProbeQueue = [0x00, 0x20, 0x40, 0x60];
  obdRenderProbe();
  obdEnsurePump();
}
function obdProbeDone(blk, payload) {
  if (payload && (payload[0] === 0x41) && payload[1] === blk && payload.length >= 6) {
    const v = (payload[2]<<24) | (payload[3]<<16) | (payload[4]<<8) | payload[5];
    for (let i = 1; i <= 0x20; i++) if (v & (1 << (0x20 - i))) obdSupported.add(blk + i);
  }
  obdRenderProbe();
  obdUpdateAvailability();
  obdMaybeStopPump();
}
function obdRenderProbe() {
  const grid = document.getElementById('obdProbeGrid');
  grid.innerHTML = '';
  if (!obdSupported) { grid.style.display = 'none'; return; }
  grid.style.display = 'flex';
  for (let pid = 0x01; pid <= 0x60; pid++) {
    const cell = document.createElement('span');
    const sup  = obdSupported.has(pid);
    cell.className = 'obd-pidcell' + (sup ? ' sup' : '');
    cell.textContent = pid.toString(16).toUpperCase().padStart(2,'0');
    if (OBD_PID01[pid]) cell.title = OBD_PID01[pid];
    grid.appendChild(cell);
  }
}

// ── Quick Watch ───────────────────────────────────────────────────────────────
function obdWatchToggle(pid, on) {
  if (on) { if (!obdWatch.includes(pid)) obdWatch.push(pid); }
  else    { obdWatch = obdWatch.filter(p => p !== pid); obdWatchVals.delete(pid); }
  obdRenderWatch();
  if (obdWatchOn) renderTxModuleRows();   // keep the scheduler mirror in sync while watching
  if (window.obdScheduleSave) window.obdScheduleSave();
}
function obdWatchStart() {
  if (!obdBusReady()) { isotpLogWarn('Watch disabled - bus closed or listen-only'); return; }
  if (!obdWatch.length) {
    const grid = document.getElementById('obdWatchGrid');
    if (grid) grid.innerHTML = '<span style="color:var(--amber);font-size:11px;font-family:var(--sans)">No PIDs selected - tick boxes above, then Start.</span>';
    isotpLogWarn('Select at least one PID to watch');
    return;
  }
  obdWatchOn = true; obdWatchIdx = 0;
  document.getElementById('obdWatchBtn').textContent = 'Stop';
  document.getElementById('obdWatchBtn').classList.add('obd-btn-active');
  obdEnsurePump();
  txAutoExpand();
  obdWatchUpdateIndicator();
}
function obdWatchStop() {
  if (!obdWatchOn) { obdMaybeStopPump(); return; }
  obdWatchOn = false;
  const btn = document.getElementById('obdWatchBtn');
  if (btn) { btn.textContent = 'Start'; btn.classList.remove('obd-btn-active'); }
  obdMaybeStopPump();
  obdWatchUpdateIndicator();
}
// Global indicator in the TX Scheduler header - Quick Watch polls = active TX.
function obdWatchUpdateIndicator() {
  const badge = document.getElementById('obdWatchActiveBadge');
  if (!badge) return;
  badge.style.display = obdWatchOn ? 'inline-flex' : 'none';
  const cnt = document.getElementById('obdWatchActiveCount');
  if (cnt) cnt.textContent = obdWatch.length;
  const lbl = document.getElementById('obdWatchActiveLabel');
  if (lbl) lbl.textContent = txSuspended ? 'Quick Watch (paused)' : 'Quick Watch';
  renderTxModuleRows();
}
function obdWatchDone(pid, payload) {
  if (payload && payload[0] === 0x41 && payload[1] === pid) {
    const dec = obdDecode(payload);
    const row = dec && dec.rows[dec.rows.length - 1];
    obdWatchVals.set(pid, row ? row.v : '-');
  } else {
    obdWatchVals.set(pid, payload ? '-' : 'timeout');
  }
  obdRenderWatch();
}
function obdRenderWatch() {
  const grid = document.getElementById('obdWatchGrid');
  if (!grid) return;
  grid.innerHTML = '';
  // Empty grid stays empty (saves space); the "no PIDs" hint is shown only when the
  // user actually presses Start with nothing ticked - see obdWatchStart().
  if (!obdWatch.length) return;
  obdWatch.forEach(pid => {
    const label = (OBD_WATCHABLE.find(w => w[0] === pid) || [pid, OBD_PID01[pid] || udsH(pid)])[1];
    const tile = document.createElement('div');
    tile.className = 'obd-tile';
    tile.innerHTML = `<div class="obd-tile-label">${escHtml(label)}</div>` +
                     `<div class="obd-tile-val">${escHtml(obdWatchVals.get(pid) || '-')}</div>`;
    grid.appendChild(tile);
  });
}

// Enable/disable TX affordances + show a hint when the bus can't transmit.
function obdUpdateAvailability() {
  const ready = obdBusReady();
  document.querySelectorAll('#obdPalette .obd-btn, #obdPickSend, #obdProbeBtn, #obdWatchBtn')
    .forEach(el => { el.disabled = !ready; });
  // Dim palette/picker entries the probe found unsupported
  if (obdSupported) {
    document.querySelectorAll('#obdPalette .obd-btn[data-pid]').forEach(el => {
      const pid = el.dataset.pid;
      el.classList.toggle('obd-unsup', pid !== '' && !obdSupported.has(parseInt(pid,10)));
    });
  }
  const hint = document.getElementById('obdHint');
  if (hint) hint.style.display = ready ? 'none' : 'block';
  if (!ready) obdWatchStop();
}

function obdOnShow() {
  if (obdProtoMode === 'obd') { obdInit(); obdUpdateAvailability(); }
}

// Persistence helpers used by collectSettings/applySettings.
function obdCollectWatch() {
  if (!obdInited) return (window._obdPending || []);
  return [...obdWatch];
}
function obdApply(watchPids) {
  window._obdPending = watchPids || [];
  if (obdInited) {
    obdWatch = [];
    document.querySelectorAll('#obdWatchSelect input[data-pid]').forEach(cb => {
      const pid = parseInt(cb.dataset.pid, 10);
      cb.checked = (window._obdPending).includes(pid);
      if (cb.checked) obdWatch.push(pid);
    });
    obdRenderWatch();
  }
}
window.obdStop = obdWatchStop; // called from disconnectSerial

function isotpKeydown(e) {
  const input = document.getElementById('isotpInput');
  if (e.key === 'Enter') { isotpSend(); return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!isotpHistory.length) return;
    if (isotpHistoryIdx === -1) isotpHistoryIdx = isotpHistory.length - 1;
    else if (isotpHistoryIdx > 0) isotpHistoryIdx--;
    input.value = isotpHistory[isotpHistoryIdx];
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (isotpHistoryIdx === -1) return;
    if (isotpHistoryIdx < isotpHistory.length - 1) {
      input.value = isotpHistory[++isotpHistoryIdx];
    } else {
      isotpHistoryIdx = -1;
      input.value = '';
    }
  }
}

// ── Theme toggle ─────────────────────────────────────────────────────────────
function toggleTheme() {
  const light = document.body.classList.toggle('light');
  // Swap icon: sun (light mode active) ↔ moon (dark mode active)
  document.getElementById('themeIcon').innerHTML = light
    ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
    : '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>';
  try { localStorage.setItem('slcanTheme', light ? 'light' : 'dark'); } catch(_) {}
}
// Restore saved theme on load
try { if (localStorage.getItem('slcanTheme') === 'light') {
  document.body.classList.add('light');
  document.getElementById('themeIcon').innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
}} catch(_) {}

// ── CSV Export ───────────────────────────────────────────────────────────────
function exportDumpCSV(saveAll) {
  const flt = saveAll ? null : getFilter();
  // Base relative times on the oldest retained entry (matches the dump view; correct even after the
  // ring wraps past the original dumpStartTs frame).
  const startTs = dumpLog.size > 0 ? dumpLog.get(0).ts : (dumpStartTs ?? 0);
  // All columns below are integer/hex/enumerated (no comma, quote, or newline can occur), so quoting
  // is a no-op today - csvCell future-proofs the format if a free-text column (e.g. notes) is added.
  const csvCell = v => { const s = String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header  = ['Time_ms','ID','Type','Dir','DLC','D0','D1','D2','D3','D4','D5','D6','D7'];
  const lines   = [header.map(csvCell).join(',')];
  let count = 0;

  for (let i = 0; i < dumpLog.size; i++) {
    const e = dumpLog.get(i);
    if (flt && !applyFilter(e, flt)) continue;
    // Frames are timestamped with Date.now() (integer ms), so sub-ms digits would
    // always be .000 - keep the column as integer milliseconds.
    const relMs = Math.round(e.ts - startTs);
    const idHex = e.isExt
      ? '0x' + e.id.toString(16).toUpperCase().padStart(8,'0')
      : e.id.toString(16).toUpperCase().padStart(3,'0');
    const type  = e.isRtr ? 'RTR' : e.isExt ? 'EXT' : 'STD';
    const dir   = e.isFwd ? 'FW' : e.isTx ? 'TX' : 'RX';
    const bytes = Array.from({length: 8}, (_, j) =>
      e.data[j] !== undefined ? e.data[j].toString(16).toUpperCase().padStart(2,'0') : '');
    lines.push([relMs, idHex, type, dir, e.dlc, ...bytes].map(csvCell).join(','));
    count++;
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `can_dump_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('dumpExportCount').textContent = `${count.toLocaleString()} rows saved`;
  setTimeout(() => { document.getElementById('dumpExportCount').textContent = ''; }, 3000);
}

// ── Workspaces & persistence ──────────────────────────────────────────────────
// Named per-vehicle profiles. Two localStorage buckets:
//   slcanWorkspaces - { version, activeId, list:[{id,name,createdAt,updatedAt,data}] }
//                     data = pins, colours, notes, filters, byte format, notch,
//                     baud, listen-only/auto-open, TX rows, ISO-TP config (per-vehicle)
//   slcanPrefs      - global UI ergonomics (FPS, buffer, panel collapse states)
//   slcanTheme      - unchanged, handled by toggleTheme()
let workspaces = [];
let activeWsId = null;
let _saveTimer = null;
let _restoring = false;   // true while applying settings at startup → suppress autosave

function uid() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Factory defaults for a fresh workspace - mirror the HTML default control values.
function defaultWorkspaceData() {
  return {
    pins: [], colors: [], notes: [],
    byteFormat: 'hexascii',
    filter: { frameType: 'all', dataType: 'all', ids: '', idsExclude: false, data: '',
              onlyUnseen: false, onlyHighlighted: false, onlyRx: false },
    notch: { duration: '1', hotMs: 500 },
    baud: 'S6', listenOnly: false, autoOpen: true,
    tx: [ { enabled: false, ext: false, rtr: false, id: '7DF', dlc: 8,
            data: '02 3E 00 00 00 00 00 00', period: 100, note: 'Broadcasts UDS Tester Present' } ],
    isotp: { txId: '7E1', rxId: '7E9', canType: 'std', addrMode: 'normal', addrByte: 'F1',
             blockSize: '00', stmin: '00', padding: '', proto: 'uds', obdWatch: [] },
    graphSignals: [],
    fuzz: null,
    j1939Proto: 'j1939',
    xcp: { cro: 0x552, dto: 0x553, isExt: false, byteOrder: 'auto' },
    canopen: { node: 1, sdoTimeout: 1000, sdoReqId: null, sdoRspId: null }
  };
}

// Coerce a (possibly hand-edited / malformed) imported workspace blob to the expected shape so
// applySettings can't throw partway through - e.g. a string `tx` would blow up `(d.tx||[]).map`
// *after* pins/colours/notes were already cleared, leaving a half-applied state. Wrong-typed
// array/object fields fall back to their defaults; scalars rely on applySettings' own ?? fallbacks.
function sanitizeWorkspaceData(d) {
  const def = defaultWorkspaceData();
  const out = Object.assign({}, def, (d && typeof d === 'object') ? d : {});
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  for (const k of ['pins', 'colors', 'notes', 'tx', 'graphSignals'])
    if (!Array.isArray(out[k])) out[k] = def[k];
  for (const k of ['filter', 'notch', 'isotp', 'xcp', 'canopen'])
    if (!isObj(out[k])) out[k] = def[k];
  if (out.fuzz !== null && !isObj(out.fuzz)) out.fuzz = null;
  if (!Array.isArray(out.isotp.obdWatch)) out.isotp.obdWatch = [];
  return out;
}

const _el = id => document.getElementById(id);

// Snapshot every per-vehicle setting from in-memory state + the DOM.
function collectSettings() {
  return {
    pins: [...pinnedKeys],
    colors: [...frameColors],
    notes: [...frameNotes],
    byteFormat: _el('byteFormat').value,
    filter: {
      frameType: _el('filterFrameType').value,
      dataType: _el('filterDataType').value,
      ids: _el('filterIds').value,
      idsExclude: _el('filterIdsExclude').checked,
      data: _el('filterData').value,
      onlyUnseen: _el('filterOnlyUnseen').checked,
      onlyHighlighted: _el('filterOnlyHighlighted').checked,
      onlyRx: _el('filterOnlyRx').checked,
    },
    notch: { duration: _el('notchDuration').value, hotMs },
    baud: _el('baudRate').value,
    listenOnly: _el('listenOnly').checked,
    autoOpen: _el('autoOpen').checked,
    tx: txMessages.map(m => ({ enabled: m.enabled, ext: m.ext, rtr: m.rtr, id: m.id,
                               dlc: m.dlc, data: m.data, period: m.period, note: m.note })),
    isotp: {
      txId: _el('isotpTxId').value || isotpModeIds[obdProtoMode].tx,
      rxId: _el('isotpRxId').value || isotpModeIds[obdProtoMode].rx,
      canType: _el('isotpCanType').value, addrMode: _el('isotpAddrMode').value,
      addrByte: _el('isotpAddrByte').value, blockSize: _el('isotpBlockSize').value,
      stmin: _el('isotpStmin').value, padding: _el('isotpPadding').value,
      proto: obdProtoMode, obdWatch: obdCollectWatch(),
    },
    graphSignals: window.graphCollect ? window.graphCollect() : (window._graphPending || []),
    fuzz: window.fuzzCollect ? window.fuzzCollect() : (window._fuzzPending || null),
    j1939Proto: window.j1939GetProto ? window.j1939GetProto() : (window._j1939ProtoPending || 'j1939'),
    xcp: window.xcpCollect ? window.xcpCollect() : (window._xcpPending || null),
    canopen: window.canopenCollect ? window.canopenCollect() : (window._canopenPending || null)
  };
}

// Refresh the notch slider labels + hot-duration slider position from current state.
function updateNotchLabels() {
  const dur = parseFloat(_el('notchDuration').value) || 1;
  _el('notchDurVal').textContent = dur < 10 ? dur.toFixed(1) + 's' : dur.toFixed(0) + 's';
  // Inverse of the log slider mapping in index.html (pos → hotMs).
  _el('hotDuration').value = Math.max(0, Math.min(100, Math.round((Math.log10(Math.max(1, hotMs)) - 2) / 3 * 100)));
  _el('hotDurVal').textContent = hotMs >= 10000 ? (hotMs / 1000).toFixed(0) + 's'
    : hotMs >= 1000 ? (hotMs / 1000).toFixed(1) + 's' : hotMs + 'ms';
}

// Write a settings snapshot back into in-memory state + the DOM, then refresh views.
// TX rows are always restored DISABLED - never auto-transmit on load/switch.
function applySettings(d) {
  d = d || defaultWorkspaceData();
  _restoring = true;
  // Guard every restore step: a throw here (bad imported workspace, misbehaving module
  // *Apply hook) must NOT leave _restoring stuck true, or scheduleSave() early-returns
  // forever and all persistence is silently dead for the rest of the session.
  try {

  pinnedKeys.clear(); (d.pins   || []).forEach(k => pinnedKeys.add(k));
  frameColors.clear(); (d.colors || []).forEach(([k, v]) => frameColors.set(k, v));
  frameNotes.clear(); (d.notes  || []).forEach(([k, v]) => frameNotes.set(k, v));

  _el('byteFormat').value = d.byteFormat || 'hexascii';

  const f = d.filter || {};
  _el('filterFrameType').value      = f.frameType ?? 'all';
  _el('filterDataType').value       = f.dataType ?? 'all';
  _el('filterIds').value            = f.ids ?? '';
  _el('filterIdsExclude').checked   = !!f.idsExclude;
  _el('filterData').value           = f.data ?? '';
  _el('filterOnlyUnseen').checked   = !!f.onlyUnseen;
  _el('filterOnlyHighlighted').checked = !!f.onlyHighlighted;
  _el('filterOnlyRx').checked       = !!f.onlyRx;

  const n = d.notch || {};
  hotMs = typeof n.hotMs === 'number' ? n.hotMs : 500;
  _el('notchDuration').value = n.duration ?? '1';
  updateNotchLabels();

  _el('baudRate').value    = d.baud ?? 'S6';
  _el('listenOnly').checked = !!d.listenOnly;
  _el('autoOpen').checked   = d.autoOpen !== false;

  txMessages.forEach(m => { if (m.timer) { clearInterval(m.timer); m.timer = null; } });
  txMessages = (d.tx || []).map(m => ({ seq: txSeq++, enabled: false, ext: !!m.ext, rtr: !!m.rtr,
    id: m.id, dlc: m.dlc, data: m.data, period: m.period, timer: null, note: m.note || '' }));
  renderTxRows();

  const it = d.isotp || {};
  _el('isotpTxId').value     = it.txId ?? '7DF';
  _el('isotpRxId').value     = it.rxId ?? '7E9';
  _el('isotpCanType').value  = it.canType ?? 'std';
  _el('isotpAddrMode').value = it.addrMode ?? 'normal';
  _el('isotpAddrByte').value = it.addrByte ?? 'F1';
  _el('isotpBlockSize').value = it.blockSize ?? '00';
  _el('isotpStmin').value    = it.stmin ?? '00';
  _el('isotpPadding').value  = it.padding ?? '';
  isotpAddrModeChanged();
  isotpUpdateStminLabel();
  obdApply(it.obdWatch || []);
  const proto = ['obd', 'kwp'].includes(it.proto) ? it.proto : 'uds';
  // Reset all three protos to their built-in defaults first: only the ACTIVE proto's Tx/Rx is
  // persisted per workspace, so without this the other two would carry the previous workspace's
  // remembered ids (cross-workspace bleed).
  isotpModeIds = isotpModeIdDefaults();
  if (it.txId) isotpModeIds[proto].tx = String(it.txId).trim().toUpperCase();
  if (it.rxId) isotpModeIds[proto].rx = String(it.rxId).trim().toUpperCase();
  isotpSetProtoMode(proto);

  // Graph signals: stash for the deferred graph.js to pick up on load, and apply now if it's loaded.
  window._graphPending = d.graphSignals || [];
  if (window.graphApply) window.graphApply(window._graphPending);

  // Fuzzer config: stash for deferred fuzz.js, apply now if loaded (never auto-runs).
  window._fuzzPending = d.fuzz || null;
  if (window.fuzzApply) window.fuzzApply(window._fuzzPending);

  // J1939/NMEA protocol mode: stash for deferred j1939.js, apply now if loaded.
  window._j1939ProtoPending = d.j1939Proto || 'j1939';
  if (window.j1939Apply) window.j1939Apply(window._j1939ProtoPending);

  // XCP config: stash for deferred xcp.js, apply now if loaded.
  window._xcpPending = d.xcp || null;
  if (window.xcpApply) window.xcpApply(window._xcpPending);

  // CANopen config: stash for deferred canopen.js, apply now if loaded.
  window._canopenPending = d.canopen || null;
  if (window.canopenApply) window.canopenApply(window._canopenPending);

  changedIds.clear();
  dumpFilterDirty = true; dumpLastSize = -1; dumpRowElsDirty = true;
  rerenderTable();
  if (dumpViewActive) renderDump();

  } finally {
    _restoring = false;
  }
}

// ── Global UI prefs (not per-vehicle) ──
function collectPrefs() {
  return {
    fps: _el('fpsLimit').value,
    buffer: _el('bufferSizeSelect').value,
    txPanelOpen: _el('txContent').style.display !== 'none',
    consoleOpen: _el('pane-console').style.display !== 'none',
  };
}

function applyPrefs(p) {
  p = p || {};
  if (p.fps != null)    { _el('fpsLimit').value = p.fps; setFpsLimit(parseInt(p.fps)); }
  if (p.buffer != null) { _el('bufferSizeSelect').value = p.buffer; setBufferSize(parseInt(p.buffer)); }
  if (p.txPanelOpen != null && (_el('txContent').style.display !== 'none') !== p.txPanelOpen) toggleTxPanel();
  if (p.consoleOpen != null && (_el('pane-console').style.display !== 'none') !== p.consoleOpen) toggleConsole();
}

// ── Save (debounced) ──
function scheduleSave() {
  if (_restoring) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  const ws = workspaces.find(w => w.id === activeWsId);
  if (ws) { ws.data = collectSettings(); ws.updatedAt = Date.now(); }
  saveWorkspaces();
  saveGlobalPrefs();
}

// Surface a storage write failure (e.g. QuotaExceededError from a large notes set / many
// workspaces) once per session - saves run on a 300 ms debounce, so logging every failure would
// flood the pane. The user otherwise believes their config persisted when it silently didn't.
let _storageWarned = false;
function _warnStorageFailed(what, e) {
  if (_storageWarned) return;
  _storageWarned = true;
  log(`Could not save ${what} to local storage (${e && e.name || 'error'}) - settings may not persist this session`, 'err');
}

function saveWorkspaces() {
  try { localStorage.setItem('slcanWorkspaces',
    JSON.stringify({ version: 1, activeId: activeWsId, list: workspaces })); }
  catch(e) { _warnStorageFailed('workspaces', e); }
}

function saveGlobalPrefs() {
  try { localStorage.setItem('slcanPrefs', JSON.stringify(collectPrefs())); }
  catch(e) { _warnStorageFailed('preferences', e); }
}

// ── Workspace operations ──
function renderWsSelect() {
  const sel = _el('wsSelect');
  if (!sel) return;
  sel.innerHTML = workspaces.map(w =>
    `<option value="${w.id}"${w.id === activeWsId ? ' selected' : ''}>${escHtml(w.name)}</option>`).join('');
  updateWsDeleteLabel();
}

// The "Default" workspace can't be removed (it always reappears), so offer Reset instead of Delete.
function updateWsDeleteLabel() {
  const btn = _el('wsDeleteBtn');
  if (!btn) return;
  const ws = workspaces.find(w => w.id === activeWsId);
  btn.textContent = (ws && ws.name === 'Default') ? 'Reset' : 'Delete';
}

function switchWorkspace(id) {
  if (id === activeWsId) return;
  saveNow();                       // persist the workspace we're leaving
  const ws = workspaces.find(w => w.id === id);
  if (!ws) return;
  stopAllTx();                     // safety: never carry transmission across a switch
  activeWsId = id;
  applySettings(ws.data);
  renderWsSelect();
  saveWorkspaces();
  log('Switched to workspace: ' + ws.name, 'ok');
}

function newWorkspace() {
  const name = (prompt('New workspace name:', 'Workspace ' + (workspaces.length + 1)) || '').trim();
  if (!name) return;
  saveNow();
  stopAllTx();
  const ws = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), data: defaultWorkspaceData() };
  workspaces.push(ws);
  activeWsId = ws.id;
  applySettings(ws.data);
  renderWsSelect();
  saveWorkspaces();
  log('Created workspace: ' + name, 'ok');
}

function renameWorkspace() {
  const ws = workspaces.find(w => w.id === activeWsId);
  if (!ws) return;
  const name = (prompt('Rename workspace:', ws.name) || '').trim();
  if (!name) return;
  ws.name = name;
  renderWsSelect();
  saveWorkspaces();
}

function duplicateWorkspace() {
  const ws = workspaces.find(w => w.id === activeWsId);
  if (!ws) return;
  saveNow();
  const copy = { id: uid(), name: ws.name + ' copy', createdAt: Date.now(), updatedAt: Date.now(),
                 data: JSON.parse(JSON.stringify(ws.data)) };
  workspaces.push(copy);
  activeWsId = copy.id;
  stopAllTx();
  applySettings(copy.data);
  renderWsSelect();
  saveWorkspaces();
  log('Duplicated workspace: ' + copy.name, 'ok');
}

function deleteWorkspace() {
  const ws = workspaces.find(w => w.id === activeWsId);
  if (!ws) return;
  // "Default" is permanent - reset it to factory settings in place instead of deleting.
  if (ws.name === 'Default') {
    if (!confirm('Reset workspace "Default" to factory settings? This cannot be undone.')) return;
    stopAllTx();
    ws.data = defaultWorkspaceData();
    delete ws.hwWarnDismissed;
    ws.updatedAt = Date.now();
    applySettings(ws.data);
    renderWsSelect();
    saveWorkspaces();
    log('Reset workspace: Default', 'warn');
    return;
  }
  if (!confirm(`Delete workspace "${ws.name}"? This cannot be undone.`)) return;
  workspaces = workspaces.filter(w => w.id !== activeWsId);
  if (workspaces.length === 0) {
    workspaces.push({ id: uid(), name: 'Default', createdAt: Date.now(), updatedAt: Date.now(),
                      data: defaultWorkspaceData() });
  }
  activeWsId = workspaces[0].id;
  stopAllTx();
  applySettings(workspaces[0].data);
  renderWsSelect();
  saveWorkspaces();
  log('Deleted workspace: ' + ws.name, 'warn');
}

function exportWorkspace() {
  const ws = workspaces.find(w => w.id === activeWsId);
  if (!ws) return;
  saveNow();
  const blob = new Blob([JSON.stringify({ name: ws.name, data: ws.data }, null, 2)],
                        { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sloppycan_' + ws.name.replace(/[^\w.-]+/g, '_') + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importWorkspace(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      const ws = { id: uid(), name: String(obj.name || 'Imported'),
                   createdAt: Date.now(), updatedAt: Date.now(),
                   data: sanitizeWorkspaceData(obj.data) };
      workspaces.push(ws);
      activeWsId = ws.id;
      stopAllTx();
      applySettings(ws.data);
      renderWsSelect();
      saveWorkspaces();
      log('Imported workspace: ' + ws.name, 'ok');
    } catch (e) { log('Import failed: ' + e.message, 'err'); }
  };
  reader.onerror = () => log('Workspace read failed', 'err');
  reader.readAsText(file);
}

function toggleWsMenu() {
  const panel = _el('wsMenu');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  if (!open) {
    updateWsDeleteLabel();
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target) && e.target.id !== 'wsMenuBtn') {
          panel.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}
function closeWsMenu() { _el('wsMenu').style.display = 'none'; }

// Unified Help panel (#10) - filter syntax + byte colours + Notch workflow + view notes.
function toggleHelp() {
  const panel = _el('helpPanel');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) {
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target) && !e.target.closest('#helpBtn')) {
          panel.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}

// Connect popover - holds all adapter settings + a confirm Connect button (#1).
// Anchored to the header Connect button; outside-click closes (same pattern as the menus above).
function toggleConnectPopover(forceOpen) {
  const panel = _el('connectPopover');
  if (!panel) return;
  const wasOpen = panel.style.display !== 'none';
  const open = forceOpen === true ? true : !wasOpen;
  panel.style.display = open ? 'flex' : 'none';
  // Only wire the outside-click closer on a genuine closed→open transition (no stacking).
  // The header Connect button and the onboarding "Connect to hardware" CTA are exempt so
  // clicking them again keeps the popover open rather than toggling it shut.
  if (open && !wasOpen) {
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target) && !e.target.closest('#connectBtn') && !e.target.closest('.onboard-connect')) {
          panel.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}
function closeConnectPopover() { const p = _el('connectPopover'); if (p) p.style.display = 'none'; }

// Autosave: one delegated listener persists any settings-control change/input,
// instead of editing the many inline handlers. Debounced; ignored while restoring.
document.addEventListener('change', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) scheduleSave();
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) scheduleSave();
});

// ── Startup ──────────────────────────────────────────────────────────────────
log('sloppyCAN ready. Click Connect to open your serial adapter.', 'ok');

// Restore global UI prefs + workspaces (with one-time migration from legacy keys)
let _prefs = {};
try { _prefs = JSON.parse(localStorage.getItem('slcanPrefs') || '{}'); } catch(_) {}

let _wsStore = null;
try { _wsStore = JSON.parse(localStorage.getItem('slcanWorkspaces') || 'null'); } catch(_) {}

if (_wsStore && Array.isArray(_wsStore.list) && _wsStore.list.length) {
  workspaces = _wsStore.list;
  activeWsId = (_wsStore.activeId && workspaces.some(w => w.id === _wsStore.activeId))
    ? _wsStore.activeId : workspaces[0].id;
} else {
  // First run (or pre-workspaces install): migrate legacy pins/colours/notes into "Default".
  const data = defaultWorkspaceData();
  try { data.pins   = JSON.parse(localStorage.getItem('slcanPins')   || '[]'); } catch(_) {}
  try { data.colors = JSON.parse(localStorage.getItem('slcanColors') || '[]'); } catch(_) {}
  try { data.notes  = JSON.parse(localStorage.getItem('slcanNotes')  || '[]'); } catch(_) {}
  const def = { id: uid(), name: 'Default', createdAt: Date.now(), updatedAt: Date.now(), data };
  workspaces = [def];
  activeWsId = def.id;
  try {
    localStorage.removeItem('slcanPins');
    localStorage.removeItem('slcanColors');
    localStorage.removeItem('slcanNotes');
  } catch(_) {}
}

window.graphScheduleSave = scheduleSave; // let graph.js persist signal add/remove
window.j1939ScheduleSave = scheduleSave; // let j1939.js persist the protocol-mode dropdown
window.ingestFrame = ingestFrame; // let chademo.js demo loop replay frames into the pipeline
// Forward a Carlito telemetry frame ({id,isExt,isRtr,dlc,data[]}). Ingested once (RX pipeline +
// dashboards); only when the bus can actually transmit (open, connected, NOT listen-only) is it also
// sent on the wire and the single dump/ID-list entry tagged "FW" (gateway model: counts as RX+TX,
// shown once). Otherwise (no bus, or listen-only monitoring) it's a plain RX inject with no transmit -
// transmitting in listen-only makes the adapter reject every frame with BELL (0x07).
window.canForward = function (frame) {
  const txReady = obdBusReady(); // bus open + connected + not listen-only (canonical TX-ready check)
  ingestFrame(frame, { fwd: txReady });
  if (!txReady) return;
  // Fire-and-forget; the write is serialized inside sendCommand. txTransmitRaw is async, so swallow
  // any late rejection on the returned promise (errors are already logged) to avoid unhandled rejections.
  txTransmitRaw({
    id:  (frame.id >>> 0).toString(16).toUpperCase(),
    ext: !!frame.isExt, rtr: !!frame.isRtr,
    dlc: frame.dlc,
    data: frame.data.map(b => (b & 0xFF).toString(16).padStart(2, '0')).join('')
  }).catch(() => {});
};
window.fuzzScheduleSave  = scheduleSave; // let fuzz.js persist config changes
window.obdScheduleSave   = scheduleSave; // persist OBD sub-mode + watch selection
window.xcpScheduleSave   = scheduleSave; // let xcp.js persist CRO/DTO/byte-order config
window.xcpDemoActive     = () => demoMode; // demo XCP slave answers only in Demo mode
window.canopenScheduleSave = scheduleSave; // let canopen.js persist node/SDO config
window.canopenDemoActive   = () => demoMode; // demo CANopen node answers only in Demo mode
window.demoIsActive        = () => demoMode; // let modules gate demo-base-traffic switching

applyPrefs(_prefs);
renderWsSelect();
applySettings(workspaces.find(w => w.id === activeWsId).data);
saveWorkspaces();
saveGlobalPrefs();

// Delegated click on ID list - survives innerHTML rerenders; ignore pin button clicks
document.getElementById('frameBody').addEventListener('click', e => {
  if (e.target.closest('[data-pin]')) return;
  const row = e.target.closest('tr');
  if (!row || !row.dataset.key) return;
  const f = frames.get(row.dataset.key);
  if (f) inspectFrame(f);
});

// Right-click an ID list row → minimal "Graph this ID" menu
document.getElementById('frameBody').addEventListener('contextmenu', e => {
  const row = e.target.closest('tr');
  if (!row || !row.dataset.key || !window.graphContextMenu) return;
  e.preventDefault();
  window.graphContextMenu(e.clientX, e.clientY, row.dataset.key);
});

// ── Onboarding spotlight arrow (empty ID List) ──────────────────────────────
// Hovering / focusing a feature chip draws an arrow from the chip to the real
// control and pulses it. One target at a time, geometry recomputed on each show
// and on resize/scroll so it never goes stale.
(function onboardSpotlight() {
  const svg  = document.getElementById('onboardArrow');
  const path = document.getElementById('oaPath');
  // The Carlito card behaves like a chip now (#5) - it points an arrow at the toolbar button.
  const chips = document.querySelectorAll('.onboard-chip, .onboard-card[data-target]');
  if (!svg || !path || !chips.length) return;

  let activeChip = null, activeTarget = null;

  // Point on rect r's border along the line from its centre toward (tx, ty).
  function edgePoint(r, tx, ty) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const sx = dx ? (r.width / 2) / Math.abs(dx) : Infinity;
    const sy = dy ? (r.height / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function draw() {
    if (!activeChip || !activeTarget) return;
    const c = activeChip.getBoundingClientRect();
    const t = activeTarget.getBoundingClientRect();
    if (!t.width || !t.height) { hide(); return; }   // target hidden → bail
    const s = edgePoint(c, t.left + t.width / 2, t.top + t.height / 2);
    const e = edgePoint(t, c.left + c.width / 2, c.top + c.height / 2);
    const dx = e.x - s.x, dy = e.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const bend = Math.min(70, len * 0.18);           // gentle arc, perpendicular to the line
    const mx = (s.x + e.x) / 2 + (-dy / len) * bend;
    const my = (s.y + e.y) / 2 + ( dx / len) * bend;
    path.setAttribute('d', `M ${s.x} ${s.y} Q ${mx} ${my} ${e.x} ${e.y}`);
  }

  let _autoT = 0;
  function show(chip) {
    showArrowBetween(chip, document.querySelector(chip.dataset.target));
  }

  // Draw the arrow from a source element to a target element, optionally auto-hiding after autoMs.
  function showArrowBetween(sourceEl, target, autoMs) {
    if (!sourceEl || !target) return;
    clearTimeout(_autoT);
    if (activeTarget && activeTarget !== target) activeTarget.classList.remove('onboard-pulse');
    activeChip = sourceEl; activeTarget = target;
    target.classList.add('onboard-pulse');
    svg.classList.add('show');
    draw();
    if (autoMs) _autoT = setTimeout(hide, autoMs);
  }

  function hide() {
    clearTimeout(_autoT);
    if (activeTarget) activeTarget.classList.remove('onboard-pulse');
    activeChip = activeTarget = null;
    svg.classList.remove('show');
  }

  // Programmatic trigger (used by the onboarding "Select your Hardware" CTA #1).
  window.onboardArrowTo = (sourceEl, targetSel, ms) => showArrowBetween(sourceEl, document.querySelector(targetSel), ms);

  chips.forEach(chip => {
    chip.addEventListener('mouseenter', () => show(chip));
    chip.addEventListener('mouseleave', hide);
    chip.addEventListener('focus', () => show(chip));   // keyboard + touch tap
    chip.addEventListener('blur', hide);
  });
  window.addEventListener('resize', draw);
  // The onboarding panel scrolls independently of the fixed chrome it points at.
  document.getElementById('emptyState').addEventListener('scroll', draw, { passive: true });
})();
