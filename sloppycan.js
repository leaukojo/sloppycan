// ── sloppyCAN — Architecture Overview ───────────────────────────────────────
// Single-file HTML app using the Web Serial API (Chrome/Edge only).
//
// SERIAL LAYER
//   connectSerial() opens the port at 115200 baud, sends V/N for version,
//   then opens the CAN bus (O or L). readLoop() reads bytes into frameBuffer
//   (CAN mode) or termBuffer (terminal mode). processBuffer() parses SLCAN
//   lines; parseSLCAN() converts them into frame objects fed to ingestFrame().
//
// DATA MODEL
//   frames      — Map<key, frame>: one entry per unique CAN ID, updated live.
//   dumpLog     — RingBuffer(DUMP_MAX, default 100000): every received/sent frame in order.
//   frameNotes  — Map<key, string>: user notes, persists across clear.
//   notchedBytes / stableBytes — set after a Notch run; drive byte colouring.
//   notchSnapshot — Map<key, {ts, data}> taken at notch start.
//
// RENDERING
//   Single RAF loop throttled to 100ms. Calls rerenderTable() (ID List) or
//   renderDump() (Traffic Dump) depending on active tab. Terminal tab pauses
//   CAN rendering. updateStats() runs every tick regardless of tab.
//
// BYTE COLOURS (ID List only, RX frames only)
//   Green  — hot: changed within hotMs (configurable, default 500ms)
//   Amber  — noisy: changed during notch window
//   Grey   — stable: unchanged during notch, current value = snapshot value
//   White  — unclassified: not notched, not recently changed
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
//   frameKey(f) = "E:<id>" (EXT) or "S:<id>" (STD) — used in all Maps.

let port = null;
let reader = null;
let paused = false;
let frames = new Map(); // frameKey → {id, isExt, isRtr, dlc, data, byteChangedAt, count, firstSeen, lastSeen, timestamps, hasRx, hasTx}
let totalFrames = 0;
let parseErrors = 0;
let frameBuffer = '';
let termBuffer  = ''; // accumulates bytes for terminal line display
let sortKey = 'id';
let sortAsc = true;
let terminalMode = false;
let frameRateBuffer = []; // timestamps
let bytesReceived = 0;
let lastRenderTime = 0;
let changedIds = new Set();
// notchedBytes: Map<frameKey, Set<byteIndex>> — bytes that changed during the notch window (shown amber)
let notchedBytes = new Map();
// stableBytes: Map<frameKey, Map<byteIndex, value>> — bytes unchanged during notch at their observed value (shown grey)
// Grey only applies while the current byte value matches the snapshotted value.
let stableBytes  = new Map();
let notching = false;
let notchTimer = null;
let notchTicker = null;
let notchSnapshot = null;
let hotMs = 500; // configurable highlight duration (log slider pos=25 → 500ms)

let usbSerDev = null;
let usbSerIn  = null;
let usbSerOut = null;

const _onAndroid = /Android/i.test(navigator.userAgent);
const SERIAL_USB_FILTERS = [
  {vendorId: 0x0483, productId: 0x5740},
  {vendorId: 0x1d50, productId: 0x606f}
];

// ── gs_usb (candleLight / CANable-native) ──────────────────────────────────────
// Binary WebUSB protocol — does NOT use SLCAN text. Selected via the Adapter dropdown.
let connMode = 'serial';       // 'serial' (Web Serial + Android CDC) | 'gsusb'
let gsFclk   = 48000000;       // CAN clock (Hz), refined from BT_CONST at connect
let gsIface  = 0;              // gs_usb vendor interface number (for control transfers)
let gsEchoId = 0;              // rotating TX echo id (avoids reusing a busy echo slot)
// gs_usb bit-timing segment/brp limits — refined from BT_CONST, defaults are bxCAN's.
let gsBtConst = { tseg1_min: 1, tseg1_max: 16, tseg2_min: 1, tseg2_max: 8,
                  sjw_max: 4, brp_min: 1, brp_max: 1024, brp_inc: 1 };
const GSUSB_FILTERS = [
  {vendorId: 0x1d50, productId: 0x606f},  // candleLight / geschwister schneider
  {vendorId: 0x1209, productId: 0x2323},  // CANable (gs_usb firmware)
  {vendorId: 0x1d50, productId: 0x6070}   // candleLight-FD (classic mode)
];
const GS_BREQ = { HOST_FORMAT: 0, BITTIMING: 1, MODE: 2, BT_CONST: 4, DEVICE_CONFIG: 5 };
const GS_MODE = { RESET: 0, START: 1 };
const GS_MODE_LISTEN_ONLY = 1 << 0;
const CAN_EFF_FLAG = 0x80000000, CAN_RTR_FLAG = 0x40000000, CAN_ERR_FLAG = 0x20000000;
const CAN_SFF_MASK = 0x7FF, CAN_EFF_MASK = 0x1FFFFFFF;

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
const SLCAN_BITRATE_HZ = {
  S0: 10000, S1: 20000, S2: 50000, S3: 100000, S4: 125000,
  S5: 250000, S6: 500000, S7: 800000, S8: 1000000
};
function getBitrateHz() {
  return SLCAN_BITRATE_HZ[document.getElementById('baudRate').value] || 500000;
}

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
  // Update the inspector ID text color in-place — avoid full re-render which resets the view
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

function toggleNotchPanel() {
  const panel = document.getElementById('notchPanel');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  if (!open) {
    // Close on outside click
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target) && e.target.id !== 'notchArrowBtn') {
          panel.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}
const frameNotes = new Map(); // key → note string

function saveNotes() {
  scheduleSave(); // persist into the active workspace
}

// ── Ring buffer — O(1) push and oldest-first iteration ──────────────────────
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

// Dump view — ring buffer of raw frames
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

let RENDER_INTERVAL = 100; // ms — changed by setFpsLimit()
function setFpsLimit(fps) {
  RENDER_INTERVAL = fps === 0 ? 16 : Math.round(1000 / fps);
}

// Check Web Serial API
if (!navigator.serial && !(_onAndroid && navigator.usb)) {
  document.getElementById('noSerialBanner').style.display = 'block';
  document.getElementById('connectBtn').disabled = true;
}
// gs_usb is WebUSB-only — disable the option if WebUSB is unavailable
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

// Expand the scheduler if collapsed — called when transmission starts.
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
      <input type="checkbox" title="Enable — send periodically" ${msg.enabled ? 'checked' : ''}
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
    txSendOne(msg);
    msg.timer = setInterval(() => txSendOne(msg), msg.period);
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

