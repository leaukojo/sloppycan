// ── CANopen (CiA 301) ─────────────────────────────────────────────────────────
// Self-contained module: passive decode of CANopen traffic + an active client
// (SDO read/write, NMT control, SYNC). All CANopen state, decode tables, and
// rendering live here. Same revertable bolt-on pattern as xcp.js / chademo.js.
//
// CANopen rides 11-bit "COB-IDs": id = (functionCode << 7) | nodeId. The function
// code (top 4 bits) + the SYNC/EMCY split at 0x080 select the message type; the
// low 7 bits are the node-ID (1..127, 0 = broadcast in NMT). One bus carries NMT,
// SYNC, EMCY, TPDO/RPDO, SDO, and heartbeat for up to 127 nodes.
//
// INTEGRATION POINTS — the only changes required in the main files:
//   sloppycan.js  ingestFrame(), after the xcp hook:
//     if (window.canopenIngestFrame) canopenIngestFrame(frame);
//   sloppycan.js  clearFrames(), at end:  if (window.canopenClear) canopenClear();
//   sloppycan.js  disconnectSerial():     if (window.canopenStop) window.canopenStop();
//   sloppycan.js  startup:  window.canopenScheduleSave = scheduleSave;
//                           window.canopenDemoActive = () => demoMode;
//   sloppycan.js  switchViewTab(): canopen tab toggle + wrap show/hide + canopenOnShow()
//   sloppycan.js  persistence: defaultWorkspaceData/collectSettings/applySettings 'canopen' key
//   index.html    view-tabs button + #canopenWrap content + <script src="canopen.js" defer>
//
// Active TX goes only through window.fuzzTxFrame (no transport code here).
// To REVERT: delete this file + canopen-explainer.html and the seams above.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.co-note {
  background:var(--bg2); border-bottom:1px solid var(--border);
  padding:8px 16px; font-size:11px; color:var(--text2); font-family:var(--sans);
  display:flex; align-items:center; gap:14px; flex-shrink:0; line-height:1.5;
}
.co-note a { color:var(--blue); text-decoration:none; white-space:nowrap; margin-left:auto; }
.co-config {
  background:var(--bg2); border-bottom:1px solid var(--border);
  padding:7px 16px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;
  flex-shrink:0; font-family:var(--sans); font-size:11px; color:var(--text2);
}
.co-config label { display:flex; align-items:center; gap:5px; }
.co-config input {
  background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:5px; font-family:var(--mono); font-size:11px; padding:3px 6px; outline:none; width:74px;
}
.co-demo-flag {
  margin-left:auto; font-size:10px; padding:3px 9px; border-radius:11px;
  background:var(--amber-dim); color:var(--amber); font-family:var(--sans); white-space:nowrap;
}
.co-stab {
  background:transparent; border:none; border-bottom:2px solid transparent;
  color:var(--text2); cursor:pointer; font-family:var(--sans); font-size:12px;
  font-weight:500; padding:8px 14px; transition:color .15s,border-color .15s;
}
.co-stab:hover { color:var(--text); }
.co-stab.active { color:var(--green); border-bottom-color:var(--green); }
.co-controls {
  padding:14px 20px; display:flex; flex-direction:column; gap:11px;
  border-top:1px solid var(--border); flex-shrink:0;
}
.co-btn-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.co-btn {
  font-size:11.5px; padding:5px 12px; background:var(--bg2); color:var(--text2);
  border:1px solid var(--border); border-radius:6px; cursor:pointer;
  font-family:var(--sans); white-space:nowrap; transition:background .15s,color .15s;
}
.co-btn:hover:not(:disabled) { background:var(--bg3); color:var(--text); }
.co-btn:disabled { opacity:.4; cursor:not-allowed; }
.co-btn.go     { background:var(--green-dim); color:var(--green); border-color:transparent; }
.co-btn.danger { background:var(--red-dim);   color:var(--red);   border-color:transparent; }
.co-form { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-family:var(--sans); font-size:11px; color:var(--text2); }
.co-form label { display:flex; align-items:center; gap:5px; }
.co-form input {
  background:var(--bg3); border:1px solid var(--border); color:var(--text);
  border-radius:5px; font-family:var(--mono); font-size:11px; padding:4px 7px; outline:none; width:64px;
}
.co-form .grp-title {
  font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); min-width:84px;
}
.co-readout {
  font-family:var(--mono); font-size:11px; color:var(--green); padding:2px 0 0 84px;
  word-break:break-all; min-height:14px;
}
.co-readout.err { color:var(--red); }
.co-nodes { padding:14px 20px 4px; }
.co-empty { text-align:center; color:var(--text3); font-size:12px; padding:36px 0; font-family:var(--sans); line-height:1.6; }
.co-chip { display:inline-block; padding:2px 10px; border-radius:11px; font-size:11px; font-weight:600;
  font-family:var(--sans); background:var(--bg2); color:var(--text3); border:1px solid var(--border); }
.co-chip.oper  { background:var(--green-dim); color:var(--green); border-color:transparent; }
.co-chip.preop { background:var(--amber-dim); color:var(--amber); border-color:transparent; }
.co-chip.stop  { background:var(--red-dim);   color:var(--red);   border-color:transparent; }
.co-chip.boot  { background:var(--bg3);        color:var(--text2); }
.co-tag { display:inline-block; padding:1px 6px; margin-right:3px; border-radius:7px;
  font-size:9px; font-family:var(--sans); background:var(--bg3); color:var(--text3); }
