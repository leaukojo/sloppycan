// ── XCP-on-CAN (ASAM MCD-1 XCP) ───────────────────────────────────────────────
// Self-contained module: passive decode of XCP traffic + an active XCP master.
// All XCP state, decode tables, and rendering live here. Same revertable bolt-on
// pattern as j1939.js / chademo.js / fuzz.js.
//
// XCP rides two CAN IDs: CRO (Command Receive Object, master→slave) and DTO (Data
// Transmit Object, slave→master = responses + DAQ data). A DTO's first byte
// classifies it: 0xFF RES, 0xFE ERR, 0xFD EV, 0xFC SERV, 0x00–0xFB DAQ data.
//
// Command/error codes follow the real ASAM XCP Protocol Layer spec (the plan's
// listed DAQ/ERR codes were scrambled — corrected here so a real slave answers).
//
// INTEGRATION POINTS — the only changes required in the main files:
//   sloppycan.js  ingestFrame(), after the chademo hook:
//     if (window.xcpIngestFrame) xcpIngestFrame(frame);
//   sloppycan.js  clearFrames(), at end:  if (window.xcpClear) xcpClear();
//   sloppycan.js  disconnectSerial():     if (window.xcpStop) xcpStop();
//   sloppycan.js  startup:  window.xcpScheduleSave = scheduleSave;
//                           window.xcpDemoActive = () => demoMode;
//   sloppycan.js  switchViewTab(): xcp tab toggle + wrap show/hide + xcpOnShow()
//   sloppycan.js  persistence: defaultWorkspaceData/collectSettings/applySettings 'xcp' key
//   index.html    view-tabs button + #xcpWrap content + <script src="xcp.js" defer>
//
// Active TX goes only through window.fuzzTxFrame (no transport code here).
// To REVERT: delete this file + xcp-explainer.html and the seams above.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.xcp-config {
  background:var(--bg2); border-bottom:1px solid var(--border);
  padding:7px 16px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;
  flex-shrink:0; font-family:var(--sans); font-size:11px; color:var(--text2);
}
.xcp-config label { display:flex; align-items:center; gap:5px; }
.xcp-config input, .xcp-config select {
  background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:5px; font-family:var(--mono); font-size:11px; padding:3px 6px; outline:none;
}
.xcp-config input { width:64px; }
.xcp-demo-flag {
  margin-left:auto; font-size:10px; padding:3px 9px; border-radius:11px;
  background:var(--amber-dim); color:var(--amber); font-family:var(--sans); white-space:nowrap;
}
.xcp-controls {
  padding:14px 20px; display:flex; flex-direction:column; gap:12px;
  border-bottom:1px solid var(--border); flex-shrink:0;
}
.xcp-controls .xcp-config { background:transparent; border:none; padding:0; }
.xcp-controls:not(.xcp-connected) .xcp-hide-until-connected { display:none; }
.xcp-controls:not(.xcp-connected) #xcpConnectBtn { background:var(--bg2); color:var(--text2); border-color:var(--border); }
.xcp-log-bar {
  background:var(--bg2); border-top:1px solid var(--border); border-bottom:1px solid var(--border);
  padding:6px 16px; display:flex; align-items:center; gap:14px; flex-shrink:0;
  font-family:var(--sans); font-size:12px; font-weight:600; color:var(--text);
}
.xcp-log-bar a { color:var(--blue); text-decoration:none; white-space:nowrap; font-weight:400; margin-left:auto; font-size:11px; }
.xcp-log-bar button { font-size:11px; padding:3px 10px; }
.xcp-btn-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.xcp-btn {
  font-size:11.5px; padding:5px 12px; background:var(--bg2); color:var(--text2);
  border:1px solid var(--border); border-radius:6px; cursor:pointer;
  font-family:var(--sans); white-space:nowrap; transition:background .15s,color .15s;
}
.xcp-btn:hover:not(:disabled) { background:var(--bg3); color:var(--text); }
.xcp-btn:disabled { opacity:.4; cursor:not-allowed; }
.xcp-btn.go     { background:var(--green-dim); color:var(--green); border-color:transparent; }
.xcp-btn.danger { background:var(--red-dim);   color:var(--red);   border-color:transparent; }
.xcp-form {
  display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  font-family:var(--sans); font-size:11px; color:var(--text2);
}
.xcp-form label { display:flex; align-items:center; gap:5px; }
.xcp-form input {
  background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:5px; font-family:var(--mono); font-size:11px; padding:4px 7px; outline:none;
}
.xcp-form .grp-title {
  font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3);
  min-width:96px;
}
.xcp-readout {
  font-family:var(--mono); font-size:11px; color:var(--green); padding:2px 0 0 96px;
  word-break:break-all; min-height:14px;
}
.xcp-readout.err { color:var(--red); }
.xcp-sess { padding:14px 20px; }
.xcp-state {
  display:inline-block; padding:4px 14px; border-radius:14px; font-size:13px;
  font-weight:600; font-family:var(--sans); background:var(--bg2); color:var(--text2);
  border:1px solid var(--border);
}
.xcp-state.conn { background:var(--green-dim); color:var(--green); border-color:transparent; }
.xcp-tiles {
  display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
  gap:12px; margin:14px 0 8px;
}
.xcp-tile { background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:11px 13px; }
.xcp-tile .xt-label {
  font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3);
  font-family:var(--sans); margin-bottom:4px;
}
.xcp-tile .xt-val { font-size:18px; color:var(--text); font-family:var(--mono); line-height:1.15; }
.xcp-chips-title { font-size:12px; font-weight:600; color:var(--text); margin:16px 0 6px; font-family:var(--sans); }
.xcp-chip {
  display:inline-block; padding:2px 9px; margin:3px; border-radius:11px;
  font-size:10px; font-family:var(--sans); background:var(--bg2);
  color:var(--text3); border:1px solid var(--border);
}
.xcp-chip.on { background:var(--green-dim); color:var(--green); border-color:transparent; }
.xcp-empty { text-align:center; color:var(--text3); font-size:12px; padding:40px 0; font-family:var(--sans); line-height:1.6; }
.xcp-tbl { width:100%; border-collapse:collapse; font-size:11.5px; }
.xcp-tbl th {
  text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text3); padding:5px 8px; border-bottom:1px solid var(--border);
  font-weight:500; font-family:var(--sans); white-space:nowrap;
  background:var(--bg2); cursor:default;
}
.xcp-tbl td { padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; color:var(--text2); font-family:var(--mono); }
.xcp-tbl tr:last-child td { border-bottom:none; }
.xcp-tbl td.xc-ts  { color:var(--text3); font-size:10px; white-space:nowrap; }
.xcp-tbl td.xc-dir { font-family:var(--sans); white-space:nowrap; font-size:10px; }
.xcp-tbl td.xc-dir.cro { color:var(--blue); }
.xcp-tbl td.xc-dir.dto { color:var(--purple); }
.xcp-tbl td.xc-id  { color:var(--blue); white-space:nowrap; }
.xcp-tbl td.xc-type{ font-family:var(--sans); white-space:nowrap; }
.xcp-tbl td.xc-type.res { color:var(--green); }
.xcp-tbl td.xc-type.err { color:var(--red); }
.xcp-tbl td.xc-type.daq { color:var(--text3); }
.xcp-tbl td.xc-raw { color:var(--text3); font-size:10px; letter-spacing:.03em; }
.xcp-tbl td.xc-dec { color:var(--text2); font-size:10.5px; font-family:var(--sans); }
`;
  document.head.appendChild(s);
})();

// ── Command codes (CRO first byte = PID) — ASAM XCP Protocol Layer ─────────────
const XCP_CMD = {
  0xFF:'CONNECT', 0xFE:'DISCONNECT', 0xFD:'GET_STATUS', 0xFC:'SYNCH',
  0xFB:'GET_COMM_MODE_INFO', 0xFA:'GET_ID', 0xF9:'SET_REQUEST', 0xF8:'GET_SEED',
  0xF7:'UNLOCK', 0xF6:'SET_MTA', 0xF5:'UPLOAD', 0xF4:'SHORT_UPLOAD',
  0xF3:'BUILD_CHECKSUM', 0xF2:'TRANSPORT_LAYER_CMD', 0xF1:'USER_CMD',
  0xF0:'DOWNLOAD', 0xEF:'DOWNLOAD_NEXT', 0xEE:'DOWNLOAD_MAX', 0xED:'SHORT_DOWNLOAD',
  0xEC:'MODIFY_BITS', 0xEB:'SET_CAL_PAGE', 0xEA:'GET_CAL_PAGE',
  0xE9:'GET_PAG_PROCESSOR_INFO', 0xE8:'GET_SEGMENT_INFO', 0xE7:'GET_PAGE_INFO',
  0xE6:'SET_SEGMENT_MODE', 0xE5:'GET_SEGMENT_MODE', 0xE4:'COPY_CAL_PAGE',
  0xE3:'CLEAR_DAQ_LIST', 0xE2:'SET_DAQ_PTR', 0xE1:'WRITE_DAQ', 0xE0:'SET_DAQ_LIST_MODE',
  0xDF:'GET_DAQ_LIST_MODE', 0xDE:'START_STOP_DAQ_LIST', 0xDD:'START_STOP_SYNCH',
  0xDC:'GET_DAQ_CLOCK', 0xDB:'READ_DAQ', 0xDA:'GET_DAQ_PROCESSOR_INFO',
  0xD9:'GET_DAQ_RESOLUTION_INFO', 0xD8:'GET_DAQ_LIST_INFO', 0xD7:'GET_DAQ_EVENT_INFO',
  0xD6:'FREE_DAQ', 0xD5:'ALLOC_DAQ', 0xD4:'ALLOC_ODT', 0xD3:'ALLOC_ODT_ENTRY',
  0xD2:'PROGRAM_START', 0xD1:'PROGRAM_CLEAR', 0xD0:'PROGRAM', 0xCF:'PROGRAM_RESET',
  0xCE:'GET_PGM_PROCESSOR_INFO', 0xCD:'GET_SECTOR_INFO', 0xCC:'PROGRAM_PREPARE',
  0xCB:'PROGRAM_FORMAT', 0xCA:'PROGRAM_NEXT', 0xC9:'PROGRAM_MAX', 0xC8:'PROGRAM_VERIFY',
};

// ── Error codes (DTO ERR, byte 1) ─────────────────────────────────────────────
const XCP_ERR = {
  0x00:'ERR_CMD_SYNCH', 0x10:'ERR_CMD_BUSY', 0x11:'ERR_DAQ_ACTIVE', 0x12:'ERR_PGM_ACTIVE',
  0x13:'ERR_CMD_UNKNOWN', 0x14:'ERR_CMD_SYNTAX', 0x15:'ERR_OUT_OF_RANGE',
  0x16:'ERR_WRITE_PROTECTED', 0x17:'ERR_ACCESS_DENIED', 0x18:'ERR_ACCESS_LOCKED',
  0x19:'ERR_PAGE_NOT_VALID', 0x1A:'ERR_MODE_NOT_VALID', 0x1B:'ERR_SEGMENT_NOT_VALID',
  0x1C:'ERR_SEQUENCE', 0x1D:'ERR_DAQ_CONFIG', 0x20:'ERR_MEMORY_OVERFLOW',
  0x21:'ERR_GENERIC', 0x22:'ERR_VERIFY', 0x23:'ERR_RESOURCE_TEMPORARY_NOT_ACCESSIBLE',
};
const XCP_EV = {
  0x00:'EV_RESUME_MODE', 0x01:'EV_CLEAR_DAQ', 0x02:'EV_STORE_DAQ', 0x03:'EV_STORE_CAL',
  0x05:'EV_CMD_PENDING', 0x06:'EV_DAQ_OVERLOAD', 0x07:'EV_SESSION_TERMINATED',
  0x08:'EV_TIME_SYNC', 0x09:'EV_STIM_TIMEOUT', 0x0A:'EV_SLEEP', 0x0B:'EV_WAKE_UP',
};
const XCP_RESOURCE = [   // CONNECT response byte1 bits
  { bit:0, label:'CAL/PAG' }, { bit:2, label:'DAQ' }, { bit:3, label:'STIM' }, { bit:4, label:'PGM' },
];
const XCP_GETID_TYPE = { 0:'ASCII', 1:'ASAM-MC2 filename', 2:'ASAM-MC2 path', 3:'URL', 4:'A2L upload' };

// ── State ─────────────────────────────────────────────────────────────────────
const xcpCfg = { cro:0x552, dto:0x553, isExt:false, byteOrder:'auto' };
const XCP = {            // live session model (from CONNECT / GET_STATUS)
  connected:false, resource:null, commModeBasic:null,
  maxCto:null, maxDto:null, protoVer:null, transVer:null,
  sessionStatus:null, protection:null, byteOrder:'le',   // learned from CONNECT
};
let xcpLog = [];
let xcpLastCmd = null;   // {pid, data, ts} — last CRO seen (for passive RES/ERR pairing)
let xcpPending = null;   // {pid, label, timer} — single active transaction in flight
let xcpConnectedUI = false;  // reveal action buttons only after Connect is clicked
let xcpDirty = false;
let xcpWasHidden = true;
let xcpLastTick = 0;
let xcpDemoMta = 0;      // demo slave's Memory Transfer Address
let xcpDemoUploadQueue = []; // demo slave: bytes the next UPLOAD(s) serve (e.g. GET_ID string)
let xcpDemoDaqTimer = null;
const XCP_LOG_MAX = 600;
const XCP_TIMEOUT = 1000;
const XCP_DAQ_COALESCE_MS = 150;
const XCP_GETID_MAX = 1024;   // cap GET_ID UPLOAD readback (defensive against bad length)

// ── Helpers ───────────────────────────────────────────────────────────────────
function xcpH(v, w = 2) { return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0'); }
function xcpHexId(v) { return (v >>> 0).toString(16).toUpperCase(); }  // hex without 0x, for the CRO/DTO ID fields
function xcpRelTs(ts) {
  const s = (Date.now() - ts) / 1000;
  return s < 1 ? 'now' : s < 60 ? s.toFixed(1) + 's ago' : Math.round(s / 60) + 'm ago';
}
function xcpHexBytes(data) { return Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '); }
function xcpParseId(str, fallback) { const v = parseInt((str || '').replace(/^0x/i, ''), 16); return Number.isFinite(v) ? v : fallback; }
function xcpParseInt(str) { const t = (str || '').trim(); const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, /^[0-9a-f]+$/i.test(t) && /[a-f]/i.test(t) ? 16 : 10); return Number.isFinite(v) ? v >>> 0 : NaN; }

// Active byte order: manual override wins, else the slave's CONNECT-reported order.
function xcpBE() { return xcpCfg.byteOrder === 'be' || (xcpCfg.byteOrder === 'auto' && XCP.byteOrder === 'be'); }
function xcpReadU16(d, i, be) { if (i + 1 >= d.length) return null; return be ? (d[i] << 8) | d[i + 1] : d[i] | (d[i + 1] << 8); }
function xcpReadU32(d, i, be) {
  if (i + 3 >= d.length) return null;
  const b = be ? [d[i], d[i + 1], d[i + 2], d[i + 3]] : [d[i + 3], d[i + 2], d[i + 1], d[i]];
  return (b[0] * 0x1000000 + ((b[1] << 16) | (b[2] << 8) | b[3])) >>> 0;
}
function xcpU32Bytes(v, be) { const b = [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; return be ? b : b.reverse(); }

// ── Passive decode ────────────────────────────────────────────────────────────
// Decode a CRO (command). Returns { type:'cro', name, summary }.
function xcpDecodeCmd(data) {
  const pid = data[0];
  const name = XCP_CMD[pid] || 'CMD ' + xcpH(pid);
  let summary = name;
  const be = xcpBE();
  switch (pid) {
    case 0xFA: { const t = XCP_GETID_TYPE[data[1]]; if (t) summary += ' · ' + t; break; }
    case 0xF6: { const a = xcpReadU32(data, 4, be); if (a != null) summary += ' · @' + xcpH(a, 8); break; }
    case 0xF5: if (data[1] != null) summary += ' · ' + data[1] + ' bytes'; break;
    case 0xF4: { const a = xcpReadU32(data, 4, be); summary += ` · ${data[1]} bytes${a != null ? ' @' + xcpH(a, 8) : ''}`; break; }
    case 0xF0: if (data[1] != null) summary += ' · ' + data[1] + ' bytes'; break;
    case 0xDD: { const m = ['stop all', 'start selected', 'stop selected', 'prepare start'][data[1]]; if (m) summary += ' · ' + m; break; }
  }
  return { type: 'cro', name, summary };
}

// Decode a DTO. cmd = the command this responds to (for RES context). Updates XCP.
function xcpDecodeDto(data, cmd) {
  const pid = data[0];
  if (pid === 0xFE) {                       // ERR
    const ec = data[1]; const nm = XCP_ERR[ec] || xcpH(ec);
    return { type: 'err', cls: 'err', summary: 'ERR · ' + nm };
  }
  if (pid === 0xFD) { const nm = XCP_EV[data[1]] || xcpH(data[1]); return { type: 'ev', cls: '', summary: 'EVENT · ' + nm }; }
  if (pid === 0xFC) return { type: 'serv', cls: '', summary: 'SERV · ' + xcpH(data[1]) };
  if (pid === 0xFF) {                       // RES — decode in the context of cmd
    return xcpDecodeRes(data, cmd);
  }
  // 0x00–0xFB → DAQ data packet, first byte = PID (ODT number)
  return { type: 'daq', cls: 'daq', summary: 'DAQ · PID ' + xcpH(pid) };
}

function xcpDecodeRes(data, cmd) {
  const be = xcpBE();
  if (cmd === 0xFF) {                        // CONNECT response
    const resource = data[1], cmb = data[2];
    const beNew = (cmb & 0x01) ? 'be' : 'le';
    XCP.connected = true; XCP.resource = resource; XCP.commModeBasic = cmb;
    XCP.maxCto = data[3];
    XCP.byteOrder = beNew;
    XCP.maxDto = (cmb & 0x01) ? ((data[4] << 8) | data[5]) : (data[4] | (data[5] << 8));
    XCP.protoVer = data[6]; XCP.transVer = data[7];
    const res = XCP_RESOURCE.filter(r => resource & (1 << r.bit)).map(r => r.label).join('/') || 'none';
    xcpDirty = true;
    return { type: 'res', cls: 'res', summary: `RES CONNECT · ${res} · ${beNew.toUpperCase()} · MAX_CTO ${XCP.maxCto} · MAX_DTO ${XCP.maxDto}` };
  }
  if (cmd === 0xFD) {                        // GET_STATUS response
    XCP.sessionStatus = data[1]; XCP.protection = data[2]; xcpDirty = true;
    return { type: 'res', cls: 'res', summary: `RES GET_STATUS · session ${xcpH(data[1])} · protection ${xcpH(data[2])}` };
  }
  if (cmd === 0xFB) {                        // GET_COMM_MODE_INFO response
    return { type: 'res', cls: 'res', summary: `RES COMM_MODE_INFO · optional ${xcpH(data[2])} · MAX_BS ${data[4]} · MIN_ST ${data[5]} · queue ${data[6]}` };
  }
  if (cmd === 0xFA) {                        // GET_ID response
    const len = xcpReadU32(data, 4, be);
    return { type: 'res', cls: 'res', summary: `RES GET_ID · mode ${xcpH(data[1])} · length ${len != null ? len : '?'}` };
  }
  if (cmd === 0xF5 || cmd === 0xF4) {        // UPLOAD / SHORT_UPLOAD response → data bytes
    const bytes = Array.from(data.slice(1));
    return { type: 'res', cls: 'res', summary: 'RES upload · ' + (bytes.length ? xcpHexBytes(bytes) : '(no data)'), uploadBytes: bytes };
  }
  if (cmd === 0xDA) {                        // GET_DAQ_PROCESSOR_INFO response
    const maxDaq = xcpReadU16(data, 2, be), maxEv = xcpReadU16(data, 4, be);
    return { type: 'res', cls: 'res', summary: `RES DAQ_INFO · props ${xcpH(data[1])} · MAX_DAQ ${maxDaq} · MAX_EVENT ${maxEv}` };
  }
  return { type: 'res', cls: 'res', summary: 'RES' + (data.length > 1 ? ' · ' + xcpHexBytes(data.slice(1)) : '') };
}

// ── Ingest hook ───────────────────────────────────────────────────────────────
function xcpIngestFrame(frame) {
  if (!!frame.isExt !== !!xcpCfg.isExt) return;     // CAN type must match config
  const data = frame.data; const ts = Date.now();
  if (frame.id === xcpCfg.cro) {                     // observed command (passive master)
    xcpLastCmd = { pid: data[0], data: Array.from(data), ts };
    const dec = xcpDecodeCmd(data);
    xcpPushLog({ ts, dir: 'cro', id: frame.id, data: Array.from(data), cls: '', type: dec.name, summary: dec.summary });
    return;
  }
  if (frame.id !== xcpCfg.dto) return;
  const pid = data[0];
  // Pair RES/ERR with the active transaction if one is in flight, else the last seen CRO.
  const ctxCmd = (xcpPending ? xcpPending.pid : (xcpLastCmd ? xcpLastCmd.pid : null));
  const dec = xcpDecodeDto(data, ctxCmd);

  if (xcpPending && (pid === 0xFF || pid === 0xFE)) {
    const p = xcpPending; xcpPending = null;
    if (p.timer) clearTimeout(p.timer);
    if (p.onResp) p.onResp(pid === 0xFF, dec, Array.from(data));
    xcpUpdateButtons();
  }
  xcpPushLog({ ts, dir: 'dto', id: frame.id, data: Array.from(data),
    cls: dec.cls, type: dec.type === 'res' ? 'RES' : dec.type === 'err' ? 'ERR' : dec.type === 'daq' ? 'DAQ' : dec.type.toUpperCase(),
    summary: dec.summary, isDaq: dec.type === 'daq' });
}

// Coalesce a fast DAQ stream into one updating row so it can't flood the DOM.
function xcpPushLog(e) {
  const last = xcpLog[xcpLog.length - 1];
  if (e.isDaq && last && last.isDaq && last.id === e.id && (e.ts - last.ts) < XCP_DAQ_COALESCE_MS) {
    last.ts = e.ts; last.data = e.data; last.daqCount = (last.daqCount || 1) + 1;
    last.summary = e.summary; xcpDirty = true; return;
  }
  xcpLog.push(e);
  if (xcpLog.length > XCP_LOG_MAX) xcpLog.shift();
  xcpDirty = true;
}

function xcpClear() {
  xcpLog = []; xcpLastCmd = null;
  XCP.connected = false; XCP.resource = XCP.commModeBasic = XCP.maxCto = XCP.maxDto = null;
  XCP.protoVer = XCP.transVer = XCP.sessionStatus = XCP.protection = null; XCP.byteOrder = 'le';
  xcpStopDemoDaq();
  xcpDirty = true;
}

// ── Active master ─────────────────────────────────────────────────────────────
function xcpReady() { return !!(window.fuzzBusReady && window.fuzzBusReady()) && !document.getElementById('listenOnly').checked; }

// Send a CRO and await its RES/ERR. opts.onResp(ok, dec, raw) fires on response.
async function xcpSend(bytes, label, opts = {}) {
  if (!xcpReady()) { xcpReadout(label + ': bus not ready (connect/Demo, and disable listen-only)', true); return; }
  if (xcpPending) { xcpReadout('busy — one XCP transaction at a time', true); return; }
  if (window.fuzzBusPaused && window.fuzzBusPaused()) {
    xcpReadout('⚠ Bus is paused — command sent but no response can be received while paused', true);
  }
  const ok = await window.fuzzTxFrame(xcpCfg.cro, xcpCfg.isExt, bytes.length, bytes);
  if (!ok) { xcpReadout(label + ': TX failed (bus closed?)', true); return; }
  xcpLastCmd = { pid: bytes[0], data: bytes.slice(), ts: Date.now() };
  xcpPushLog({ ts: Date.now(), dir: 'cro', id: xcpCfg.cro, data: bytes.slice(), cls: '', type: XCP_CMD[bytes[0]] || 'CMD', summary: xcpDecodeCmd(bytes).summary });
  xcpPending = {
    pid: bytes[0], label,
    onResp: opts.onResp,
    timer: setTimeout(() => {
      xcpPending = null;
      xcpReadout(label + ': timeout (no response)', true);
      xcpPushLog({ ts: Date.now(), dir: 'dto', id: xcpCfg.dto, data: [], cls: 'err', type: 'TIMEOUT', summary: label + ' timed out' });
      xcpUpdateButtons();
    }, XCP_TIMEOUT),
  };
  xcpUpdateButtons();
  // Demo slave: when global Demo mode is on, fabricate a plausible DTO response.
  if (window.xcpDemoActive && window.xcpDemoActive()) setTimeout(() => xcpDemoRespond(bytes), 20);
}

function xcpConnect()      { xcpConnectedUI = true; xcpUpdateConnectUI(); xcpSend([0xFF, 0x00], 'CONNECT', { onResp: (ok) => xcpReadout(ok ? 'connected' : 'CONNECT rejected', !ok) }); }
function xcpDisconnect()   { xcpStopDemoDaq(); xcpSend([0xFE], 'DISCONNECT', { onResp: (ok) => { if (ok) { XCP.connected = false; xcpDirty = true; } xcpReadout(ok ? 'disconnected' : 'DISCONNECT rejected', !ok); } }); xcpConnectedUI = false; xcpUpdateConnectUI(); }
function xcpGetStatus()    { xcpSend([0xFD], 'GET_STATUS', { onResp: (ok, d) => xcpReadout(ok ? d.summary : 'GET_STATUS rejected', !ok) }); }
function xcpCommModeInfo() { xcpSend([0xFB], 'GET_COMM_MODE_INFO', { onResp: (ok, d) => xcpReadout(ok ? d.summary : 'rejected', !ok) }); }
function xcpGetId() {
  const t = parseInt(document.getElementById('xcpIdType').value) || 0;
  xcpSend([0xFA, t], 'GET_ID', { onResp: (ok, d, raw) => {
    if (!ok) { xcpReadout('GET_ID rejected', true); return; }
    const mode = raw[1] || 0;
    const rawLen = xcpReadU32(raw, 4, xcpBE()) || 0;
    if (rawLen === 0) { xcpReadout('GET_ID · empty (length 0)', false); return; }
    if (mode & 0x02) {  // TRANSFER_MODE set → ID embedded in the response, not via UPLOAD
      xcpReadout(`GET_ID · embedded transfer mode · ${rawLen} bytes (no UPLOAD)`, false); return;
    }
    // Normal case: GET_ID set the MTA; read the ID with UPLOAD (MTA auto-advances).
    // Clamp so a garbage/wrong-byte-order length can't spin a runaway UPLOAD loop.
    const len = Math.min(rawLen, XCP_GETID_MAX);
    xcpReadout(`GET_ID · reading ${len}${len < rawLen ? ' of ' + rawLen : ''} byte ID via UPLOAD…`, false);
    xcpReadIdViaUpload(len, []);
  } });
}

// Sequentially UPLOAD the GET_ID identification (≤ MAX_DTO−1 bytes per response on CAN).
function xcpReadIdViaUpload(remaining, acc) {
  const cap = Math.min((XCP.maxDto || 8) - 1, 7);
  const chunk = Math.min(remaining, cap);
  xcpSend([0xF5, chunk], 'UPLOAD (GET_ID)', { onResp: (ok, d, raw) => {
    if (!ok) { xcpReadout('GET_ID UPLOAD rejected: ' + (d.summary || ''), true); return; }
    const got = raw.slice(1, 1 + chunk);
    const all = acc.concat(got);
    const left = remaining - got.length;
    if (left > 0 && got.length > 0) { xcpReadIdViaUpload(left, all); return; }
    const ascii = all.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    xcpReadout(`GET_ID = "${ascii}"  (${all.length} bytes)`, false);
  } });
}
function xcpGetDaqInfo()   { xcpSend([0xDA], 'GET_DAQ_PROCESSOR_INFO', { onResp: (ok, d) => xcpReadout(ok ? d.summary : 'rejected', !ok) }); }
function xcpDaqStart()     { xcpSend([0xDD, 0x01], 'START_STOP_SYNCH (start)', { onResp: (ok) => xcpReadout(ok ? 'DAQ start acknowledged' : 'rejected', !ok) }); }
function xcpDaqStop()      { xcpStopDemoDaq(); xcpSend([0xDD, 0x00], 'START_STOP_SYNCH (stop)', { onResp: (ok) => xcpReadout(ok ? 'DAQ stop acknowledged' : 'rejected', !ok) }); }

function xcpReadMem() {
  const addr = xcpParseInt(document.getElementById('xcpReadAddr').value);
  const len = parseInt(document.getElementById('xcpReadLen').value) || 0;
  if (!Number.isFinite(addr)) { xcpReadout('read: invalid address', true); return; }
  if (len < 1 || len > 255) { xcpReadout('read: length must be 1–255', true); return; }
  const be = xcpBE();
  const bytes = [0xF4, len, 0x00, 0x00, ...xcpU32Bytes(addr, be)];   // SHORT_UPLOAD
  xcpSend(bytes, 'SHORT_UPLOAD', { onResp: (ok, d) => {
    if (ok && d.uploadBytes) xcpReadout(`@${xcpH(addr, 8)}: ${xcpHexBytes(d.uploadBytes)}`);
    else xcpReadout('read rejected: ' + (d.summary || ''), true);
  } });
}

function xcpWriteMem() {
  const addr = xcpParseInt(document.getElementById('xcpWriteAddr').value);
  const hex = (document.getElementById('xcpWriteData').value || '').trim().replace(/0x/gi, '').replace(/[\s,]+/g, ' ').trim();
  if (!Number.isFinite(addr)) { xcpReadout('write: invalid address', true); return; }
  const parts = hex.length ? hex.split(' ') : [];
  const bytes = parts.map(p => parseInt(p, 16));
  if (!bytes.length || bytes.some(b => !Number.isFinite(b) || b < 0 || b > 255)) { xcpReadout('write: invalid data bytes', true); return; }
  if (bytes.length > 5) { xcpReadout('write: max 5 bytes per DOWNLOAD here (single CTO)', true); return; }
  const be = xcpBE();
  xcpSend([0xF6, 0x00, 0x00, 0x00, ...xcpU32Bytes(addr, be)], 'SET_MTA', { onResp: (ok) => {
    if (!ok) { xcpReadout('write: SET_MTA rejected', true); return; }
    xcpSend([0xF0, bytes.length, ...bytes], 'DOWNLOAD', { onResp: (ok2, d2) => xcpReadout(ok2 ? `wrote ${bytes.length} byte(s) @${xcpH(addr, 8)}` : 'DOWNLOAD rejected: ' + (d2.summary || ''), !ok2) });
  } });
}

function xcpReadout(msg, isErr) {
  const el = document.getElementById('xcp-readout');
  if (el) { el.textContent = msg; el.classList.toggle('err', !!isErr); }
}

// ── Demo XCP slave (active only when global Demo mode is on) ───────────────────
function xcpDemoRespond(cmd) {
  const pid = cmd[0]; const be = false;   // demo slave is little-endian
  let resp;
  switch (pid) {
    case 0xFF: resp = [0xFF, 0x15, 0x00, 0x08, 0x08, 0x00, 0x01, 0x01]; break; // CONNECT: CAL/PAG+DAQ+PGM, LE, MAX_CTO 8, MAX_DTO 8, v1/v1
    case 0xFD: resp = [0xFF, 0x00, 0x00, 0x00, 0x34, 0x12]; break;              // GET_STATUS
    case 0xFB: resp = [0xFF, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01]; break;  // COMM_MODE_INFO
    case 0xFA: {                                                                // GET_ID: set MTA at the ID, return length; master reads it via UPLOAD
      const idStr = (cmd[1] === 1) ? 'ECU_SIM.A2L' : 'sloppyCAN XCP demo';
      xcpDemoUploadQueue = [...idStr].map(c => c.charCodeAt(0));
      const len = xcpDemoUploadQueue.length;
      resp = [0xFF, 0x00, 0x00, 0x00, len & 0xFF, (len >> 8) & 0xFF, (len >> 16) & 0xFF, (len >>> 24) & 0xFF];
      break;
    }
    case 0xF6: xcpDemoMta = xcpReadU32(cmd, 4, be) || 0; resp = [0xFF]; break;   // SET_MTA
    case 0xF0: resp = [0xFF]; break;                                            // DOWNLOAD ack
    case 0xF5: { const n = Math.min(cmd[1] || 0, 7); resp = [0xFF]; for (let k = 0; k < n; k++) { if (xcpDemoUploadQueue.length) resp.push(xcpDemoUploadQueue.shift()); else { resp.push(xcpDemoMta & 0xFF); xcpDemoMta = (xcpDemoMta + 1) >>> 0; } } break; } // UPLOAD (serves GET_ID bytes first, then pseudo)
    case 0xF4: { const n = Math.min(cmd[1] || 0, 7); const a = xcpReadU32(cmd, 4, be) || 0; resp = [0xFF]; for (let k = 0; k < n; k++) resp.push((a + k * 17 + 0x10) & 0xFF); break; } // SHORT_UPLOAD pseudo-data
    case 0xDA: resp = [0xFF, 0x00, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00]; break;   // GET_DAQ_PROCESSOR_INFO
    case 0xDD: resp = [0xFF]; if (cmd[1] === 0x01 || cmd[1] === 0x03) xcpStartDemoDaq(); else xcpStopDemoDaq(); break; // START_STOP_SYNCH
    case 0xFE: xcpStopDemoDaq(); resp = [0xFF]; break;                           // DISCONNECT
    default: resp = [0xFE, 0x13];                                               // ERR_CMD_UNKNOWN
  }
  if (window.ingestFrame) window.ingestFrame({ id: xcpCfg.dto, isExt: xcpCfg.isExt, isRtr: false, dlc: resp.length, data: resp });
}

function xcpStartDemoDaq() {
  if (xcpDemoDaqTimer) return;
  let t = 0;
  xcpDemoDaqTimer = setInterval(() => {
    if (!(window.xcpDemoActive && window.xcpDemoActive())) { xcpStopDemoDaq(); return; }
    t++;
    const rpm = 800 + Math.round(600 * (1 + Math.sin(t / 8)));   // a ramping measurement
    const temp = 60 + (t % 40);
    // DAQ DTO: PID 0x00 (ODT 0) + measured bytes (rpm u16 LE, temp, counter)
    const data = [0x00, rpm & 0xFF, (rpm >> 8) & 0xFF, temp, t & 0xFF, 0, 0, 0];
    if (window.ingestFrame) window.ingestFrame({ id: xcpCfg.dto, isExt: xcpCfg.isExt, isRtr: false, dlc: 8, data });
  }, 50);
}
function xcpStopDemoDaq() { if (xcpDemoDaqTimer) { clearInterval(xcpDemoDaqTimer); xcpDemoDaqTimer = null; } }

// Stop everything (called from disconnectSerial).
function xcpStop() {
  if (xcpPending && xcpPending.timer) clearTimeout(xcpPending.timer);
  xcpPending = null; xcpStopDemoDaq();
  xcpConnectedUI = false; xcpUpdateConnectUI();
  xcpUpdateButtons();
}

// ── Config strip ──────────────────────────────────────────────────────────────
function xcpCfgChange() {
  xcpCfg.cro = xcpParseId(document.getElementById('xcpCro').value, 0x552);
  xcpCfg.dto = xcpParseId(document.getElementById('xcpDto').value, 0x553);
  xcpCfg.isExt = document.getElementById('xcpCanType').value === 'ext';
  xcpCfg.byteOrder = document.getElementById('xcpByteOrder').value;
  if (window.xcpScheduleSave) window.xcpScheduleSave();
  xcpDirty = true;
}

// ── Render ────────────────────────────────────────────────────────────────────
// Reveal the action buttons only after Connect; Disconnect / bus close collapses.
function xcpUpdateConnectUI() {
  const c = document.getElementById('xcp-controls');
  if (c) c.classList.toggle('xcp-connected', xcpConnectedUI);
}

function xcpClearLog() { xcpLog = []; xcpDirty = true; xcpRender(); }

function xcpUpdateButtons() {
  const ready = xcpReady() && !xcpPending;
  document.querySelectorAll('#xcpWrap .xcp-tx-btn').forEach(b => { b.disabled = !ready; });
  const flag = document.getElementById('xcpDemoFlag');
  if (flag) flag.style.display = (window.xcpDemoActive && window.xcpDemoActive()) ? '' : 'none';
}

function xcpRender() {
  const wrap = document.getElementById('xcpWrap');
  if (!wrap || wrap.style.display === 'none') { xcpWasHidden = true; return; }
  if (xcpWasHidden) { xcpWasHidden = false; xcpDirty = true; }
  xcpUpdateButtons();
  if (!xcpDirty) return;
  xcpDirty = false;
  xcpRenderSession();
  xcpRenderLog();
}

function xcpTile(label, val) {
  return `<div class="xcp-tile"><div class="xt-label">${label}</div><div class="xt-val">${val}</div></div>`;
}

function xcpRenderSession() {
  const el = document.getElementById('xcp-sessioninfo');
  if (!el) return;
  if (!XCP.connected) {
    el.innerHTML = '<div class="xcp-empty">Not connected.<br>' +
      'Set the CRO/DTO IDs above, then click <b>Connect</b>.<br>' +
      'With <b>Demo</b> mode on, a simulated XCP slave answers — no hardware needed.</div>';
    return;
  }
  const res = XCP_RESOURCE.map(r => `<span class="xcp-chip${(XCP.resource & (1 << r.bit)) ? ' on' : ''}">${r.label}</span>`).join('');
  const show = v => (v == null ? '—' : v);
  el.innerHTML = `
    <div style="margin-bottom:4px"><span class="xcp-state conn">Connected</span></div>
    <div class="xcp-tiles">
      ${xcpTile('MAX_CTO', show(XCP.maxCto))}
      ${xcpTile('MAX_DTO', show(XCP.maxDto))}
      ${xcpTile('Byte order', (xcpBE() ? 'Big-endian' : 'Little-endian'))}
      ${xcpTile('Protocol ver', XCP.protoVer == null ? '—' : xcpH(XCP.protoVer))}
      ${xcpTile('Transport ver', XCP.transVer == null ? '—' : xcpH(XCP.transVer))}
      ${xcpTile('Session status', XCP.sessionStatus == null ? '—' : xcpH(XCP.sessionStatus))}
      ${xcpTile('Protection', XCP.protection == null ? '—' : xcpH(XCP.protection))}
    </div>
    <div class="xcp-chips-title">Slave resources <span style="color:var(--text3);font-weight:400">(CONNECT byte 1)</span></div>
    <div>${res}</div>`;
}

function xcpRenderLog() {
  const el = document.getElementById('xcp-log');
  if (!el) return;
  if (!xcpLog.length) { el.innerHTML = '<div class="xcp-empty">No XCP frames yet.<br>Commands ride the CRO ID, responses + DAQ ride the DTO ID.</div>'; return; }
  el.innerHTML = `<table class="xcp-tbl">
    <thead><tr><th>Time</th><th>Dir</th><th>ID</th><th>Type</th><th>Bytes</th><th>Decoded</th></tr></thead><tbody>` +
    [...xcpLog].reverse().map(e => {
      const dirLbl = e.dir === 'cro' ? '▲ CRO' : '▼ DTO';
      const cnt = e.daqCount && e.daqCount > 1 ? ` <span style="color:var(--text3)">×${e.daqCount}</span>` : '';
      return `<tr>
        <td class="xc-ts">${xcpRelTs(e.ts)}</td>
        <td class="xc-dir ${e.dir}">${dirLbl}</td>
        <td class="xc-id">${xcpH(e.id, e.id > 0x7FF ? 8 : 3)}</td>
        <td class="xc-type ${e.cls}">${e.type}</td>
        <td class="xc-raw">${e.data.length ? xcpHexBytes(e.data) : '—'}</td>
        <td class="xc-dec">${e.summary || ''}${cnt}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