function txBuildSlcan(msg) {
  const id     = msg.id.trim().toUpperCase().padStart(msg.ext ? 8 : 3, '0');
  const prefix = msg.rtr ? (msg.ext ? 'R' : 'r') : (msg.ext ? 'T' : 't');
  let frame = prefix + id + msg.dlc;
  if (!msg.rtr) {
    frame += txDataBytes(msg).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return frame;
}

async function txSendOne(msg) {
  if (!busIsOpen || (!port && !usbSerDev && !demoMode)) {
    const el = document.getElementById(`txstat-${msg.seq}`);
    if (el) { el.textContent = 'NO BUS'; el.className = 'tx-status error'; }
    return;
  }
  try {
    if (connMode === 'gsusb') {
      const r = await usbSerDev.transferOut(usbSerOut, gsUsbBuildFrame(msg));
      if (r && r.status !== 'ok') log(`gs_usb TX ${r.status}`, 'err');
    } else await sendCommand(txBuildSlcan(msg));
    // Mark frame as TX in the frames map
    const id  = parseInt(msg.id, 16);
    const key = frameKey({ isExt: msg.ext, id });
    const now = Date.now();
    const dataBytes = txDataBytes(msg);
    dumpLog.push({ ts: now, isTx: true, id, isExt: msg.ext, isRtr: msg.rtr, dlc: msg.dlc, data: dataBytes });
    dumpFilterDirty = true;
    if (frames.has(key)) {
      const existing = frames.get(key);
      existing.hasTx = true;
      existing.count++;
      existing.lastSeen = now;
      existing.timestamps.push(now);
      if (existing.timestamps.length > 120) existing.timestamps.splice(0, 20);
      // Update data so ID list shows latest TX payload
      if (!existing.hasRx) {
        existing.data = dataBytes;
        existing.dlc  = msg.dlc;
        existing.isRtr = msg.rtr;
      }
    } else {
      frames.set(key, {
        id, isExt: msg.ext, isRtr: msg.rtr, dlc: msg.dlc, data: dataBytes,
        byteChangedAt: [], count: 1, firstSeen: now, lastSeen: now, timestamps: [now],
        hasRx: false, hasTx: true
      });
    }
    if (msg.enabled) {
      const el = document.getElementById(`txstat-${msg.seq}`);
      if (el) {
        el.textContent = txSuspended ? 'Paused' : 'ON';
        el.className = `tx-status ${txSuspended ? 'paused' : 'running'}`;
      }
    }
  } catch(e) {
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

// TX Scheduler "Transmitting" indicator — visible whenever timers are actively
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
// (Quick Watch, Fuzzer). Non-editable — purely informational — and tinted with
// the TX warning colour so it reads as "this is being transmitted, not by you".
function txModuleRowHtml(module, idText, ext, dataText, periodText, note) {
  return `<div class="tx-row tx-module-row" title="Sent by ${escHtml(module)} — read-only">
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
  // OBD-II Quick Watch — one round-robin poll per watched PID on the ISO-TP Tx ID.
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
  // Fuzzer — randomized frames; show a single summary row.
  const fz = window.fuzzModuleSummary ? window.fuzzModuleSummary() : null;
  if (fz) rows.push(txModuleRowHtml('Fuzzer', fz.idText, fz.ext, fz.dataText, fz.periodText, fz.note));

  body.innerHTML = rows.join('');
  section.style.display = rows.length ? '' : 'none';   // body's own collapse is via toggleTxModule
  const cnt = document.getElementById('txModuleCount');
  if (cnt) cnt.textContent = rows.length;
}
window.renderTxModuleRows = renderTxModuleRows;   // fuzz.js refreshes its summary row through this

// ── Fuzzer hooks (used by fuzz.js — remove with that module to revert) ────────
// Single seam the fuzzer calls to put a raw frame on the wire. Mirrors the
// transport branch + dumpLog/frames bookkeeping in txSendOne, but takes raw
// values (id number, byte array) instead of a scheduler row object.
window.fuzzBusReady = () => busIsOpen && (port || usbSerDev || demoMode);
window.fuzzBusPaused = () => paused;

// IDs currently observed in the ID list (numbers) for idMode:'observed'.
window.fuzzObservedIds = (wantExt) => {
  const out = [];
  for (const f of frames.values()) if (!!f.isExt === !!wantExt) out.push(f.id);
  return out;
};

window.fuzzTxFrame = async (id, isExt, dlc, bytes) => {
  if (!window.fuzzBusReady()) return false;
  try {
    if (connMode === 'gsusb') {
      const r = await usbSerDev.transferOut(usbSerOut, gsUsbPackFrame(id, isExt, false, bytes));
      if (r && r.status !== 'ok') log(`gs_usb TX ${r.status}`, 'err');
    } else if (!demoMode) {
      const idHex = (id & (isExt ? CAN_EFF_MASK : CAN_SFF_MASK)).toString(16).toUpperCase().padStart(isExt ? 8 : 3, '0');
      await sendCommand((isExt ? 'T' : 't') + idHex + dlc + bytes.map(b => b.toString(16).toUpperCase().padStart(2,'0')).join(''));
    }
    const key = frameKey({ isExt, id });
    const now = Date.now();
    dumpLog.push({ ts: now, isTx: true, id, isExt, isRtr: false, dlc, data: [...bytes] });
    dumpFilterDirty = true;
    if (frames.has(key)) {
      const ex = frames.get(key);
      ex.hasTx = true; ex.count++; ex.lastSeen = now; ex.timestamps.push(now);
      if (ex.timestamps.length > 120) ex.timestamps.splice(0, 20);
      if (!ex.hasRx) { ex.data = [...bytes]; ex.dlc = dlc; ex.isRtr = false; }
    } else {
      frames.set(key, { id, isExt, isRtr: false, dlc, data: [...bytes],
        byteChangedAt: [], count: 1, firstSeen: now, lastSeen: now, timestamps: [now],
        hasRx: false, hasTx: true });
    }
    return true;
  } catch(e) { return false; }
};

// ── Utilities ────────────────────────────────────────────────────────────────
function frameKey(f) {
  return `${f.isExt ? 'E' : 'S'}:${f.id}`;
}

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
  return { frameType, dataType, ids, idsExclude, dataRaw, onlyHighlighted, onlyUnseen, onlyRx };
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
    const hexStr = (f.data || []).map(b => b.toString(16).padStart(2,'0')).join('');
    const ascStr = (f.data || []).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('').toLowerCase();
    if (!hexStr.includes(flt.dataRaw.replace(/\s+/g,'')) && !ascStr.includes(flt.dataRaw)) return false;
  }
  // Only RX: exclude frames that are TX-only (hasTx true, hasRx false); for dump entries use isTx
  if (flt.onlyRx) {
    if (f.isTx === true) return false;          // dump entry: explicitly TX
    if (f.hasTx && !f.hasRx) return false;       // ID list: TX-only frame
  }
  if (flt.onlyHighlighted || flt.onlyUnseen) {
    // TX frames are not subject to notch/highlight logic — skip these filters for them
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
        // "Only highlighted" relies on per-byte timestamps — only meaningful in ID List
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
  // Auto-expand console on errors
  if (cls === 'err' && body.style.display === 'none') toggleConsole();
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Transient toast (bottom-right). type: 'err' | 'warn' | 'ok'. Click to dismiss.
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

// Inline connection-failure message anchored below the Connect button (complements the toast).
function showConnectError(msg) {
  const el = document.getElementById('connectError');
  if (!el) return;
  el.textContent = String(msg);
  el.hidden = false;
}
function clearConnectError() {
  const el = document.getElementById('connectError');
  if (el) { el.textContent = ''; el.hidden = true; }
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
  if (e.key === 'Enter') termSend();
  if (e.key === 'ArrowUp') {
    if (termHistory.length) e.target.value = termHistory[termHistory.length - 1];
  }
}

const termHistory = [];
async function termSend() {
  const input = document.getElementById('termInput');
  const cmd = input.value.trim();
  if (!cmd) return;
  termHistory.push(cmd);
  input.value = '';
  await sendCommand(cmd);
}

function encodeCmd(trimmed) {
  const bytes = new Uint8Array(trimmed.length + 1);
  for (let i = 0; i < trimmed.length; i++) bytes[i] = trimmed.charCodeAt(i);
  bytes[trimmed.length] = 0x0D;
  return bytes;
}

async function sendCommand(cmd) {
  const trimmed = cmd.replace(/[\r\n]+$/, '');
  if (connMode === 'gsusb') return;   // gs_usb has no SLCAN text channel
  if (demoMode) {
    // In demo mode, only actually send to serial if user is in the terminal tab
    if (terminalMode) {
      // Terminal tab: show in terminal log but don't send (no real port)
      termLog('tx', trimmed + '\\r');
      termLog('rx', 'Demo mode');
    }
    // All other demo sends (bus open/close, TX scheduler) are silent no-ops
    return;
  }
  if (usbSerDev) {
    await usbSerDev.transferOut(usbSerOut, encodeCmd(trimmed));
    termLog('tx', trimmed + '\\r');
    return;
  }
  if (!port || !port.writable) { log('Not connected', 'err'); return; }
  const writer = port.writable.getWriter();
  try {
    await writer.write(encodeCmd(trimmed));
    termLog('tx', trimmed + '\\r');
  } finally {
    writer.releaseLock();
  }
}

let busIsOpen = false;

function getOpenCmd() {
  return document.getElementById('listenOnly').checked ? 'L' : 'O';
}
function getBaudCmd() {
  return document.getElementById('baudRate').value; // S0–S8
}

async function busOpen() {
  const listenOnly = document.getElementById('listenOnly').checked;
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
  busIsOpen = true;
  paused = false;
  updateBusPauseBtn();
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
      if (m.enabled && !m.timer) m.timer = setInterval(() => txSendOne(m), m.period);
    });
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Suspend All`;
    btn.classList.remove('active-notch');
    log('TX resumed', 'ok');
  }
  obdWatchUpdateIndicator();
  renderTxRows();
}

async function openWebUSBCDC() {
  const dev = await navigator.usb.requestDevice({filters: SERIAL_USB_FILTERS});
  await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  let ctrl = null, data = null, inEp = null, outEp = null;
  for (const ifc of dev.configuration.interfaces) {
    const alt = ifc.alternates[0];
    if (alt.interfaceClass === 0x02 && alt.interfaceSubclass === 0x02)
      ctrl = ifc.interfaceNumber;
    if (alt.interfaceClass === 0x0A) {
      data = ifc.interfaceNumber;
      for (const ep of alt.endpoints) {
        if (ep.direction === 'in')  inEp  = ep.endpointNumber;
        if (ep.direction === 'out') outEp = ep.endpointNumber;
      }
    }
  }
  if (data === null) throw new Error('CDC-ACM data interface not found');
  if (ctrl !== null) await dev.claimInterface(ctrl);
  await dev.claimInterface(data);
  if (ctrl !== null) {
    const coding = new ArrayBuffer(7);
    const v = new DataView(coding);
    v.setUint32(0, 115200, true); v.setUint8(4, 0); v.setUint8(5, 0); v.setUint8(6, 8);
    await dev.controlTransferOut(
      {requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: ctrl},
      coding
    );
    await dev.controlTransferOut(
      {requestType: 'class', recipient: 'interface', request: 0x22, value: 0x03, index: ctrl}
    );
  }
  return {dev, inEp, outEp};
}

// ── gs_usb transport ───────────────────────────────────────────────────────────
// Open a gs_usb device: claim its vendor interface, find bulk endpoints, send the
// host-format marker, and read BT_CONST for the CAN clock. Structurally mirrors
// openWebUSBCDC but speaks the gs_usb vendor protocol instead of CDC-ACM.
async function openGsUsb() {
  const dev = await navigator.usb.requestDevice({filters: GSUSB_FILTERS});
  await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  let iface = null, inEp = null, outEp = null;
  for (const ifc of dev.configuration.interfaces) {
    const alt = ifc.alternates[0];
    if (alt.interfaceClass === 0xFF) {           // vendor-specific interface
      iface = ifc.interfaceNumber;
      for (const ep of alt.endpoints) {
        if (ep.direction === 'in')  inEp  = ep.endpointNumber;
        if (ep.direction === 'out') outEp = ep.endpointNumber;
      }
      break;
    }
  }
  if (iface === null || inEp === null || outEp === null)
    throw new Error('gs_usb vendor interface not found');
  await dev.claimInterface(iface);
  gsIface = iface;

  // GS_USB_BREQ_HOST_FORMAT — little-endian byte-order marker (0x0000beef)
  const hf = new ArrayBuffer(4);
  new DataView(hf).setUint32(0, 0x0000beef, true);
  await dev.controlTransferOut(
    {requestType: 'vendor', recipient: 'interface', request: GS_BREQ.HOST_FORMAT, value: 1, index: iface},
    hf
  );

  // GS_USB_BREQ_BT_CONST — read the CAN clock and bit-timing limits (struct gs_device_bt_const,
  // all u32 LE: feature@0, fclk_can@4, tseg1_min@8, tseg1_max@12, tseg2_min@16, tseg2_max@20,
  // sjw_max@24, brp_min@28, brp_max@32, brp_inc@36).
  try {
    const r = await dev.controlTransferIn(
      {requestType: 'vendor', recipient: 'interface', request: GS_BREQ.BT_CONST, value: 0, index: iface},
      40
    );
    if (r.data && r.data.byteLength >= 40) {
      const d = r.data;
      gsFclk = d.getUint32(4, true);
      gsBtConst = {
        tseg1_min: d.getUint32(8,  true), tseg1_max: d.getUint32(12, true),
        tseg2_min: d.getUint32(16, true), tseg2_max: d.getUint32(20, true),
        sjw_max:   d.getUint32(24, true),
        brp_min:   d.getUint32(28, true), brp_max:   d.getUint32(32, true),
        brp_inc:   d.getUint32(36, true)
      };
    } else if (r.data && r.data.byteLength >= 8) {
      gsFclk = r.data.getUint32(4, true);
    }
  } catch (_) { /* keep defaults */ }

  return {dev, inEp, outEp, name: dev.productName || 'gs_usb device'};
}

// Solve CAN bit timing for the device clock and target bitrate, targeting an 87.5% sample
// point while respecting the device's segment/brp limits (gsBtConst). Returns the chosen
// {prop_seg, phase_seg1, phase_seg2, sjw, brp} plus {ntq, sp, actual} for logging.
function gsCalcBitTiming(fclk, bitrate) {
  const bt = gsBtConst;
  const SP = 0.875;
  let best = null, bestScore = Infinity;
  for (let brp = bt.brp_min; brp <= bt.brp_max; brp += bt.brp_inc) {
    const ntq = Math.round(fclk / (brp * bitrate));   // total time quanta incl. sync
    if (ntq < 1 + bt.tseg1_min + bt.tseg2_min) continue;
    const actual = fclk / (brp * ntq);
    const brErr = Math.abs(actual - bitrate) / bitrate;
    if (brErr > 0.005) continue;                       // strict pass: <0.5% bitrate error
    let tseg1 = Math.round(ntq * SP) - 1;              // prop_seg + phase_seg1
    tseg1 = Math.min(Math.max(tseg1, bt.tseg1_min), bt.tseg1_max);
    const tseg2 = ntq - 1 - tseg1;                     // phase_seg2
    if (tseg2 < bt.tseg2_min || tseg2 > bt.tseg2_max) continue;
    const sp = (1 + tseg1) / ntq;
    const score = brErr * 1000 + Math.abs(sp - SP);
    if (score < bestScore) {
      bestScore = score;
      const phase_seg1 = Math.max(1, Math.floor(tseg1 / 2));
      best = { prop_seg: Math.max(1, tseg1 - phase_seg1), phase_seg1,
               phase_seg2: tseg2, sjw: Math.min(tseg2, bt.sjw_max), brp, ntq, sp, actual };
    }
  }
  if (best) return best;
  // Relaxed pass: no candidate met the 0.5% target — pick the lowest combined-error one.
  for (let brp = bt.brp_min; brp <= bt.brp_max; brp += bt.brp_inc) {
    const ntq = Math.round(fclk / (brp * bitrate));
    if (ntq < 1 + bt.tseg1_min + bt.tseg2_min) continue;
    const actual = fclk / (brp * ntq);
    const brErr = Math.abs(actual - bitrate) / bitrate;
    let tseg1 = Math.min(Math.max(Math.round(ntq * SP) - 1, bt.tseg1_min), bt.tseg1_max);
    let tseg2 = ntq - 1 - tseg1;
    if (tseg2 < bt.tseg2_min) continue;
    if (tseg2 > bt.tseg2_max) { tseg2 = bt.tseg2_max; tseg1 = ntq - 1 - tseg2; }
    if (tseg1 < bt.tseg1_min || tseg1 > bt.tseg1_max) continue;
    const sp = (1 + tseg1) / ntq;
    const score = brErr * 1000 + Math.abs(sp - SP);
    if (score < bestScore) {
      bestScore = score;
      const phase_seg1 = Math.max(1, Math.floor(tseg1 / 2));
      best = { prop_seg: Math.max(1, tseg1 - phase_seg1), phase_seg1,
               phase_seg2: tseg2, sjw: Math.min(tseg2, bt.sjw_max), brp, ntq, sp, actual };
    }
  }
  return best;
}

// GS_USB_BREQ_BITTIMING — must be sent while the device is in RESET (before MODE START).
async function gsSetBitTiming(hz) {
  const t = gsCalcBitTiming(gsFclk, hz);
  if (!t) { log(`gs_usb: no valid bit timing for ${hz/1000}k @ ${gsFclk/1e6}MHz`, 'err'); return; }
  const buf = new ArrayBuffer(20);
  const v = new DataView(buf);
  v.setUint32(0,  t.prop_seg,   true);
  v.setUint32(4,  t.phase_seg1, true);
  v.setUint32(8,  t.phase_seg2, true);
  v.setUint32(12, t.sjw,        true);
  v.setUint32(16, t.brp,        true);
  const r = await usbSerDev.controlTransferOut(
    {requestType: 'vendor', recipient: 'interface', request: GS_BREQ.BITTIMING, value: 0, index: gsIface},
    buf
  );
  if (r && r.status !== 'ok') log(`gs_usb bit timing transfer ${r.status}`, 'err');
  log(`gs_usb bit timing: ${hz/1000}k (brp=${t.brp} tseg1=${t.prop_seg + t.phase_seg1} ` +
      `tseg2=${t.phase_seg2} sp=${(t.sp * 100).toFixed(1)}%)`,
      r && r.status === 'ok' ? 'ok' : 'warn');
}

// GS_USB_BREQ_MODE — START (open bus) or RESET (close bus).
async function gsSetMode(start, listenOnly) {
  const buf = new ArrayBuffer(8);
  const v = new DataView(buf);
  v.setUint32(0, start ? GS_MODE.START : GS_MODE.RESET, true);
  v.setUint32(4, start && listenOnly ? GS_MODE_LISTEN_ONLY : 0, true);
  await usbSerDev.controlTransferOut(
    {requestType: 'vendor', recipient: 'interface', request: GS_BREQ.MODE, value: 0, index: gsIface},
    buf
  );
}

// RX loop: read one gs_host_frame per bulk-IN transfer. The classic frame is variable
// length — a 12-byte header (echo_id, can_id, dlc, channel, flags, reserved) followed by
// exactly `dlc` data bytes (no padding), plus an optional trailing timestamp we don't enable
// and ignore. (A 20-byte read assumption would silently drop every frame with dlc < 8.)
async function gsUsbPump() {
  try {
    while (usbSerDev && connMode === 'gsusb') {
      const r = await usbSerDev.transferIn(usbSerIn, 64);
      if (!r.data || r.data.byteLength < 12) continue;   // need at least the header
      bytesReceived += r.data.byteLength;
      document.getElementById('statBytes').textContent = bytesReceived.toLocaleString();
      const dv = r.data;
      const echo_id = dv.getUint32(0, true);
      if (echo_id !== 0xFFFFFFFF) continue;       // TX echo — bookkeeping done in txSendOne
      const can_id = dv.getUint32(4, true);
      if (can_id & CAN_ERR_FLAG) continue;        // skip error frames
      const dlc   = dv.getUint8(8);
      const isExt = !!(can_id & CAN_EFF_FLAG);
      const isRtr = !!(can_id & CAN_RTR_FLAG);
      const id    = can_id & (isExt ? CAN_EFF_MASK : CAN_SFF_MASK);
      const n = Math.min(dlc, 8, dv.byteLength - 12);
      const data = [];
      for (let i = 0; i < n; i++) data.push(dv.getUint8(12 + i));
      totalFrames++;
      frameRateBuffer.push(Date.now());
      if (!paused) ingestFrame({ id, isExt, isRtr, dlc, data });
    }
  } catch (e) {
    if (usbSerDev) disconnectSerial();
  }
}

// Pack a CAN frame into a 20-byte gs_host_frame (rotating echo_id so our pump ignores the echo).
function gsUsbPackFrame(id, isExt, isRtr, dataBytes) {
  const dlc = Math.min(dataBytes.length, 8);
  const buf = new ArrayBuffer(20);
  const v = new DataView(buf);
  let can_id = (id & (isExt ? CAN_EFF_MASK : CAN_SFF_MASK)) >>> 0;
  if (isExt) can_id = (can_id | CAN_EFF_FLAG) >>> 0;
  if (isRtr) can_id = (can_id | CAN_RTR_FLAG) >>> 0;
  v.setUint32(0, gsEchoId, true);     // echo_id (rotated to avoid reusing a busy echo slot)
  gsEchoId = (gsEchoId + 1) & 0xF;
  v.setUint32(4, can_id, true);       // can_id + flags
  v.setUint8(8, dlc);                 // can_dlc
  // channel(9)/flags(10)/reserved(11) left 0
  for (let i = 0; i < dlc; i++) v.setUint8(12 + i, dataBytes[i] & 0xFF);
  return new Uint8Array(buf);
}
function gsUsbBuildFrame(msg) {
  return gsUsbPackFrame(parseInt(msg.id, 16), msg.ext, msg.rtr, txDataBytes(msg));
}

// Route a decoded serial chunk to the frame parser or the terminal log.
// Shared by readLoop (Web Serial) and usbSerialPump (Android WebUSB).
function dispatchSerialText(text) {
  if (!terminalMode) {
    frameBuffer += text;
    processBuffer();
  } else {
    // In terminal mode: accumulate into termBuffer, flush complete lines on CR
    frameBuffer = '';
    termBuffer += text;
    let idx;
    while ((idx = termBuffer.indexOf('\r')) !== -1) {
      const line = termBuffer.substring(0, idx).trim();
      termBuffer = termBuffer.substring(idx + 1);
      if (line.length > 0) termLog('rx', line);
    }
  }
}

async function usbSerialPump() {
  const decoder = new TextDecoder();
  try {
    while (usbSerDev) {
      const r = await usbSerDev.transferIn(usbSerIn, 512);
      if (r.data && r.data.byteLength > 0) {
        bytesReceived += r.data.byteLength;
        document.getElementById('statBytes').textContent = bytesReceived.toLocaleString();
        dispatchSerialText(decoder.decode(r.data, { stream: true }));
      }
    }
  } catch(e) {
    if (usbSerDev) disconnectSerial();
  }
}

async function connectSerial() {
  const adapter = document.getElementById('adapterType').value; // 'serial' | 'gsusb'
  clearConnectError();
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
      // Query version — give the UART a moment to settle (SLCAN only)
      await new Promise(r => setTimeout(r, 150));
      await sendCommand('V');
      await new Promise(r => setTimeout(r, 100));
      await sendCommand('N');
      await new Promise(r => setTimeout(r, 100));
    }

    // Auto-open the bus if checked
    if (document.getElementById('autoOpen').checked) {
      const listenOnly = document.getElementById('listenOnly').checked;
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
      busIsOpen = true;
    }

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
  } catch (e) {
    if (e.name !== 'NotFoundError') {
      log(`Connection error: ${e.message}`, 'err');
      log('Connection failed — make sure the adapter is not already open in another program or browser tab, then review your settings (Adapter, Baudrate, Advanced).', 'warn');
      showToast('Connection failed — is the adapter already in use by another app or tab? Otherwise check your adapter settings.', 'err');
      showConnectError(`Connection failed: ${e.message}. The adapter may already be open in another program or browser tab — close it and retry. Otherwise check Adapter, Baudrate & Advanced settings.`);
      flashSettingsHint();
    }
    try { if (port) await port.close(); } catch(_) {}
    port = null;
    usbSerDev = null;
    connMode = 'serial';
  }
}

