// ── J1939 Decoder ─────────────────────────────────────────────────────────────
// Self-contained module. All J1939 state and rendering lives here.
//
// INTEGRATION POINTS - the only changes required in the main files:
//
//   sloppycan.js  ingestFrame(), after isotpIngestFrame(frame):
//     if (window.j1939IngestFrame) j1939IngestFrame(frame);          // ← line A
//
//   sloppycan.js  clearFrames(), at end:
//     if (window.j1939Clear) j1939Clear();                            // ← line B
//
//   index.html  view-tabs div:
//     <button class="view-tab" id="vtab-j1939" onclick="switchViewTab('j1939')">J1939</button>
//
//   index.html  switchViewTab():
//     + j1939 cases (tab toggle + wrap show/hide)
//
// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.j1939-stab {
  background:transparent; border:none; border-bottom:2px solid transparent;
  color:var(--text2); cursor:pointer; font-family:var(--sans); font-size:12px;
  font-weight:500; padding:8px 14px; transition:color .15s,border-color .15s;
}
.j1939-stab:hover { color:var(--text); }
.j1939-stab.active { color:var(--green); border-bottom-color:var(--green); }
.j1939-tbl { width:100%; border-collapse:collapse; font-size:11.5px; }
.j1939-tbl th {
  text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text3); padding:5px 8px; border-bottom:1px solid var(--border);
  font-weight:500; font-family:var(--sans); white-space:nowrap;
  background:var(--bg2); position:sticky; top:0; z-index:1;
}
.j1939-tbl td {
  padding:5px 8px; border-bottom:1px solid var(--border); vertical-align:top;
  color:var(--text2); font-family:var(--mono);
}
.j1939-tbl tr:last-child td { border-bottom:none; }
.j1939-tbl td.j-pgn  { color:var(--text); }
.j1939-tbl td.j-name { font-family:var(--sans); color:var(--text2); }
.j1939-tbl td.j-sa   { color:var(--blue); }
.j1939-tbl td.j-val  { color:var(--green); font-family:var(--mono); }
.j1939-tbl td.j-ts   { color:var(--text3); font-size:10px; white-space:nowrap; }
.j1939-tbl td.j-raw  { color:var(--text3); font-size:10px; letter-spacing:.04em; }
.j1939-fault-badge { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:600; }
.j1939-fault-badge.dm1 { background:var(--red-dim);  color:var(--red); }
.j1939-fault-badge.dm2 { background:var(--amber-dim); color:var(--amber); }
.j1939-empty { text-align:center; color:var(--text3); font-size:12px; padding:48px 0; font-family:var(--sans); }
.j1939-log-row { display:flex; gap:12px; align-items:baseline; padding:3px 0; border-bottom:1px solid var(--border); font-size:11px; }
.j1939-log-row:last-child { border-bottom:none; }
.j1939-tp-badge { display:inline-block; padding:0 4px; background:var(--purple-dim); color:var(--purple); border-radius:3px; font-size:9px; margin-left:4px; }
`;
  document.head.appendChild(s);
})();

// NMEA2K_DB / ISOBUS_DB, the dictionaries the tab's other two modes decode with, live in
// j1939-tables.js beside J1939_DB.
// Returns the dictionary for the active protocol mode (J1939 stays unchanged).
function j1939ActiveDb() {
  if (j1939ProtoMode === 'nmea2000') return NMEA2K_DB;
  if (j1939ProtoMode === 'iso11783') return ISOBUS_DB;
  return J1939_DB;
}

// ── NMEA 2000 bit-field decode ────────────────────────────────────────────────
// Little-endian. Supports arbitrary bit offset/length (≤32 via bit extraction;
// >32 must be byte-aligned, computed as a float - exact integers aren't needed
// for display, e.g. 64-bit lat/lon × 1e-16). Returns the same {name,display,valid}
// shape as j1939DecodeSPN so the existing renderers work unchanged.
function n2kDecodeField(def, data) {
  const bo = def.bo, bl = def.bl;
  const byteStart = bo >> 3;
  const byteEnd   = (bo + bl - 1) >> 3;
  if (data.length <= byteEnd) return null;

  if (def.str) {
    let s = '';
    for (let i = byteStart; i <= byteEnd && i < data.length; i++) {
      const c = data[i];
      if (c === 0 || c === 0xFF || c === 0x40) break; // 0x40 = N2K string filler
      if (c >= 32 && c < 127) s += String.fromCharCode(c);
    }
    s = s.trim();
    // Untrusted device bytes - escape before it reaches the innerHTML render sinks
    // (j1939SpnHtml / j1939RenderLog). printable-ASCII includes < > & " '.
    return { name: def.name, display: s ? escHtml(s) : '-', valid: !!s };
  }

  let raw, allOnes;
  if (bl <= 32) {
    let acc = 0;
    for (let i = byteStart; i <= byteEnd; i++) acc += data[i] * Math.pow(2, 8 * (i - byteStart));
    raw = Math.floor(acc / Math.pow(2, bo & 7)) % Math.pow(2, bl);
    allOnes = Math.pow(2, bl) - 1;
    if (def.signed && raw >= Math.pow(2, bl - 1)) raw -= Math.pow(2, bl);
  } else {
    const nb = bl >> 3; // byte-aligned for >32-bit fields
    raw = 0;
    for (let i = 0; i < nb; i++) raw += data[byteStart + i] * Math.pow(2, 8 * i);
    allOnes = Math.pow(2, bl) - 1;
    if (def.signed && (data[byteStart + nb - 1] & 0x80)) raw -= Math.pow(2, bl);
  }

  // An explicit enum entry wins over the generic N/A sentinel: small mapped fields can define
  // their all-ones slot meaningfully (e.g. a 4-bit Fluid Type where 0xF = 'Error', not 'N/A').
  if (def.map && def.map[raw] !== undefined) return { name: def.name, display: def.map[raw], valid: true };

  // not-available (all ones / max positive) and out-of-range (next value) sentinels
  if (!def.signed) {
    if (raw === allOnes)     return { name: def.name, display: 'N/A', valid: false };
    if (raw === allOnes - 1) return { name: def.name, display: '-',   valid: false };
  } else {
    const maxPos = Math.pow(2, bl - 1) - 1;
    if (raw === maxPos)     return { name: def.name, display: 'N/A', valid: false };
    if (raw === maxPos - 1) return { name: def.name, display: '-',   valid: false };
  }

  if (def.map) return { name: def.name, display: def.map[raw] ?? String(raw), valid: true };

  const val = raw * (def.scale ?? 1) + (def.offset ?? 0);
  if (def.date) {
    const d = new Date(val * 86400000);
    return { name: def.name, display: isNaN(d.getTime()) ? String(val) : d.toISOString().slice(0, 10), valid: true };
  }
  if (def.time) {
    const sec = ((val % 86400) + 86400) % 86400;
    const p2 = n => String(n).padStart(2, '0');
    return { name: def.name, display: `${p2(Math.floor(sec/3600))}:${p2(Math.floor((sec%3600)/60))}:${p2(Math.floor(sec%60))}`, valid: true };
  }
  return { name: def.name, display: val.toFixed(def.dp ?? 0) + (def.unit ? ' ' + def.unit : ''), valid: true };
}

// ── NMEA 2000 Fast Packet reassembly ──────────────────────────────────────────
// Multi-frame inline transport (not J1939 TP). First frame: data[0]&0x1F==0,
// data[1]=total length, data[2..7]=first 6 bytes. Subsequent frames: data[1..7]
// = next 7 bytes at offset 6+(frameCounter-1)*7. Keyed by (pgn,sa,seqCounter).
let n2kFastPacket = new Map(); // `${pgn}:${sa}:${seq}` → {total, bytes, frames, seen, ts}

function n2kFastPacketIngest(pgn, sa, da, data, ts) {
  if (data.length < 2) return;
  const seq = (data[0] >> 5) & 0x07;
  const frameCounter = data[0] & 0x1F;
  const key = `${pgn}:${sa}:${seq}`;

  if (frameCounter === 0) {
    const total = data[1];
    const bytes = new Uint8Array(total);
    let n = 0;
    for (let i = 2; i < 8 && i < data.length && n < total; i++) bytes[n++] = data[i];
    // Total frames for full coverage: first frame carries 6 bytes, each continuation 7. Track a
    // seen-set (not a running byte count) so a duplicated/retransmitted frame can't over-count and
    // trip completion with a gap still present.
    const frames = total <= 6 ? 1 : 1 + Math.ceil((total - 6) / 7);
    const sess = { total, bytes, frames, seen: new Set([0]), ts };
    n2kFastPacket.set(key, sess);
    // A short Fast Packet (total ≤ 6) is fully carried by the first frame - dispatch now, else it
    // would sit until evicted as stale and never decode.
    if (sess.seen.size >= frames) {
      n2kFastPacket.delete(key);
      j1939DispatchPGN(pgn, sa, da, Array.from(bytes), ts, true);
    }
  } else {
    const sess = n2kFastPacket.get(key);
    if (!sess) return;
    const offset = 6 + (frameCounter - 1) * 7;
    for (let i = 1; i < 8 && i < data.length; i++) {
      const pos = offset + (i - 1);
      if (pos < sess.total) sess.bytes[pos] = data[i];
    }
    if (frameCounter < sess.frames) sess.seen.add(frameCounter); // dedup retransmits; guard bogus idx
    sess.ts = ts;
    if (sess.seen.size >= sess.frames) {
      n2kFastPacket.delete(key);
      j1939DispatchPGN(pgn, sa, da, Array.from(sess.bytes), ts, true);
    }
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let j1939PgnMap  = new Map(); // `${pgn}:${sa}` → {pgn, sa, data, ts, count, spnResults}
let j1939AddrMap = new Map(); // sa → {sa, fnName, industryName, mfrCode, ecuInst, ts}
let j1939DmMap   = new Map(); // sa → {dm1:[...dtcs], dm2:[...dtcs], dm1ts, dm2ts}
let j1939Log     = [];        // last J1939_LOG_MAX decoded frames
let j1939LogSeq  = 0;         // per-entry key for the Frame Log's keyed rows
let j1939TpSessions = new Map(); // session key → TP session state
let j1939SubActive = 'pgn';   // active sub-tab
let j1939ProtoMode = 'j1939'; // 'j1939' | 'nmea2000' - set by the tab's mode dropdown
let j1939Dirty   = false;     // render needed
let j1939WasHidden = true;    // true while the J1939 tab is not visible
let j1939LastRender = 0;      // throttle clock for the full-table rebuild
const J1939_RENDER_MS = 67;   // ~15 fps cap
let j1939LastTick = 0;        // last time the visible tab was force-refreshed (relative timestamps)
const J1939_LOG_MAX = 500;
// Random 29-bit traffic (fuzzing, CANopen-extended, DroneCAN) parses as J1939 too: the PGN table
// keeps the J1939_PGN_MAX most recently seen pgn:sa pairs and the PGN Monitor draws the newest
// J1939_PGN_ROWS of them (an 18k-row table took ~0.5 s per render).
const J1939_PGN_MAX = 2000;
const J1939_PGN_ROWS = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────
function j1939Hex(v, w = 2) { return '0x' + j1939H(v, w); }

function j1939SaLabel(sa) {
  const c = j1939AddrMap.get(sa);
  if (c) {
    // An ISO 11783 implement is identified by its DEVICE CLASS (NAME bits 49-55 under the
    // agriculture industry group; class 1 is the tractor itself): its function, 132 "Machine
    // Control" for isobus.js's implement, only means something within that class. Function 0
    // (Engine) falls through to the address tables, which read 0x00 as Engine #1.
    if (c.industryGrp === 2 && c.devClass > 1 && ISOBUS_DEVICE_CLASS[c.devClass]) return ISOBUS_DEVICE_CLASS[c.devClass] + ' implement';
    if (c.fn !== 0) return c.fnName;
  }
  return J1939_SA[sa] || `SA 0x${j1939H(sa)}`;
}

const j1939RelTs = window.canRelTs;        // shared formatter (defined in sloppycan.js)

// `db` defaults to the tab's active mode; the flavor modules' self-tests pass one explicitly so
// their result does not depend on which mode button the user last pressed.
function j1939DecodePGN(pgn, data, db = j1939ActiveDb()) {
  const entry = db[pgn];
  if (!entry) return [];
  if (entry.decode) return entry.decode(data);                                              // custom decoder (ISOBUS TC/VT)
  if (entry.fields) return entry.fields.map(d => n2kDecodeField(d, data)).filter(Boolean); // NMEA bit-field model
  if (!entry.spns || !entry.spns.length) return [];
  return entry.spns.map(d => j1939DecodeSPN(d, data)).filter(Boolean);
}

// ── Transport Protocol (J1939-21 TP) ─────────────────────────────────────────
// Handles BAM (broadcast) and CMDT (connection-mode) multi-packet reassembly.
// TP.CM messages arrive on PGN 0xEC00 (PDU1, PF=0xEC, PS=destination)
// TP.DT messages arrive on PGN 0xEB00 (PDU1, PF=0xEB, PS=destination)
//
// BAM flow:  SA → 0xFF: TP.CM_BAM → SA → 0xFF: TP.DT × N
// CMDT flow: SA → DA:   TP.CM_RTS → DA → SA: TP.CM_CTS → SA → DA: TP.DT × N → DA → SA: EndAck

function j1939TpKey(sa, da) { return da === 0xFF ? `BAM:${sa}` : `${sa}:${da}`; }

function j1939TpIngestCM(parsed, data, ts) {
  if (data.length < 8) return;
  const ctrl = data[0];
  const { sa, da } = parsed;

  if (ctrl === 0x20) {
    // TP.CM_BAM: broadcast announce
    const totalBytes = data[1] | (data[2] << 8);
    const totalPkts  = data[3];
    const pgn        = data[5] | (data[6] << 8) | (data[7] << 16);
    // Too few packets for the byte count (zero included) would complete with a zero-filled tail, or
    // at once with nothing in it. A new announce still ends the old one.
    if (!totalBytes || totalPkts < Math.ceil(totalBytes / 7)) { j1939TpSessions.delete(j1939TpKey(sa, 0xFF)); return; }
    j1939TpSessions.set(j1939TpKey(sa, 0xFF), {
      pgn, sa, da: 0xFF, totalBytes, totalPkts, seenPkts: new Set(),
      data: new Uint8Array(totalBytes), ts,
    });
  } else if (ctrl === 0x10) {
    // TP.CM_RTS: connection-mode request to send
    const totalBytes = data[1] | (data[2] << 8);
    const totalPkts  = data[3];
    const pgn        = data[5] | (data[6] << 8) | (data[7] << 16);
    if (!totalBytes || totalPkts < Math.ceil(totalBytes / 7)) { j1939TpSessions.delete(j1939TpKey(sa, da)); return; }   // as BAM
    j1939TpSessions.set(j1939TpKey(sa, da), {
      pgn, sa, da, totalBytes, totalPkts, seenPkts: new Set(),
      data: new Uint8Array(totalBytes), ts,
    });
  } else if (ctrl === 0xFF) {
    // TP.CM_Conn_Abort - either end may send it, so the session can be keyed either way round
    j1939TpSessions.delete(j1939TpKey(sa, da));
    j1939TpSessions.delete(j1939TpKey(da, sa));
    // ...and a sender aborting its own broadcast: that session is keyed BAM:sa whatever the DA. The
    // abort names its PGN, so a CMDT abort from the same node leaves its BAM alone.
    const bam = j1939TpSessions.get(j1939TpKey(sa, 0xFF));
    if (bam && bam.pgn === (data[5] | (data[6] << 8) | (data[7] << 16))) j1939TpSessions.delete(j1939TpKey(sa, 0xFF));
  }
}

function j1939TpIngestDT(parsed, data, ts) {
  if (data.length < 2) return;
  const { sa, da } = parsed;
  const key  = j1939TpKey(sa, da);
  const sess = j1939TpSessions.get(key);
  if (!sess) return;

  const seqNum = data[0]; // 1-based
  if (seqNum < 1) return;    // 0 is no packet: pkt -1 would pass the guard below and count toward completion
  const pkt    = seqNum - 1; // 0-based packet index
  const offset = pkt * 7;
  for (let i = 1; i < 8 && i < data.length; i++) {
    const pos = offset + (i - 1);
    if (pos < sess.totalBytes) sess.data[pos] = data[i];
  }
  if (pkt < sess.totalPkts) sess.seenPkts.add(pkt); // track coverage (dedups duplicates/retransmits)
                                                    // rather than counting; a lost middle packet
                                                    // can't falsely complete via an over-count
  sess.ts = ts;   // refresh activity time so the idle-eviction below is a true inactivity timeout

  if (sess.seenPkts.size >= sess.totalPkts) {
    // Reassembly complete - deliver as a full PGN
    j1939TpSessions.delete(key);
    j1939DispatchPGN(sess.pgn, sess.sa, sess.da, Array.from(sess.data), ts, true);
  }
}

// ── ISO 11783 Extended Transport Protocol (ETP, ISO 11783-6) ──────────────────
// For messages > 1785 bytes (J1939 TP's cap). ETP.CM on PGN 0xC800, ETP.DT on
// 0xC700. The trap vs J1939 TP: data-packet sequence numbers are relative to the
// most recent DPO (Data Packet Offset), so byteOffset = (dpoOffset + seq − 1)*7.
const ETP_MAX_BYTES = 256 * 1024; // cap reassembly buffer; abort beyond it
let isoEtpSessions = new Map();   // `${sa}:${da}` → {pgn, sa, da, totalBytes, dpoOffset, data, ts}

function isoEtpKey(sa, da) { return `${sa}:${da}`; }

function isoEtpIngestCM(parsed, data, ts) {
  if (data.length < 8) return;
  const ctrl = data[0];
  const { sa, da } = parsed;
  const key = isoEtpKey(sa, da);
  if (ctrl === 0x14) {
    // RTS: bytes 1–4 = total size (32-bit LE), bytes 5–7 = PGN
    const totalBytes = (data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24)) >>> 0;
    const pgn        = data[5] | (data[6] << 8) | (data[7] << 16);
    if (totalBytes === 0 || totalBytes > ETP_MAX_BYTES) { isoEtpSessions.delete(key); return; }
    isoEtpSessions.set(key, { pgn, sa, da, totalBytes, totalPkts: Math.ceil(totalBytes / 7), seenPkts: new Set(), dpoOffset: 0, data: new Uint8Array(totalBytes), ts });
  } else if (ctrl === 0x16) {
    // DPO: byte 1 = num packets, bytes 2–4 = packet offset (3-byte LE)
    const sess = isoEtpSessions.get(key);
    if (!sess) return;
    sess.dpoOffset = data[2] | (data[3] << 8) | (data[4] << 16);
    sess.ts = ts;
  } else if (ctrl === 0xFF) {
    isoEtpSessions.delete(key); // Abort
  }
  // 0x15 CTS / 0x17 EOMA are receiver-side acks - ignored for passive reassembly.
}

function isoEtpIngestDT(parsed, data, ts) {
  if (data.length < 2) return;
  const { sa, da } = parsed;
  const key  = isoEtpKey(sa, da);
  const sess = isoEtpSessions.get(key);
  if (!sess) return;
  const seq = data[0]; // 1-based, relative to the current DPO offset
  if (seq < 1) return;   // 0 is no packet (it would land on the previous window's last one)
  const pkt = sess.dpoOffset + seq - 1; // absolute 0-based packet index
  const byteOffset = pkt * 7;
  for (let i = 1; i < 8 && i < data.length; i++) {
    const pos = byteOffset + (i - 1);
    if (pos < sess.totalBytes) sess.data[pos] = data[i];
  }
  if (pkt < sess.totalPkts) sess.seenPkts.add(pkt); // track full coverage (dedups + order-independent)
                          // rather than completing on last-byte-write, which a lost middle packet would
                          // falsely trip; guard the index so a bogus pkt can't inflate size and complete
  sess.ts = ts;
  if (sess.seenPkts.size >= sess.totalPkts) { // every packet received - reassembly complete
    isoEtpSessions.delete(key);
    j1939DispatchPGN(sess.pgn, sess.sa, sess.da, Array.from(sess.data), ts, 'etp');
  }
}

// ── PGN Dispatch ──────────────────────────────────────────────────────────────
function j1939DispatchPGN(pgn, sa, da, data, ts, fromTP) {
  const pgnKey = `${pgn}:${sa}`;

  // Handle Address Claim if dispatched here
  if (pgn === 0xEE00) {
    const name = j1939DecodeName(data);
    if (name) {
      j1939AddrMap.set(sa, { sa, ts, data: Array.from(data), ...name });
      j1939Dirty = true;
    }
  }

  // Handle DM1/DM2
  if (pgn === 0xFECA || pgn === 0xFECB) {
    const dtcs = j1939DecodeDTCs(data);
    const entry = j1939DmMap.get(sa) || {};
    if (pgn === 0xFECA) { entry.dm1 = dtcs; entry.dm1ts = ts; entry.dm1Data = Array.from(data); }
    else                { entry.dm2 = dtcs; entry.dm2ts = ts; entry.dm2Data = Array.from(data); }
    j1939DmMap.set(sa, entry);
  }

  // Decode SPNs
  const spnResults = j1939DecodePGN(pgn, data);

  // Update live PGN table. Delete-then-set keeps the Map in least-recently-seen order, so the cap
  // evicts from the front; j1939AddrMap / j1939DmMap are keyed by SA alone and so stop at 256.
  const existing = j1939PgnMap.get(pgnKey);
  if (existing) j1939PgnMap.delete(pgnKey);
  else if (j1939PgnMap.size >= J1939_PGN_MAX) j1939PgnMap.delete(j1939PgnMap.keys().next().value);
  j1939PgnMap.set(pgnKey, {
    pgn, sa, da, data, ts, fromTP,
    count: (existing?.count ?? 0) + 1,
    spnResults,
  });

  // Append to frame log (cap at J1939_LOG_MAX)
  j1939Log.push({ seq: ++j1939LogSeq, pgn, sa, da, data, ts, fromTP, spnResults });
  if (j1939Log.length > J1939_LOG_MAX) j1939Log.shift();

  j1939Dirty = true;
}

// ── Main Frame Ingest Hook ────────────────────────────────────────────────────
function j1939IngestFrame(frame) {
  if (!frame.isExt) return; // J1939 always uses 29-bit extended IDs
  const parsed = j1939ParseId(frame.id);
  const { pgn, sa, da } = parsed;
  const data = frame.data;
  const ts   = Date.now();

  // Address Claim: PGN 0xEE00 (PDU1: PF=0xEE, sent to the global DA 0xFF with the SA's NAME) - shared by all modes
  if (pgn === 0xEE00) {
    const name = j1939DecodeName(data);
    if (name) {
      j1939AddrMap.set(sa, { sa, ts, data: Array.from(data), ...name });
      j1939Dirty = true;
    }
    return;
  }

  // A request (59904) is handed to the request server, which may answer it. Deliberately BEFORE
  // the per-mode branches and deliberately not an early return: the Mode dropdown picks how
  // frames are displayed and must not decide what is on the bus, and a request is itself a frame
  // that belongs in the monitor and the log whether or not anything answers it.
  if (pgn === J1939_REQ_PGN) j1939ServeRequest(parsed, data);

  // NMEA 2000: Fast Packet for multi-frame PGNs (no J1939 TP), else dispatch immediately.
  if (j1939ProtoMode === 'nmea2000') {
    const entry = NMEA2K_DB[pgn];
    if (entry && entry.fp) { n2kFastPacketIngest(pgn, sa, da, data, ts); return; }
    j1939DispatchPGN(pgn, sa, da, data, ts, false);
    return;
  }

  // ISO 11783: large messages use ETP (0xC800 CM / 0xC700 DT). Standard J1939 TP
  // (0xEC/0xEB, handled below) stays active - only ETP frames return early here.
  if (j1939ProtoMode === 'iso11783') {
    const pf = (frame.id >> 16) & 0xFF;
    if (pf === 0xC8) { isoEtpIngestCM(parsed, data, ts); return; }
    if (pf === 0xC7) { isoEtpIngestDT(parsed, data, ts); return; }
  }

  // J1939 TP.CM: PGN 0xEC00 (PF=0xEC < 0xF0 → PDU1, PS=destination)
  if ((frame.id >> 16 & 0xFF) === 0xEC) { j1939TpIngestCM(parsed, data, ts); return; }

  // J1939 TP.DT: PGN 0xEB00
  if ((frame.id >> 16 & 0xFF) === 0xEB) { j1939TpIngestDT(parsed, data, ts); return; }

  // Regular PGN
  j1939DispatchPGN(pgn, sa, da, data, ts, false);
}

// ── Protocol mode (J1939 ↔ NMEA 2000) ─────────────────────────────────────────
// Swaps the active dictionary + transport. Clears the live tables so entries
// re-decode under the new dictionary. Persisted per-workspace as `j1939Proto`.
function j1939SetProto(mode) {
  mode = (mode === 'nmea2000' || mode === 'iso11783') ? mode : 'j1939';
  j1939ProtoMode = mode;
  // Reflect into the proto toggle (button group on the left of the sub-tab bar).
  const btnIds = { j1939: 'j1939ProtoJ1939', nmea2000: 'j1939ProtoNmea2000', iso11783: 'j1939ProtoIso11783' };
  for (const [m, id] of Object.entries(btnIds)) {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('active', m === mode);
  }
  const lkN = document.getElementById('nmea2000LearnLink');
  if (lkN) lkN.style.display = (mode === 'nmea2000') ? '' : 'none';
  const lkI = document.getElementById('iso11783LearnLink');
  if (lkI) lkI.style.display = (mode === 'iso11783') ? '' : 'none';
  // NMEA 2000 has no DM1/DM2 - hide the Faults sub-tab in NMEA mode (ISOBUS keeps it).
  const dmBtn = document.getElementById('j1939stab-dm');
  if (dmBtn) dmBtn.style.display = (mode === 'nmea2000') ? 'none' : '';
  if (mode === 'nmea2000' && j1939SubActive === 'dm') j1939SubTab('pgn');
  // Fresh rebuild - entries cache decoded values from the prior dictionary.
  j1939PgnMap.clear(); j1939Log = []; j1939DmMap.clear();
  n2kFastPacket.clear(); isoEtpSessions.clear(); j1939TpSessions.clear();
  j1939Dirty = true;
  j1939Render();
}
// ── The DM1 LAMP STATES, driven into Carlito's cluster ────────────────────────
// J1939-73's DM1 lamp status is TWO BITS per lamp: off, on, flash 1 Hz, flash 2 Hz - and the two
// flashing states are how a real cluster separates a fault that is ACTIVE from one that is
// PENDING. The contract carries the three lamps as plain bools (`red_stop` / `amber_warn` /
// `protect_lamp`, mirrored verbatim like turnL), and THAT IS ENOUGH, because a flash rate is a
// property of the SOURCE and not of the dashboard: this module holds the four-state lamp status
// and sends the bit that is lit THIS INSTANT. The game has no blink timer for these or for
// anything else.
//
// So the urgency really is on the wire, in the only form a mirrored bit can carry it - the rate.
// A listener watching the bit over a second reads it exactly the way a cluster does.
const J1939_LAMP_OFF = 0, J1939_LAMP_ON = 1, J1939_LAMP_FLASH_1HZ = 2, J1939_LAMP_FLASH_2HZ = 3;
// Phase off the wall clock rather than an accumulator, so it never drifts and needs no timer of
// its own; carlito.js samples these at the ~33 Hz uplink rate, which resolves 2 Hz comfortably.
// Duty is a half-on square wave, which is what a flashing telltale looks like - unlike the
// aircraft beacon's short pulse.
function j1939LampBit(state) {
  switch (state | 0) {
    case J1939_LAMP_ON: return 1;
    case J1939_LAMP_FLASH_1HZ: return (Date.now() % 1000) < 500 ? 1 : 0;
    case J1939_LAMP_FLASH_2HZ: return (Date.now() % 500) < 250 ? 1 : 0;
    default: return 0;
  }
}
// The DM1 lamps' STATES (not their bits). DM1's Malfunction Indicator Lamp is deliberately
// absent: the contract's `checkEngine` already IS the MIL, so a fourth entry here would be the
// same lamp under a second name.
//
// The two TRAILER lamps share the pattern without being DM1: `trailer_ebs_fault` is the towed
// unit's ISO 11992 fault report and `trailer_abs_lamp` is SAE J2497's power-line lamp. The contract
// mirrors both verbatim with no local source, so a selector here is the fault injected from the
// bench, which is the only way either lamp ever lights. Neither has a frame this side decodes:
// J2497 has no CAN carrier at all (it is modulated onto the power line), and while iso11992.js now
// packs the trailer's EBS21 / EBS22 (trailer ABS / VDC) onto this CAN, `trailer_ebs_fault` still
// has no decode: the towed unit is SA 0xC8, the address iso11992.js itself transmits from, so a
// real trailer's frames could not be told from our own echo (the own-address rule).
const j1939Lamps = { red_stop: 0, amber_warn: 0, protect_lamp: 0, trailer_ebs_fault: 0, trailer_abs_lamp: 0 };
window.carlitoUplinkSources = window.carlitoUplinkSources || {};
Object.assign(window.carlitoUplinkSources, {
  red_stop:     () => j1939LampBit(j1939Lamps.red_stop),
  amber_warn:   () => j1939LampBit(j1939Lamps.amber_warn),
  protect_lamp: () => j1939LampBit(j1939Lamps.protect_lamp),
  trailer_ebs_fault: () => j1939LampBit(j1939Lamps.trailer_ebs_fault),
  trailer_abs_lamp:  () => j1939LampBit(j1939Lamps.trailer_abs_lamp),
});
// Read the lamp selectors out of the bar. No latch and no command to flush: these are lamp
// states sampled by the uplink, not messages sent on an edge.
function j1939LampChange() {
  for (const name of Object.keys(j1939Lamps)) {
    const el = document.getElementById('j1939Lamp_' + name);
    if (el) j1939Lamps[name] = parseInt(el.value, 10) || 0;
  }
}
window.j1939LampChange = j1939LampChange;

// ── THE REQUEST PATH (J1939-21) ───────────────────────────────────────────────
// Most of J1939 is broadcast: an ECU decides a parameter group is worth sending and sends it,
// on its own clock, forever. A handful of parameter groups are NOT sent that way - J1939-71
// gives their transmission repetition rate as "On request", which means the frame does not
// exist until somebody asks for it. PGN 59904 (0xEA00, RQST) is how you ask: three bytes, the
// 24-bit PGN you want, little-endian, addressed to one ECU or to the global address 0xFF.
//
// THIS IS BOTH ENDS OF THAT EXCHANGE. The client half is the bar in the tab - a tool at
// address 0xF9 asking the bus a question. The server half stands in for the vehicle's own
// ECUs and answers out of the game's live telemetry, which is the mirror of the DM1 lamp
// states above: those go INTO the game, these come OUT of it.
//
// It carries three signals whose parameter group is request-only, so they have no periodic
// frame: `speed_limit` (SPN 74, PGN 65261 CCSS), `engine_hours` (SPN 247, PGN 65253 HOURS) and
// `axle_load` (SPN 582, PGN 65258 VW, declared `onRequest` by j1939-flavor.js). Broadcasting
// them at 10 Hz would misstate both their rate and their identity.
//
// Sources: J1939-21 for the request/acknowledgment layouts and the priority-6 default (which
// is what the familiar `18EA`/`18E8` id prefixes carry); J1939-71 for both parameter groups
// (65261 CCSS: on request, priority 6, PDU2, SPN 74 in byte 1 at 1 km/h per bit, 0 offset;
// 65253 HOURS: on request, priority 6, PDU2, SPN 247 in bytes 1-4 at 0.05 h per bit;
// 65258 VW: on request, priority 6, PDU2, SPN 928 in byte 1 and SPN 582 in bytes 2-3 at
// 0.5 kg per bit). The
// isobus.js rule - a PGN/SPN number comes off a primary source, never off a plan document -
// applies here too, and it is cheap to honour because the numbers are in J1939_DB
// (j1939-tables.js): this path encodes through the very table it decodes with.
const J1939_REQ_PGN = 0xEA00;    // Request
const J1939_ACK_PGN = 0xE800;    // Acknowledgment (ACKM)
const J1939_CLAIM_PGN = 0xEE00;  // Address Claimed
const J1939_PRIO_REQ = 6;        // J1939-21's default for the request, the ack and both answers
// J1939-21 control byte. Only NACK is ever sent from here: a positive ACK belongs to commands,
// and the positive answer to a request IS the requested parameter group. (The control-byte
// names, J1939_ACK_CTRL, live in j1939-tables.js.)
const J1939_ACK_NACK = 1;
const J1939_SA_TOOL = 0xF9;      // the request client - Off-Board Diagnostic-Service Tool #1
// Both parameter groups below are engine-ECU functions: the road-speed governor SPN 74 reports
// is part of the engine controller, and so is the hour meter. isobus.js already sources EEC1
// from this same address for the same reason.
const J1939_SA_ENGINE = 0x00;

// The wire primitives (id build, 0xFF blank, the Table 1 clamp, the bit writer) are
// j1939-pack.js's, shared with every packer.
const j1939Pack = window.J1939Pack;

// The exact inverse of j1939DecodeSPN, reading the SAME {b,n,f,o,bit,bits} descriptors out of
// J1939_DB. That is the whole point of writing it this way rather than typing a second table:
// a scale that is wrong here is wrong in the monitor too, and the self-test round-trips one
// against the other. The arithmetic, including J1939-71 Table 1's clamp to 0xFA, 0xFAFF, ...,
// is j1939Pack.put's.
function j1939EncodeSPN(def, data, value) {
  const v = Number(value);
  if (!def || !Number.isFinite(v)) return false;
  if (def.n === 0) j1939Pack.bits(data, def.b, def.bit, def.bits, v);
  else j1939Pack.put(data, def.b, def.n, v, def.f, def.o);
  return true;
}
// Look an SPN descriptor up in J1939_DB by (pgn, spn). Reading it rather than passing one in is
// what keeps the request server from carrying a private copy of a number the decoder already has.
function j1939SpnDef(pgn, spn) {
  const e = J1939_DB[pgn];
  return (e && e.spns && e.spns.find(d => d.spn === spn)) || null;
}
// ── The answerable parameter groups ─────────────────────────────────────────
// A module that can answer a request for a PGN registers here. `signals` is what carlito.js's
// coverage check folds in - a signal SERVED ON REQUEST is covered, and reported on its own line,
// because "carried by a frame that only exists when asked for" and "carried by a periodic frame"
// are different statements and a check that cannot tell them apart hides the difference.
// `build` is handed the game's live telemetry and returns the eight data bytes, or null if THIS
// truck or tractor has nothing to say, and that gets a NACK. (A car or boat is not asked at all:
// it has no J1939 network - see the server below.)
window.j1939RequestServers = window.j1939RequestServers || [];
const J1939_REQ_SERVERS = window.j1939RequestServers;

// The presence of the KEY is the question, never truthiness (j1939Pack.hasNum): the contract says a
// body with no limiter publishes speed_limit 0 EVERY tick rather than omitting it, so a 0 must
// answer with a 0.

J1939_REQ_SERVERS.push({
  pgn: 0xFEED, abbr: 'CCSS', sa: J1939_SA_ENGINE, prio: J1939_PRIO_REQ,
  signals: ['speed_limit'],
  build(t) {
    if (!j1939Pack.hasNum(t, 'speed_limit')) return null;
    const d = j1939Pack.blank();
    // SPN 74 only. 87 and 88 are the cruise high/low set limits, which the game does not model -
    // and 0xFF is how J1939 says exactly that, so they are left standing rather than zeroed.
    j1939EncodeSPN(j1939SpnDef(0xFEED, 74), d, t.speed_limit);
    return d;
  },
});
J1939_REQ_SERVERS.push({
  pgn: 0xFEE5, abbr: 'HOURS', sa: J1939_SA_ENGINE, prio: J1939_PRIO_REQ,
  signals: ['engine_hours'],
  build(t) {
    if (!j1939Pack.hasNum(t, 'engine_hours')) return null;
    const d = j1939Pack.blank();
    // SPN 247 only; 249 (total engine revolutions) has no counter behind it in the game, and an
    // hour meter multiplied by a guessed idle speed would be a second model wearing its hat.
    j1939EncodeSPN(j1939SpnDef(0xFEE5, 247), d, t.engine_hours);
    return d;
  },
});
// Vehicle Weight, for the carlito `j1939` flavor's `axle_load`. The other two servers here are
// engine-ECU functions; THIS ONE IS NOT - a weight is a reading from the suspension, so it is
// answered by Axle - Drive #1 (0x09), the same address isobus.js sources EAC1 from. That is the
// whole reason the server carries its own `sa` rather than a shared constant.
const J1939_SA_AXLE_DRV1 = 0x09;
// SPN 928 Axle Location: low nibble = position left to right, high nibble = axle front to back,
// both zero-based. 0x10 is "second axle, first position" - the drive axle of a two-axle tractor.
// It is SET rather than left at 0xFF, which is the opposite of what isobus.js does with EAC1's
// SPN 927, and the two cases really are different: there is one axle controller in that message
// and no position to give, whereas VW's own note says a request is answered "with as many
// messages as necessary to transmit all available information" - so which axle a weight belongs
// to is carried by this byte and nowhere else, and omitting it would make the answer unreadable.
const J1939_VW_DRIVE_AXLE = 0x10;
J1939_REQ_SERVERS.push({
  pgn: 0xFEEA, abbr: 'VW', sa: J1939_SA_AXLE_DRV1, prio: J1939_PRIO_REQ,
  signals: ['axle_load'],
  build(t) {
    if (!j1939Pack.hasNum(t, 'axle_load')) return null;
    const d = j1939Pack.blank();
    d[0] = J1939_VW_DRIVE_AXLE;
    j1939EncodeSPN(j1939SpnDef(0xFEEA, 582), d, t.axle_load);
    // 180 Trailer Weight and 181 Cargo Weight stay "not available". The contract publishes
    // trailer_axle_load, which is the trailer's AXLE load reported over the trailer's own bus -
    // not the trailer's total mass - and there is no cargo mass anywhere in the telemetry, only
    // the refuse hopper's percentage. Both would be a second model wearing this group's hat.
    return d;
  },
});

// ── Transmit ────────────────────────────────────────────────────────────────
// Everything this path puts on the wire goes through canForward, the same gateway carlito.js's
// telemetry rides: ingested once for the monitor AND transmitted when a bus is open, shown as a
// single FW entry. There is no second transmit path and no bus state to check here.
function j1939TxFrame(pgn, sa, da, prio, data) {
  j1939TxRaw({ id: j1939Pack.buildId(pgn, prio, sa, da), isExt: true, isRtr: false, dlc: data.length, data });
}
function j1939TxRaw(f) {
  // J1939Pack's frames (a claim claimFirst inserts) carry no isRtr / dlc; ingestFrame logs both.
  f = Object.assign({ isRtr: false, dlc: f.data.length }, f);
  if (window.canForward) window.canForward(f);
  else if (window.ingestFrame) window.ingestFrame(f);
}

// ── Server ──────────────────────────────────────────────────────────────────
// Called for every 59904 seen, whichever dictionary the tab's Mode dropdown has selected: that
// dropdown picks how frames are DISPLAYED and must not change what is on the bus.
//
// THE THREE OUTCOMES ARE THE LESSON, and they are different on purpose:
//   - the vehicle publishes the signal            -> the parameter group, from the engine ECU
//   - a vehicle is there but has no such parameter -> a NACK from the engine ECU
//   - no vehicle on the link at all               -> SILENCE, because there is no ECU to answer
//   - a vehicle with no J1939 network (a car, a boat) -> SILENCE, for the same reason
//     (carlito-registry.js's carlitoJ1939Network)
// The silent ones are the same reading the DroneCAN roster gives a node that has stopped publishing.
// An answer, or a NACK, goes through J1939Pack.claimFirst: an ECU claims its address before the
// first frame it ever sends, so a source that has said nothing yet claims first.
// A request that nothing answers is not a bug in the requester. A server with `nack: false` (the
// implement's Address Claimed, isobus.js) folds the second case into the third: a control function
// that is not attached is not on the bus to NACK from.
//
// A REQUEST FOR ADDRESS CLAIMED (60928) is answered by EVERY control function, not one server:
// it is how a node learns who is on the bus. Each source holding a claim (J1939Pack's ledger)
// re-sends its NAME - all of them for a global request, the one asked for a specific one - and
// the implement then answers through its own server below.
let j1939ReqLast = null;   // { ts, pgn, outcome } - the bar's readout, not bus state
function j1939AnswerClaims(parsed) {
  const t = window.carlitoTelemetry ? window.carlitoTelemetry() : null;
  if (!t || !(window.carlitoJ1939Network && window.carlitoJ1939Network(t))) return 0;
  let n = 0;
  for (const sa of j1939Pack.claimedSources()) {
    if (parsed.da !== 0xFF && parsed.da !== sa) continue;   // addressed to some other ECU
    if (parsed.sa === sa) continue;                          // an ECU does not answer itself
    j1939TxRaw(j1939Pack.claimFrame(sa));
    n++;
  }
  return n;
}
function j1939ServeRequest(parsed, data) {
  if (!data || data.length < 3) return;
  const want = (data[0] | (data[1] << 8) | (data[2] << 16)) >>> 0;
  const claims = want === J1939_CLAIM_PGN ? j1939AnswerClaims(parsed) : 0;
  const claimed = claims ? `${claims} vehicle source${claims > 1 ? 's' : ''} re-claimed` : '';
  const note = (o) => j1939ReqNote(want, claimed && o ? claimed + '; ' + o : (claimed || o));
  // Whether anything here implements the group AT ALL, kept apart from whether it was addressed
  // to the right ECU. Those are different answers: "nobody carries this" and "the ECU that
  // carries it is not the one you asked" are the two ways a specific-address request goes quiet,
  // and telling a reader they are the same thing would send them looking in the wrong place.
  let implemented = null;
  for (const srv of J1939_REQ_SERVERS) {
    if (srv.pgn !== want) continue;
    implemented = srv;
    if (parsed.da !== 0xFF && parsed.da !== srv.sa) continue;   // addressed to some other ECU
    if (parsed.sa === srv.sa) continue;                          // an ECU does not answer itself
    const t = window.carlitoTelemetry ? window.carlitoTelemetry() : null;
    if (!t) { note('no vehicle on the link - nothing answered'); return; }
    if (!(window.carlitoJ1939Network && window.carlitoJ1939Network(t))) {
      note('this vehicle has no J1939 network - nothing answered'); return;
    }
    const tx = (pgn, da, prio, data) => {
      const f = { id: j1939Pack.buildId(pgn, prio, srv.sa, da), isExt: true, isRtr: false, dlc: data.length, data };
      for (const g of j1939Pack.claimFirst([f], t)) j1939TxRaw(g);
    };
    const payload = srv.build(t);
    if (payload) {
      // PDU2, so the answer is a broadcast whoever asked for it - which is why every listener
      // sees it and it lands in the PGN Monitor beside the periodic traffic.
      tx(srv.pgn, 0xFF, srv.prio, payload);
      note('answered by ' + j1939SaLabel(srv.sa));
    } else if (srv.nack === false) {
      // The address, not a label: the last claim from it is still in the map, and naming the
      // implement that just left as the one not answering would read backwards.
      note(`nothing at 0x${j1939H(srv.sa)} to answer`);
    } else {
      const d = j1939Pack.blank();
      d[0] = J1939_ACK_NACK;
      d[1] = 0xFF;                                   // group function: not applicable to a request
      d[4] = srv.sa;                                 // the address the acknowledgment came from
      d[5] = want & 0xFF; d[6] = (want >> 8) & 0xFF; d[7] = (want >> 16) & 0xFF;
      tx(J1939_ACK_PGN, parsed.sa, J1939_PRIO_REQ, d);
      note('NACK - this vehicle carries no such parameter');
    }
    return;
  }
  // The address named here is the SERVER'S, not a constant: VW is answered by Axle - Drive #1
  // and the other two by Engine #1, so a fixed 'it is the engine' would send a reader looking at
  // the wrong ECU for one group in three.
  if (claims) { note(''); return; }   // the vehicle's own sources answered; no server is this one
  // Every control function answers 60928, so the implement's server is no pointer for it.
  if (want === J1939_CLAIM_PGN) {
    note(parsed.da === 0xFF ? 'nothing on this bus has claimed an address' : `nothing at 0x${j1939H(parsed.da)} has claimed an address`);
    return;
  }
  note(implemented
    ? `it is ${j1939SaLabel(implemented.sa)} that carries this one, not 0x${j1939H(parsed.da)}`
    : 'nothing on this bus implements it - no answer is the answer');
}
function j1939ReqNote(pgn, outcome) {
  j1939ReqLast = { ts: Date.now(), pgn, outcome };
  const el = document.getElementById('j1939ReqStatus');
  if (el) el.textContent = j1939PgnLabel(pgn) + ' - ' + outcome;
}

// ── Client ──────────────────────────────────────────────────────────────────
// The bar's Send button. Reads the PGN box (0x-prefixed hex, else decimal - canParseIntAuto's
// rules) and the destination, then puts a real 59904 on the bus from the tool address. The
// server above answers it exactly the way it would answer a laptop plugged into the same
// connector: the exchange is not short-circuited internally, it goes out and comes back.
function j1939SendRequest() {
  const pgnEl = document.getElementById('j1939ReqPgn');
  const daEl  = document.getElementById('j1939ReqDa');
  const pgn = window.canParseIntAuto ? window.canParseIntAuto(pgnEl ? pgnEl.value : '') : NaN;
  if (!Number.isFinite(pgn) || pgn > 0xFFFFFF) { j1939ReqNote(0, 'not a PGN'); return; }

  let da = 0xFF;
  if (daEl) {
    const raw = (daEl.value || '').trim();
    if (!raw || /^(every|global)/i.test(raw)) {
      da = 0xFF;
    } else {
      const m = raw.match(/^(0x[0-9a-fA-F]+|\d+)/);
      const token = m ? m[1] : raw;
      const v = window.canParseIntAuto ? window.canParseIntAuto(token) : parseInt(token, 10);
      if (!Number.isFinite(v) || v < 0 || v > 255) { j1939ReqNote(pgn, 'invalid destination address'); return; }
      da = v & 0xFF;
    }
  }
  // The readout is set BEFORE the frame goes out, because the frame comes straight back through
  // ingestFrame and the server writes the OUTCOME over it in the same call stack. Noting it
  // afterwards would report "requested" every time and hide the answer.
  j1939ReqNote(pgn, 'requested' + (da === 0xFF ? ' (global)' : ' from 0x' + j1939H(da)));
  j1939TxFrame(J1939_REQ_PGN, J1939_SA_TOOL, da, J1939_PRIO_REQ,
    [pgn & 0xFF, (pgn >> 8) & 0xFF, (pgn >> 16) & 0xFF]);
}
// The preset dropdown only FILLS the box. The request stays a typed field, because the point of
// the bar is that any PGN can be asked for - including one nothing here answers, which is a
// reading of its own.
function j1939ReqPreset() {
  const sel = document.getElementById('j1939ReqPreset');
  const box = document.getElementById('j1939ReqPgn');
  if (sel && box && sel.value) { box.value = sel.value; sel.value = ''; }
}
window.j1939SendRequest = j1939SendRequest;
window.j1939ReqPreset = j1939ReqPreset;

window.j1939SetProto = j1939SetProto;
window.j1939GetProto = () => j1939ProtoMode;
window.j1939Apply    = (m) => j1939SetProto(m || window._j1939ProtoPending || 'j1939');

// Toggle-button handler. In demo mode, switching protocol also switches the demo
// base traffic (prompted); otherwise it just swaps the decode dictionary + persists.
function j1939ProtoClick(mode) {
  if (window.demoIsActive && window.demoIsActive()) {
    // In demo: demoMaybeSwitch prompts then applies (it calls j1939SetProto itself).
    const lbl = mode === 'nmea2000' ? 'NMEA 2000' : mode === 'iso11783' ? 'ISO 11783' : 'J1939';
    window.demoMaybeSwitch(mode, lbl);
  } else {
    j1939SetProto(mode);
    if (window.j1939ScheduleSave) window.j1939ScheduleSave();
  }
  // Each mode is a different machine's bus; the mode → vehicle mapping is in vehicle-panel.js.
  // ONLY IF THE MODE ACTUALLY TOOK: in demo, demoMaybeSwitch is two confirms of its own and can
  // be declined, and a third dialog about a mode the user is not in would be wrong.
  if (j1939ProtoMode === mode && window.vehiclePanelRequestForProto) window.vehiclePanelRequestForProto(mode);
}
window.j1939ProtoClick = j1939ProtoClick;

// ── Clear Hook ────────────────────────────────────────────────────────────────
function j1939Clear() {
  j1939PgnMap.clear();
  j1939AddrMap.clear();
  j1939DmMap.clear();
  j1939Log = [];
  j1939TpSessions.clear();
  j1939ReqLast = null;
  const rq = document.getElementById('j1939ReqStatus');
  if (rq) rq.textContent = '';
  j1939Dirty = true;
}

// ── Sub-tab Switching ─────────────────────────────────────────────────────────
function j1939SubTab(name) {
  j1939SubActive = name;
  ['pgn','log','dm','addr'].forEach(n => {
    const btn = document.getElementById('j1939stab-' + n);
    btn.classList.toggle('active', n === name);
    btn.setAttribute('aria-selected', n === name ? 'true' : 'false');
    document.getElementById('j1939-' + n).style.display = n === name ? '' : 'none';
  });
  j1939Dirty = true; // only the active sub-tab is rendered; force the newly-shown one
  j1939Render();
}

// ── Render ────────────────────────────────────────────────────────────────────
function j1939Render() {
  if (document.getElementById('j1939Wrap')?.style.display === 'none') { j1939WasHidden = true; return; }
  if (j1939WasHidden) { j1939WasHidden = false; j1939Dirty = true; } // tab just became visible - refresh
  if (!j1939Dirty) return;
  // Throttle the full-table innerHTML rebuild to ~15 fps: j1939Dirty is set per dispatched frame,
  // which on a busy bus would rebuild the active sub-tab ~60×/s. Don't clear dirty while throttled
  // so the next RAF still renders once the window elapses.
  const _nowR = Date.now();
  if (_nowR - j1939LastRender < J1939_RENDER_MS) return;
  j1939LastRender = _nowR;
  j1939Dirty = false;

  const badge = document.getElementById('j1939Badge');
  if (badge) badge.textContent = `${j1939PgnMap.size} PGN${j1939PgnMap.size !== 1 ? 's' : ''} · ${j1939AddrMap.size} addr`;

  switch (j1939SubActive) {
    case 'pgn':  j1939RenderPGN();  break;
    case 'log':  j1939RenderLog();  break;
    case 'dm':   j1939RenderDM();   break;
    case 'addr': j1939RenderAddr(); break;
  }
}

function j1939SpnHtml(results) {
  if (!results || !results.length) return '<span style="color:var(--text3)">-</span>';
  return results.filter(r => r.valid).map(r =>
    `<span style="color:var(--text2);font-family:var(--sans);font-size:10px">${r.name}</span> `+
    `<span style="color:var(--green)">${r.display}</span>`
  ).join('<br>');
}

function j1939BytesHtml(data, max = 32) {
  const arr = Array.from(data);
  const shown = arr.slice(0, max).map(b => j1939H(b)).join(' ');
  return arr.length > max ? `${shown} … <span style="color:var(--text3)">(${arr.length} bytes)</span>` : shown;
}

// The sub-tabs update their rows in place (sloppycan.js's renderKeyedTable): a full innerHTML
// rebuild at ~15 fps restarted the hover fade, split clicks and wiped text selection.

// PGN Monitor - one row per PGN per SA, most recent values
function j1939RenderPGN() {
  const el = document.getElementById('j1939-pgn');
  const all = [...j1939PgnMap.values()];   // least recently seen first
  const rows = all.slice(-J1939_PGN_ROWS).sort((a,b) => a.pgn - b.pgn || a.sa - b.sa);
  const hidden = all.length - rows.length;
  if (hidden) rows.push({ more: hidden });
  const db = j1939ActiveDb();
  window.renderKeyedTable(el, {
    tableClass: 'j1939-tbl',
    theadHtml: `<tr>
    <th>PGN</th><th>Name</th><th>SA (Source)</th><th>Values</th>
    <th>Frames</th><th>Last seen</th><th>Raw data</th>
  </tr>`,
    emptyHtml: '<div class="j1939-empty">No J1939 frames received yet.<br>J1939 uses 29-bit extended CAN IDs.</div>',
  }, rows, e => e.more ? 'more' : e.pgn + ':' + e.sa, e => {
    if (e.more) return { cells: [{ span: 7, style: 'color:var(--text3);text-align:center',
      html: `${e.more} more not shown (least recently seen)` }] };
    const entry = db[e.pgn];
    const pgnStr = j1939H(e.pgn, 4);
    const name = entry ? `<b>${entry.abbr}</b> <span style="color:var(--text3)">${entry.name}</span>` : `PGN ${pgnStr}`;
    const tpBadge = e.fromTP ? `<span class="j1939-tp-badge">${e.fromTP === 'etp' ? 'ETP' : (j1939ProtoMode === 'nmea2000' ? 'FP' : 'TP')}</span>` : '';
    return { cells: [
      { cls: 'j-pgn', html: pgnStr + tpBadge },
      { cls: 'j-name', html: name },
      { cls: 'j-sa', style: 'white-space:nowrap', html: `0x${j1939H(e.sa)}<br><span style="color:var(--text3);font-family:var(--sans);font-size:10px">${j1939SaLabel(e.sa)}</span>` },
      j1939SpnHtml(e.spnResults),
      { cls: 'j-ts', html: e.count },
      { cls: 'j-ts', html: j1939RelTs(e.ts) },
      { cls: 'j-raw', html: j1939BytesHtml(e.data) },
    ] };
  });
}

// Frame Log - last J1939_LOG_MAX decoded frames, chronological (newest at bottom)
function j1939RenderLog() {
  const el = document.getElementById('j1939-log');
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const db = j1939ActiveDb();
  window.renderKeyedTable(el, {
    tableClass: 'j1939-tbl',
    theadHtml: `<tr>
    <th>Time</th><th>PGN</th><th>SA → DA</th><th>Values / Raw</th>
  </tr>`,
    emptyHtml: '<div class="j1939-empty">No J1939 frames in log yet.</div>',
  }, j1939Log, e => e.seq, e => {
    const entry = db[e.pgn];
    const pgnLabel = entry ? `<b>${entry.abbr}</b>` : j1939H(e.pgn,4);
    const tpBadge  = e.fromTP ? `<span class="j1939-tp-badge">${e.fromTP === 'etp' ? 'ETP' : (j1939ProtoMode === 'nmea2000' ? 'FP' : 'TP')}</span>` : '';
    const daStr    = e.da === 0xFF ? 'FF (bcast)' : j1939H(e.da);
    const vals     = e.spnResults?.filter(r=>r.valid).map(r=>`${r.name}: ${r.display}`).join(' · ') || j1939BytesHtml(e.data);
    return { cells: [
      { cls: 'j-ts', html: j1939RelTs(e.ts) },
      { cls: 'j-pgn', html: pgnLabel + tpBadge },
      { cls: 'j-sa', style: 'white-space:nowrap', html: `0x${j1939H(e.sa)} → 0x${daStr}` },
      { style: 'font-size:10.5px;color:var(--text2);font-family:var(--mono)', html: vals },
    ] };
  });
  if (j1939Log.length && nearBottom) el.scrollTop = el.scrollHeight;
}

// Faults - DM1 (active) and DM2 (previously active) per SA. One section element per SA, built once;
// inside it each DM type has a header line and a DTC table keyed by SPN:FMI.
function j1939RenderDM() {
  const el = document.getElementById('j1939-dm');
  if (!j1939DmMap.size) {
    el._dmSecs = null;
    window.setHtmlIfChanged(el, '<div class="j1939-empty">No DM1/DM2 messages received yet.<br>DM1 = active faults, DM2 = previously active.</div>');
    return;
  }
  if (!el._dmSecs) { el.innerHTML = el._html = ''; el._dmSecs = new Map(); }
  const secs = el._dmSecs;
  const entries = [...j1939DmMap.entries()].sort((a,b) => a[0]-b[0]);
  const want = new Set(entries.map(([sa]) => sa));
  for (const [sa, sec] of secs) if (!want.has(sa)) { sec.root.remove(); secs.delete(sa); }
  entries.forEach(([sa, entry], i) => {
    let sec = secs.get(sa);
    if (!sec) {
      const root = document.createElement('div');
      root.style.marginBottom = '20px';
      root.innerHTML = '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px;font-family:var(--sans)"></div>' +
        ['dm1', 'dm2'].map(t => `<div data-dm="${t}" style="margin-bottom:8px"><span></span><div></div></div>`).join('');
      sec = { root, title: root.firstChild, blocks: {} };
      for (const t of ['dm1', 'dm2']) {
        const b = root.querySelector(`[data-dm="${t}"]`);
        sec.blocks[t] = { b, head: b.firstChild, tbl: b.lastChild };
      }
      secs.set(sa, sec);
    }
    if (el.children[i] !== sec.root) el.insertBefore(sec.root, el.children[i] || null);
    window.setHtmlIfChanged(sec.title, `SA 0x${j1939H(sa)} - ${j1939SaLabel(sa)}`);
    for (const [type, dtcs, ts, rawMsgData] of [
      ['dm1', entry.dm1, entry.dm1ts, entry.dm1Data],
      ['dm2', entry.dm2, entry.dm2ts, entry.dm2Data]
    ]) {
      const blk = sec.blocks[type];
      const disp = dtcs ? '' : 'none';
      if (blk.b.style.display !== disp) blk.b.style.display = disp;
      if (!dtcs) continue;
      window.setHtmlIfChanged(blk.head, `<span class="j1939-fault-badge ${type}">${type.toUpperCase()}</span>
      <span style="font-size:10px;color:var(--text3);margin-left:6px;font-family:var(--sans)">${ts ? j1939RelTs(ts) : ''} - ${dtcs.length} fault${dtcs.length!==1?'s':''}</span>
      <span class="j-raw" style="margin-left:10px" title="Raw message payload">Raw: ${rawMsgData ? j1939BytesHtml(rawMsgData) : '-'}</span>` +
        (dtcs.length ? '' : `<span style="font-size:11px;color:var(--green);margin-left:10px;font-family:var(--sans)">No active faults</span>`));
      const mt = dtcs.length ? '4px' : '';
      if (blk.tbl.style.marginTop !== mt) blk.tbl.style.marginTop = mt;
      window.renderKeyedTable(blk.tbl, {
        tableClass: 'j1939-tbl',
        theadHtml: '<tr><th>SPN</th><th>FMI</th><th>Description</th><th>Count</th><th>Raw Data</th></tr>',
      }, dtcs, d => d.spn + ':' + d.fmi, d => {
        // Deep-link the SPN to dtc.html (reconstruct the 4-byte DM record).
        const rec = [d.spn & 0xFF, (d.spn >> 8) & 0xFF, (((d.spn >> 16) & 0x7) << 5) | (d.fmi & 0x1F), d.oc & 0x7F];
        const href = `explainers/dtc.html?bytes=${rec.map(x => x.toString(16).toUpperCase().padStart(2,'0')).join('+')}&fmt=j1939`;
        return { cells: [
          { cls: 'j-pgn', html: `<a href="${href}" target="_blank" style="color:inherit;text-decoration:none" title="Decode in DTC decoder">${d.spn} ↗</a>` },
          { cls: 'j-ts', html: d.fmi },
          { cls: 'j-name', html: d.fmiDesc },
          { cls: 'j-ts', html: d.oc },
          { cls: 'j-raw', title: 'Raw 4-byte DTC record (hex)', html: d.raw ? j1939BytesHtml(d.raw) : rec.map(x => j1939H(x)).join(' ') },
        ] };
      });
    }
  });
}

// Keep the PGN request destination dropdown options in sync with claimed CAs
function j1939UpdateDaList() {
  const dl = document.getElementById('j1939ReqDaList');
  if (!dl) return;
  const staticOpts = [
    { val: '255', label: 'every ECU (global / 0xFF)' },
    { val: '0x00', label: '0x00 Engine #1' },
    { val: '0xF0', label: '0xF0 Tractor ECU' },
  ];
  const seen = new Set(['255', '0', '0x00', '240', '0xF0', '0xf0']);
  const dynamicOpts = [];
  if (typeof j1939AddrMap !== 'undefined' && j1939AddrMap.size) {
    for (const [sa, info] of j1939AddrMap.entries()) {
      const saHex = '0x' + j1939H(sa);
      if (seen.has(String(sa)) || seen.has(saHex) || seen.has(saHex.toLowerCase())) continue;
      seen.add(String(sa));
      seen.add(saHex);
      const name = info.fnName || j1939SaLabel(sa) || 'ECU';
      dynamicOpts.push({ val: saHex, label: `${saHex} ${name}` });
    }
  }
  dl.innerHTML = [...staticOpts, ...dynamicOpts].map(o => `<option value="${o.val}">${o.label}</option>`).join('');
}

// Address Claim - SA → device identity table
function j1939RenderAddr() {
  j1939UpdateDaList();
  const el = document.getElementById('j1939-addr');
  window.renderKeyedTable(el, {
    tableClass: 'j1939-tbl',
    theadHtml: `<tr>
    <th>SA</th><th>Function</th><th>Industry</th><th>ECU Instance</th>
    <th>Mfr Code</th><th>Arb. Addr</th><th>Last seen</th><th>Raw Data</th>
  </tr>`,
    emptyHtml: '<div class="j1939-empty">No Address Claim (PGN 0xEE00) messages received.<br>Devices broadcast their identity when joining the bus.</div>',
  }, [...j1939AddrMap.values()].sort((a,b)=>a.sa-b.sa), e => e.sa, e => ({ cells: [
    { cls: 'j-pgn', html: `0x${j1939H(e.sa)}` },
    { cls: 'j-name', html: j1939ProtoMode === 'nmea2000'
      ? `${NMEA_DEVICE_CLASS[e.devClass] || ('Class ' + e.devClass)} <span style="color:var(--text3)">/ Fn ${e.fn}</span>`
      : j1939ProtoMode === 'iso11783'
      ? `${ISOBUS_DEVICE_CLASS[e.devClass] || ('Class ' + e.devClass)} <span style="color:var(--text3)">/ ${e.fnName}</span>`
      : e.fnName },
    { cls: 'j-name', html: e.industryName },
    { cls: 'j-ts', html: e.ecuInst },
    { cls: 'j-ts', html: `0x${j1939H(e.mfrCode,3)}` },
    { cls: 'j-ts', html: e.arbitrary ? 'Yes' : 'No' },
    { cls: 'j-ts', html: j1939RelTs(e.ts) },
    { cls: 'j-raw', title: 'Raw 8-byte NAME (hex)', html: e.data ? j1939BytesHtml(e.data) : '-' },
  ] }));
}

// ── Demo (NMEA 2000) ──────────────────────────────────────────────────────────
// window.j1939DemoFrames() is called by sloppycan.js's demo loop; it returns an
// array of synthetic N2K frames for the current tick, EMPTY unless NMEA mode is
// active (so the J1939 tab/ID List stay clean otherwise). Includes a 127489
// Fast-Packet burst so reassembly is exercised.
let j1939DemoTickN = 0; // tick counter (FP burst every 5th)
let j1939DemoSeq   = 0; // rotating Fast-Packet sequence counter
// Priority 6. A PDU1 PGN (the address claims, ETP, the Task Controller value) goes to `da`, or to
// the global address 0xFF when none is given; a PDU2 PGN ignores it.
function n2kFrame(pgn, sa, data, da) { return { id: j1939Pack.buildId(pgn, 6, sa, da), isExt: true, isRtr: false, dlc: data.length, data }; }
function n2kU16(v) { v = Math.round(v) & 0xFFFF; return [v & 0xFF, (v >> 8) & 0xFF]; }
function n2kI16(v) { v = Math.round(v); if (v < 0) v += 0x10000; v &= 0xFFFF; return [v & 0xFF, (v >> 8) & 0xFF]; }
function n2kU32(v) { v = Math.round(v) >>> 0; return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }
function n2kI32(v) { v = Math.round(v); if (v < 0) v += 0x100000000; v = v >>> 0; return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }

// The RAMN Control Panel, when it is what drives: j1939-flavor.js encodes it as the J1939
// driver-demand groups (EEC2 / EBC1 / VDC2 / TC1, SPN 70 / 597 in CCVS), nmea2000.js its steer
// as a rudder order. Null while the panel's traffic is off (Disable traffic, or a Carlito
// challenge), so hand-sent frames are the only driver then - and while a DRONE is on the link: a
// live pedal makes the bridge drive outright, and the drone's always-sourced DroneCAN `arm` would
// then keep it grounded with the keyboard locked out, where the fallback lets the keyboard fly it.
function j1939DemoDriveCtrl() {
  if (!window.ramnCtrlGet) return null;
  if (window.ramnTrafficOn && !window.ramnTrafficOn()) return null;
  if (window.vehiclePanelIsFamily && window.carlitoTelemetry &&
      window.vehiclePanelIsFamily('drone', window.carlitoTelemetry())) return null;
  return window.ramnCtrlGet();
}
// The same demand for the encoders the game's own groups share: while VDC2 / CCVS are the game's
// (one producer, below), j1939-flavor.js carries the wheel and switches inside them. The pedal's
// EEC2 is never the game's: the demo sends its own.
// Null unless the demo is running a traffic that drives through J1939.
window.j1939DemoDrive = () => {
  const kind = window.demoIsActive && window.demoIsActive() && window.demoGetBaseTraffic && window.demoGetBaseTraffic();
  return (kind === 'j1939' || kind === 'iso11783') ? j1939DemoDriveCtrl() : null;
};

// ── One producer per group, while the game is on the link ─────────────────────
// While the game's telemetry is being forwarded, every (PGN, source address) on the bus has
// EXACTLY ONE producer, and the demo sends only what the game has no equivalent for:
//  - nothing the telemetry path is forwarding (carlito.js carlitoProducing: what it actually sent,
//    so no packer's gate is restated here) - which is why the demo's boat position and wind are
//    sent from nmea2000.js's navigation address (0x02), the address the boat's own come from;
//  - nothing the game carries under another identity (J1939_GAME_TWINS): a tractor's bearing
//    and speed are 0x520 / 0x524's, which VDS would restate;
//  - no claim of an address the game holds: an implement claims once, on attaching (isobus.js),
//    and keeps 0x80 - the demo sprayer's address - for as long as it stays attached; and every
//    vehicle source claims once, before its first frame (J1939Pack.claimFirst), so a demo NAME
//    at an address in that ledger would be a second NAME there once the claim's hold lapsed.
// A car produces no J1939 group, so it silences nothing. The driver demand is not lost when its
// group is the game's: j1939-flavor.js merges it into that one frame (VDC2 / CCVS).
const J1939_GAME_TWINS = { tractor: [0xFEE8] };
const J1939_SA_IMPLEMENT = 0x80;
function j1939DemoDropGameOwned(frames) {
  const p = window.carlitoProducing ? window.carlitoProducing() : null;
  if (!p) return frames;
  const is = (fam) => !!(window.carlitoIsFamily && window.carlitoIsFamily(fam, p.t));
  const twins = new Set(Object.keys(J1939_GAME_TWINS).filter(is).flatMap(fam => J1939_GAME_TWINS[fam]));
  const implement = is('tractor') && !!p.t.implement_connected;
  const claimed = new Set(j1939Pack.claimedSources());
  return frames.filter(f => {
    const { pgn, sa } = j1939Pack.parseId(f.id >>> 0);
    if (twins.has(pgn) || p.produces(pgn, sa)) return false;
    if (pgn === 0xEE00 && claimed.has(sa)) return false;
    return !(implement && pgn === 0xEE00 && sa === J1939_SA_IMPLEMENT);
  });
}

// Plain-J1939 base traffic: animated EEC1/ET1/CCVS1/VEP1/Fuel PGNs, the driver demand, + a periodic
// engine ISO Address Claim, all PDU2 broadcast from SA 0x00 except Dash Display, from Instrument
// Cluster #1 (0x17). Empty unless J1939 mode.
//
// ONE ENCODER PER GROUP: the five groups come out of j1939-flavor.js's builders, the ones the
// game's mirrors use (window.j1939FlavorFrames), with that file's addresses and priorities. The
// fields only the demo animates (torques, fuel and oil temperature, cruise, charging voltage) are
// written over them through J1939_DB's own descriptors, so no scale is typed here.
//
// PACED BY THE STANDARD: each group goes out at JF_MSGS's `ms` (J1939-71's repetition rate), not
// at the demo tick - ET1 / VEP1 / DD once a second. A group is due on the first tick at least
// `ms` after its last, less half a tick, so a tick that fires early does not skip it; EEC1's 0
// ("engine speed dependent") rides every tick. The tick is MEASURED (the spacing since the last
// call), so the interval stays sloppycan.js demoStartBaseTimers' alone.
const j1939DemoLastAt = {};       // group -> Date.now() it last went out
let j1939DemoPrevAt;              // Date.now() of the previous tick
function j1939DemoDue(name, now, tol) {
  const ms = window.j1939FlavorMsgs[name].ms, last = j1939DemoLastAt[name];
  if (ms && last !== undefined && now - last < ms - tol) return false;
  j1939DemoLastAt[name] = now;
  return true;
}
let j1939DemoTickJ = 0;
function j1939BaseDemoFrames() {
  const now = Date.now(), t = now / 1000;
  const tol = j1939DemoPrevAt === undefined ? 0 : (now - j1939DemoPrevAt) / 2;   // half a tick
  j1939DemoPrevAt = now;
  const osc = (lo, hi, p, ph = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / p + ph));
  const frames = [];
  const G = window.j1939FlavorFrames;
  const full = (f) => ({ id: f.id, isExt: true, isRtr: false, dlc: f.data.length, data: f.data });
  const spn = (f, pgn, n, v) => j1939EncodeSPN(j1939SpnDef(pgn, n), f.data, v);
  // SPN 70 Parking Brake (1.3) and SPN 597 Brake Switch (4.5) in CCVS come from the RAMN Control
  // Panel while it drives, and read "not available" otherwise - a switch reading "off" would be
  // decoded as a command and dim a stop lamp someone is sending by hand.
  const drive = window.j1939DriveFrames ? j1939DemoDriveCtrl() : null;
  if (G && j1939DemoDue('EEC1', now, tol)) {
    const f = G.EEC1({ rpm: osc(700, 2200, 9) });
    j1939Pack.bits(f.data, 0, 0, 4, 0);                  // SPN 899 Engine Torque Mode, 0 as ever
    spn(f, 0xF004, 512, osc(5, 40, 7));
    spn(f, 0xF004, 513, osc(5, 40, 7, 1));
    frames.push(full(f));
  }
  if (G && j1939DemoDue('ET1', now, tol)) {
    const f = G.ET1({ coolant: osc(80, 95, 60) });
    spn(f, 0xFEEE, 174, osc(40, 60, 50));                // fuel temperature
    spn(f, 0xFEEE, 175, 90);                             // oil temperature
    frames.push(full(f));
  }
  if (G && j1939DemoDue('CCVS', now, tol)) {
    const f = G.CCVS({ kmh: osc(0, 90, 23) }, drive);
    for (const n of [595, 596, 598]) spn(f, 0xFEF1, n, 0); // cruise active / enable, clutch: off
    spn(f, 0xFEF1, 86, osc(60, 90, 40));                 // cruise set speed
    frames.push(full(f));
  }
  if (drive) frames.push(...window.j1939DriveFrames(drive));
  if (G && j1939DemoDue('VEP1', now, tol)) {
    const f = G.VEP1({ battery: osc(12.4, 14.2, 11) });
    spn(f, 0xFEF7, 167, 13.8);                           // charging system potential
    frames.push(full(f));
  }
  // Dash Display from Instrument Cluster #1 - the sender j1939-flavor.js's DD mirror uses, so the
  // one-producer rule sees the two as one group.
  if (G && j1939DemoDue('DD', now, tol)) frames.push(full(G.DD({ fuel: osc(20, 90, 200) })));
  // ISO Address Claim (0xEE00) every 30th tick - engine ECU NAME.
  if (j1939DemoTickJ++ % 30 === 0) {
    const name = (id, mfr, fn, devClass, indGrp) =>
      [...n2kU32((id | (mfr << 21)) >>> 0), ...n2kU32(((fn << 8) | (devClass << 17) | (indGrp << 28) | (1 << 31)) >>> 0)];
    frames.push(n2kFrame(0xEE00, 0x00, name(0x40001, 0, 0, 0, 0))); // Engine #1
  }
  return frames;
}

function j1939DemoFrames() {
  const frames = j1939ProtoMode === 'iso11783' ? isoDemoFrames()
    : j1939ProtoMode === 'j1939' ? j1939BaseDemoFrames() : n2kDemoFrames();
  return j1939DemoDropGameOwned(frames);
}
function n2kDemoFrames() {
  const t = Date.now() / 1000;
  const osc = (lo, hi, p, ph = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / p + ph));
  const frames = [];
  // 127245 Rudder ORDER from the steering control head: the RAMN Control Panel's steer (nmea2000.js).
  const drive = j1939DemoDriveCtrl();
  if (drive && window.nmea2000RudderOrderFrame) {
    const o = window.nmea2000RudderOrderFrame(drive.steer);
    frames.push({ id: o.id, isExt: true, isRtr: false, dlc: o.data.length, data: o.data });
  }
  // 127250 Vessel Heading (true) - single frame
  // Deviation and Variation are signed and little-endian: "not available" is 0x7FFF, so FF 7F.
  frames.push(n2kFrame(127250, 0x02, [0xFF, ...n2kU16(osc(0, 2*Math.PI, 30) / 0.0001), 0xFF, 0x7F, 0xFF, 0x7F, 0x00]));
  // 127488 Engine Rapid - speed + boost
  frames.push(n2kFrame(127488, 0x00, [0x00, ...n2kU16(osc(700, 3500, 11) / 0.25), ...n2kU16(120000 / 100), 0x00, 0xFF, 0xFF]));
  // 129025 Position Rapid Update (1e-7 deg) and 130306 Wind Data (apparent), both from 0x02 -
  // nmea2000.js's navigation address (SA_NAV) - so a boat's own groups replace these one for one.
  frames.push(n2kFrame(129025, 0x02, [...n2kI32((37.81 + 0.001 * Math.sin(t / 20)) / 1e-7), ...n2kI32((-122.45 + 0.001 * Math.cos(t / 20)) / 1e-7)]));
  frames.push(n2kFrame(130306, 0x02, [0xFF, ...n2kU16(osc(0, 15, 17) / 0.01), ...n2kU16(osc(0, 2*Math.PI, 23) / 0.0001), 0x02, 0xFF, 0xFF]));

  // 127489 Engine Dynamic (Fast Packet, 26-byte payload) every 5th tick
  if ((j1939DemoTickN++ % 5) === 0) {
    const payload = [
      0x00,                                 // instance
      ...n2kU16(350000 / 100),              // oil pressure (kPa = 350)
      ...n2kU16((90 + 273.15) / 0.1),       // oil temp 90 °C
      ...n2kU16((osc(82, 96, 60) + 273.15) / 0.01), // coolant temp
      ...n2kI16(1390),                      // alternator 13.90 V
      ...n2kI16(osc(5, 40, 13) / 0.1),      // fuel rate
      ...n2kU32(1234 * 3600),               // engine hours
      ...n2kU16(450000 / 100),              // coolant pressure
      ...n2kU16(300000 / 1000),             // fuel pressure
      0xFF,                                 // reserved
      0x00, 0x00, 0x00, 0x00,              // discrete status 1 & 2
      Math.round(osc(20, 85, 9)) & 0xFF,   // engine load %
      0x32,                                 // engine torque %
    ]; // 26 bytes
    const seq = (j1939DemoSeq++ & 0x07), total = payload.length;
    let idx = 0;
    const f0 = [(seq << 5) | 0, total];
    for (let i = 0; i < 6; i++) f0.push(idx < total ? payload[idx++] : 0xFF);
    frames.push(n2kFrame(127489, 0x00, f0));
    for (let fc = 1; idx < total; fc++) {
      const fr = [(seq << 5) | fc];
      for (let i = 0; i < 7; i++) fr.push(idx < total ? payload[idx++] : 0xFF);
      frames.push(n2kFrame(127489, 0x00, fr));
    }
  }
  return frames;
}
// ── Demo (ISO 11783 / ISOBUS) ─────────────────────────────────────────────────
// Synthetic TECU speed/PTO/hitch + a Task-Controller value, periodic ag address
// claims, and (every 80th tick) a >1785-byte ETP object-pool transfer to the VT
// so ETP reassembly + the DPO offset path are exercised. Empty unless ISOBUS mode.
let isoDemoTick = 0;
function isoEtpDemoFrames(sa, da, targetPgn, payload) {
  const frames = [];
  const total = payload.length;
  const pgn3 = [targetPgn & 0xFF, (targetPgn >> 8) & 0xFF, (targetPgn >> 16) & 0xFF];
  const totalPkts = Math.ceil(total / 7);
  frames.push(n2kFrame(0xC800, sa, [0x14, ...n2kU32(total), ...pgn3], da)); // RTS
  const emitWindow = (dpoOffset, nPkts) => {
    // DPO: ctrl 0x16, num packets, 3-byte packet offset, PGN - then the DT packets.
    frames.push(n2kFrame(0xC800, sa, [0x16, nPkts & 0xFF, dpoOffset & 0xFF, (dpoOffset >> 8) & 0xFF, (dpoOffset >> 16) & 0xFF, ...pgn3], da));
    for (let p = 1; p <= nPkts; p++) {
      const off = (dpoOffset + p - 1) * 7;
      const fr = [p];
      for (let i = 0; i < 7; i++) fr.push(off + i < total ? payload[off + i] : 0xFF);
      frames.push(n2kFrame(0xC700, sa, fr, da));
    }
  };
  const win1 = Math.min(totalPkts, 200); // two DPO windows to exercise the offset path
  emitWindow(0, win1);
  if (totalPkts > win1) emitWindow(win1, totalPkts - win1);
  return frames;
}
function isoDemoFrames() {
  const t = Date.now() / 1000;
  const osc = (lo, hi, p, ph = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / p + ph));
  const frames = [];
  const tick = isoDemoTick++;

  // Tractor ECU (SA 0xF0): wheel speed/distance, rear PTO, rear hitch, direction/speed.
  // Byte 8 is 0x15, not 0x40: direction (8.1) Forward, key switch (8.3) Not off, start/stop
  // (8.5) Permit, operator direction reversed (8.7) Not reversed.
  frames.push(n2kFrame(0xFE48, 0xF0, [...n2kU16(osc(0, 8, 17) / 0.001), ...n2kU32(Math.round((t % 1000) * 1000)), 0xFF, 0x15]));
  // The PTO rides 0xFE43 and the hitch 0xFE45, not the reverse. Byte 5 of the PTO is
  // 0x41 so the request status (5.1) and the engagement itself (5.7) both read Engaged; byte 2
  // of the hitch is 0x7F so the limit status (2.4) is N/A and the in-work indication (2.7)
  // reads In Work.
  frames.push(n2kFrame(0xFE43, 0xF0, [...n2kU16(osc(0, 1000, 13) / 0.125), ...n2kU16(540 / 0.125), 0x41, 0xFF, 0xFF, 0xFF]));
  frames.push(n2kFrame(0xFE45, 0xF0, [Math.round(osc(0, 100, 23) / 0.4) & 0xFF, 0x7F, Math.round((osc(0, 80, 29) + 100) / 0.8) & 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
  frames.push(n2kFrame(0xFEE8, 0xF0, [...n2kU16(osc(0, 360, 60) * 128), ...n2kU16(osc(0, 30, 17) * 256), ...n2kU16((osc(-10, 10, 31) + 200) * 128), ...n2kU16((120 + 2500) / 0.125)]));
  // ISOBUS is J1939 on the wire: the tractor is driven by the same driver-demand groups.
  const drive = window.j1939DriveFrames ? j1939DemoDriveCtrl() : null;
  if (drive) {
    frames.push(...window.j1939DriveFrames(drive));
    frames.push(n2kFrame(0xFEF1, 0x00, window.j1939CcvsPatch([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], drive)));
  }

  // Task Controller (SA 0x80): a "Value" (cmd 3) for application-rate DDI 271.
  const ddi = 271, element = 5, cmd = 3, val = Math.round(osc(0, 5000, 8));
  frames.push(n2kFrame(0xCB00, 0x80, [((element & 0x0F) << 4) | cmd, (element >> 4) & 0xFF, ddi & 0xFF, (ddi >> 8) & 0xFF, val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF]));

  // Address claims (ag NAMEs, every 30th tick): the Tractor ECU + a sprayer implement. Functions off
  // isobus.net's nameFunction table: 134 Tractor ECU (industry group 2, vehicle system 0) and 132
  // Sprayers Machine Control (device class 6) - the same function isobus.js's implement claims.
  if (tick % 30 === 0) {
    const name = (id, mfr, fn, devClass, indGrp) =>
      [...n2kU32((id | (mfr << 21)) >>> 0), ...n2kU32(((fn << 8) | (devClass << 17) | (indGrp << 28) | (1 << 31)) >>> 0)];
    frames.push(n2kFrame(0xEE00, 0xF0, name(0x12345, 100, 134, 0, 2))); // Tractor ECU
    frames.push(n2kFrame(0xEE00, 0x80, name(0x23456, 137, 132, 6, 2))); // Sprayer
  }

  // ETP transfer (every 80th tick): a >1785-byte object pool to the VT (0xE700, ECU to VT), at
  // the Virtual Terminal's preferred address 0x26 (isobus.net SourceAddress table).
  if (tick % 80 === 1) {
    const total = 1792, payload = new Array(total);
    for (let i = 0; i < total; i++) payload[i] = 0x20 + (i % 0x5F);
    frames.push(...isoEtpDemoFrames(0x80, 0x26, 0xE700, payload));
  }
  return frames;
}

window.j1939DemoFrames = j1939DemoFrames;

// ── Render loop ───────────────────────────────────────────────────────────────
(function loop() {
  // Force a refresh ~1×/s so relative "Last seen" timestamps keep ticking with no new traffic
  const now = Date.now();
  if (now - j1939LastTick >= 1000) { j1939Dirty = true; j1939LastTick = now; }
  // Drop stale Fast-Packet / ETP sessions so a lost middle frame can't wedge a slot.
  for (const [k, s] of n2kFastPacket) if (now - s.ts > 1000) n2kFastPacket.delete(k);
  for (const [k, s] of isoEtpSessions) if (now - s.ts > 2000) isoEtpSessions.delete(k);
  // TP/BAM sessions too: a lost middle DT (or a CM that announces a buffer but never sends
  // data) would otherwise pin up to 64 KB per (sa,da) slot forever. Idle timeout, not age.
  for (const [k, s] of j1939TpSessions) if (now - s.ts > 2000) j1939TpSessions.delete(k);
  j1939Render();
  requestAnimationFrame(loop);
})();

// Apply a proto mode stashed by applySettings() before this deferred module loaded.
if (window._j1939ProtoPending) j1939SetProto(window._j1939ProtoPending);