.co-tbl { width:100%; border-collapse:collapse; font-size:11.5px; }
.co-tbl th {
  text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text3); padding:5px 8px; border-bottom:1px solid var(--border);
  font-weight:500; font-family:var(--sans); white-space:nowrap; background:var(--bg2); cursor:default;
}
.co-tbl td { padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top; color:var(--text2); font-family:var(--mono); }
.co-tbl tr:last-child td { border-bottom:none; }
.co-tbl td.co-ts  { color:var(--text3); font-size:10px; white-space:nowrap; }
.co-tbl td.co-id  { color:var(--blue); white-space:nowrap; }
.co-tbl td.co-node{ color:var(--text2); white-space:nowrap; text-align:center; }
.co-tbl td.co-type{ font-family:var(--sans); white-space:nowrap; }
.co-tbl td.co-type.emcy { color:var(--red); }
.co-tbl td.co-type.sdo  { color:var(--purple); }
.co-tbl td.co-type.hb   { color:var(--green); }
.co-tbl td.co-type.nmt  { color:var(--amber); }
.co-tbl td.co-type.pdo  { color:var(--text2); }
.co-tbl td.co-raw { color:var(--text3); font-size:10px; letter-spacing:.03em; }
.co-tbl td.co-dec { color:var(--text2); font-size:10.5px; font-family:var(--sans); }
.co-tbl tr.emcy-row td { background:var(--red-dim); }
`;
  document.head.appendChild(s);
})();

// ── Decode tables (CiA 301) ───────────────────────────────────────────────────
const CO_NMT_CMD = { 0x01:'Start (→Operational)', 0x02:'Stop (→Stopped)', 0x80:'Enter Pre-Operational',
  0x81:'Reset Node', 0x82:'Reset Communication' };
// NMT command → resulting node state byte (for updating the node map / Demo node)
const CO_NMT_TO_STATE = { 0x01:0x05, 0x02:0x04, 0x80:0x7F, 0x81:0x00, 0x82:0x00 };
const CO_NMT_STATE = { 0x00:'Boot-up', 0x04:'Stopped', 0x05:'Operational', 0x7F:'Pre-Operational' };
const CO_STATE_CLASS = { 0x00:'boot', 0x04:'stop', 0x05:'oper', 0x7F:'preop' };

// EMCY error-code class by high byte; full-code specials override.
const CO_EMCY_CLASS = { 0x00:'No error / reset', 0x10:'Generic', 0x20:'Current', 0x30:'Voltage',
  0x40:'Temperature', 0x50:'Device hardware', 0x60:'Device software', 0x70:'Additional modules',
  0x80:'Monitoring / communication', 0x90:'External error', 0xF0:'Additional functions', 0xFF:'Device specific' };
const CO_EMCY_SPECIAL = { 0x0000:'Error reset / no error', 0x8110:'CAN overrun', 0x8120:'CAN error passive',
  0x8130:'Life-guard / heartbeat error', 0x8140:'Recovered from bus-off', 0x8150:'CAN-ID collision' };
const CO_EMCY_REG_BITS = [ { bit:0, label:'generic' }, { bit:1, label:'current' }, { bit:2, label:'voltage' },
  { bit:3, label:'temperature' }, { bit:4, label:'communication' }, { bit:5, label:'device-profile' },
  { bit:7, label:'manufacturer' } ];

// SDO abort codes (CiA 301 §7.2.4.3.17) — the common ones.
const CO_SDO_ABORT = {
  0x05030000:'Toggle bit not alternated', 0x05040000:'SDO protocol timed out',
  0x05040001:'Invalid/unknown command specifier', 0x05040002:'Invalid block size',
  0x05040005:'Out of memory', 0x06010000:'Unsupported object access',
  0x06010001:'Attempt to read a write-only object', 0x06010002:'Attempt to write a read-only object',
  0x06020000:'Object does not exist in the dictionary', 0x06040041:'Object cannot be mapped to PDO',
  0x06040042:'Mapped objects exceed PDO length', 0x06060000:'Access failed (hardware error)',
  0x06070010:'Data type / length mismatch', 0x06070012:'Data type mismatch (length too high)',
  0x06070013:'Data type mismatch (length too low)', 0x06090011:'Sub-index does not exist',
  0x06090030:'Value range exceeded', 0x06090031:'Value too high', 0x06090032:'Value too low',
  0x08000000:'General error', 0x08000020:'Data cannot be transferred/stored',
  0x08000022:'Data cannot be transferred (device state)',
};

// ── State ─────────────────────────────────────────────────────────────────────
const coCfg = { node: 1, sdoTimeout: 1000, sdoReqId: null, sdoRspId: null };
const coNodes = new Map();   // nodeId -> { state, lastSeen, types:Set }
let coLog = [];
let coPending = null;        // single in-flight SDO transaction { node, kind, rspId, ... timer }
let coSessionConfirmed = false;
let coSubActive = 'nodes';
let coDirty = false;
let coWasHidden = true;
let coLastTick = 0;
const CO_LOG_MAX = 600;
const CO_PDO_COALESCE_MS = 120;

// Demo node state
let coDemoTimer = null;
let coDemoNodeState = { 5: 0x05, 8: 0x7F };   // heartbeat states for the two fake nodes
let coDemoSeg = null;                          // active segmented-upload source for the Demo SDO server
let coDemoTick = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function coH(v, w = 2) { return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0'); }
function coRelTs(ts) {
  const s = (Date.now() - ts) / 1000;
  return s < 1 ? 'now' : s < 60 ? s.toFixed(1) + 's ago' : Math.round(s / 60) + 'm ago';
}
function coHexBytes(data) { return Array.from(data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '); }
function coParseId(str) { const v = parseInt((str || '').replace(/^0x/i, ''), 16); return Number.isFinite(v) ? v : null; }
function coParseInt(str) {
  const t = (str || '').trim();
  const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, /^[0-9a-f]+$/i.test(t) && /[a-f]/i.test(t) ? 16 : 10);
  return Number.isFinite(v) ? v >>> 0 : NaN;
}
function coU32(d, i) { return ((d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0); }
function coSdoReqId(node) { return Number.isFinite(coCfg.sdoReqId) && coCfg.sdoReqId != null ? coCfg.sdoReqId : (0x600 + node); }
function coSdoRspId(node) { return Number.isFinite(coCfg.sdoRspId) && coCfg.sdoRspId != null ? coCfg.sdoRspId : (0x580 + node); }
function coAscii(bytes) { return bytes.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join(''); }

// ── COB-ID classification (predefined connection set) ─────────────────────────
function coClassify(id) {
  if (id === 0x000) return { node: 0, type: 'NMT', kind: 'nmt' };
  if (id === 0x7E4) return { node: 0, type: 'LSS (slave)', kind: 'lss' };
  if (id === 0x7E5) return { node: 0, type: 'LSS (master)', kind: 'lss' };
  const node = id & 0x7F;
  const fc = (id >> 7) & 0xF;
  switch (fc) {
    case 0x1: return node === 0 ? { node: 0, type: 'SYNC', kind: 'sync' } : { node, type: 'EMCY', kind: 'emcy' };
    case 0x2: return { node, type: 'TIME', kind: 'time' };
    case 0x3: return { node, type: 'TPDO1', kind: 'pdo' };
    case 0x4: return { node, type: 'RPDO1', kind: 'pdo' };
    case 0x5: return { node, type: 'TPDO2', kind: 'pdo' };
    case 0x6: return { node, type: 'RPDO2', kind: 'pdo' };
    case 0x7: return { node, type: 'TPDO3', kind: 'pdo' };
    case 0x8: return { node, type: 'RPDO3', kind: 'pdo' };
    case 0x9: return { node, type: 'TPDO4', kind: 'pdo' };
    case 0xA: return { node, type: 'RPDO4', kind: 'pdo' };
    case 0xB: return { node, type: 'SDO tx', kind: 'sdo_tx' };
    case 0xC: return { node, type: 'SDO rx', kind: 'sdo_rx' };
    case 0xE: return { node, type: 'Heartbeat', kind: 'hb' };
    default:  return { node, type: coH(id, 3), kind: 'other' };
  }
}

// ── Per-type decoders ─────────────────────────────────────────────────────────
function coDecodeNmt(d) {
  const cmd = CO_NMT_CMD[d[0]] || ('command ' + coH(d[0]));
  const tgt = d[1] === 0 ? 'all nodes' : 'node ' + d[1];
  // Reflect the commanded state into the node map.
  const st = CO_NMT_TO_STATE[d[0]];
  if (st != null) {
    if (d[1] === 0) coNodes.forEach(n => { n.state = st; });
    else { const n = coNodeFor(d[1]); n.state = st; }
  }
  return cmd + ' → ' + tgt;
}

function coDecodeHb(node, d) {
  const st = d[0] & 0x7F;
  const n = coNodeFor(node);
  n.state = st;
  return CO_NMT_STATE[st] || ('state ' + coH(st));
}

function coEmcyClassOf(code) {
  if (CO_EMCY_SPECIAL[code]) return CO_EMCY_SPECIAL[code];
  return CO_EMCY_CLASS[(code >> 8) & 0xFF] || 'Unknown';
}
function coDecodeEmcy(d) {
  const code = d[0] | (d[1] << 8);
  const reg = d[2];
  const bits = CO_EMCY_REG_BITS.filter(b => reg & (1 << b.bit)).map(b => b.label).join(', ') || 'none';
  const manuf = coHexBytes(d.slice(3, 8));
  return `code ${coH(code, 4)} (${coEmcyClassOf(code)}) · reg ${coH(reg)} [${bits}] · mfr ${manuf}`;
}

// SDO decode. dir: 'rx' = client→server (request, 0x600+n) | 'tx' = server→client (response, 0x580+n).
function coDecodeSdo(d, dir) {
  const cs = d[0];
  const idx = d[1] | (d[2] << 8);
  const sub = d[3];
  const loc = `${coH(idx, 4)}/${coH(sub)}`;
  if (cs === 0x80) {                                   // abort (both directions)
    const ac = coU32(d, 4);
    return { kind: 'abort', idx, sub, summary: `ABORT ${loc} · ${CO_SDO_ABORT[ac] || coH(ac, 8)}`, abort: ac };
  }
  const ccs = (cs >> 5) & 0x7;
  if (dir === 'rx') {                                  // requests
    if (cs === 0x40) return { kind: 'upreq', idx, sub, summary: `Read req ${loc}` };
    if (ccs === 1) {                                   // download (write)
      if (cs & 0x02) { const size = (cs & 0x01) ? 4 - ((cs >> 2) & 0x3) : 4; return { kind: 'dlreq', idx, sub, summary: `Write req ${loc} = ${coExpVal(d, size)}` }; }
      return { kind: 'dlinit', idx, sub, summary: `Write init ${loc} · ${coU32(d, 4)} bytes (segmented)` };
    }
    if (ccs === 0) return { kind: 'dlseg', summary: 'Download segment' };
    if (ccs === 3) return { kind: 'upsegreq', summary: 'Upload segment request' };
    return { kind: 'sdo', summary: `${loc} cs ${coH(cs)}` };
  } else {                                             // responses
    if (ccs === 2) {                                   // upload response
      if (cs & 0x02) { const size = (cs & 0x01) ? 4 - ((cs >> 2) & 0x3) : 4; return { kind: 'upresp', idx, sub, size, summary: `Read resp ${loc} = ${coExpVal(d, size)}` }; }
      return { kind: 'upinit', idx, sub, total: coU32(d, 4), summary: `Read init ${loc} · ${coU32(d, 4)} bytes (segmented)` };
    }
    if (ccs === 3) return { kind: 'dlresp', idx, sub, summary: `Write confirm ${loc}` };
    if (ccs === 0) return { kind: 'upseg', summary: 'Upload segment' };
    if (ccs === 1) return { kind: 'dlsegresp', summary: 'Download segment resp' };
    return { kind: 'sdo', summary: `${loc} cs ${coH(cs)}` };
  }
}
function coExpVal(d, size) {
  if (!size || size < 1 || size > 4) size = 4;
  let v = 0; for (let i = 0; i < size; i++) v |= (d[4 + i] << (8 * i));
  v = v >>> 0;
  return `0x${v.toString(16).toUpperCase()} (${v})`;
}

function coNodeFor(node) {
  let n = coNodes.get(node);
  if (!n) { n = { state: null, lastSeen: 0, types: new Set() }; coNodes.set(node, n); }
  return n;
}

// ── Ingest hook ───────────────────────────────────────────────────────────────
function canopenIngestFrame(frame) {
  if (frame.isExt) return;                             // CANopen is 11-bit only
  const id = frame.id, d = frame.data, ts = Date.now();
  const c = coClassify(id);
  if (c.node) { const n = coNodeFor(c.node); n.lastSeen = ts; n.types.add(coTypeBadge(c.kind)); }

  let summary = '', emcy = false;
  switch (c.kind) {
    case 'nmt':    summary = coDecodeNmt(d); break;
    case 'hb':     summary = coDecodeHb(c.node, d); break;
    case 'emcy':   summary = coDecodeEmcy(d); emcy = true; break;
    case 'sync':   summary = d.length ? 'SYNC · counter ' + d[0] : 'SYNC'; break;
    case 'time':   summary = 'TIME stamp'; break;
    case 'pdo':    summary = d.length ? coHexBytes(d) + '  (raw — no mapping)' : '(empty)'; break;
    case 'sdo_rx': summary = coDecodeSdo(Array.from(d), 'rx').summary; break;
    case 'sdo_tx': { const dec = coDecodeSdo(Array.from(d), 'tx'); summary = dec.summary; coSdoResolve(id, dec, Array.from(d)); break; }
    case 'lss':    summary = coHexBytes(d); break;
    default:       summary = coHexBytes(d);
  }
  coPushLog({ ts, id, node: c.node, kind: c.kind, type: c.type, data: Array.from(d), summary, emcy });
}

function coTypeBadge(kind) {
  return ({ pdo: 'PDO', sdo_rx: 'SDO', sdo_tx: 'SDO', emcy: 'EMCY', hb: 'HB', nmt: 'NMT', sync: 'SYNC' })[kind] || '';
}

function coPushLog(e) {
  const last = coLog[coLog.length - 1];
  if (e.kind === 'pdo' && last && last.kind === 'pdo' && last.id === e.id && (e.ts - last.ts) < CO_PDO_COALESCE_MS) {
    last.ts = e.ts; last.data = e.data; last.summary = e.summary; last.count = (last.count || 1) + 1; coDirty = true; return;
  }
  coLog.push(e);
  if (coLog.length > CO_LOG_MAX) coLog.shift();
  coDirty = true;
}

function canopenClear() {
  coLog = []; coNodes.clear();
  if (coPending && coPending.timer) clearTimeout(coPending.timer);
  coPending = null; coDemoSeg = null;
  coDirty = true;
}

// ── Active client ─────────────────────────────────────────────────────────────
function coReady() { return !!(window.fuzzBusReady && window.fuzzBusReady()) && !document.getElementById('listenOnly').checked; }
function coReadout(msg, isErr) { const el = document.getElementById('co-readout'); if (el) { el.textContent = msg; el.classList.toggle('err', !!isErr); } }

function coConfirmSession() {
  if (coSessionConfirmed) return true;
  if (!confirm('Active CANopen transmits onto the bus — SDO writes change the object dictionary and ' +
    'NMT Stop halts a node\'s PDOs. Only do this on a bench/test network you control. Proceed?')) return false;
  coSessionConfirmed = true; return true;
}

// Low-level: send one frame, log it, optionally drive the Demo server.
async function coTx(id, dlc, bytes, dir, dec) {
  const ok = await window.fuzzTxFrame(id, false, dlc, bytes);
  if (!ok) return false;
  coPushLog({ ts: Date.now(), id, node: id & 0x7F, kind: dir === 'rx' ? 'sdo_rx' : 'nmt', type: coClassify(id).type, data: bytes.slice(), summary: dec });
  if (window.canopenDemoActive && window.canopenDemoActive()) setTimeout(() => coDemoServer(id, bytes), 15);
  return true;
}

function coArmTimer(node) {
  return setTimeout(() => {
    coPending = null;
    coReadout('SDO timeout (no response from node ' + node + ')', true);
    coUpdateButtons();
  }, coCfg.sdoTimeout || 1000);
}

// SDO upload (read). Resolves via coSdoResolve() in the ingest hook.
async function coSdoRead(node, index, sub) {
  if (!coReady()) { coReadout('bus not ready (connect/Demo, and disable listen-only)', true); return; }
  if (coPending) { coReadout('busy — one SDO transaction at a time', true); return; }
  if (!coConfirmSession()) return;
  const req = coSdoReqId(node);
  const dec = coDecodeSdo([0x40, index & 0xFF, (index >> 8) & 0xFF, sub], 'rx').summary;
  coPending = { node, kind: 'read', rspId: coSdoRspId(node), index, sub, seg: false, buf: [], toggle: false, timer: coArmTimer(node) };
  coReadout(`reading ${coH(index, 4)}/${coH(sub)} from node ${node}…`);
  if (!await coTx(req, 8, [0x40, index & 0xFF, (index >> 8) & 0xFF, sub, 0, 0, 0, 0], 'rx', dec)) { coSdoFail('TX failed (bus closed?)'); return; }
  coUpdateButtons();
}

// SDO download (write, expedited ≤4 bytes).
async function coSdoWrite(node, index, sub, value, size) {
  if (!coReady()) { coReadout('bus not ready (connect/Demo, and disable listen-only)', true); return; }
  if (coPending) { coReadout('busy — one SDO transaction at a time', true); return; }
  if (!coConfirmSession()) return;
  const cs = 0x23 | ((4 - size) << 2);
  const bytes = [cs, index & 0xFF, (index >> 8) & 0xFF, sub, value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >>> 24) & 0xFF];
  const req = coSdoReqId(node);
  coPending = { node, kind: 'write', rspId: coSdoRspId(node), index, sub, timer: coArmTimer(node) };
  coReadout(`writing ${coH(index, 4)}/${coH(sub)} = ${coExpVal(bytes, size)} on node ${node}…`);
  if (!await coTx(req, 8, bytes, 'rx', coDecodeSdo(bytes, 'rx').summary)) { coSdoFail('TX failed (bus closed?)'); return; }
  coUpdateButtons();
}

// Called from the ingest hook for every 0x580+node frame; advances the in-flight SDO.
function coSdoResolve(id, dec, d) {
  if (!coPending || id !== coPending.rspId) return;
  if (dec.kind === 'abort') { coSdoFail('aborted · ' + (CO_SDO_ABORT[dec.abort] || coH(dec.abort, 8))); return; }
  if (coPending.kind === 'write') {
    if (dec.kind === 'dlresp') coSdoOk(`wrote ${coH(coPending.index, 4)}/${coH(coPending.sub)} on node ${coPending.node}`);
    return;
  }
  // read
  if (dec.kind === 'upresp') { coSdoOk(`${coH(coPending.index, 4)}/${coH(coPending.sub)} = ${coExpVal(d, dec.size)}`); return; }
  if (dec.kind === 'upinit') {                         // segmented — request the first segment
    coPending.seg = true; coPending.buf = []; coPending.toggle = false; coPending.total = dec.total;
    clearTimeout(coPending.timer); coPending.timer = coArmTimer(coPending.node);
    coTx(coSdoReqId(coPending.node), 8, [0x60, 0, 0, 0, 0, 0, 0, 0], 'rx', 'Upload segment request');
    return;
  }
  if (dec.kind === 'upseg') {                          // a segment of data
    const cs = d[0]; const n = (cs >> 1) & 0x7; const last = cs & 0x01;
    const valid = 7 - n;
    for (let i = 0; i < valid; i++) coPending.buf.push(d[1 + i]);
    clearTimeout(coPending.timer); coPending.timer = coArmTimer(coPending.node);
    if (last) {
      const all = coPending.buf;
      coSdoOk(`${coH(coPending.index, 4)}/${coH(coPending.sub)} = "${coAscii(all)}" (${all.length} bytes: ${coHexBytes(all)})`);
    } else {
      coPending.toggle = !coPending.toggle;
      coTx(coSdoReqId(coPending.node), 8, [0x60 | (coPending.toggle ? 0x10 : 0), 0, 0, 0, 0, 0, 0, 0], 'rx', 'Upload segment request');
    }
  }
}
function coSdoOk(msg) { if (coPending && coPending.timer) clearTimeout(coPending.timer); coPending = null; coReadout(msg); coUpdateButtons(); }
function coSdoFail(msg) { if (coPending && coPending.timer) clearTimeout(coPending.timer); coPending = null; coReadout(msg, true); coUpdateButtons(); }

// NMT control (broadcast 0x000) — fire-and-forget.
async function coNmt(cmd, target) {
  if (!coReady()) { coReadout('bus not ready (connect/Demo, and disable listen-only)', true); return; }
  if (!coConfirmSession()) return;
  const label = (CO_NMT_CMD[cmd] || coH(cmd)) + ' → ' + (target === 0 ? 'all nodes' : 'node ' + target);
  // coDecodeNmt also updates the (Demo/real) node map for live feedback.
  coDecodeNmt([cmd, target]);
  await window.fuzzTxFrame(0x000, false, 2, [cmd, target]);
  coPushLog({ ts: Date.now(), id: 0x000, node: 0, kind: 'nmt', type: 'NMT', data: [cmd, target], summary: label });
  if (window.canopenDemoActive && window.canopenDemoActive()) coDemoApplyNmt(cmd, target);
  coReadout('NMT: ' + label);
  coDirty = true;
}

// SYNC (broadcast 0x080, 0 bytes) — fire-and-forget.
async function coSync() {
  if (!coReady()) { coReadout('bus not ready (connect/Demo, and disable listen-only)', true); return; }
  if (!coConfirmSession()) return;
  await window.fuzzTxFrame(0x080, false, 0, []);
  coPushLog({ ts: Date.now(), id: 0x080, node: 0, kind: 'sync', type: 'SYNC', data: [], summary: 'SYNC' });
  coReadout('SYNC sent'); coDirty = true;
}

function coStop() { if (coPending && coPending.timer) clearTimeout(coPending.timer); coPending = null; coStopDemo(); coUpdateButtons(); }

// ── Demo CANopen node (active only when global Demo mode is on) ─────────────────
// A small device dictionary the Demo SDO server answers from.
const CO_DEMO_OD = {
  0x1000: { sub: { 0: { exp: 0x00020191 } } },                         // device type
  0x1008: { sub: { 0: { str: 'sloppyCAN CANopen node' } } },           // device name (segmented)
  0x1018: { sub: { 1: { exp: 0x000002A1 }, 2: { exp: 0x0000000C } } }, // vendor ID / product code
  0x6000: { sub: { 1: { exp: 0x00, rw: true } } },                     // a writable example object
};

function coDemoServer(reqId, req) {
  const node = reqId & 0x7F;
  const rspId = coSdoRspId(node);
  const send = (bytes) => { if (window.ingestFrame) window.ingestFrame({ id: rspId, isExt: false, isRtr: false, dlc: 8, data: bytes }); };
  const cs = req[0];
  // Upload segment request → serve next chunk of the active string.
  if (((cs >> 5) & 0x7) === 3 && cs !== 0x40) {
    if (!coDemoSeg) return;
    const tgl = (cs >> 4) & 1;
    const remain = coDemoSeg.bytes.length - coDemoSeg.pos;
    const take = Math.min(7, remain);
    const chunk = coDemoSeg.bytes.slice(coDemoSeg.pos, coDemoSeg.pos + take);
    coDemoSeg.pos += take;
    const last = coDemoSeg.pos >= coDemoSeg.bytes.length ? 1 : 0;
    const n = 7 - take;
    const out = [(tgl << 4) | (n << 1) | last]; for (let i = 0; i < 7; i++) out.push(chunk[i] || 0);
    if (last) coDemoSeg = null;
    send(out); return;
  }
  const idx = req[1] | (req[2] << 8), sub = req[3];
  const obj = CO_DEMO_OD[idx] && CO_DEMO_OD[idx].sub[sub];
  if (cs === 0x40) {                                   // upload (read)
    if (!obj) { send([0x80, req[1], req[2], sub, 0x00, 0x00, 0x02, 0x06]); return; }   // 0x06020000
    if (obj.str != null) {                             // segmented
      const bytes = [...obj.str].map(ch => ch.charCodeAt(0));
      coDemoSeg = { bytes, pos: 0 };
      const total = bytes.length;
      send([0x41, req[1], req[2], sub, total & 0xFF, (total >> 8) & 0xFF, 0, 0]); return;
    }
    const v = obj.exp >>> 0;                            // expedited 4-byte
    send([0x43, req[1], req[2], sub, v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF]); return;
  }
  if (((cs >> 5) & 0x7) === 1) {                        // download (write)
    if (!obj) { send([0x80, req[1], req[2], sub, 0x00, 0x00, 0x02, 0x06]); return; }   // doesn't exist
    if (!obj.rw) { send([0x80, req[1], req[2], sub, 0x02, 0x00, 0x01, 0x06]); return; } // 0x06010002 read-only
    send([0x60, req[1], req[2], sub, 0, 0, 0, 0]); return;
  }
}

function coDemoApplyNmt(cmd, target) {
  const st = CO_NMT_TO_STATE[cmd]; if (st == null) return;
  if (target === 0) Object.keys(coDemoNodeState).forEach(k => coDemoNodeState[k] = st);
  else if (coDemoNodeState[target] != null) coDemoNodeState[target] = st;
}

function coStartDemo() {
  if (coDemoTimer) return;
  coDemoTimer = setInterval(() => {
    if (!(window.canopenDemoActive && window.canopenDemoActive())) { coStopDemo(); return; }
    if (!window.ingestFrame) return;
    coDemoTick++;
    // Heartbeats for the fake nodes.
    for (const k of Object.keys(coDemoNodeState)) {
      const node = +k;
      window.ingestFrame({ id: 0x700 + node, isExt: false, isRtr: false, dlc: 1, data: [coDemoNodeState[node]] });
    }
    // A TPDO1 from node 5 with changing bytes.
    const v = 800 + Math.round(400 * (1 + Math.sin(coDemoTick / 6)));
    window.ingestFrame({ id: 0x185, isExt: false, isRtr: false, dlc: 6, data: [v & 0xFF, (v >> 8) & 0xFF, coDemoTick & 0xFF, 0x00, 0x01, (coDemoTick * 3) & 0xFF] });
    // A periodic EMCY from node 8 so the decode is visible.
    if (coDemoTick % 12 === 5) window.ingestFrame({ id: 0x088, isExt: false, isRtr: false, dlc: 8, data: [0x30, 0x81, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00] });
  }, 1000);
}
function coStopDemo() { if (coDemoTimer) { clearInterval(coDemoTimer); coDemoTimer = null; } coDemoSeg = null; }

// ── Config strip ──────────────────────────────────────────────────────────────
function canopenCfgChange() {
  const node = parseInt(document.getElementById('coNode').value);
  coCfg.node = Number.isFinite(node) ? Math.max(0, Math.min(127, node)) : 1;
  const to = parseInt(document.getElementById('coSdoTimeout').value);
  coCfg.sdoTimeout = Number.isFinite(to) && to > 0 ? to : 1000;
  coCfg.sdoReqId = coParseId(document.getElementById('coSdoReq').value);
  coCfg.sdoRspId = coParseId(document.getElementById('coSdoRsp').value);
  if (window.canopenScheduleSave) window.canopenScheduleSave();
  coDirty = true;
}

// ── Render ────────────────────────────────────────────────────────────────────
function canopenSubTab(name) {
  coSubActive = name;
  ['nodes', 'log'].forEach(n => {
    document.getElementById('co-stab-' + n).classList.toggle('active', n === name);
    document.getElementById('co-' + n).style.display = n === name ? '' : 'none';
  });
  coDirty = true; coRender();
}

function coUpdateButtons() {
  const ready = coReady() && !coPending;
  document.querySelectorAll('#canopenWrap .co-tx-btn').forEach(b => { b.disabled = !ready; });
  const flag = document.getElementById('coDemoFlag');
  if (flag) flag.style.display = (window.canopenDemoActive && window.canopenDemoActive()) ? '' : 'none';
}

function coRender() {
  const wrap = document.getElementById('canopenWrap');
  if (!wrap || wrap.style.display === 'none') { coWasHidden = true; return; }
  if (coWasHidden) { coWasHidden = false; coDirty = true; }
  coUpdateButtons();
  // Demo node runs whenever Demo mode is on (independent of which tab is shown);
  // (re)start it here so frames flow as soon as the tab is opened during Demo.
  if (window.canopenDemoActive && window.canopenDemoActive()) coStartDemo();
  if (!coDirty) return;
  coDirty = false;
  if (coSubActive === 'nodes') coRenderNodes();
  else coRenderLog();
}

function coRenderNodes() {
  const el = document.getElementById('co-nodemap');
  if (!el) return;
  if (!coNodes.size) {
    el.innerHTML = '<div class="co-empty">No nodes seen yet.<br>' +
      'Heartbeats (0x700+node) and any traffic populate this map.<br>' +
      'With <b>Demo</b> mode on, two simulated nodes appear — no hardware needed.</div>';
    return;
  }
  const rows = [...coNodes.keys()].sort((a, b) => a - b).map(id => {
    const n = coNodes.get(id);
    const stName = n.state == null ? '—' : (CO_NMT_STATE[n.state] || coH(n.state));
    const cls = n.state == null ? '' : (CO_STATE_CLASS[n.state] || '');
    const tags = [...n.types].filter(Boolean).map(t => `<span class="co-tag">${t}</span>`).join('');
    return `<tr>
      <td class="co-node">${id} <span style="color:var(--text3)">(${coH(id)})</span></td>
      <td><span class="co-chip ${cls}">${stName}</span></td>
      <td class="co-ts">${n.lastSeen ? coRelTs(n.lastSeen) : '—'}</td>
      <td>${tags || '<span style="color:var(--text3)">—</span>'}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<table class="co-tbl">
    <thead><tr><th>Node</th><th>State</th><th>Last seen</th><th>Messages</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function coRenderLog() {
  const el = document.getElementById('co-log');
  if (!el) return;
  if (!coLog.length) { el.innerHTML = '<div class="co-empty">No CANopen frames yet.<br>The COB-ID (11-bit) is split into a function code + node-ID to classify each frame.</div>'; return; }
  const typeCls = { emcy: 'emcy', sdo_rx: 'sdo', sdo_tx: 'sdo', hb: 'hb', nmt: 'nmt', pdo: 'pdo' };
  el.innerHTML = `<table class="co-tbl">
    <thead><tr><th>Time</th><th>COB-ID</th><th>Node</th><th>Type</th><th>Bytes</th><th>Decoded</th></tr></thead><tbody>` +
    [...coLog].reverse().map(e => {
      const cnt = e.count && e.count > 1 ? ` <span style="color:var(--text3)">×${e.count}</span>` : '';
      return `<tr class="${e.emcy ? 'emcy-row' : ''}">
        <td class="co-ts">${coRelTs(e.ts)}</td>
        <td class="co-id">${coH(e.id, 3)}</td>
        <td class="co-node">${e.node || '—'}</td>
        <td class="co-type ${typeCls[e.kind] || ''}">${e.type}</td>
        <td class="co-raw">${e.data.length ? coHexBytes(e.data) : '—'}</td>
        <td class="co-dec">${e.summary || ''}${cnt}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

function canopenOnShow() {
  document.getElementById('coNode').value = coCfg.node;
  document.getElementById('coSdoTimeout').value = coCfg.sdoTimeout;
  document.getElementById('coSdoReq').value = coCfg.sdoReqId != null ? coH(coCfg.sdoReqId, 3) : '';
  document.getElementById('coSdoRsp').value = coCfg.sdoRspId != null ? coH(coCfg.sdoRspId, 3) : '';
  if (document.getElementById('coSdoNode')) document.getElementById('coSdoNode').value = coCfg.node;
  if (document.getElementById('coNmtNode')) document.getElementById('coNmtNode').value = coCfg.node;
  coDirty = true; coRender();
}

// ── Control handlers (called from the SDO/NMT/SYNC form buttons) ───────────────
function canopenSdoReadBtn() {
  const node = parseInt(document.getElementById('coSdoNode').value);
  const index = coParseInt(document.getElementById('coSdoIndex').value);
  const sub = coParseInt(document.getElementById('coSdoSub').value);
  if (!Number.isFinite(node) || node < 1 || node > 127) { coReadout('read: node must be 1–127', true); return; }
  if (!Number.isFinite(index) || !Number.isFinite(sub)) { coReadout('read: invalid index/sub', true); return; }
  coSdoRead(node, index & 0xFFFF, sub & 0xFF);
}
function canopenSdoWriteBtn() {
  const node = parseInt(document.getElementById('coSdoNode').value);
  const index = coParseInt(document.getElementById('coSdoIndex').value);
  const sub = coParseInt(document.getElementById('coSdoSub').value);
  const value = coParseInt(document.getElementById('coSdoValue').value);
  if (!Number.isFinite(node) || node < 1 || node > 127) { coReadout('write: node must be 1–127', true); return; }
  if (!Number.isFinite(index) || !Number.isFinite(sub) || !Number.isFinite(value)) { coReadout('write: invalid index/sub/value', true); return; }
  let size = 1; if (value > 0xFFFFFF) size = 4; else if (value > 0xFFFF) size = 3; else if (value > 0xFF) size = 2;
  if (!confirm(`Write ${coExpVal([0, 0, 0, 0, value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF, (value >>> 24) & 0xFF], size)} ` +
    `to ${coH(index & 0xFFFF, 4)}/${coH(sub & 0xFF)} on node ${node}?\nThis MODIFIES the node's object dictionary.`)) return;
  coSdoWrite(node, index & 0xFFFF, sub & 0xFF, value >>> 0, size);
}
function canopenNmtBtn(cmd) {
  const v = document.getElementById('coNmtNode').value.trim();
  const target = (v === '' || /^all$/i.test(v)) ? 0 : parseInt(v);
  if (!Number.isFinite(target) || target < 0 || target > 127) { coReadout('NMT: node must be 0 (all) or 1–127', true); return; }
  coNmt(cmd, target);
}
function canopenSyncBtn() { coSync(); }

// ── Render loop ───────────────────────────────────────────────────────────────
(function loop() {
  const now = Date.now();
  if (now - coLastTick >= 1000) { coDirty = true; coLastTick = now; }   // tick relative timestamps
  coRender();
  requestAnimationFrame(loop);
})();

// ── Persistence ───────────────────────────────────────────────────────────────
function canopenCollect() { return { node: coCfg.node, sdoTimeout: coCfg.sdoTimeout, sdoReqId: coCfg.sdoReqId, sdoRspId: coCfg.sdoRspId }; }
function canopenApply(p) {
  p = p || {};
  coCfg.node = typeof p.node === 'number' ? p.node : 1;
  coCfg.sdoTimeout = typeof p.sdoTimeout === 'number' ? p.sdoTimeout : 1000;
  coCfg.sdoReqId = typeof p.sdoReqId === 'number' ? p.sdoReqId : null;
  coCfg.sdoRspId = typeof p.sdoRspId === 'number' ? p.sdoRspId : null;
  if (document.getElementById('coNode')) canopenOnShow();
  coDirty = true;
}

// ── Exports ───────────────────────────────────────────────────────────────────
window.canopenIngestFrame = canopenIngestFrame;
window.canopenClear = canopenClear;
window.canopenStop = coStop;
window.canopenOnShow = canopenOnShow;
window.canopenSubTab = canopenSubTab;
window.canopenCfgChange = canopenCfgChange;
window.canopenSdoReadBtn = canopenSdoReadBtn;
window.canopenSdoWriteBtn = canopenSdoWriteBtn;
window.canopenNmtBtn = canopenNmtBtn;
window.canopenSyncBtn = canopenSyncBtn;
window.canopenCollect = canopenCollect;
window.canopenApply = canopenApply;
if (window._canopenPending) canopenApply(window._canopenPending);