// Transform the Demo button into a page-reload button (used after demo start and
// after a hardware disconnect, so the stale Demo entry point isn't offered).
function makeReloadBtn() {
  const demoBtn = document.getElementById('demoBtn');
  demoBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-3.49"/></svg> Reload`;
  demoBtn.style.borderColor = 'var(--border2)';
  demoBtn.style.color = 'var(--text2)';
  demoBtn.onclick = () => location.reload();
}

// Briefly highlight the header settings area to prompt the user to review it
// (e.g. after a failed connection attempt).
function flashSettingsHint() {
  const el = document.getElementById('advancedMenuBtn');
  const adapter = document.getElementById('adapterType');
  [el, adapter].forEach(n => { if (n) { n.classList.add('settings-flash'); setTimeout(() => n.classList.remove('settings-flash'), 2400); } });
}

async function disconnectSerial() {
  clearConnectError();
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
  log('Disconnected', 'warn');
}

function setStatus(connected) {
  const pill = document.getElementById('statusPill');
  const text = document.getElementById('statusText');
  if (connected) {
    pill.classList.add('connected');
    text.textContent = 'Connected';
  } else {
    pill.classList.remove('connected');
    text.textContent = 'Disconnected';
  }
}

async function readLoop() {
  const decoder = new TextDecoder();
  try {
    reader = port.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // value is a Uint8Array
      bytesReceived += value.byteLength;
      document.getElementById('statBytes').textContent = bytesReceived.toLocaleString();
      const text = decoder.decode(value, { stream: true });
      dispatchSerialText(text);
    }
  } catch (e) {
    if (e.name !== 'NetworkError' && e.name !== 'AbortError') {
      log(`Read error: ${e.message}`, 'err');
    }
  } finally {
    try { if (reader) reader.releaseLock(); } catch(_) {}
    reader = null;
    if (port) disconnectSerial(); // skip if user already disconnected manually
  }
}

function processBuffer() {
  // SLCAN lines end with \r (CR)
  let idx;
  while ((idx = frameBuffer.indexOf('\r')) !== -1) {
    const line = frameBuffer.substring(0, idx);
    frameBuffer = frameBuffer.substring(idx + 1);
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Check for V/N version responses
    if (trimmed.startsWith('V') && trimmed.length >= 5) {
      // Vxxyy — hardware xx, firmware yy
      const hw = trimmed.substring(1, 3);
      const fw = trimmed.substring(3, 5);
      const info = `HW v${hw}  FW v${fw}`;
      document.getElementById('deviceInfo').textContent = info;
      log(`Device version: hardware=${hw} firmware=${fw}`, 'ok');
      continue;
    }
    if (trimmed.startsWith('N') && trimmed.length > 1 && !/^[0-9A-Fa-f]/.test(trimmed[1])) {
      // N + serial number string
      const serial = trimmed.substring(1);
      const cur = document.getElementById('deviceInfo').textContent;
      document.getElementById('deviceInfo').textContent = (cur ? cur + '  ' : '') + `S/N: ${serial}`;
      log(`Device serial: ${serial}`, 'ok');
      continue;
    }
    // Bell (0x07) = error response from adapter
    if (trimmed === '\x07' || trimmed.charCodeAt(0) === 7) {
      log('Adapter returned error (bell/0x07) — check command sequence', 'err');
      continue;
    }

    parseSLCAN(trimmed);
  }
}

// Render a raw SLCAN line with control chars escaped, for diagnostic logging.
function escRawLine(s) {
  return Array.from(s).map(ch => {
    const c = ch.charCodeAt(0);
    return c < 32 ? `\\x${c.toString(16).padStart(2, '0')}` : ch;
  }).join('');
}

// SLCAN format:
// tIIILDD...   standard frame (11-bit ID, 3 hex digits)
// TIIIIIIIILDD... extended frame (29-bit ID, 8 hex digits)
// rIIIL        standard remote frame
// RIIIIIIIIL   extended remote frame
// z/Z          timestamps (optional, some adapters add them)
//
// Raw bytes are surfaced to the log ONLY when a frame line can't be parsed
// (malformed/truncated) or throws — recognised status/timestamp lines stay silent.
function parseSLCAN(line) {
  try {
    const type = line[0];
    let frame = null;

    if (type === 't' || type === 'r') {
      // Standard 11-bit
      if (line.length < 5) { parseErrors++; log(`raw(unparsed): ${escHtml(escRawLine(line))}`, 'warn'); return; }
      const id = parseInt(line.substring(1, 4), 16);
      const dlc = parseInt(line[4], 16);
      const isRtr = type === 'r';
      const dataHex = isRtr ? '' : line.substring(5, 5 + dlc * 2);
      const data = hexToBytes(dataHex);
      frame = { id, dlc, data, isRtr, isExt: false };
    } else if (type === 'T' || type === 'R') {
      // Extended 29-bit
      if (line.length < 10) { parseErrors++; log(`raw(unparsed): ${escHtml(escRawLine(line))}`, 'warn'); return; }
      const id = parseInt(line.substring(1, 9), 16);
      const dlc = parseInt(line[9], 16);
      const isRtr = type === 'R';
      const dataHex = isRtr ? '' : line.substring(10, 10 + dlc * 2);
      const data = hexToBytes(dataHex);
      frame = { id, dlc, data, isRtr, isExt: true };
    } else {
      // status, timestamps, etc — recognised non-frame line, ignore silently
      return;
    }

    if (!frame) return;

    totalFrames++;
    frameRateBuffer.push(Date.now());

    if (!paused) {
      ingestFrame(frame);
    }
  } catch(e) {
    parseErrors++;
    log(`raw(unparsed): ${escHtml(escRawLine(line))} — ${e.message}`, 'err');
  }
}

function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i+2), 16));
  }
  return bytes;
}

function ingestFrame(frame) {
  const key = frameKey(frame);
  const now = Date.now();

  // Always append to dump log (ring buffer — O(1), no GC pressure)
  dumpLog.push({ ts: now, isTx: false, id: frame.id, isExt: frame.isExt, isRtr: frame.isRtr, dlc: frame.dlc, data: frame.data.slice() });
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
    existing.timestamps.push(now);
    if (existing.timestamps.length > 120) existing.timestamps.splice(0, 20);
  } else {
    frames.set(key, {
      id: frame.id, isExt: frame.isExt, isRtr: frame.isRtr,
      dlc: frame.dlc, data: frame.data,
      byteChangedAt: frame.data.map(() => now),
      count: 1, firstSeen: now, lastSeen: now, timestamps: [now],
      hasRx: true, hasTx: false
    });
    changedIds.add(key);
  }
  // Pass every received frame to the ISO-TP engine (no-op unless a request is pending)
  isotpIngestFrame(frame);
  if (window.j1939IngestFrame) j1939IngestFrame(frame); // ← J1939 hook (line A — remove to revert)
  if (window.chademoIngestFrame) chademoIngestFrame(frame); // ← CHAdeMO hook (remove to revert)
  if (window.xcpIngestFrame) xcpIngestFrame(frame); // ← XCP hook (remove to revert)
  if (window.canopenIngestFrame) canopenIngestFrame(frame); // ← CANopen hook (remove to revert)
  if (window.graphIngestFrame) graphIngestFrame(frame); // ← Graph hook (remove to revert)
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

// Single RAF render loop — runs continuously, throttled to RENDER_INTERVAL
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

function rerenderTable() {
  const flt = getFilter();
  const fmt = document.getElementById('byteFormat').value;

  let rows = Array.from(frames.values()).filter(f => applyFilter(f, flt));

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

  const tbody = document.getElementById('frameBody');
  const now2 = Date.now();

  if (frames.size === 0) {
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('frameTable').style.display = 'none';
    document.getElementById('byteLegend').style.display = 'none';
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('frameTable').style.display = 'table';
  document.getElementById('byteLegend').style.display = 'flex';

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
    const rxBadge  = f.hasRx ? ' <span class="td-type rx">RX</span>' : '';
    const txBadge  = f.hasTx ? ' <span class="td-type tx">TX</span>' : '';
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
      ? '<span style="color:var(--text3)">—</span>'
      : fmt === 'hexascii'
        ? f.data.map((b, i) => `<span class="byte${byteClass(i)}">${b.toString(16).toUpperCase().padStart(2,'0')}</span>`).join('') +
          (f.data.length ? `<span class="byte ascii-str" style="margin-left:6px;color:var(--text2);letter-spacing:0.02em">${f.data.map((b, i) => (b >= 32 && b < 127) ? `<span style="${byteClass(i) === ' noisy' ? 'color:var(--amber)' : byteClass(i) === ' hot' ? 'color:var(--green)' : byteClass(i) === ' stable' ? 'color:var(--text3);opacity:0.55' : ''}">${escHtml(String.fromCharCode(b))}</span>` : `<span style="color:var(--text3)">.</span>`).join('')}</span>` : '')
        : f.data.map((b, i) => `<span class="byte${byteClass(i)}">${formatByte(b, fmt)}</span>`).join('');
    const rate = f.timestamps.filter(t => now2 - t < 1000).length;
    const ageMs = now2 - f.lastSeen;
    const ageStr = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs/1000).toFixed(1)}s`;
    const fresh = ageMs < 500;

    let row = existingRows[key];
    if (!row) {
      // Create the row and ALL cells once — never use row.innerHTML again for this row.
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

    // ── cell[0]: pin button — only rebuild when pin state changes ─────────────
    if (row.dataset.pinned !== (isPinned ? '1' : '0')) {
      row.dataset.pinned = isPinned ? '1' : '0';
      const pinSvg = `<svg viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" style="width:12px;height:12px"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>`;
      row.cells[0].innerHTML = `<button class="pin-btn${isPinned ? ' pinned' : ''}" data-pin onclick="togglePin('${key}');event.stopPropagation()" title="${isPinned ? 'Unpin' : 'Pin to top'}">${pinSvg}</button>`;
    }

    // ── cells[1-3, 8]: rarely-changing static content ─────────────────────────
    const noteStr = frameNotes.get(key) || '';
    const fp = f.dlc + '|' + typeClass + '|' + (f.hasRx?'R':'') + (f.hasTx?'T':'') +
               '|' + (isNewId ? 'N' : '') + '|' + noteStr + '|' + colorStr;
    if (row.dataset.fp !== fp) {
      row.dataset.fp = fp;
      row.cells[1].style.color = colorStr || 'var(--blue)';
      row.cells[1].textContent = '0x' + idHex;
      row.cells[2].innerHTML   = `<span class="td-type ${typeClass}">${typeLabel}</span>${rxBadge}${txBadge}`;
      row.cells[3].textContent = f.dlc;
      row.cells[8].textContent = noteStr;
      row.cells[8].title       = noteStr;
    }

    // ── cell[4]: data bytes — always update (byte colors are time-dependent) ──
    row.cells[4].innerHTML = dataHtml;

    // ── cells[5-7]: live counters — always update ─────────────────────────────
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
  // Mirror the active state to aria-selected for screen readers.
  document.querySelectorAll('.view-tabs .view-tab').forEach(t =>
    t.setAttribute('aria-selected', t.classList.contains('active') ? 'true' : 'false'));

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

  if (name === 'dump')  renderDump();
  if (name === 'graph' && window.graphOnShow) window.graphOnShow();
  if (name === 'fuzz'  && window.fuzzOnShow)  window.fuzzOnShow();
  if (name === 'xcp'   && window.xcpOnShow)   window.xcpOnShow();
  if (name === 'canopen' && window.canopenOnShow) window.canopenOnShow();
  if (name === 'term')  document.getElementById('termInput').focus();
  if (name === 'isotp') { document.getElementById('isotpInput').focus(); obdOnShow(); }
  updateNotchBtn();
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
    const asc = entry.data.map(b => (b >= 32 && b < 127) ? escHtml(String.fromCharCode(b)) : '<span style="color:var(--text3)">.</span>').join('');
    return hex + `<span class="byte ascii-str" style="margin-left:6px;color:var(--text2)">${asc}</span>`;
  }
  return entry.data.map((b, i) => `<span class="${cls(b,i)}">${formatByte(b, fmt)}</span>`).join('');
}