function xcpOnShow() {
  document.getElementById('xcpCro').value = xcpHexId(xcpCfg.cro);
  document.getElementById('xcpDto').value = xcpHexId(xcpCfg.dto);
  document.getElementById('xcpCanType').value = xcpCfg.isExt ? 'ext' : 'std';
  document.getElementById('xcpByteOrder').value = xcpCfg.byteOrder;
  xcpUpdateConnectUI();
  xcpDirty = true; xcpRender();
}

// ── Render loop ───────────────────────────────────────────────────────────────
(function loop() {
  const now = Date.now();
  if (now - xcpLastTick >= 1000) { xcpDirty = true; xcpLastTick = now; }  // tick relative timestamps
  xcpRender();
  requestAnimationFrame(loop);
})();

// ── Persistence ───────────────────────────────────────────────────────────────
function xcpCollect() { return { cro: xcpCfg.cro, dto: xcpCfg.dto, isExt: xcpCfg.isExt, byteOrder: xcpCfg.byteOrder }; }
function xcpApply(p) {
  p = p || {};
  xcpCfg.cro = typeof p.cro === 'number' ? p.cro : 0x552;
  xcpCfg.dto = typeof p.dto === 'number' ? p.dto : 0x553;
  xcpCfg.isExt = !!p.isExt;
  xcpCfg.byteOrder = p.byteOrder || 'auto';
  // Reflect into the DOM if the tab markup is present.
  if (document.getElementById('xcpCro')) {
    document.getElementById('xcpCro').value = xcpHexId(xcpCfg.cro);
    document.getElementById('xcpDto').value = xcpHexId(xcpCfg.dto);
    document.getElementById('xcpCanType').value = xcpCfg.isExt ? 'ext' : 'std';
    document.getElementById('xcpByteOrder').value = xcpCfg.byteOrder;
  }
  xcpDirty = true;
}

// ── Exports ───────────────────────────────────────────────────────────────────
window.xcpIngestFrame = xcpIngestFrame;
window.xcpClear = xcpClear;
window.xcpStop = xcpStop;
window.xcpOnShow = xcpOnShow;
window.xcpClearLog = xcpClearLog;
window.xcpCfgChange = xcpCfgChange;
window.xcpConnect = xcpConnect;
window.xcpDisconnect = xcpDisconnect;
window.xcpGetStatus = xcpGetStatus;
window.xcpCommModeInfo = xcpCommModeInfo;
window.xcpGetId = xcpGetId;
window.xcpReadMem = xcpReadMem;
window.xcpWriteMem = xcpWriteMem;
window.xcpGetDaqInfo = xcpGetDaqInfo;
window.xcpDaqStart = xcpDaqStart;
window.xcpDaqStop = xcpDaqStop;
window.xcpCollect = xcpCollect;
window.xcpApply = xcpApply;
if (window._xcpPending) xcpApply(window._xcpPending);
