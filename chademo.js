// ── CHAdeMO Decoder ───────────────────────────────────────────────────────────
// Self-contained module. All CHAdeMO state and rendering lives here.
//
// CHAdeMO is DC fast-charging over a DEDICATED 500 kbit/s CAN on the charge
// connector (separate from the vehicle's main bus), using fixed 11-bit IDs
// (0x100–0x102 vehicle→charger, 0x108/0x109 charger→vehicle, plus v2.0 discharge
// 0x118/0x200–0x209). J1772 (analog Control-Pilot PWM) and ISO 15118 (PLC/IPv6)
// are NOT on CAN, so only CHAdeMO is decoded here. See ev-charging-explainer.html.
//
// INTEGRATION POINTS — the only changes required in the main files:
//   sloppycan.js  ingestFrame(), after the j1939 hook:
//     if (window.chademoIngestFrame) chademoIngestFrame(frame);
//   sloppycan.js  clearFrames(), at end:
//     if (window.chademoClear) chademoClear();
//   sloppycan.js  startup: window.ingestFrame = ingestFrame;   (used by the demo button)
//   index.html    view-tabs button + #chademoWrap content + <script src="chademo.js" defer>
//   sloppycan.js  switchViewTab(): chademo tab toggle + wrap show/hide
//
// To REVERT: delete this file + ev-charging-explainer.html, remove the seams above.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.chademo-note {
  background:var(--bg2); border-bottom:1px solid var(--border);
  padding:8px 16px; font-size:11px; color:var(--text2); font-family:var(--sans);
  display:flex; align-items:center; gap:14px; flex-shrink:0; line-height:1.5;
}
.chademo-note a { color:var(--blue); text-decoration:none; white-space:nowrap; }
.chademo-stab {
  background:transparent; border:none; border-bottom:2px solid transparent;
  color:var(--text2); cursor:pointer; font-family:var(--sans); font-size:12px;
  font-weight:500; padding:8px 14px; transition:color .15s,border-color .15s;
}
.chademo-stab:hover { color:var(--text); }
.chademo-stab.active { color:var(--green); border-bottom-color:var(--green); }
.chademo-demo-btn {
  margin-left:auto; font-size:11px; padding:4px 12px; background:var(--green-dim);
  color:var(--green); border:1px solid var(--green); border-radius:6px;
  cursor:pointer; font-family:var(--sans); white-space:nowrap;
}
.chademo-demo-btn:hover { filter:brightness(1.15); }
.chademo-state {
  display:inline-block; padding:4px 14px; border-radius:14px; font-size:13px;
  font-weight:600; font-family:var(--sans); background:var(--bg2); color:var(--text2);
  border:1px solid var(--border);
}
.chademo-state.charging { background:var(--green-dim); color:var(--green); border-color:transparent; }
.chademo-state.cap      { background:var(--blue-dim);  color:var(--blue);  border-color:transparent; }
.chademo-state.stop     { background:var(--amber-dim); color:var(--amber); border-color:transparent; }
.chademo-tiles {
  display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
  gap:12px; margin:16px 0 8px;
}
.chademo-tile {
  background:var(--bg2); border:1px solid var(--border); border-radius:10px;
  padding:12px 14px;
}
.chademo-tile .ct-label {
  font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3);
  font-family:var(--sans); margin-bottom:4px;
}
.chademo-tile .ct-val {
  font-size:22px; color:var(--green); font-family:var(--mono); line-height:1.1;
}
.chademo-tile .ct-val.muted { color:var(--text); }
.chademo-tile .ct-sub {
  font-size:11px; color:var(--text3); font-family:var(--mono); margin-top:3px;
}
.chademo-flags-title {
  font-size:12px; font-weight:600; color:var(--text); margin:18px 0 6px;
  font-family:var(--sans);
}
.chademo-chip {
  display:inline-block; padding:2px 9px; margin:3px; border-radius:11px;
  font-size:10px; font-family:var(--sans); background:var(--bg2);
  color:var(--text3); border:1px solid var(--border);
}
.chademo-chip.on.bad  { background:var(--red-dim);   color:var(--red);   border-color:transparent; }
.chademo-chip.on.good { background:var(--green-dim); color:var(--green); border-color:transparent; }
.chademo-chip.on.info { background:var(--amber-dim); color:var(--amber); border-color:transparent; }
.chademo-empty { text-align:center; color:var(--text3); font-size:12px; padding:48px 0; font-family:var(--sans); }
.chademo-tbl { width:100%; border-collapse:collapse; font-size:11.5px; }
.chademo-tbl th {
  text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text3); padding:5px 8px; border-bottom:1px solid var(--border);
  font-weight:500; font-family:var(--sans); white-space:nowrap;
  /* opaque bg on the cell (not <thead>) so the sticky header isn't see-through
     with border-collapse:collapse */
  background:var(--bg2); cursor:default; position:sticky; top:0; z-index:1;
}
.chademo-tbl td {
  padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top;
  color:var(--text2); font-family:var(--mono);
}
.chademo-tbl tr:last-child td { border-bottom:none; }
.chademo-tbl td.cm-ts  { color:var(--text3); font-size:10px; white-space:nowrap; }
.chademo-tbl td.cm-id  { color:var(--blue); white-space:nowrap; }
.chademo-tbl td.cm-name{ font-family:var(--sans); color:var(--text2); white-space:nowrap; }
.chademo-tbl td.cm-val { color:var(--text2); font-size:10.5px; }
.chademo-tbl td.cm-raw { color:var(--text3); font-size:10px; letter-spacing:.04em; }
`;
  document.head.appendChild(s);
})();

// ── Bit-field labels (index = bit position, LSB first) ────────────────────────
const CM_FAULT_BITS = [   // 0x102 byte 4 — vehicle fault flags (all faults → red)
  { label:'Battery overvoltage',  kind:'bad' },
  { label:'Battery undervoltage', kind:'bad' },
  { label:'Current deviation',    kind:'bad' },
  { label:'Battery over-temp',    kind:'bad' },
  { label:'Voltage deviation',    kind:'bad' },
];
const CM_VSTATUS_BITS = [ // 0x102 byte 5 — vehicle status
  { label:'Charging enabled',  kind:'good' },
  { label:'Not parked (shift)',kind:'info' },
  { label:'Vehicle fault',     kind:'bad'  },
  { label:'Contactor open',    kind:'info' },
  { label:'Normal-stop request', kind:'info' },
];
const CM_CSTATUS_BITS = [ // 0x109 byte 5 — charger status
  { label:'Charging',           kind:'good' },
  { label:'Charger malfunction',kind:'bad'  },
  { label:'Connector locked',   kind:'info' },
  { label:'Battery incompatible', kind:'bad' },
  { label:'Charging-system malfunction', kind:'bad' },
  { label:'Charging-stop control', kind:'info' },
];

// ── Message decode table (keyed by 11-bit ID) ─────────────────────────────────
// Stable, well-defined fields only; unknown bytes shown raw, protocol-number byte
// always surfaced so revision drift (0.9/1.0/2.0) doesn't break decode.
const CHADEMO_MSGS = {
  0x100: { name:'Vehicle · Capability', fields:[
    { label:'Max batt V',       byte:4, len:2, unit:'V' },
    { label:'Charged-rate ref', byte:6, unit:'%' },
  ]},
  0x101: { name:'Vehicle · Charging Time', fields:[
    { label:'Max time (10s)', byte:1, scale:10, unit:'s' },
    { label:'Max time',       byte:2, unit:'min' },
    { label:'Est time',       byte:3, unit:'min' },
    { label:'Batt capacity',  byte:5, len:2, scale:0.1, unit:'kWh', dp:1 },
  ]},
  0x102: { name:'Vehicle · Session', fields:[
    { label:'Proto#',   byte:0 },
    { label:'Target V', byte:1, len:2, unit:'V' },
    { label:'Req A',    byte:3, unit:'A' },
    { label:'Faults',   byte:4, bits:CM_FAULT_BITS },
    { label:'Status',   byte:5, bits:CM_VSTATUS_BITS },
    { label:'SoC',      byte:6, unit:'%' },
  ]},
  0x108: { name:'Charger · Available Output', fields:[
    { label:'Avail V',     byte:1, len:2, unit:'V' },
    { label:'Avail A',     byte:3, unit:'A' },
    { label:'Threshold V', byte:4, len:2, unit:'V' },
  ]},
  0x109: { name:'Charger · Status', fields:[
    { label:'Proto#',     byte:0 },
    { label:'Present V',  byte:1, len:2, unit:'V' },
    { label:'Present A',  byte:3, unit:'A' },
    { label:'Status',     byte:5, bits:CM_CSTATUS_BITS },
    { label:'Remain (10s)', byte:6, scale:10, unit:'s' },
    { label:'Remain',     byte:7, unit:'min' },
  ]},
  0x118: { name:'Vehicle · Discharge est. (v2.0)', raw:true },
  0x200: { name:'Charger · Discharge (v2.0)', raw:true },
  0x201: { name:'Charger · Discharge (v2.0)', raw:true },
  0x208: { name:'Vehicle · Discharge (v2.0)', raw:true },
  0x209: { name:'Vehicle · Discharge (v2.0)', raw:true },
};
function chademoKnown(id) { return id in CHADEMO_MSGS; }

// ── State ─────────────────────────────────────────────────────────────────────
const CM = {            // live dashboard model — last-known values
  protoV:null, protoC:null,
  targetV:null, presentV:null,
  reqA:null, presentA:null,
  soc:null, remainMin:null, remain10s:null,
  availV:null, availA:null,
  vFaults:0, vStatus:0, cStatus:0,
  lastIds:new Map(),    // id → ts (for the coarse state machine)
};
let chademoLog = [];    // last CHADEMO_LOG_MAX decoded frames
let chademoSubActive = 'session';
let chademoDirty = false;
let chademoWasHidden = true;
let chademoLastTick = 0;
let chademoDemoTimer = null;
const CHADEMO_LOG_MAX = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────
function cmH(v, w = 3) { return '0x' + v.toString(16).toUpperCase().padStart(w, '0'); }
function cmU16(data, i) { return (i + 1 < data.length) ? (data[i] | (data[i + 1] << 8)) : null; }
function cmRelTs(ts) {
  const s = (Date.now() - ts) / 1000;
  return s < 1 ? 'now' : s < 60 ? s.toFixed(1) + 's ago' : Math.round(s / 60) + 'm ago';
}
function cmScalar(f, data) {
  if (f.byte >= data.length) return null;
  let v = f.len === 2 ? cmU16(data, f.byte) : data[f.byte];
  if (v == null) return null;
  if (f.scale) v *= f.scale;
  return v;
}
function cmSetBits(value, defs) {
  const out = [];
  for (let i = 0; i < defs.length; i++) if (value & (1 << i)) out.push(defs[i].label);
  return out;
}

// One-line value string for the frame log.
function chademoValueStr(id, data) {
  const m = CHADEMO_MSGS[id];
  if (!m || m.raw) return null;
  const parts = [];
  for (const f of m.fields) {
    if (f.bits) {
      if (f.byte >= data.length) continue;
      const set = cmSetBits(data[f.byte], f.bits);
      parts.push(`${f.label}: ${set.length ? set.join('|') : 'none'}`);
    } else {
      const v = cmScalar(f, data);
      if (v == null) continue;
      parts.push(`${f.label}: ${f.dp != null ? v.toFixed(f.dp) : v}${f.unit || ''}`);
    }
  }
  return parts.join(' · ');
}

// ── Ingest hook ───────────────────────────────────────────────────────────────
function chademoIngestFrame(frame) {
  if (frame.isExt) return;             // CHAdeMO is 11-bit standard frames
  if (!chademoKnown(frame.id)) return; // only the CHAdeMO ID set
  const data = frame.data;
  const ts = Date.now();
  CM.lastIds.set(frame.id, ts);

  switch (frame.id) {
    case 0x102:
      CM.protoV  = data[0] ?? CM.protoV;
      CM.targetV = cmU16(data, 1) ?? CM.targetV;
      CM.reqA    = data[3] ?? CM.reqA;
      CM.vFaults = data[4] ?? 0;
      CM.vStatus = data[5] ?? 0;
      CM.soc     = data[6] ?? CM.soc;
      break;
    case 0x108:
      CM.availV  = cmU16(data, 1) ?? CM.availV;
      CM.availA  = data[3] ?? CM.availA;
      break;
    case 0x109:
      CM.protoC    = data[0] ?? CM.protoC;
      CM.presentV  = cmU16(data, 1) ?? CM.presentV;
      CM.presentA  = data[3] ?? CM.presentA;
      CM.cStatus   = data[5] ?? 0;
      CM.remain10s = data[6] ?? CM.remain10s;
      CM.remainMin = data[7] ?? CM.remainMin;
      break;
  }

  chademoLog.push({ id: frame.id, data, ts, val: chademoValueStr(frame.id, data) });
  if (chademoLog.length > CHADEMO_LOG_MAX) chademoLog.shift();
  chademoDirty = true;
}

function chademoClear() {
  CM.protoV = CM.protoC = CM.targetV = CM.presentV = CM.reqA = CM.presentA = null;
  CM.soc = CM.remainMin = CM.remain10s = CM.availV = CM.availA = null;
  CM.vFaults = CM.vStatus = CM.cStatus = 0;
  CM.lastIds.clear();
  chademoLog = [];
  chademoDirty = true;
}

// ── Coarse session state ──────────────────────────────────────────────────────
function chademoSessionState() {
  if (!CM.lastIds.size) return { label: 'Idle', kind: '' };
  if ((CM.vStatus & 0x10) || (CM.cStatus & 0x20)) return { label: 'Stop', kind: 'stop' };
  if ((CM.cStatus & 0x01) || (CM.vStatus & 0x01)) return { label: 'Charging', kind: 'charging' };
  const now = Date.now();
  const recent = id => CM.lastIds.has(id) && now - CM.lastIds.get(id) < 3000;
  if (recent(0x100) || recent(0x101) || recent(0x108) || recent(0x102))
    return { label: 'Capability exchange', kind: 'cap' };
  return { label: 'Connected (idle)', kind: '' };
}

// ── Render ────────────────────────────────────────────────────────────────────
function chademoSubTab(name) {
  chademoSubActive = name;
  ['session', 'log'].forEach(n => {
    document.getElementById('chademo-stab-' + n).classList.toggle('active', n === name);
    document.getElementById('chademo-' + n).style.display = n === name ? '' : 'none';
  });
  chademoDirty = true;
  chademoRender();
}

function chademoRender() {
  if (document.getElementById('chademoWrap')?.style.display === 'none') { chademoWasHidden = true; return; }
  if (chademoWasHidden) { chademoWasHidden = false; chademoDirty = true; }
  if (!chademoDirty) return;
  chademoDirty = false;
  if (chademoSubActive === 'session') chademoRenderSession();
  else chademoRenderLog();
}

function tile(label, val, sub, muted) {
  return `<div class="chademo-tile">
    <div class="ct-label">${label}</div>
    <div class="ct-val${muted ? ' muted' : ''}">${val}</div>
    ${sub ? `<div class="ct-sub">${sub}</div>` : ''}
  </div>`;
}
const cmShow = (v, unit = '') => (v == null ? '—' : v + unit);

function chademoChips(value, defs) {
  return defs.map((d, i) => {
    const on = (value & (1 << i)) !== 0;
    return `<span class="chademo-chip${on ? ' on ' + d.kind : ''}">${d.label}</span>`;
  }).join('');
}

function chademoRenderSession() {
  const el = document.getElementById('chademo-session');
  if (!CM.lastIds.size) {
    el.innerHTML = '<div class="chademo-empty">No CHAdeMO frames received yet.<br>' +
      'CHAdeMO uses 11-bit IDs (0x100–0x109) on a dedicated 500 kbit/s charge bus.<br>' +
      'Click <b>Demo session</b> to replay a charging session.</div>';
    return;
  }
  const st = chademoSessionState();
  const remain = CM.remainMin != null && CM.remainMin !== 0xFF ? CM.remainMin + ' min'
    : (CM.remain10s != null && CM.remain10s !== 0xFF ? (CM.remain10s * 10) + ' s' : '—');

  el.innerHTML = `
    <div style="margin-bottom:4px"><span class="chademo-state ${st.kind}">${st.label}</span></div>
    <div class="chademo-tiles">
      ${tile('State of charge', cmShow(CM.soc, '%'))}
      ${tile('Voltage', cmShow(CM.presentV, ' V'), 'target ' + cmShow(CM.targetV, ' V'))}
      ${tile('Current', cmShow(CM.presentA, ' A'), 'requested ' + cmShow(CM.reqA, ' A'))}
      ${tile('Remaining time', remain, null, true)}
      ${tile('Charger output', cmShow(CM.availV, ' V'), 'max ' + cmShow(CM.availA, ' A'), true)}
      ${tile('Protocol #', 'V ' + cmShow(CM.protoV), 'charger ' + cmShow(CM.protoC), true)}
      ${tile('Connector', (CM.cStatus & 0x04) ? 'Locked' : 'Unlocked', null, true)}
    </div>
    <div class="chademo-flags-title">Vehicle faults <span style="color:var(--text3);font-weight:400">(0x102 byte 4)</span></div>
    <div>${chademoChips(CM.vFaults, CM_FAULT_BITS)}</div>
    <div class="chademo-flags-title">Vehicle status <span style="color:var(--text3);font-weight:400">(0x102 byte 5)</span></div>
    <div>${chademoChips(CM.vStatus, CM_VSTATUS_BITS)}</div>
    <div class="chademo-flags-title">Charger status <span style="color:var(--text3);font-weight:400">(0x109 byte 5)</span></div>
    <div>${chademoChips(CM.cStatus, CM_CSTATUS_BITS)}</div>`;
}

function chademoRenderLog() {
  const el = document.getElementById('chademo-log');
  if (!chademoLog.length) { el.innerHTML = '<div class="chademo-empty">No CHAdeMO frames in log yet.</div>'; return; }
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = `<table class="chademo-tbl">
    <thead><tr><th>Time</th><th>ID</th><th>Message</th><th>Bytes</th><th>Decoded</th></tr></thead><tbody>` +
    chademoLog.map(e => {
      const m = CHADEMO_MSGS[e.id];
      const raw = Array.from(e.data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      return `<tr>
        <td class="cm-ts">${cmRelTs(e.ts)}</td>
        <td class="cm-id">${cmH(e.id)}</td>
        <td class="cm-name">${m ? m.name : '—'}</td>
        <td class="cm-raw">${raw}</td>
        <td class="cm-val">${e.val || '<span style="color:var(--text3)">—</span>'}</td>
      </tr>`;
    }).join('') + '</tbody></table>';
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// ── Demo session (tab button) — replays a handshake + charging ramp ───────────
function chademoDemoFrame(id, bytes) {
  const data = bytes.slice(0, 8);
  while (data.length < 8) data.push(0);
  if (window.ingestFrame) window.ingestFrame({ id, isExt: false, isRtr: false, dlc: data.length, data });
}
function chademoDemo() {
  if (chademoDemoTimer) return; // already running
  const btn = document.getElementById('chademoDemoBtn');
  if (btn) { btn.textContent = 'Demo running…'; btn.disabled = true; }
  chademoSubTab('session');

  // Capability exchange (sent once before energy transfer).
  chademoDemoFrame(0x100, [0, 0, 0, 0, 0xE2, 0x01, 80, 0]);          // max batt 0x01E2=482 V, charged-rate 80%
  chademoDemoFrame(0x101, [0, 0xFF, 90, 45, 0, 0xE8, 0x03, 0]);      // max 90 min, est 45 min, cap 100.0 kWh
  chademoDemoFrame(0x108, [0, 0xF4, 0x01, 125, 0xF4, 0x01, 0, 0]);   // avail 500 V / 125 A, threshold 500 V

  let soc = 20, t = 0;
  const TICKS = 60; // ~6 s
  chademoDemoTimer = setInterval(() => {
    t++;
    soc = Math.min(80, soc + 1);
    const targetV = 380 + Math.round(soc * 0.6);         // climbs with SoC
    const reqA = soc < 75 ? 120 : Math.max(10, 120 - (soc - 75) * 20); // taper near full
    const remainMin = Math.max(0, Math.round((80 - soc) * 0.7));
    const last = (soc >= 80) || (t >= TICKS);

    // 0x102 vehicle: proto 2, target V, req A, no faults, status charging-enabled (bit0)
    const vStatus = last ? 0x10 : 0x01; // last frame → normal-stop request
    chademoDemoFrame(0x102, [0x02, targetV & 0xFF, targetV >> 8, reqA, 0x00, vStatus, soc, 0]);
    // 0x109 charger: proto 2, present V/A tracking, charging (bit0) + connector locked (bit2)
    const presentV = targetV - 2, presentA = reqA - 1;
    const cStatus = last ? 0x20 : 0x05; // last → charging-stop control
    chademoDemoFrame(0x109, [0x02, presentV & 0xFF, presentV >> 8, presentA, 0, cStatus, 0, remainMin]);

    if (last) chademoDemoStop();
  }, 100);
}
function chademoDemoStop() {
  if (chademoDemoTimer) { clearInterval(chademoDemoTimer); chademoDemoTimer = null; }
  const btn = document.getElementById('chademoDemoBtn');
  if (btn) { btn.textContent = 'Demo session'; btn.disabled = false; }
}

// ── Render loop ───────────────────────────────────────────────────────────────
(function loop() {
  const now = Date.now();
  if (now - chademoLastTick >= 1000) { chademoDirty = true; chademoLastTick = now; } // tick relative timestamps
  chademoRender();
  requestAnimationFrame(loop);
})();

// ── Exports ───────────────────────────────────────────────────────────────────
window.chademoIngestFrame = chademoIngestFrame;
window.chademoClear = chademoClear;
window.chademoSubTab = chademoSubTab;
window.chademoDemo = chademoDemo;