let dumpStartTs = null; // relative time base
let dumpAutoScroll = true; // follows new frames unless user scrolls up
let dumpScrollLocked = false; // user explicitly paused auto-scroll
let dumpLastFirst = -1, dumpLastLast = -1, dumpLastSize = -1, dumpLastHead = -1; // dirty-check
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
  const hasFilter = flt.frameType !== 'all' || flt.dataType !== 'all' || flt.ids.length > 0 || (flt.idsExclude && flt.ids.length > 0) || flt.dataRaw || flt.onlyHighlighted || flt.onlyUnseen || flt.onlyRx;

  // Apply filter using ring buffer's O(result) filter method; cache result until dirty
  if (!hasFilter) {
    dumpFilterCache = null;
    dumpFilterDirty = false;
  } else if (dumpFilterDirty) {
    dumpFilterCache = dumpLog.filter(e => applyFilter(e, flt));
    dumpFilterDirty = false;
    // The filtered array grows with a stable prefix (ring buffer only wraps after 100k
    // entries), so existing index→entry mappings stay valid — no full row eviction needed.
    // Genuine ring-wrap invalidation is handled below via dumpLog.head.
  }
  const filtered = dumpFilterCache; // null = use ring buffer directly

  const total = filtered ? filtered.length : dumpLog.size;
  const getEntry = filtered ? (i => filtered[i]) : (i => dumpLog.get(i));

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
  // When ring buffer wraps, head advances — cached rows now map to stale entries
  if (dumpLog.head !== dumpLastHead && dumpLastHead !== -1) dumpRowElsDirty = true;
  dumpLastFirst = firstRow;
  dumpLastLast  = lastRow;
  dumpLastSize  = dumpLog.size;
  dumpLastHead  = dumpLog.head;

  // Relative time base from oldest entry
  if (dumpLog.size > 0 && dumpStartTs === null) dumpStartTs = dumpLog.get(0).ts;

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
    const dirBadge  = e.isTx
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
      <td style="color:${dumpColor || 'var(--blue)'};font-weight:500;font-family:var(--mono)">${idHex}</td>
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
function inspectFrame(f) {
  switchViewTab('inspect');
  lastInspectedFrame = f;

  const isExt = f.isExt;
  const isRtr = f.isRtr;
  const id    = f.id;
  const data  = f.data || [];
  const dlc   = f.dlc;
  const noteKey = frameKey({ isExt, id });

  // Helper: integer → bit array MSB first, padded to `len` bits
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

  // Build the field list for a standard (11-bit) or extended (29-bit) CAN frame
  // Standard: SOF(1) | ID(11) | RTR(1) | IDE(1,=0) | r0(1) | DLC(4) | DATA(0-64) | CRC(15) | CRCDELIM(1) | ACK(1) | ACKDELIM(1) | EOF(7) | IFS(3)
  // Extended: SOF(1) | BASEID(11) | SRR(1) | IDE(1,=1) | EXTID(18) | RTR(1) | r1(1) | r0(1) | DLC(4) | DATA | CRC(15) | ...

  let fields = [];

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

  data.forEach((byte, idx) => {
    fields.push({ label: `D${idx}`, cls: 'data', bits: toBits(byte, 8) });
  });

  // Collect all bits from SOF through data for CRC input
  const crcInputBits = fields.flatMap(f => f.bits);
  const crcVal = computeCrc15(crcInputBits);
  const crcBits = toBits(crcVal, 15);

  fields.push({ label: 'CRC (15)',   cls: 'crc', bits: crcBits });
  fields.push({ label: 'CRC Delim', cls: 'crc', bits: [1] });
  fields.push({ label: 'ACK',       cls: 'eof', bits: [0] });  // dominant = 0 (acknowledged)
  fields.push({ label: 'ACK Delim', cls: 'eof', bits: [1] });
  fields.push({ label: 'EOF',       cls: 'eof', bits: Array(7).fill(1) });
  fields.push({ label: 'IFS',       cls: 'eof', bits: Array(3).fill(1) });

  // Split fields into 3 rows: [SOF..DLC], [Data bytes], [CRC..]
  const dlcIdx   = fields.findIndex(f => f.label === 'DLC');
  const crcIdx   = fields.findIndex(f => f.label === 'CRC (15)');
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
    ['Data (hex)',   dataHexStr || '—'],
    ['Data (ASCII)', dataAscii || '—'],
    ['CRC-15',       `0x${crcVal.toString(16).toUpperCase().padStart(4,'0')} (${crcVal.toString(2).padStart(15,'0')})`],
    ['Total bits', `${fields.reduce((s,f)=>s+f.bits.length,0)} (before stuffing)`],
  ].map(([label, val]) =>
    `<tr><td>${escHtml(label)}</td><td>${escHtml(String(val))}</td></tr>`
  ).join('');

  // ── Bit stuffing ────────────────────────────────────────────────────────────
  // Stuffing applies from SOF through end of CRC (not CRC delim, ACK, EOF, IFS).
  // Rule: after 5 consecutive equal bits, insert the opposite bit.
  // Each bit is tagged with its frame section for color coding.
  const POST_STUFF_LABELS = ['CRC Delim','ACK','ACK Delim','EOF','IFS'];
  const stuffableFields = fields.filter(fld => !POST_STUFF_LABELS.includes(fld.label));

  const sectionOf = label => {
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
  };
  const SECTION_COLORS = {
    sof: '#e2e8f0', id: '#60a5fa', flags: '#f59e0b', dlc: '#f97316',
    data: '#00e87a', crc: '#a78bfa', ack: '#f87171', eof: '#64748b', ifs: '#334155',
  };
  const SECTION_LABELS = [
    ['sof','SOF'],['id','ID'],['flags','Flags'],['dlc','DLC'],['data','Data'],
    ['crc','CRC+Delim'],['ack','ACK+Delim'],['eof','EOF'],['ifs','IFS'],
  ];

  // Build raw stuffable bit array tagged with section
  const rawWithSec = stuffableFields.flatMap(fld =>
    fld.bits.map(b => ({ bit: b, sec: sectionOf(fld.label) }))
  );

  // Apply stuffing — track lastEmittedBit to correctly handle runs after a stuff bit
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
  fields.filter(fld => POST_STUFF_LABELS.includes(fld.label)).forEach(fld => {
    const sec = sectionOf(fld.label);
    fld.bits.forEach(b => stuffed.push({ bit: b, stuffed: false, sec }));
  });

  const stuffCount = stuffed.filter(s => s.stuffed).length;

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
      <div id="inspectIdDisplay" style="font-size:20px;font-weight:600;font-family:var(--mono);color:${currentColor || 'var(--text)'}">${(isExt ? '0x' : '') + idHex}</div>
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

    <div class="inspect-title">Bit Field Layout <span style="font-size:10px;font-weight:400;color:var(--text3);letter-spacing:0;text-transform:none">— without bit stuffing</span></div>
    <div class="bitfield-wrap">
      ${fieldHtml}
    </div>

    <div class="inspect-title">Bitstream with Bit Stuffing
      <span style="font-size:10px;font-weight:400;color:var(--text3);letter-spacing:0;text-transform:none">
        — ${stuffed.length} bits total, ${stuffCount} stuff bit${stuffCount !== 1 ? 's' : ''} inserted
      </span>
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

  // Pause button is disabled when there is no connection, or while in the terminal tab
  const hasConnection = demoMode || (port !== null) || (usbSerDev !== null);
  btn.disabled = !hasConnection || terminalMode;

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
  // gs_usb has no SLCAN text channel — hide the terminal tab entirely.
  if (connMode === 'gsusb') { tab.style.display = 'none'; return; }
  tab.style.display = '';
  const connected = demoMode || !!port || !!usbSerDev;
  tab.disabled = !connected;
  tab.title = connected ? '' : 'Connect or start demo to use the Serial Terminal';
}

async function busPauseClick() {
  if (!busIsOpen) {
    // Open bus
    if (demoMode) {
      busIsOpen = true;
      paused = false;
      DEMO_CONFIG.forEach(({ id, period }) => {
        demoTimers.push(setInterval(() => demoTick(id), period));
      });
      demoTimers.push(setInterval(demoInjectN2k, 100));
      if (txSuspended) toggleTxSuspend();
      updateBusPauseBtn();
    } else {
      await busOpen();
    }
  } else if (!paused) {
    paused = true;
    if (demoMode) {
      demoTimers.forEach(t => clearInterval(t));
      demoTimers = [];
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
      DEMO_CONFIG.forEach(({ id, period }) => {
        demoTimers.push(setInterval(() => demoTick(id), period));
      });
      demoTimers.push(setInterval(demoInjectN2k, 100));
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
  if (window.j1939Clear) j1939Clear(); // ← J1939 hook (line B — remove to revert)
  if (window.chademoClear) chademoClear(); // ← CHAdeMO hook (remove to revert)
  if (window.xcpClear) xcpClear(); // ← XCP hook (remove to revert)
  if (window.canopenClear) canopenClear(); // ← CANopen hook (remove to revert)
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
  document.getElementById('byteLegend').style.display = 'none';
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
    if (!snapshot.has(key)) return; // new frame — appeared after notch started
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
  log(`Notch complete — ${noisyCount} noisy byte(s) across ${notchedBytes.size} ID(s)`, 'ok');
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

  // Snapshot — store byteChangedAt timestamps, current data values, and lastSeen.
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
// Demo mode is permanent for the session — reload the page to exit.
// sendCommand() is a no-op in demo mode except when the Serial Terminal tab is active.
let demoMode = false;
let demoTimers = [];
let demoCounters = {};

const DEMO_CONFIG = [
  { id: 0x024, period: 10  },
  { id: 0x039, period: 10  },
  { id: 0x062, period: 10  },
  { id: 0x077, period: 100 },
  { id: 0x098, period: 100 },
  { id: 0x150, period: 100 },
  { id: 0x1A7, period: 100 },
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
  const payload = [0x00, 0x00]; // 2-byte payload = 0
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

// Demo: inject NMEA 2000 frames (j1939.js returns [] unless NMEA mode is active).
function demoInjectN2k() {
  if (!window.j1939DemoFrames) return;
  for (const fr of window.j1939DemoFrames()) {
    ingestFrame(fr);
    totalFrames++;
    frameRateBuffer.push(Date.now());
  }
}

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

// A second demo ECU (transmission) that answers only a subset — used to demonstrate
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
    // Stored / pending / permanent DTCs (pairs, no count byte — matches obdDecode)
    return [mode + 0x40, 0x01, 0x33, 0x04, 0x20]; // P0133, P0420
  }
  if (mode === 0x04) return [0x44];                                    // DTCs cleared
  if (mode === 0x09 && req[1] === 0x02) {
    // VIN — 0x49 0x02 <count=01> + 17 ASCII chars (multi-frame ISO-TP)
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
    const eng  = cfg.isExt ? 0x18DAF110 : 0x7E8; // engine
    const tcm  = cfg.isExt ? 0x18DAF11A : 0x7E9; // transmission
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
      : [0x7F, mode, 0x11]; // NRC serviceNotSupported (UDS — unchanged behaviour)
  if (!respPayload) return; // unsupported OBD ask → no reply (timeout)
  demoInjectIsoTp(respPayload, cfg.rxId, cfg);
}

// Demo KWP2000 responder — positive response (SID+0x40) for known SIDs, else
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

// Inject a full ISO-TP response (SF, or FF + CFs) as RX frames from one responder.
// One base latency for the whole sequence so frames keep their order (each CF must
// arrive after its FF) — a per-frame random delay could reorder them.
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
  DEMO_CONFIG.forEach(({ id, period }) => {
    demoTimers.push(setInterval(() => demoTick(id), period));
  });
  demoTimers.push(setInterval(demoInjectN2k, 100));

  document.getElementById('connectBtn').style.display = 'none';
  document.getElementById('disconnectBtn').style.display = 'none';
  makeReloadBtn(); // transform Demo button into a page-reload button
  document.getElementById('listenOnly').disabled = true;
  document.getElementById('baudRate').disabled = true;
  document.getElementById('autoOpen').disabled = true;
  document.getElementById('notchBtn').disabled = false;
  document.getElementById('termInput').disabled = false;
  document.getElementById('termInput').style.opacity = '1';

  // Show a demo pill in the header
  document.getElementById('statusPill').classList.add('connected');
  document.getElementById('statusText').textContent = 'Demo';
  updateBusPauseBtn();
  updateNotchBtn();
  startRenderLoop();
  log('Demo mode started — reload the page to exit demo mode.', 'ok');
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
let isotpRxState    = null;  // {totalLen, data[], seqExpected} — ongoing multi-frame rx
let isotpPendingEl  = null;  // DOM wrap element awaiting a response
let isotpTimer      = null;  // N_Bs / N_Cr timeout handle
let isotpTxQueue    = [];    // CF frames queued to send after FC
let isotpCfBlkCnt   = 0;     // frames sent since last FC
let isotpEntrySeq   = 0;     // monotonic counter for unique decode-panel IDs
// Functional-addressing (0x7DF / 0x18DB33F1) multi-responder state. Active only for
// manual sends to a functional Tx ID; the single-responder path above is untouched.
let isotpFuncMode   = false; // true while aggregating responses from multiple ECUs
let isotpRxMap      = new Map(); // responderId -> {totalLen, data[], seqExpected, cfRxCount}
let isotpFuncCount  = 0;     // responders seen in the current functional window

const ISOTP_TIMEOUT = 1000;  // ms — simplified fixed timeout for all N_x timers

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
  return { txId, rxId, isExt, addrMode, addrByte, blockSize, stmin, padding };
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
  dumpLog.push({ ts: Date.now(), isTx: true, id: txId, isExt: cfg.isExt,
                 isRtr: false, dlc: data.length, data: [...data] });
  dumpFilterDirty = true;
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

// Send queued CF frames, respecting block size and STmin.
async function isotpFlushCFs(cfg) {
  while (isotpTxQueue.length > 0) {
    await isotpTxCan(isotpTxQueue.shift(), cfg);
    isotpCfBlkCnt++;
    if (cfg.blockSize > 0 && isotpCfBlkCnt >= cfg.blockSize) {
      isotpCfBlkCnt = 0;
      isotpArmTimer(); // wait for next FC before continuing
      return;
    }
    if (cfg.stmin > 0) await new Promise(r => setTimeout(r, isotpDecodeStmin(cfg.stmin.toString(16)).ms));
  }
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
}

// ── RX state machine ─────────────────────────────────────────────────────────
// Called from ingestFrame() for every received CAN frame. Fast early-exit when
// there is no pending request, so there is no performance impact on normal use.
function isotpIngestFrame(frame) {
  if (!isotpPendingEl && !isotpRxState && isotpTxQueue.length === 0 && isotpRxMap.size === 0) return;
  const cfg = isotpCfg();
  if (isotpFuncMode) { isotpIngestFunctional(frame, cfg); return; }
  if (isNaN(cfg.rxId) || frame.id !== cfg.rxId || frame.isExt !== cfg.isExt) return;

  const d   = frame.data;
  const off = cfg.addrMode === 'extended' ? 1 : 0;
  if (d.length <= off) return;

  const pciHi = (d[off] >> 4) & 0x0F;

  if (pciHi === 0) {
    // ── Single Frame response ─────────────────────────────────────────────
    const len     = d[off] & 0x0F;
    const payload = d.slice(off + 1, off + 1 + len);
    // NRC 0x78 — ResponsePending: annotate entry, reset timer, keep waiting
    if (payload.length >= 3 && payload[0] === 0x7F && payload[2] === 0x78) {
      if (isotpPendingEl) isotpAddPendingNote(isotpPendingEl, payload);
      isotpArmTimer();
      return;
    }
    const el = isotpPendingEl;
    isotpCancelAll(); isotpPendingEl = null;
    if (el) isotpMarkDone(el, payload);

  } else if (pciHi === 1) {
    // ── First Frame response ──────────────────────────────────────────────
    const totalLen = ((d[off] & 0x0F) << 8) | d[off + 1];
    // cfRxCount tracks how many CFs have arrived in the current block so we
    // know when to send the next FC (when blockSize > 0).
    isotpRxState = { totalLen, data: [...d.slice(off + 2)], seqExpected: 1, cfRxCount: 0 };
    isotpSendFC(cfg); // send initial Flow Control (CTS) — async, fire-and-forget
    isotpArmTimer();

  } else if (pciHi === 2) {
    // ── Consecutive Frame response ────────────────────────────────────────
    if (!isotpRxState) return;
    const seq = d[off] & 0x0F;
    if (seq !== isotpRxState.seqExpected) {
      const el = isotpPendingEl;
      isotpCancelAll(); isotpPendingEl = null;
      if (el) isotpMarkError(el, 'CF sequence error');
      return;
    }
    isotpRxState.seqExpected = (isotpRxState.seqExpected + 1) & 0x0F;
    isotpRxState.data.push(...d.slice(off + 1));
    isotpRxState.cfRxCount++;

    if (isotpRxState.data.length >= isotpRxState.totalLen) {
      // Reassembly complete
      const payload = isotpRxState.data.slice(0, isotpRxState.totalLen);
      const el      = isotpPendingEl;
      isotpCancelAll(); isotpPendingEl = null;
      if (el) isotpMarkDone(el, payload);
    } else if (cfg.blockSize > 0 && isotpRxState.cfRxCount >= cfg.blockSize) {
      // Block exhausted — send the next FC so ECU continues sending CFs
      isotpRxState.cfRxCount = 0;
      isotpSendFC(cfg);    // async, fire-and-forget
      isotpArmTimer();     // restart N_Cr timeout waiting for next CF
    } else {
      isotpArmTimer(); // reset N_Cr timeout
    }

  } else if (pciHi === 3) {
    // ── Flow Control (ECU → tester, for our multi-frame request) ──────────
    const fs = d[off] & 0x0F;
    if (fs === 0 && isotpTxQueue.length > 0) { // CTS
      if (isotpTimer) { clearTimeout(isotpTimer); isotpTimer = null; }
      isotpFlushCFs(cfg);
    }
    // fs=1 (Wait) and fs=2 (Overflow) left for future handling
  }
}

// ── Functional-addressing RX (multiple ECUs, keyed per responder) ─────────────
// Active only while isotpFuncMode is true (a manual send to 0x7DF / 0x18DB33F1).
// Each responder gets its own reassembly state; the window stays open (rearming the
// timer) until ISOTP_TIMEOUT of silence, then isotpFuncFinalize() closes the entry.
function isotpIngestFunctional(frame, cfg) {
  if (!isotpIsResponder(frame.id, frame.isExt, cfg)) return;
  const d   = frame.data;
  const off = cfg.addrMode === 'extended' ? 1 : 0;
  if (d.length <= off) return;
  const rid   = frame.id;
  const pciHi = (d[off] >> 4) & 0x0F;

  if (pciHi === 0) {
    // ── Single Frame from this ECU ────────────────────────────────────────────
    const len     = d[off] & 0x0F;
    const payload = d.slice(off + 1, off + 1 + len);
    if (payload.length >= 3 && payload[0] === 0x7F && payload[2] === 0x78) {
      if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, payload, { pending: true });
      isotpArmTimer();
      return;
    }
    if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, payload);
    isotpFuncCount++;
    isotpArmTimer();

  } else if (pciHi === 1) {
    // ── First Frame from this ECU — start its own reassembly, FC to its physical ID
    const totalLen = ((d[off] & 0x0F) << 8) | d[off + 1];
    isotpRxMap.set(rid, { totalLen, data: [...d.slice(off + 2)], seqExpected: 1, cfRxCount: 0 });
    isotpSendFCTo(cfg, isotpPhysicalIdFor(rid, cfg.isExt)); // async, fire-and-forget
    isotpArmTimer();

  } else if (pciHi === 2) {
    // ── Consecutive Frame from this ECU ───────────────────────────────────────
    const st = isotpRxMap.get(rid);
    if (!st) return;
    const seq = d[off] & 0x0F;
    if (seq !== st.seqExpected) {
      isotpRxMap.delete(rid);
      if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, null, { error: 'CF sequence error' });
      isotpArmTimer();
      return;
    }
    st.seqExpected = (st.seqExpected + 1) & 0x0F;
    st.data.push(...d.slice(off + 1));
    st.cfRxCount++;
    if (st.data.length >= st.totalLen) {
      const payload = st.data.slice(0, st.totalLen);
      isotpRxMap.delete(rid);
      if (isotpPendingEl) isotpFuncAppendResponse(isotpPendingEl, rid, payload);
      isotpFuncCount++;
      isotpArmTimer();
    } else if (cfg.blockSize > 0 && st.cfRxCount >= cfg.blockSize) {
      st.cfRxCount = 0;
      isotpSendFCTo(cfg, isotpPhysicalIdFor(rid, cfg.isExt));
      isotpArmTimer();
    } else {
      isotpArmTimer();
    }
  }
  // pciHi === 3 (FC) is not expected — functional requests are Single Frame only.
}

// Close the functional collection window: mark any incomplete responders, replace the
// "listening…" line with a summary (or fall back to the normal timeout if nobody answered).
function isotpFuncFinalize() {
  const el = isotpPendingEl;
  for (const rid of isotpRxMap.keys()) {
    if (el) isotpFuncAppendResponse(el, rid, null, { error: 'incomplete — timeout' });
  }
  const seen = isotpFuncCount;
  isotpRxMap.clear();
  isotpFuncMode = false;
  isotpPendingEl = null;
  if (!el) return;
  const wt = el.querySelector('.isotp-rx-waiting');
  if (seen === 0) {
    if (wt) { wt.style.fontStyle = 'normal'; wt.innerHTML = `<span style="min-width:22px;flex-shrink:0"></span><span style="color:var(--red)">no response — timeout (${ISOTP_TIMEOUT} ms)</span>`; }
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

// ── OBD-II / ISO 15031 / SAE J1979 Parser ────────────────────────────────────
const OBD_MODE = {
  0x01:'Show Current Data', 0x02:'Show Freeze Frame Data',
  0x03:'Show Stored DTCs', 0x04:'Clear DTCs & Reset MIL',
  0x05:'O2 Sensor Test Results', 0x06:'On-Board System Test Results',
  0x07:'Show Pending DTCs', 0x08:'Control On-Board System',
  0x09:'Request Vehicle Info', 0x0A:'Permanent DTCs',
};
const OBD_PID01 = {
  0x00:'Supported PIDs [01–20]', 0x01:'Monitor status since DTCs cleared',
  0x03:'Fuel system status', 0x04:'Calculated engine load (%)',
  0x05:'Engine coolant temp (°C)', 0x06:'Short term fuel trim B1 (%)',
  0x07:'Long term fuel trim B1 (%)', 0x08:'Short term fuel trim B2 (%)',
  0x09:'Long term fuel trim B2 (%)', 0x0A:'Fuel pressure (kPa)',
  0x0B:'Intake manifold pressure (kPa)', 0x0C:'Engine RPM (rpm)',
  0x0D:'Vehicle speed (km/h)', 0x0E:'Timing advance (° before TDC)',
  0x0F:'Intake air temperature (°C)', 0x10:'Mass air flow rate (g/s)',
  0x11:'Throttle position (%)', 0x12:'Commanded secondary air status',
  0x13:'O2 sensors present (B1–B2)', 0x1C:'OBD standards compliance',
  0x1F:'Run time since engine start (s)', 0x20:'Supported PIDs [21–40]',
  0x21:'Distance traveled with MIL on (km)', 0x22:'Fuel rail pressure (kPa rel.)',
  0x23:'Fuel rail pressure (kPa gauge)', 0x2C:'Commanded EGR (%)',
  0x2D:'EGR error (%)', 0x2E:'Commanded evaporative purge (%)',
  0x2F:'Fuel tank level (%)', 0x30:'Warm-ups since codes cleared',
  0x31:'Distance since codes cleared (km)', 0x33:'Absolute barometric pressure (kPa)',
  0x3C:'Catalyst temperature B1S1 (°C)', 0x40:'Supported PIDs [41–60]',
  0x41:'Monitor status this drive cycle', 0x42:'Control module voltage (V)',
  0x43:'Absolute load value (%)', 0x44:'Commanded air-fuel equivalence ratio',
  0x45:'Relative throttle position (%)', 0x46:'Ambient air temperature (°C)',
  0x47:'Absolute throttle pos B (%)', 0x4D:'Time run with MIL on (min)',
  0x4E:'Time since DTC cleared (min)', 0x51:'Fuel type',
  0x52:'Ethanol fuel content (%)', 0x60:'Supported PIDs [61–80]',
  0x67:'Engine coolant temp (multi-sensor)', 0x68:'Intake air temp (multi-sensor)',
};
const OBD_PID09 = {
  0x00:'Supported PIDs', 0x02:'Vehicle Identification Number (VIN)',
  0x04:'Calibration ID', 0x06:'Calibration Verification Number (CVN)',
  0x0A:'ECU name', 0x0B:'ECU name (in-use perf. tracking)',
};

// Decode one Mode-01 (current data) / Mode-02 (freeze frame) PID value.
// `d` is the data bytes *after* the PID (and after the frame-# byte for Mode 02).
// Returns {k,v} or null (caller renders raw hex when null).
function obdM01Value(pid, d) {
  switch (pid) {
    case 0x04: return {k:'Engine load',     v:`${Math.round(d[0]*100/255)} %`};
    case 0x05: return {k:'Coolant temp',    v:`${d[0]-40} °C`};
    case 0x06: case 0x07: case 0x08: case 0x09:
               return {k:'Fuel trim',       v:`${((d[0]-128)*100/128).toFixed(1)} %`};
    case 0x0B: return {k:'MAP pressure',    v:`${d[0]} kPa`};
    case 0x0C: return d.length>=2 ? {k:'RPM', v:`${((d[0]<<8)|d[1])/4} rpm`} : null;
    case 0x0D: return {k:'Speed',           v:`${d[0]} km/h`};
    case 0x0E: return {k:'Timing advance',  v:`${d[0]/2-64} ° before TDC`};
    case 0x0F: return {k:'Intake air temp', v:`${d[0]-40} °C`};
    case 0x10: return d.length>=2 ? {k:'MAF', v:`${((d[0]<<8)|d[1])/100} g/s`} : null;
    case 0x11: return {k:'Throttle',        v:`${Math.round(d[0]*100/255)} %`};
    case 0x14: case 0x15: case 0x16: case 0x17:
    case 0x18: case 0x19: case 0x1A: case 0x1B:
               return d.length>=2 ? {k:'O2 sensor', v:`${(d[0]/200).toFixed(3)} V · trim ${((d[1]-128)*100/128).toFixed(1)} %`}
                                  : {k:'O2 sensor', v:`${(d[0]/200).toFixed(3)} V`};
    case 0x2F: return {k:'Fuel level',      v:`${Math.round(d[0]*100/255)} %`};
    case 0x33: return {k:'Baro pressure',   v:`${d[0]} kPa`};
    case 0x42: return d.length>=2 ? {k:'Voltage', v:`${((d[0]<<8)|d[1])/1000} V`} : null;
    case 0x46: return {k:'Ambient temp',    v:`${d[0]-40} °C`};
    case 0x49: case 0x4A: case 0x4B: case 0x4C:
               return {k:'Pedal/throttle',  v:`${Math.round(d[0]*100/255)} %`};
    case 0x52: return {k:'Ethanol content', v:`${Math.round(d[0]*100/255)} %`};
    case 0x5C: return {k:'Oil temp',        v:`${d[0]-40} °C`};
    case 0x5E: return d.length>=2 ? {k:'Fuel rate', v:`${(((d[0]<<8)|d[1])/20).toFixed(1)} L/h`} : null;
    default:   return null;
  }
}

function obdDecode(bytes) {
  if (!bytes || !bytes.length) return null;
  const mode = bytes[0];
  const isResp  = mode >= 0x41 && mode <= 0x4A;
  const rawMode = isResp ? mode - 0x40 : mode;
  if (rawMode < 0x01 || rawMode > 0x0A) return null;
  const modeName = OBD_MODE[rawMode] || `Mode ${udsH(rawMode)}`;
  const rows = [
    {k:'Protocol', v:'OBD-II (ISO 15031 / SAE J1979)'},
    {k:'Mode',     v:`${udsH(rawMode)}  ${modeName}`},
  ];
  const add = (k,v) => rows.push({k,v});
  let summary = `OBD-II Mode ${udsH(rawMode)} · ${modeName}`;

  if (rawMode === 0x03 || rawMode === 0x07 || rawMode === 0x0A) {
    // No PID — just DTC request/list
    if (isResp && bytes.length > 1) {
      const dtcs = [];
      for (let i = 1; i + 1 < bytes.length; i += 2) {
        const w = (bytes[i] << 8) | bytes[i+1];
        if (w === 0) continue;
        const prefix = ['P','C','B','U'][(w >> 14) & 3];
        dtcs.push(prefix + ((w >> 12) & 3).toString() + ((w >> 8) & 0xF).toString(16).toUpperCase()
                  + ((w >> 4) & 0xF).toString(16).toUpperCase() + (w & 0xF).toString(16).toUpperCase());
      }
      if (dtcs.length) rows.push({ k:'DTCs', v:dtcs.join('  '), vHtml:dtcs.map(c => dtcLink(c, `q=${c}&fmt=obdcode`)).join('  ') });
      else add('DTCs', 'none');
      summary = `OBD-II Response · ${modeName}${dtcs.length ? ' · ' + dtcs.join(' ') : ' · none'}`;
    }
  } else if (rawMode === 0x04) {
    summary = isResp ? 'OBD-II Response · DTCs cleared' : 'OBD-II Clear DTCs & Reset MIL';
  } else if (rawMode === 0x06) {
    // On-board monitoring test results — standardized record:
    // MID, TID, UASID, value(2), min(2), max(2)
    if (bytes.length > 1) {
      const mid = bytes[1];
      add('MID', udsH(mid));
      summary = `OBD-II Mode 06${isResp ? ' Response' : ''} · MID ${udsH(mid)}`;
      if (isResp && bytes.length >= 10) {
        const tid = bytes[2], uas = bytes[3];
        const val = (bytes[4]<<8)|bytes[5], mn = (bytes[6]<<8)|bytes[7], mx = (bytes[8]<<8)|bytes[9];
        add('TID', udsH(tid));
        add('Value', `${val}  (min ${mn} / max ${mx}, UAS ${udsH(uas)})`);
        add('Result', (val >= mn && val <= mx) ? 'PASS' : 'FAIL');
      } else if (isResp && bytes.length > 2) {
        add('Data', udsBytesHex(bytes.slice(2)));
      }
    }
  } else if (bytes.length > 1) {
    const pid = bytes[1];
    const pidMap = (rawMode === 0x01 || rawMode === 0x02) ? OBD_PID01 : rawMode === 0x09 ? OBD_PID09 : {};
    const pidName = pidMap[pid] || null;
    add('PID', `${udsH(pid)}  ${pidName || '(unknown)'}`);
    summary = `OBD-II Mode ${udsH(rawMode)} PID ${udsH(pid)}${pidName ? ' · ' + pidName : ''}`;
    if (isResp && bytes.length > 2) {
      // Mode 02 (freeze frame) carries a frame-number byte before the data
      let d, frameNo = null;
      if (rawMode === 0x02) { frameNo = bytes[2]; d = bytes.slice(3); add('Frame #', udsH(frameNo)); }
      else d = bytes.slice(2);
      if (rawMode === 0x01 || rawMode === 0x02) {
        const r = obdM01Value(pid, d);
        if (r) add(r.k, r.v); else add('Data', udsBytesHex(d));
      } else if (rawMode === 0x09 && pid === 0x02) {
        // VIN is ASCII — filter to printable, dropping any leading count byte
        try { add('VIN', d.filter(b=>b>=0x20&&b<0x7F).map(b=>String.fromCharCode(b)).join('').trim()); }
        catch(e) { add('Data', udsBytesHex(d)); }
      } else {
        add('Data', udsBytesHex(d));
      }
      summary = `OBD-II Response · Mode ${udsH(rawMode)} PID ${udsH(pid)}${pidName ? ' · ' + pidName : ''}`;
    }
  }
  return { type: isResp ? 'positive' : 'request', summary, rows };
}

// ── UDS / ISO 14229-1 Parser ─────────────────────────────────────────────────
const UDS_SVC = {
  0x10:'DiagnosticSessionControl', 0x11:'ECUReset',
  0x14:'ClearDiagnosticInformation', 0x19:'ReadDTCInformation',
  0x22:'ReadDataByIdentifier', 0x23:'ReadMemoryByAddress',
  0x24:'ReadScalingDataByIdentifier', 0x27:'SecurityAccess',
  0x28:'CommunicationControl', 0x29:'Authentication',
  0x2A:'ReadDataByPeriodicIdentifier', 0x2C:'DynamicallyDefineDataIdentifier',
  0x2E:'WriteDataByIdentifier', 0x2F:'InputOutputControlByIdentifier',
  0x31:'RoutineControl', 0x34:'RequestDownload', 0x35:'RequestUpload',
  0x36:'TransferData', 0x37:'RequestTransferExit', 0x38:'RequestFileTransfer',
  0x3D:'WriteMemoryByAddress', 0x3E:'TesterPresent',
  0x83:'AccessTimingParameter', 0x84:'SecuredDataTransmission',
  0x85:'ControlDTCSetting', 0x86:'ResponseOnEvent', 0x87:'LinkControl',
};
const UDS_NRC = {
  0x10:'generalReject', 0x11:'serviceNotSupported',
  0x12:'subFunctionNotSupported', 0x13:'incorrectMessageLengthOrInvalidFormat',
  0x14:'responseTooLong', 0x21:'busyRepeatRequest', 0x22:'conditionsNotCorrect',
  0x24:'requestSequenceError', 0x25:'noResponseFromSubnetComponent',
  0x26:'failurePreventsExecutionOfRequestedAction', 0x31:'requestOutOfRange',
  0x33:'securityAccessDenied', 0x34:'authenticationRequired',
  0x35:'invalidKey', 0x36:'exceededNumberOfAttempts',
  0x37:'requiredTimeDelayNotExpired', 0x70:'uploadDownloadNotAccepted',
  0x71:'transferDataSuspended', 0x72:'generalProgrammingFailure',
  0x73:'wrongBlockSequenceCounter',
  0x78:'requestCorrectlyReceivedResponsePending',
  0x7E:'subFunctionNotSupportedInActiveSession',
  0x7F:'serviceNotSupportedInActiveSession',
};
const UDS_SESSION = {0x01:'defaultSession',0x02:'programmingSession',0x03:'extendedDiagnosticSession',0x04:'safetySystemDiagnosticSession'};
const UDS_RESET   = {0x01:'hardReset',0x02:'keyOffOnReset',0x03:'softReset'};
const UDS_DTC_SF  = {
  0x01:'reportNumberOfDTCByStatusMask', 0x02:'reportDTCByStatusMask',
  0x03:'reportDTCSnapshotIdentification', 0x04:'reportDTCSnapshotRecordByDTCNumber',
  0x05:'reportDTCStoredDataByRecordNumber', 0x06:'reportDTCExtDataRecordByDTCNumber',
  0x07:'reportNumberOfDTCBySeverityMaskRecord', 0x08:'reportDTCBySeverityMaskRecord',
  0x09:'reportSeverityInformationOfDTC', 0x0A:'reportSupportedDTC',
  0x0B:'reportFirstTestFailedDTC', 0x0C:'reportFirstConfirmedDTC',
  0x0D:'reportMostRecentTestFailedDTC', 0x0E:'reportMostRecentConfirmedDTC',
  0x0F:'reportMirrorMemoryDTCByStatusMask', 0x14:'reportDTCFaultDetectionCounter',
  0x15:'reportDTCWithPermanentStatus',
};
const UDS_COMM_SF = {0x00:'enableRxAndTx',0x01:'enableRxAndDisableTx',0x02:'disableRxAndEnableTx',0x03:'disableRxAndTx'};
const UDS_IO_CTRL = {0x00:'returnControlToECU',0x01:'resetToDefault',0x02:'freezeCurrentState',0x03:'shortTermAdjustment'};
const UDS_RTN_SF  = {0x01:'startRoutine',0x02:'stopRoutine',0x03:'requestRoutineResults'};
const UDS_DTC_ON  = {0x01:'on',0x02:'off'};
const UDS_LNK_SF  = {0x01:'verifyBaudrateTransitionWithFixedBaudrate',0x02:'verifyBaudrateTransitionWithSpecificBaudrate',0x03:'transitionBaudrate'};
const UDS_PRD_SF  = {0x01:'sendAtSlowRate',0x02:'sendAtMediumRate',0x03:'sendAtFastRate',0x04:'stopSending'};
const UDS_DDDI_SF = {0x01:'defineByIdentifier',0x02:'defineByMemoryAddress',0x03:'clearDynamicallyDefinedDataIdentifier'};

function udsH(v,w=2){ return '0x'+v.toString(16).toUpperCase().padStart(w,'0'); }
function udsBytesHex(b){ return b.map(v=>v.toString(16).toUpperCase().padStart(2,'0')).join(' '); }
function udsDTC(a,b,c){ const p=['P','C','B','U'][(a>>6)&3]; return p+[((a>>4)&3),(a&0xF),(b>>4),(b&0xF),(c>>4),(c&0xF)].map(n=>n.toString(16).toUpperCase()).join('')+'  ('+udsBytesHex([a,b,c])+')'; }
function udsDTCStatus(s){ return ['testFailed','testFailedThisMonitoringCycle','pendingDTC','confirmedDTC','testNotCompletedSinceLastClear','testFailedSinceLastClear','testNotCompletedThisMonitoringCycle','warningIndicatorRequested'].filter((_,i)=>s&(1<<i)).join(', ')||'none'; }
// Deep-link a decoded DTC to the standalone dtc.html decoder. (Revert: remove these + the .vHtml rows that use them.)
function dtcLink(label,qs){ return `<a href="dtc.html?${qs}" target="_blank" style="color:var(--blue);text-decoration:none">${escHtml(label)} ↗</a>`; }
function dtcHexQ(arr){ return arr.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join('+'); }
function udsMemAddr(bytes,o){ const alfi=bytes[o],sa=(alfi>>4)&0xF,aa=alfi&0xF; let addr=0,size=0; for(let i=0;i<aa;i++)addr=(addr<<8)|(bytes[o+1+i]||0); for(let i=0;i<sa;i++)size=(size<<8)|(bytes[o+1+aa+i]||0); return {addr,size,consumed:1+aa+sa,adBytes:aa}; }

function udsDecode(bytes){
  if(!bytes||!bytes.length)return null;
  // OBD-II modes 0x01–0x0A (req) and 0x41–0x4A (resp) — check before UDS
  const m=bytes[0];
  if((m>=0x01&&m<=0x0A)||(m>=0x41&&m<=0x4A)){const o=obdDecode(bytes);if(o)return o;}
  if(m===0x7F)return udsDecodeNeg(bytes);
  const sid=m-0x40;
  if((m&0x40)&&UDS_SVC[sid])return udsDecodeRsp(bytes,sid);
  return udsDecodeReq(bytes,m);
}

function udsDecodeNeg(bytes){
  const sid=bytes[1]||0,nrc=bytes[2]||0;
  const sNm=UDS_SVC[sid]||udsH(sid),nNm=UDS_NRC[nrc]||udsH(nrc);
  const isPd=nrc===0x78;
  return { type:isPd?'pending':'negative',
    summary:isPd?`ResponsePending · ${sNm}`:`NegativeResponse · ${sNm} · ${nNm}`,
    rows:[{k:'Type',v:isPd?'Response Pending (NRC 0x78)':'Negative Response'},{k:'Service',v:`${udsH(sid)}  ${sNm}`},{k:'NRC',v:`${udsH(nrc)}  ${nNm}`}] };
}

function udsDecodeReq(bytes,sid){
  const sNm=UDS_SVC[sid]||`Unknown ${udsH(sid)}`;
  const rows=[{k:'Service',v:`${udsH(sid)}  ${sNm}`}];
  const add=(k,v)=>rows.push({k,v});
  let summary=sNm;
  const sf=bytes.length>1?bytes[1]:null,sfV=sf!==null?sf&0x7F:null,sfSPR=sf!==null&&!!(sf&0x80);
  switch(sid){
    case 0x10:{const n=UDS_SESSION[sfV]||udsH(sfV);add('Session',`${udsH(sfV)}  ${n}`);if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x11:{const n=UDS_RESET[sfV]||udsH(sfV);add('Reset type',`${udsH(sfV)}  ${n}`);if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x14:{if(bytes.length>=4){const g=(bytes[1]<<16)|(bytes[2]<<8)|bytes[3];add('Group of DTC',g===0xFFFFFF?'0xFFFFFF (all)':udsH(g,6));summary=`${sNm} · ${g===0xFFFFFF?'all':udsH(g,6)}`;}break;}
    case 0x19:{const n=UDS_DTC_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;
      if([0x01,0x02,0x07,0x08,0x0F,0x11,0x12,0x13,0x17].includes(sfV)&&bytes.length>2)add('Status mask',udsH(bytes[2]));
      if([0x04,0x06,0x09,0x10].includes(sfV)&&bytes.length>4){add('DTC',udsDTC(bytes[2],bytes[3],bytes[4]));if(bytes.length>5)add('Record number',udsH(bytes[5]));}
      break;}
    case 0x22:{const dids=[];for(let i=1;i+1<bytes.length;i+=2){const d=(bytes[i]<<8)|bytes[i+1];dids.push(udsH(d,4));add('DID',udsH(d,4));}summary=`${sNm} · ${dids.join(', ')}`;break;}
    case 0x23:{if(bytes.length>=2){const m=udsMemAddr(bytes,1);add('Address',udsH(m.addr,m.adBytes*2));add('Size',`${m.size} bytes`);summary=`${sNm} · addr ${udsH(m.addr,m.adBytes*2)} · ${m.size} B`;}break;}
    case 0x24:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));summary=`${sNm} · ${udsH(d,4)}`;}break;}
    case 0x27:{const lvl=sfV,isR=!!(lvl&1);add('Level',`${udsH(lvl)}  (${isR?'requestSeed':'sendKey'})`);if(!isR&&bytes.length>2)add('Key',udsBytesHex(bytes.slice(2)));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · level ${udsH(lvl)} ${isR?'(request seed)':'(send key)'}`;break;}
    case 0x28:{const n=UDS_COMM_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>2)add('Communication type',udsH(bytes[2]));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x2A:{const n=UDS_PRD_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>2)add('Periodic DIDs',bytes.slice(2).map(b=>udsH(b)).join(', '));summary=`${sNm} · ${n}`;break;}
    case 0x2C:{const n=UDS_DDDI_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>=4)add('Target DID',udsH((bytes[2]<<8)|bytes[3],4));summary=`${sNm} · ${n}`;break;}
    case 0x2E:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));if(bytes.length>3)add('Data',udsBytesHex(bytes.slice(3)));summary=`${sNm} · ${udsH(d,4)} · ${bytes.length-3} byte(s)`;}break;}
    case 0x2F:{if(bytes.length>=4){const d=(bytes[1]<<8)|bytes[2],cn=UDS_IO_CTRL[bytes[3]]||udsH(bytes[3]);add('DID',udsH(d,4));add('Control option',`${udsH(bytes[3])}  ${cn}`);if(bytes.length>4)add('Enable mask',udsBytesHex(bytes.slice(4)));summary=`${sNm} · ${udsH(d,4)} · ${cn}`;}break;}
    case 0x31:{if(bytes.length>=4){const n=UDS_RTN_SF[sfV]||udsH(sfV),rid=(bytes[2]<<8)|bytes[3];add('Sub-function',`${udsH(sfV)}  ${n}`);add('Routine ID',udsH(rid,4));if(bytes.length>4)add('Optional record',udsBytesHex(bytes.slice(4)));summary=`${sNm} · ${n} · ${udsH(rid,4)}`;}break;}
    case 0x34:case 0x35:{if(bytes.length>=2){const dfi=bytes[1];add('Data format',`${udsH(dfi)}  compress=${(dfi>>4)&0xF} encrypt=${dfi&0xF}`);if(bytes.length>2){const m=udsMemAddr(bytes,2);add('Address',udsH(m.addr,m.adBytes*2));add('Size',`${m.size} bytes`);summary=`${sNm} · ${udsH(m.addr,m.adBytes*2)} · ${m.size} B`;}else summary=sNm;}break;}
    case 0x36:{if(bytes.length>=2){add('Block seq counter',udsH(bytes[1]));if(bytes.length>2)add('Data',`${udsBytesHex(bytes.slice(2,18))}${bytes.length>18?'…':''}  (${bytes.length-2} bytes)`);summary=`${sNm} · block ${udsH(bytes[1])} · ${bytes.length-2} B`;}break;}
    case 0x37:{if(bytes.length>1)add('Optional record',udsBytesHex(bytes.slice(1)));summary=sNm;break;}
    case 0x38:{if(bytes.length>=2)add('Mode of operation',udsH(bytes[1]));summary=sNm;break;}
    case 0x3D:{if(bytes.length>=2){const m=udsMemAddr(bytes,1);add('Address',udsH(m.addr,m.adBytes*2));add('Size',`${m.size} bytes`);const ds=1+m.consumed;if(bytes.length>ds)add('Data',udsBytesHex(bytes.slice(ds)));summary=`${sNm} · ${udsH(m.addr,m.adBytes*2)}`;}break;}
    case 0x3E:{const n=sfV===0?'zeroSubFunction':udsH(sfV);add('Sub-function',`${udsH(sf)}  ${n}${sfSPR?' (suppress PR)':''}`);summary=`${sNm}${sfSPR?' (no response)':''}`;break;}
    case 0x83:case 0x86:{if(sf!==null)add('Sub-function',udsH(sfV));summary=sNm;break;}
    case 0x85:{const n=UDS_DTC_ON[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  DTC setting ${n}`);if(bytes.length>=5)add('Group of DTC',udsBytesHex(bytes.slice(2,5)));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    case 0x87:{const n=UDS_LNK_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>2)add('Baudrate record',udsBytesHex(bytes.slice(2)));if(sfSPR)add('Suppress PR','yes');summary=`${sNm} · ${n}`;break;}
    default:{if(bytes.length>1)add('Payload',udsBytesHex(bytes.slice(1)));}
  }
  return {type:'request',summary,rows};
}

function udsDecodeRsp(bytes,sid){
  const sNm=UDS_SVC[sid]||`Unknown ${udsH(sid)}`;
  const rows=[{k:'Type',v:'Positive Response'},{k:'Service',v:`${udsH(sid)}  ${sNm}`}];
  const add=(k,v)=>rows.push({k,v});
  let summary=`PositiveResponse · ${sNm}`;
  const sf=bytes.length>1?bytes[1]:null,sfV=sf!==null?sf&0x7F:null;
  switch(sid){
    case 0x10:{const n=UDS_SESSION[sfV]||udsH(sfV);add('Session',`${udsH(sfV)}  ${n}`);if(bytes.length>=6){add('P2 max',`${(bytes[2]<<8)|bytes[3]} ms`);add('P2* max',`${((bytes[4]<<8)|bytes[5])*10} ms`);}summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x11:{const n=UDS_RESET[sfV]||udsH(sfV);add('Reset type',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x14:{summary=`PositiveResponse · ${sNm} · cleared`;break;}
    case 0x19:{const n=UDS_DTC_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;
      if(sfV===0x01&&bytes.length>=6){add('Status avail mask',udsH(bytes[2]));add('DTC format',udsH(bytes[3]));const cnt=(bytes[4]<<8)|bytes[5];add('DTC count',String(cnt));summary+=` · ${cnt} DTC(s)`;}
      else if([0x02,0x0A,0x0B,0x0C,0x0D,0x0E,0x0F,0x13,0x15].includes(sfV)){
        if(bytes.length>=3)add('Status avail mask',udsH(bytes[2]));
        const dtcs=[],dtcHtml=[];let i=3;while(i+3<bytes.length){const a=bytes[i],b=bytes[i+1],c=bytes[i+2],st=bytes[i+3],code=udsDTC(a,b,c);dtcs.push(`${code}  status ${udsH(st)} (${udsDTCStatus(st)})`);dtcHtml.push(`${dtcLink(code,`bytes=${dtcHexQ([a,b,c,st])}&fmt=uds`)}  <span style="color:var(--text2)">status ${udsH(st)} (${escHtml(udsDTCStatus(st))})</span>`);i+=4;}
        if(dtcs.length){rows.push({k:'DTCs',v:dtcs.join('\n'),vHtml:dtcHtml.join('<br>')});summary+=` · ${dtcs.length} DTC(s)`;}else{add('DTCs','none');summary+=' · no DTCs';}
      }
      else if([0x06,0x10].includes(sfV)&&bytes.length>=5){const a=bytes[2],b=bytes[3],c=bytes[4],st=bytes.length>=6?bytes[5]:null,code=udsDTC(a,b,c);rows.push({k:'DTC',v:code,vHtml:dtcLink(code,`bytes=${dtcHexQ(st!==null?[a,b,c,st]:[a,b,c])}&fmt=uds`)});if(bytes.length>=6)add('Status',`${udsH(bytes[5])}  ${udsDTCStatus(bytes[5])}`);if(bytes.length>6)add('Ext data',udsBytesHex(bytes.slice(6)));}
      break;}
    case 0x22:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));const data=bytes.slice(3);if(data.length){add('Data',`${udsBytesHex(data.slice(0,32))}${data.length>32?'…':''}  (${data.length} bytes)`);const asc=data.map(b=>b>=32&&b<127?String.fromCharCode(b):'.').join('');if(asc.replace(/\./g,'').length>=2)add('ASCII',asc);}summary=`PositiveResponse · ${sNm} · ${udsH(d,4)}`;}break;}
    case 0x23:{if(bytes.length>1){const d=bytes.slice(1);add('Data',`${udsBytesHex(d.slice(0,32))}${d.length>32?'…':''}  (${d.length} bytes)`);summary=`PositiveResponse · ${sNm} · ${d.length} bytes`;}break;}
    case 0x27:{const lvl=sfV,isR=!!(lvl&1);add('Level',`${udsH(lvl)}  (${isR?'seed':'key accepted'})`);if(isR&&bytes.length>2)add('Seed',udsBytesHex(bytes.slice(2)));summary=`PositiveResponse · ${sNm} · ${isR?'seed':'key accepted'}`;break;}
    case 0x28:{const n=UDS_COMM_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x2C:{const n=UDS_DDDI_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);if(bytes.length>=4)add('DID',udsH((bytes[2]<<8)|bytes[3],4));summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x2E:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));summary=`PositiveResponse · ${sNm} · ${udsH(d,4)}`;}break;}
    case 0x2F:{if(bytes.length>=3){const d=(bytes[1]<<8)|bytes[2];add('DID',udsH(d,4));if(bytes.length>3)add('Control status',udsBytesHex(bytes.slice(3)));summary=`PositiveResponse · ${sNm} · ${udsH(d,4)}`;}break;}
    case 0x31:{if(bytes.length>=4){const n=UDS_RTN_SF[sfV]||udsH(sfV),rid=(bytes[2]<<8)|bytes[3];add('Sub-function',`${udsH(sfV)}  ${n}`);add('Routine ID',udsH(rid,4));if(bytes.length>4)add('Status record',udsBytesHex(bytes.slice(4)));summary=`PositiveResponse · ${sNm} · ${n} · ${udsH(rid,4)}`;}break;}
    case 0x34:case 0x35:{if(bytes.length>=2){const lfi=bytes[1],nb=(lfi>>4)&0xF;let sz=0;for(let i=0;i<nb;i++)sz=(sz<<8)|(bytes[2+i]||0);add('Max block length',`${sz} bytes`);summary=`PositiveResponse · ${sNm} · maxBlock ${sz} B`;}break;}
    case 0x36:{if(bytes.length>=2){add('Block seq counter',udsH(bytes[1]));if(bytes.length>2)add('Response param',udsBytesHex(bytes.slice(2)));summary=`PositiveResponse · ${sNm} · block ${udsH(bytes[1])}`;}break;}
    case 0x37:{if(bytes.length>1)add('Transfer response',udsBytesHex(bytes.slice(1)));summary=`PositiveResponse · ${sNm}`;break;}
    case 0x3E:{summary=`PositiveResponse · ${sNm}`;break;}
    case 0x85:{const n=UDS_DTC_ON[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  DTC setting ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    case 0x87:{const n=UDS_LNK_SF[sfV]||udsH(sfV);add('Sub-function',`${udsH(sfV)}  ${n}`);summary=`PositiveResponse · ${sNm} · ${n}`;break;}
    default:{if(bytes.length>1)add('Payload',udsBytesHex(bytes.slice(1)));}
  }
  return {type:'positive',summary,rows};
}

// ── KWP2000 (ISO 14230) — UDS's ancestor on the same ISO-TP carrier ──
// Separate tables (NOT a patch to UDS_*): several SIDs collide with UDS but mean
// different things — 0x21 ReadDataByLocalIdentifier, 0x1A ReadECUIdentification,
// 0x81 StartCommunication. Positive-response (SID+0x40) and 0x7F neg-response
// conventions are identical to UDS, so kwpDecode mirrors udsDecode's shape.
const KWP_SVC = {
  0x10:'StartDiagnosticSession', 0x11:'ECUReset',
  0x14:'ClearDiagnosticInformation', 0x17:'ReadStatusOfDTC',
  0x18:'ReadDTCByStatus', 0x1A:'ReadECUIdentification',
  0x20:'StopDiagnosticSession', 0x21:'ReadDataByLocalIdentifier',
  0x22:'ReadDataByCommonIdentifier', 0x23:'ReadMemoryByAddress',
  0x27:'SecurityAccess', 0x28:'DisableNormalMessageTransmission',
  0x29:'EnableNormalMessageTransmission', 0x2C:'DynamicallyDefineLocalIdentifier',
  0x2E:'WriteDataByCommonIdentifier', 0x2F:'InputOutputControlByCommonIdentifier',
  0x30:'InputOutputControlByLocalIdentifier', 0x31:'StartRoutineByLocalIdentifier',
  0x32:'StopRoutineByLocalIdentifier', 0x33:'RequestRoutineResultsByLocalIdentifier',
  0x34:'RequestDownload', 0x35:'RequestUpload', 0x36:'TransferData',
  0x37:'RequestTransferExit', 0x38:'StartRoutineByAddress',
  0x39:'StopRoutineByAddress', 0x3A:'RequestRoutineResultsByAddress',
  0x3B:'WriteDataByLocalIdentifier', 0x3D:'WriteMemoryByAddress',
  0x3E:'TesterPresent', 0x81:'StartCommunication', 0x82:'StopCommunication',
  0x83:'AccessTimingParameters', 0x85:'StartProgrammingSession',
};
const KWP_NRC = {
  0x10:'generalReject', 0x11:'serviceNotSupported', 0x12:'subFunctionNotSupported',
  0x21:'busyRepeatRequest', 0x22:'conditionsNotCorrect', 0x23:'routineNotComplete',
  0x31:'requestOutOfRange', 0x33:'securityAccessDenied', 0x35:'invalidKey',
  0x36:'exceedNumberOfAttempts', 0x37:'requiredTimeDelayNotExpired',
  0x40:'downloadNotAccepted', 0x41:'improperDownloadType',
  0x42:'cantDownloadToSpecifiedAddress', 0x43:'cantDownloadNumberOfBytesRequested',
  0x50:'uploadNotAccepted', 0x51:'improperUploadType', 0x71:'transferSuspended',
  0x72:'transferAborted', 0x74:'illegalAddressInBlockTransfer',
  0x75:'illegalByteCountInBlockTransfer', 0x76:'illegalBlockTransferType',
  0x77:'blockTransferDataChecksumError',
  0x78:'requestCorrectlyReceivedResponsePending',
  0x79:'incorrectByteCountDuringBlockTransfer',
  0x80:'serviceNotSupportedInActiveDiagnosticSession',
  0x9A:'dataDecompressionFailed', 0x9B:'dataDecryptionFailed',
  0xA0:'ecuNotResponding', 0xA1:'ecuAddressUnknown',
};
const KWP_DIAG_MODE = {0x81:'default',0x85:'programming',0x89:'standby',0x92:'EOL/end-of-line'};

// ASCII render with hex fallback (mirrors udsDecodeRsp 0x22 / obdDecode VIN guard).
function kwpAscii(b){ const a=b.map(v=>v>=32&&v<127?String.fromCharCode(v):'.').join(''); return a.replace(/\./g,'').length>=2?a:null; }

function kwpDecode(bytes){
  if(!bytes||!bytes.length)return null;
  const m=bytes[0];
  if(m===0x7F){
    const sid=bytes[1]||0,nrc=bytes[2]||0;
    const sNm=KWP_SVC[sid]||udsH(sid),nNm=KWP_NRC[nrc]||udsH(nrc);
    const isPd=nrc===0x78;
    return { type:isPd?'pending':'negative',
      summary:isPd?`ResponsePending · ${sNm}`:`NegativeResponse · ${sNm} · ${nNm}`,
      rows:[{k:'Type',v:isPd?'Response Pending (NRC 0x78)':'Negative Response'},{k:'Service',v:`${udsH(sid)}  ${sNm}`},{k:'NRC',v:`${udsH(nrc)}  ${nNm}`}] };
  }
  const isRsp=!!(m&0x40)&&!!KWP_SVC[m-0x40];
  const sid=isRsp?m-0x40:m;
  const sNm=KWP_SVC[sid]||`Unknown ${udsH(sid)}`;
  const rows=[]; if(isRsp)rows.push({k:'Type',v:'Positive Response'}); rows.push({k:'Service',v:`${udsH(sid)}  ${sNm}`});
  const add=(k,v)=>rows.push({k,v});
  let summary=isRsp?`PositiveResponse · ${sNm}`:sNm;
  const body=bytes.slice(1);
  switch(sid){
    case 0x10:{const dm=bytes[1];if(dm!==undefined){const n=KWP_DIAG_MODE[dm]||udsH(dm);add('Diagnostic mode',`${udsH(dm)}  ${n}`);summary+=` · ${n}`;}break;}
    case 0x21:{const rli=bytes[1];if(rli!==undefined){add('Local identifier',udsH(rli));summary+=` · RLI ${udsH(rli)}`;}
      if(isRsp&&bytes.length>2){const data=bytes.slice(2);add('Data',`${udsBytesHex(data.slice(0,32))}${data.length>32?'…':''}  (${data.length} bytes)`);const a=kwpAscii(data);if(a)add('ASCII',a);}break;}
    case 0x1A:{const opt=bytes[1];if(opt!==undefined){add('Identification option',udsH(opt));summary+=` · ${udsH(opt)}`;}
      if(isRsp&&bytes.length>2){const data=bytes.slice(2);const a=kwpAscii(data);if(a)add('Identification',a);add('Data',`${udsBytesHex(data.slice(0,32))}${data.length>32?'…':''}  (${data.length} bytes)`);}break;}
    case 0x81:case 0x83:{if(body.length)add(isRsp?'Response params':'Params',udsBytesHex(body));break;}
    default:{if(body.length)add('Payload',udsBytesHex(body));}
  }
  return {type:isRsp?'positive':'request',summary,rows};
}

// Decode dispatcher — KWP mode uses the KWP tables; UDS/OBD stay in udsDecode
// (its existing OBD-mode auto-sniff is unchanged).
function decodePayload(bytes){ return obdProtoMode === 'kwp' ? kwpDecode(bytes) : udsDecode(bytes); }

/** Generate expandable decode HTML. id must be unique per call. */
function udsSection(decoded, id) {
  if (!decoded) return '';
  const {type,summary,rows} = decoded;
  const color = {request:'var(--text2)',positive:'var(--green)',negative:'var(--red)',pending:'var(--amber)'}[type]||'var(--text2)';
  const rowsHtml = rows.map(r => {
    const val = r.vHtml || escHtml(String(r.v)).replace(/\n/g,'<br>');
    return `<div style="display:flex;gap:8px;padding:1px 0;flex-wrap:wrap">` +
      `<span style="min-width:130px;flex-shrink:0;color:var(--text3);font-family:var(--sans);font-size:10px;text-transform:uppercase;letter-spacing:0.05em">${escHtml(r.k)}</span>` +
      `<span style="color:var(--text);font-size:11px;font-family:var(--mono);word-break:break-all">${val}</span>` +
    `</div>`;
  }).join('');
  return `<div style="margin-top:3px">` +
    `<div onclick="udsToggle('${id}')" style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;user-select:none">` +
      `<span id="${id}_a" style="color:${color};font-size:9px;line-height:1">▶</span>` +
      `<span style="color:${color};font-family:var(--sans);font-size:11px">${escHtml(summary)}</span>` +
    `</div>` +
    `<div id="${id}_d" style="display:none;margin-top:5px;padding:6px 10px;background:var(--bg2);border-left:2px solid var(--border2);border-radius:0 4px 4px 0">${rowsHtml}</div>` +
  `</div>`;
}
function udsToggle(id) {
  const d=document.getElementById(id+'_d'),a=document.getElementById(id+'_a');
  if(!d||!a)return;
  const open=d.style.display!=='none';
  d.style.display=open?'none':'block';
  a.textContent=open?'▶':'▼';
}

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
  return 'isotp-explainer.html?' + p.toString();
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
    `<span style="color:var(--amber);font-family:var(--sans);font-size:10px;margin-left:8px">Response Pending — ECU still processing</span>`;
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
  if (wt) { wt.style.fontStyle='normal'; wt.innerHTML=`<span style="min-width:22px;flex-shrink:0"></span><span style="color:var(--red)">no response — timeout (${ISOTP_TIMEOUT} ms)</span>`; }
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
    `<span style="flex:1">No response received — the ECU did not reply within ${ISOTP_TIMEOUT} ms. Check IDs, addressing mode, and that the bus is not paused.</span>` +
    `<button onclick="clearIsotpLog()" style="background:var(--red);border:none;color:#fff;border-radius:4px;padding:3px 9px;font-size:10px;cursor:pointer;font-family:var(--sans);white-space:nowrap">Clear Window</button>` +
    `<button onclick="this.closest('.isotp-timeout-banner').remove()" style="background:transparent;border:1px solid var(--red);color:var(--red);border-radius:4px;padding:3px 7px;font-size:10px;cursor:pointer;font-family:var(--sans)">✕</button>`;
  log.insertBefore(el, log.firstChild);
}

function isotpMarkError(wrap, reason) {
  if (obdCaptureCb) { const cb = obdCaptureCb; obdCaptureCb = null; cb(null); }
  if (!wrap.isConnected) return;
  const wt = wrap.querySelector('.isotp-rx-waiting');
  if (wt) { wt.style.fontStyle='normal'; wt.innerHTML=`<span style="min-width:22px;flex-shrink:0"></span><span style="color:var(--red)">error — ${escHtml(reason)}</span>`; }
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
  document.getElementById('isotpLearnLink').href = 'isotp-explainer.html';
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
    `<span style="flex:1">⚠ Protocol switched — earlier entries above were decoded under a different protocol and may read incorrectly.</span>` +
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
  // First dump entry at/after the send time (binary search — dumpLog is time-ordered).
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

  const cfg = isotpCfg();
  if (isNaN(cfg.txId) || isNaN(cfg.rxId)) { isotpLogWarn('Invalid Tx/Rx ID'); return; }
  if (!busIsOpen) { isotpLogWarn('Bus is not open'); return; }
  if (paused) { isotpLogWarn('Bus is paused — message will be sent but no response can be received while paused'); }

  // History
  if (raw !== isotpHistory[isotpHistory.length - 1]) isotpHistory.push(raw);
  isotpHistoryIdx = -1;
  input.value = '';

  // Cancel any in-flight state
  isotpCancelAll();
  isotpPendingEl = null;

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

// Request palette — common one-click asks.
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

// Default Tx/Rx ID pair per protocol. Switching modes adopts the new defaults — but
// only if the current IDs still hold the *previous* mode's defaults (custom IDs are kept).
const ISOTP_PROTO_IDS = { uds:['7E1','7E9'], obd:['7DF','7E9'], kwp:['7E5','7ED'] };
function isotpSetProtoMode(mode) {
  const next = ['obd', 'kwp'].includes(mode) ? mode : 'uds';
  const prev = obdProtoMode;
  // Warn when crossing the KWP boundary with a populated log (decodes won't match).
  if ((obdProtoMode === 'kwp') !== (next === 'kwp') &&
      document.getElementById('isotpLog').children.length > 0) {
    isotpProtoSwitchWarn();
  }
  obdProtoMode = next;
  // Adopt the new mode's default IDs when the fields still hold the old mode's defaults.
  if (prev !== next) {
    const tx = document.getElementById('isotpTxId'), rx = document.getElementById('isotpRxId');
    const [pTx, pRx] = ISOTP_PROTO_IDS[prev], [nTx, nRx] = ISOTP_PROTO_IDS[next];
    if (tx.value.trim().toUpperCase() === pTx && rx.value.trim().toUpperCase() === pRx) {
      tx.value = nTx; rx.value = nRx;
      isotpFlashField(tx); isotpFlashField(rx);
    }
  }
  document.getElementById('isotpModeUds').classList.toggle('active', obdProtoMode === 'uds');
  document.getElementById('isotpModeObd').classList.toggle('active', obdProtoMode === 'obd');
  document.getElementById('isotpModeKwp').classList.toggle('active', obdProtoMode === 'kwp');
  document.getElementById('obdWrap').style.display = obdProtoMode === 'obd' ? 'flex' : 'none';
  document.getElementById('kwpWrap').style.display = obdProtoMode === 'kwp' ? 'flex' : 'none';
  document.getElementById('udsWrap').style.display = obdProtoMode === 'uds' ? 'flex' : 'none';
  document.getElementById('isotpInputLabel').textContent =
    obdProtoMode === 'obd' ? 'OBD' : obdProtoMode === 'kwp' ? 'KWP' : 'UDS';
  // Per-mode example in the terminal input — match each protocol's own frame format.
  document.getElementById('isotpInput').placeholder =
    obdProtoMode === 'obd' ? 'hex bytes — e.g.  01 0C  or  03'
    : obdProtoMode === 'kwp' ? 'hex bytes — e.g.  21 F0  or  3E'
    : 'hex bytes — e.g.  22 F1 84  or  3E 00';
  // Active-protocol explainer link lives in the config strip (next to the ISO-TP one).
  const protoLink = document.getElementById('isotpProtoLearnLink');
  const protoInfo = obdProtoMode === 'obd' ? ['obd2-explainer.html', 'Learn how OBD-II works ↗']
    : obdProtoMode === 'kwp' ? ['kwp2000-explainer.html', 'Learn how KWP2000 works ↗']
    : ['uds-explainer.html', 'Learn how UDS works ↗'];
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
    // for certain sibling values — recompute their visibility on any change.
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
  if (!obdBusReady()) { isotpLogWarn('KWP TX disabled — bus closed or listen-only'); return; }
  document.getElementById('isotpInput').value = obdHex(bytes);
  isotpSend();
}

// UDS service palette (ISO 14229) — mirrors KWP. Reuses the UDS_* decode tables for options.
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
      // 0x03 transitionBaudrate carries no record — hide the field for that sub-function.
      {kind:'hex', label:'Baudrate record', def:'12', visibleWhen: els => parseInt(els[0].el.value, 10) !== 0x03} ] },
];
let udsInited = false;
function udsInit() {
  if (udsInited) return;
  udsInited = true;
  buildSvcPalette('udsPalette', UDS_PALETTE, udsSend);
}
function udsSend(bytes) {
  if (!obdBusReady()) { isotpLogWarn('UDS TX disabled — bus closed or listen-only'); return; }
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
  if (!obdBusReady()) { isotpLogWarn('OBD TX disabled — bus closed or listen-only'); return; }
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
  isotpTxCan(frames[0], cfg);
  if (frames.length > 1) { isotpTxQueue = frames.slice(1); isotpCfBlkCnt = 0; }
  isotpArmTimer();
  if (demoMode && !paused) demoIsoTpRespond(payload, cfg);
  return true;
}

// Drives the probe queue and the watch round-robin — one request at a time.
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
  if (!obdBusReady()) { isotpLogWarn('Probe disabled — bus closed or listen-only'); return; }
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
  if (!obdBusReady()) { isotpLogWarn('Watch disabled — bus closed or listen-only'); return; }
  if (!obdWatch.length) { isotpLogWarn('Select at least one PID to watch'); return; }
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
// Global indicator in the TX Scheduler header — Quick Watch polls = active TX.
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
    obdWatchVals.set(pid, row ? row.v : '—');
  } else {
    obdWatchVals.set(pid, payload ? '—' : 'timeout');
  }
  obdRenderWatch();
}
function obdRenderWatch() {
  const grid = document.getElementById('obdWatchGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!obdWatch.length) {
    grid.innerHTML = '<span style="color:var(--text3);font-size:11px;font-family:var(--sans)">No PIDs selected — tick boxes above, then Start.</span>';
    return;
  }
  obdWatch.forEach(pid => {
    const label = (OBD_WATCHABLE.find(w => w[0] === pid) || [pid, OBD_PID01[pid] || udsH(pid)])[1];
    const tile = document.createElement('div');
    tile.className = 'obd-tile';
    tile.innerHTML = `<div class="obd-tile-label">${escHtml(label)}</div>` +
                     `<div class="obd-tile-val">${escHtml(obdWatchVals.get(pid) || '—')}</div>`;
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
  const startTs = dumpStartTs ?? (dumpLog.size > 0 ? dumpLog.get(0).ts : 0);
  const header  = ['Time_ms','ID','Type','Dir','DLC','D0','D1','D2','D3','D4','D5','D6','D7'];
  const lines   = [header.join(',')];
  let count = 0;

  for (let i = 0; i < dumpLog.size; i++) {
    const e = dumpLog.get(i);
    if (flt && !applyFilter(e, flt)) continue;
    // Frames are timestamped with Date.now() (integer ms), so sub-ms digits would
    // always be .000 — keep the column as integer milliseconds.
    const relMs = Math.round(e.ts - startTs);
    const idHex = e.isExt
      ? '0x' + e.id.toString(16).toUpperCase().padStart(8,'0')
      : e.id.toString(16).toUpperCase().padStart(3,'0');
    const type  = e.isRtr ? 'RTR' : e.isExt ? 'EXT' : 'STD';
    const dir   = e.isTx ? 'TX' : 'RX';
    const bytes = Array.from({length: 8}, (_, j) =>
      e.data[j] !== undefined ? e.data[j].toString(16).toUpperCase().padStart(2,'0') : '');
    lines.push([relMs, idHex, type, dir, e.dlc, ...bytes].join(','));
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
//   slcanWorkspaces — { version, activeId, list:[{id,name,createdAt,updatedAt,data}] }
//                     data = pins, colours, notes, filters, byte format, notch,
//                     baud, listen-only/auto-open, TX rows, ISO-TP config (per-vehicle)
//   slcanPrefs      — global UI ergonomics (FPS, buffer, panel collapse states)
//   slcanTheme      — unchanged, handled by toggleTheme()
let workspaces = [];
let activeWsId = null;
let _saveTimer = null;
let _restoring = false;   // true while applying settings at startup → suppress autosave

function uid() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Factory defaults for a fresh workspace — mirror the HTML default control values.
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
      txId: _el('isotpTxId').value, rxId: _el('isotpRxId').value,
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
// TX rows are always restored DISABLED — never auto-transmit on load/switch.
function applySettings(d) {
  d = d || defaultWorkspaceData();
  _restoring = true;

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
  isotpSetProtoMode(['obd', 'kwp'].includes(it.proto) ? it.proto : 'uds');

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

  _restoring = false;
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

function saveWorkspaces() {
  try { localStorage.setItem('slcanWorkspaces',
    JSON.stringify({ version: 1, activeId: activeWsId, list: workspaces })); } catch(_) {}
}

function saveGlobalPrefs() {
  try { localStorage.setItem('slcanPrefs', JSON.stringify(collectPrefs())); } catch(_) {}
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
  // "Default" is permanent — reset it to factory settings in place instead of deleting.
  if (ws.name === 'Default') {
    if (!confirm('Reset workspace "Default" to factory settings? This cannot be undone.')) return;
    stopAllTx();
    ws.data = defaultWorkspaceData();
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
                   data: Object.assign(defaultWorkspaceData(), obj.data || {}) };
      workspaces.push(ws);
      activeWsId = ws.id;
      stopAllTx();
      applySettings(ws.data);
      renderWsSelect();
      saveWorkspaces();
      log('Imported workspace: ' + ws.name, 'ok');
    } catch (e) { log('Import failed: ' + e.message, 'err'); }
  };
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

function toggleFilterHelp() {
  const panel = _el('filterHelpPop');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) {
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target) && e.target.id !== 'filterHelpBtn') {
          panel.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}

function toggleAdvancedMenu() {
  const panel = _el('advancedMenu');
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  if (!open) {
    setTimeout(() => {
      const close = (e) => {
        if (!panel.contains(e.target) && e.target.id !== 'advancedMenuBtn') {
          panel.style.display = 'none';
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
  }
}

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
window.ingestFrame = ingestFrame; // let chademo.js demo button replay frames into the pipeline
window.fuzzScheduleSave  = scheduleSave; // let fuzz.js persist config changes
window.obdScheduleSave   = scheduleSave; // persist OBD sub-mode + watch selection
window.xcpScheduleSave   = scheduleSave; // let xcp.js persist CRO/DTO/byte-order config
window.xcpDemoActive     = () => demoMode; // demo XCP slave answers only in Demo mode
window.canopenScheduleSave = scheduleSave; // let canopen.js persist node/SDO config
window.canopenDemoActive   = () => demoMode; // demo CANopen node answers only in Demo mode

applyPrefs(_prefs);
renderWsSelect();
applySettings(workspaces.find(w => w.id === activeWsId).data);
saveWorkspaces();
saveGlobalPrefs();

// Delegated click on ID list — survives innerHTML rerenders; ignore pin button clicks
document.getElementById('frameBody').addEventListener('click', e => {
  if (e.target.closest('[data-pin]')) return;
  const row = e.target.closest('tr');
  if (!row || !row.dataset.key) return;
  const f = frames.get(row.dataset.key);
  if (f) inspectFrame(f);
});

// Right-click an ID list row → minimal "Graph this ID" menu (remove to revert)
document.getElementById('frameBody').addEventListener('contextmenu', e => {
  const row = e.target.closest('tr');
  if (!row || !row.dataset.key || !window.graphContextMenu) return;
  e.preventDefault();
  window.graphContextMenu(e.clientX, e.clientY, row.dataset.key);
});
