// ── DroneCAN (UAVCAN v0) ──────────────────────────────────────────────────────
// Self-contained module: a real DroneCAN transfer encoder + a passive decoder that
// reassembles multi-frame transfers off the bus. Same bolt-on pattern as xcp.js /
// canopen.js.
//
// DroneCAN rides 29-bit EXTENDED ids. For a message (broadcast) transfer:
//   bits 24-28  priority (5)          bits 8-23  message type id (16)
//   bit  7      service-not-message (0 for messages)
//   bits 0-6    source node id (7, 1..127; 0 = anonymous, a different layout we skip)
// The last byte of every frame is the TAIL BYTE:
//   bit 7 start-of-transfer, bit 6 end-of-transfer, bit 5 toggle, bits 0-4 transfer id.
// A payload of 7 bytes or less is a single frame (SOT+EOT, toggle 0, no CRC). Anything
// longer is split across 7-byte chunks preceded by a 2-byte transfer CRC, and the toggle
// bit alternates starting at 0 (that is the v0/DroneCAN rule - UAVCAN v1 starts at 1).
//
// It carries all three DroneCAN transfer kinds. A MESSAGE is a node publishing something it
// decided was worth publishing; a SERVICE is a question addressed to one node and that node's
// answer addressed back; an ANONYMOUS message is what a node with no node id yet can say. The
// three have different 29-bit id layouts and different reassembly keys, and dcParseAnyId is the
// one place that decides which is which. GetNodeInfo, RestartNode and param.GetSet are served
// out of the node roster below, which is why none of that touched the contract: a service is a
// bus concept, not a game-state concept, and what these answer with was already on the wire.
//
// This module is also the "flavor packer" for the carlito contract's dronecan-flavored
// signals: the contract deliberately says a flavor borrows a protocol's signal
// names/semantics "without implementing its CAN frames - frame layout stays on the
// sloppyCAN side", and this file is that side for DroneCAN. It registers on
// window.carlitoFlavorPackers, which carlito.js reads for both packing and its
// checkCanCoverage assertion.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   sloppycan.js  ingestFrame(), after the canopen hook:
//     if (window.dronecanIngestFrame) dronecanIngestFrame(frame);
//   sloppycan.js  clearFrames(), at end:  if (window.dronecanClear) dronecanClear();
//   sloppycan.js  disconnectSerial():     if (window.dronecanStop) window.dronecanStop();
//   sloppycan.js  startup:  window.dronecanScheduleSave = scheduleSave;
//   sloppycan.js  switchViewTab(): dronecan tab toggle + wrap show/hide + dronecanOnShow()
//   sloppycan.js  demo base-traffic engine: dronecanDemoStart/Stop + demoInitialBaseTraffic
//   sloppycan.js  persistence: defaultWorkspaceData/collectSettings/applySettings 'dronecan' key
//   index.html    view-tabs button + #dronecanWrap content (the config bar, the bench-control bar,
//                 the gimbal bar, the SERVICE bar, #dc-panes, #dc-log) + <script src="dronecan.js" defer>
//                 (after carlito_contract.js, BEFORE carlito.js - the packer AND the uplink
//                  sources must be registered by the time carlito.js evaluates its checks)
//   carlito-bridge.html  same script tag. That page has no tab markup AND does not load
//                 sloppycan.js, so the shared helpers/factory are missing too - every DOM read
//                 is null-guarded and each helper alias has a fallback, so only the encoder
//                 half comes up there.
//
// Telemetry TX rides carlito.js's canForward gateway (which is what puts it on the wire
// and in the dump as an FW entry). No transport code here.

// ── Inject CSS ────────────────────────────────────────────────────────────────
(function () {
  const s = document.createElement('style');
  s.textContent = `
.dc-config {
  background:var(--bg2); border-bottom:1px solid var(--border);
  padding:7px 16px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;
  flex-shrink:0; font-family:var(--sans); font-size:11px; color:var(--text2);
}
.dc-config label { display:flex; align-items:center; gap:5px; }
.dc-config input[type=text] { width:52px; padding:0 6px; }
.dc-config .dc-note { color:var(--text3); margin-left:auto; }
/* The bench-control bar reuses .dc-config; only the colour swatch and the Off button are new. */
.dc-config select { padding:1px 4px; }
.dc-config input[type=color] { width:34px; height:19px; padding:0; border:1px solid var(--border); background:var(--bg); cursor:pointer; }
.dc-config button {
  background:var(--bg); border:1px solid var(--border); color:var(--text2);
  border-radius:4px; padding:1px 8px; cursor:pointer; font-family:var(--sans); font-size:11px;
}
.dc-config button:hover { background:var(--bg3); color:var(--text); }
.dc-logbar {
  background:var(--bg2); border-top:1px solid var(--border); border-bottom:1px solid var(--border);
  padding:6px 16px; display:flex; align-items:center; gap:14px; flex-shrink:0;
  font-family:var(--sans); font-size:12px; font-weight:600; color:var(--text);
}
.dc-logbar .dc-errs { margin-left:auto; font-weight:400; font-size:11px; color:var(--text3); }
.dc-logbar .dc-errs b { color:var(--amber); font-weight:600; }
.dc-panes { padding:10px 16px 12px; display:flex; flex-direction:column; gap:12px; }
.dc-grp-title {
  font-family:var(--sans); font-size:11px; font-weight:700; letter-spacing:.06em;
  text-transform:uppercase; color:var(--text3); margin-bottom:5px;
}
.dc-tbl { width:100%; border-collapse:collapse; font-family:var(--mono); font-size:11px; }
.dc-tbl th {
  background:var(--bg2); color:var(--text3); font-family:var(--sans); font-size:10px;
  font-weight:700; letter-spacing:.05em; text-transform:uppercase;
  text-align:left; padding:4px 8px; position:sticky; top:0; z-index:1;
}
.dc-tbl td { padding:3px 8px; border-top:1px solid var(--border); color:var(--text2); white-space:nowrap; }
.dc-tbl td.dc-id   { color:var(--blue); }
.dc-tbl td.dc-node { color:var(--text); font-weight:600; }
.dc-tbl td.dc-msg  { color:var(--green); }
.dc-tbl td.dc-raw  { color:var(--text3); }
.dc-tbl td.dc-dec  { color:var(--text); white-space:normal; }
.dc-tbl td.dc-ts   { color:var(--text3); }
.dc-tbl tr.dc-bad td { color:var(--amber); }
.dc-tbl a.dc-seecan { color:var(--blue); text-decoration:none; }
.dc-chip {
  display:inline-block; padding:1px 6px; border:1px solid var(--border); border-radius:2px;
  font-family:var(--sans); font-size:10px; font-weight:600; color:var(--text2);
}
.dc-chip.ok   { color:var(--green); border-color:var(--green-dim); }
.dc-chip.warn { color:var(--amber); border-color:var(--amber); }
.dc-chip.off  { color:var(--text3); }
.dc-empty { color:var(--text3); font-family:var(--sans); font-size:12px; padding:14px 16px; line-height:1.6; }
.dc-readout { font-family:var(--mono); font-size:11px; color:var(--text3); padding-top:4px; }
`;
  document.head.appendChild(s);
})();

// ── Shared formatters (defined in sloppycan.js; aliased, not re-implemented) ───
// carlito-bridge.html loads this module for the ENCODER alone: it has no tab markup and does
// not load sloppycan.js, so none of the shared helpers exist there. Each alias therefore keeps
// a fallback, and the tab handle below degrades to a no-op - the encoder half must come up
// cleanly rather than throwing partway through the file and leaving `dcTab` in its TDZ.
const dcRelTs    = window.canRelTs || (() => '');
const dcHexBytes = window.canHexBytes || (d => Array.from(d).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '));
const dcEscHtml  = window.escHtml || (s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
function dcNullTab() { return { markDirty() {}, pushLog() {}, clearLog() {}, render() {}, ready: () => false }; }

const DC_LOG_MAX = 500;
const dcH = (v, w) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w || 2, '0');

// ── Wire primitives ───────────────────────────────────────────────────────────
// DSDL serialization (DroneCAN / UAVCAN v0): byte order is LITTLE-ENDIAN, bit order is
// MSB-FIRST - the spec's words are "bits are filled from the most significant to the
// least significant, i.e. the most significant bit has index 0". Concretely, and matching
// libcanard's canardEncodeScalar: a field's value is laid out as ceil(bits/8) little-endian
// bytes, the final partial byte is left-shifted so its used bits become the MSBs, and those
// `bits` bits are then copied MSB-first into the stream. A byte-aligned u32 therefore comes
// out as plain little-endian, while a uint2 at bit offset 32 lands in the TOP two bits of
// byte 4. That second case is the one everybody gets backwards, so dronecanSelfTest() pins
// it with a NodeStatus vector.
function dcBitWriter(totalBits) {
  const out = new Array(Math.ceil(totalBits / 8)).fill(0);
  let off = 0;
  return {
    put(value, bits) {
      let v = Math.trunc(Number(value));
      if (!Number.isFinite(v)) v = 0;
      // Wrapping and two's complement are done BYTE BY BYTE rather than with `((v % 2**bits) +
      // 2**bits) % 2**bits`, and that is not a style preference. Past 53 bits the arithmetic in
      // that expression is not exact: `20 + 2**64` rounds to `2**64`, so an in-range 20 came
      // back out as a ZERO, and `-1 + 2**64` rounds the same way. Every param.GetSet value,
      // default and range is an int64, so the whole parameter server read as zeroes - an
      // encoder that looked entirely unwired while being a rounding error. Below: the magnitude
      // is laid out as little-endian bytes and a negative is negated across them (invert, add
      // one), which is exact at every width. Anything above `bits` simply is not written, which
      // is the same wrap the modulo used to do.
      const nb = Math.ceil(bits / 8);
      const neg = v < 0;
      let a = neg ? -v : v;
      const src = new Array(nb);
      for (let i = 0; i < nb; i++) { src[i] = a % 256; a = Math.floor(a / 256); }
      if (neg) {
        let c = 1;
        for (let i = 0; i < nb; i++) { const t = ((~src[i]) & 0xFF) + c; src[i] = t & 0xFF; c = t >> 8; }
      }
      const rem = bits % 8;
      if (rem) src[nb - 1] = (src[nb - 1] << (8 - rem)) & 0xFF;   // left-align the partial byte
      for (let i = 0; i < bits; i++) {
        if ((src[i >> 3] >> (7 - (i & 7))) & 1) out[(off + i) >> 3] |= 1 << (7 - ((off + i) & 7));
      }
      off += bits;
    },
    bytes() { return out; },
  };
}

function dcBitReader(bytes) {
  let off = 0;
  return {
    get(bits, signed) {
      const nb = Math.ceil(bits / 8);
      const src = new Array(nb).fill(0);
      for (let i = 0; i < bits; i++) {
        const p = off + i;
        if (((bytes[p >> 3] || 0) >> (7 - (p & 7))) & 1) src[i >> 3] |= 1 << (7 - (i & 7));
      }
      const rem = bits % 8;
      if (rem) src[nb - 1] = (src[nb - 1] & 0xFF) >> (8 - rem);   // undo the left-align
      off += bits;
      // The sign is undone BYTE BY BYTE, the mirror of dcBitWriter's - and for the same reason.
      // `v -= Math.pow(2, bits)` is not exact past 53 bits: an all-ones int64 accumulates to a
      // value that rounds to 2**64, so subtracting 2**64 gives 0 and -1 decodes as zero. Here a
      // negative is detected from the sign bit and negated across the bytes (invert, add one),
      // which is exact at every width this module uses.
      let negative = false;
      if (signed && ((src[nb - 1] >> ((bits - 1) % 8)) & 1)) {
        negative = true;
        let c = 1;
        for (let i = 0; i < nb; i++) { const t = ((~src[i]) & 0xFF) + c; src[i] = t & 0xFF; c = t >> 8; }
        if (rem) src[nb - 1] &= (1 << rem) - 1;
      }
      let v = 0;
      for (let i = nb - 1; i >= 0; i--) v = v * 256 + (src[i] & 0xFF);
      return negative ? -v : v;
    },
  };
}

// IEEE-754 binary16. A non-finite input encodes as NaN (0x7E00), which is DSDL's own
// convention for "this field is not known" - we use it rather than inventing a zero.
const _dcF32 = new Float32Array(1), _dcU32 = new Uint32Array(_dcF32.buffer);
function dcFloat16(f) {
  const x = Number(f);
  if (!Number.isFinite(x)) return 0x7E00;
  _dcF32[0] = x;
  const u = _dcU32[0];
  const sign = (u >>> 16) & 0x8000;
  let exp = ((u >>> 23) & 0xFF) - 112;          // 127 (f32 bias) - 15 (f16 bias)
  let man = u & 0x7FFFFF;
  if (exp >= 0x1F) return sign | 0x7C00;         // overflow -> +/-Inf
  if (exp <= 0) {                                // subnormal or underflow
    if (exp < -10) return sign;                  // -> +/-0
    man = (man | 0x800000) >>> (1 - exp);
    return sign | ((man + 0x1000) >>> 13);
  }
  man += 0x1000;                                 // round to nearest
  if (man & 0x800000) { man = 0; exp++; if (exp >= 0x1F) return sign | 0x7C00; }
  return sign | (exp << 10) | (man >>> 13);
}
// A float32 carried as its 32-bit IEEE-754 PATTERN in a plain 32-bit field - what `f32bits`
// means, and what lets an integer bit-writer hold a float. dcF32ToBits is the ENCODE side and
// dcF32FromBits the decode side, and a field marked f32bits must go through the first on the way
// in: handing the encoder 101325 directly writes the INTEGER 101325, which is 1.4e-40 as a float
// and looks entirely plausible in a hex dump.
function dcF32ToBits(f) { _dcF32[0] = Number(f); return _dcU32[0] >>> 0; }
function dcF32FromBits(u) { _dcU32[0] = u >>> 0; return _dcF32[0]; }

function dcFloat16Decode(h) {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >> 10) & 0x1F, man = h & 0x3FF;
  if (exp === 0) return sign * man * Math.pow(2, -24);
  if (exp === 0x1F) return man ? NaN : sign * Infinity;
  return sign * (man + 1024) * Math.pow(2, exp - 25);
}

// Multi-frame transfer CRC: CRC-16-CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection,
// no final xor), seeded with the 8 little-endian bytes of the data type signature and then
// fed the serialized payload.
function dcCrc16(bytes, sigBytes) {
  let crc = 0xFFFF;
  const feed = (b) => {
    crc ^= (b & 0xFF) << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  };
  for (const b of sigBytes) feed(b);
  for (const b of bytes) feed(b);
  return crc & 0xFFFF;
}
// 'A9AF28AEA2FBB254' -> [0x54,0xB2,0xFB,0xA2,0xAE,0x28,0xAF,0xA9] (little-endian)
function dcSigBytes(hex) {
  const h = hex.replace(/^0x/i, '').padStart(16, '0');
  const out = [];
  for (let i = 7; i >= 0; i--) out.push(parseInt(h.substr(i * 2, 2), 16));
  return out;
}

function dcMsgId(priority, dataTypeId, srcNode) {
  // service-not-message is bit 7 and stays 0 for broadcasts; srcNode is 7 bits so it can't
  // collide with it.
  return ((((priority & 0x1F) << 24) >>> 0) | ((dataTypeId & 0xFFFF) << 8) | (srcNode & 0x7F)) >>> 0;
}
function dcParseMsgId(id) {
  return {
    priority:   (id >>> 24) & 0x1F,
    dataTypeId: (id >>> 8) & 0xFFFF,
    service:    (id >>> 7) & 1,
    srcNode:    id & 0x7F,
  };
}

// ── The other two id layouts ──────────────────────────────────────────────────
// A broadcast is only one of three things a 29-bit DroneCAN id can be, and the bit that says
// which is bit 7, "service not message". The message layout above spends 16 bits on the message
// type id because there is no destination to carry; a SERVICE has one, so its id is cut
// differently - 8 bits of service type id, a direction bit, and BOTH node ids:
//   bits 24-28 priority (5)      bits 16-23 service type id (8)
//   bit  15    request-not-response (1 = request)
//   bits 8-14  destination node id (7)
//   bit  7     service-not-message (1)
//   bits 0-6   source node id (7)
// So a service transfer is addressed, and both ends are on the wire - which is what lets a
// listener that saw neither end of the exchange still say who asked whom.
function dcSvcId(priority, svcTypeId, isRequest, destNode, srcNode) {
  return ((((priority & 0x1F) << 24) >>> 0) | ((svcTypeId & 0xFF) << 16) |
          ((isRequest ? 1 : 0) << 15) | ((destNode & 0x7F) << 8) | (1 << 7) | (srcNode & 0x7F)) >>> 0;
}
function dcParseSvcId(id) {
  return {
    priority:   (id >>> 24) & 0x1F,
    svcTypeId:  (id >>> 16) & 0xFF,
    isRequest:  ((id >>> 15) & 1) === 1,
    destNode:   (id >>> 8) & 0x7F,
    srcNode:    id & 0x7F,
  };
}
// And an ANONYMOUS message, which is what a node with no node id yet has to send - the chicken
// and egg dynamic allocation exists to break. Source node id is 0, and the 16-bit message type
// id will not fit beside a zero, so v0 keeps only its LOW TWO BITS and spends the freed 14 on a
// DISCRIMINATOR:
//   bits 24-28 priority (5)   bits 10-23 discriminator (14)
//   bits 8-9   low 2 bits of the message type id     bit 7 service-not-message (0)
//   bits 0-6   source node id (0)
// Two bits of type id is not identification, it is a filter - which is why anonymous transfers
// are only usable for a protocol both ends already agree on. The discriminator is there purely
// so two anonymous nodes shouting at once do not produce IDENTICAL ids and destroy each other's
// frames through CAN arbitration; the spec's own recommended fill is "the transfer CRC function
// applied to the message contents, any 14 bits of the result", which is what this uses.
function dcAnonId(priority, msgTypeId, discriminator) {
  return ((((priority & 0x1F) << 24) >>> 0) | ((discriminator & 0x3FFF) << 10) |
          ((msgTypeId & 3) << 8)) >>> 0;
}
function dcParseAnonId(id) {
  return {
    priority:      (id >>> 24) & 0x1F,
    discriminator: (id >>> 10) & 0x3FFF,
    msgTypeIdLow:  (id >>> 8) & 3,
  };
}

// Transfer ids are 5-bit rolling counters, one per (data type, source node).
const dcTidCounters = new Map();
function dcNextTid(key) {
  const v = (dcTidCounters.get(key) || 0) & 0x1F;
  dcTidCounters.set(key, (v + 1) & 0x1F);
  return v;
}

// Split a serialized payload into DroneCAN frames. Returns [{ id, isExt, data }].
function dcTransfer(m, srcNode, payload, forceTid) {
  const id = dcMsgId(m.priority, m.id, srcNode);
  const tid = (forceTid == null) ? dcNextTid(m.id + ':' + srcNode) : (forceTid & 0x1F);
  return dcFrameSplit(id, m.sig, payload, tid);
}

// Split a payload into frames for an already-built id. dcTransfer is this plus the message id;
// the service and anonymous framers below are the same thing with their own. The framing itself
// - tail byte, toggle, the 2-byte transfer CRC ahead of a multi-frame payload - is identical for
// all three, which is the point of pulling it out rather than writing it three times.
function dcFrameSplit(id, sig, payload, tid) {
  if (payload.length <= 7) {
    return [{ id, isExt: true, data: payload.concat([0x80 | 0x40 | (tid & 0x1F)]) }];
  }
  const crc = dcCrc16(payload, sig);
  const body = [crc & 0xFF, (crc >> 8) & 0xFF].concat(payload);
  const frames = [];
  let toggle = 0;
  for (let i = 0; i < body.length; i += 7) {
    const chunk = body.slice(i, i + 7);
    const sot = i === 0 ? 1 : 0;
    const eot = (i + 7 >= body.length) ? 1 : 0;
    frames.push({ id, isExt: true, data: chunk.concat([(sot << 7) | (eot << 6) | (toggle << 5) | (tid & 0x1F)]) });
    toggle ^= 1;
  }
  return frames;
}

// A service transfer. THE TRANSFER ID IS NOT ALLOCATED FOR A RESPONSE - it is copied from the
// request, which is the only thing that pairs the two halves of an exchange on a bus where four
// other nodes may be mid-transfer. A responder that rolls its own counter answers a question
// nobody asked. The priority is copied for the same reason: the spec says a response should
// carry the request's, so an urgent question gets an urgent answer.
function dcSvcTransfer(svc, isRequest, srcNode, destNode, payload, tid, priority) {
  const prio = priority == null ? svc.priority : priority;
  const t = (tid == null) ? dcNextTid('svc' + svc.id + ':' + srcNode + ':' + destNode) : (tid & 0x1F);
  return dcFrameSplit(dcSvcId(prio, svc.id, isRequest, destNode, srcNode), svc.sig, payload, t);
}

// An anonymous message. ALWAYS ONE FRAME: there is no source node id, so there is nothing to key
// a reassembly buffer on, and two anonymous nodes interleaving multi-frame transfers would
// produce a perfectly valid-looking splice of both. The DSDL says as much where it caps the
// unique-id chunk at six bytes - "this limitation is needed to ensure that all request transfers
// are single-frame" - and this refuses rather than silently truncating.
function dcAnonTransfer(m, payload, tid) {
  if (payload.length > 7) throw new Error('anonymous transfers are single-frame only');
  const disc = dcCrc16(payload, m.sig) & 0x3FFF;
  const t = (tid == null) ? dcNextTid('anon' + m.id) : (tid & 0x1F);
  return [{ id: dcAnonId(m.priority, m.id, disc), isExt: true,
            data: payload.concat([0x80 | 0x40 | (t & 0x1F)]) }];
}

// ── Message table ─────────────────────────────────────────────────────────────
// Data, not call sites: a message is a row here plus a populate block in dcBuildFrames, and
// nothing in the encoder, the framer or the decoder knows any of their names. Everything
// below is a FLAT LIST OF FIXED-WIDTH FIELDS, which is how the richer DSDL constructs are
// expressed without teaching dcEncode/dcDecode about them:
//   - a nested struct is inlined  (uavcan.Timestamp -> one uint56; CoarseOrientation ->
//     int5 x3 + bool),
//   - a FIXED-size array is inlined element by element (float16[4] orientation_xyzw ->
//     four f16 fields) - identical bits, since a fixed array has no length prefix,
//   - a VARIABLE-length array we send EMPTY becomes just its length prefix, a plain
//     integer field of ceil(log2(max+1)) bits set to 0 (covariance_len below),
//   - unless it is the LAST field with elements of >= 8 bits, where the DSDL v0 TAIL ARRAY
//     OPTIMIZATION drops the prefix as well - an empty one is then literally zero bits, so
//     it has no field at all (BatteryInfo.model_name, Fix2.ecef_position_velocity,
//     Solution.linear_acceleration_covariance),
//   - `void` padding is a hidden zero field of the same width,
//   - a float32 (Fix2.ned_velocity and the two air_data pressures) is carried as its 32-bit
//     IEEE-754 PATTERN in a plain 32-bit field; `f32bits` tells the summary formatter to read it
//     back as a float, and dcF32ToBits is what a caller must put in.
// `bits` is the exact serialized length of that field list and dcEncode allocates from it,
// so it must be kept in step by hand.
//
// THE SIGNATURES ARE LOAD-BEARING, not decoration: the 64-bit data type signature seeds the
// multi-frame transfer CRC, so a wrong one produces frames this module's own decoder happily
// accepts and every real DroneCAN tool rejects. All nine were taken from the DSDL itself
// (dronecan/DSDL, via pydronecan's get_data_type_signature) rather than copied out of a plan
// document, and NodeStatus/esc.Status matching the constants that were already here is what
// says that source is the right one. The single-frame ones (ArmingStatus and the two indication
// COMMANDS) never reach dcCrc16 at all, so a wrong constant there would be invisible at runtime -
// which is exactly why they were checked against the DSDL rather than tested into.
const DC_HEALTH = { 0: 'OK', 1: 'WARNING', 2: 'ERROR', 3: 'CRITICAL' };
const DC_MODE   = { 0: 'OPERATIONAL', 1: 'INITIALIZATION', 2: 'MAINTENANCE', 3: 'SOFTWARE_UPDATE', 7: 'OFFLINE' };

const DC_TIME_STD    = { 0: 'NONE', 1: 'TAI', 2: 'UTC', 3: 'GPS' };
const DC_FIX_STATUS  = { 0: 'NO_FIX', 1: 'TIME_ONLY', 2: '2D_FIX', 3: '3D_FIX' };
const DC_GNSS_MODE   = { 0: 'SINGLE', 1: 'DGPS', 2: 'RTK', 3: 'PPP' };
const DC_SENSOR_TYPE = { 0: 'UNDEFINED', 1: 'SONAR', 2: 'LIDAR', 3: 'RADAR' };
const DC_READING     = { 0: 'UNDEFINED', 1: 'VALID_RANGE', 2: 'TOO_CLOSE', 3: 'TOO_FAR' };
const DC_ARMING      = { 0: 'DISARMED', 255: 'FULLY_ARMED' };
const DC_GIMBAL_MODE = { 0: 'ANGULAR_VELOCITY', 1: 'ORIENTATION_FIXED_FRAME',
                         2: 'ORIENTATION_BODY_FRAME', 3: 'GEO_POI' };
const DC_ACTUATOR_TYPE = { 0: 'UNITLESS', 1: 'POSITION', 2: 'FORCE', 3: 'SPEED', 4: 'PWM' };
// The hardpoint's binary command, which is also its status (the DSDL says the two fields mean
// the same thing). Not a `map` on the field - it is a uint16 whose 1+ values all mean hold.
const DC_HOOK_RELEASE = 0, DC_HOOK_HOLD = 1;
// Gimbal / hardpoint / air-data instance ids. One of each on this airframe, so they are 0 - but
// named, because a literal 0 in an encode call is indistinguishable from a placeholder.
const DC_GIMBAL_ID = 0, DC_HARDPOINT_ID = 0;

// BatteryInfo.status_flags bits we can honestly assert. The charger ones are deliberately
// absent: there is no charger in the game - the only recharge is a respawn, which hands you
// a whole fresh aircraft - so CHARGING/CHARGED could never be set truthfully.
const DC_BATT_IN_USE   = 1;
const DC_BATT_TEMP_HOT = 8;
// DSDL's own "cannot be estimated" constant for state_of_health_pct. Using it beats inventing
// a health percentage for a pack with no ageing model behind it.
const DC_SOH_UNKNOWN = 127;
// IEEE-754 binary32 quiet NaN, the DSDL convention for "this field is not known" - the f32
// counterpart of dcFloat16's 0x7E00.
const DC_F32_NAN = 0x7FC00000;

const DC_MSGS = {
  // ── uavcan.protocol.dynamic_node_id.Allocation ──────────────────────────────
  // Message type id 1, and the only message here that is normally sent ANONYMOUSLY - which is
  // the whole reason it exists. Every other id in this table belongs to a node that already has
  // an id; this is what a node with none says. Priority 24 is libcanard's
  // CANARD_TRANSFER_PRIORITY_LOW, which its own allocatee examples use: joining the bus is
  // background work and must not delay anything already flying.
  //
  // `unique_id` is uint8[<=16] AND LAST, so the tail array optimization drops its length prefix
  // and the array is literally the bytes that are left - which is what makes a first-stage
  // request (6 bytes of unique id) and a final grant (all 16) the same message with the same
  // fields and different lengths. The DSDL says so in as many words: "note that array is
  // tail-optimized".
  1: {
    id: 1, name: 'uavcan.protocol.dynamic_node_id.Allocation', short: 'Allocation',
    sigHex: '0B2A812620A11D40', priority: 24, bits: 8,
    fields: [
      { name: 'node_id', bits: 7 },
      { name: 'first_part_of_unique_id', bits: 1 },
      { name: 'unique_id', tail: true },
    ],
  },
  341: {
    id: 341, name: 'uavcan.protocol.NodeStatus', short: 'NodeStatus',
    sigHex: '0F0868D0C1A7C6F1', priority: 24, bits: 56,
    fields: [
      { name: 'uptime_sec', bits: 32, unit: 's' },
      { name: 'health',     bits: 2, map: DC_HEALTH },
      { name: 'mode',       bits: 3, map: DC_MODE },
      { name: 'sub_mode',   bits: 3 },
      { name: 'vendor_specific_status_code', bits: 16, hex: true },
    ],
  },
  1034: {
    id: 1034, name: 'uavcan.equipment.esc.Status', short: 'esc.Status',
    sigHex: 'A9AF28AEA2FBB254', priority: 20, bits: 110,
    fields: [
      { name: 'error_count',      bits: 32 },
      { name: 'voltage',          f16: true, unit: 'V', dp: 2 },
      { name: 'current',          f16: true, unit: 'A', dp: 1 },
      { name: 'temperature',      f16: true, unit: 'K', dp: 1 },
      { name: 'rpm',              bits: 18, signed: true },
      { name: 'power_rating_pct', bits: 7, unit: '%' },
      { name: 'esc_index',        bits: 5 },
    ],
  },
  1092: {
    id: 1092, name: 'uavcan.equipment.power.BatteryInfo', short: 'BatteryInfo',
    sigHex: '249C26548A711966', priority: 20, bits: 184,
    fields: [
      { name: 'temperature',               f16: true, unit: 'K',  dp: 1 },
      { name: 'voltage',                   f16: true, unit: 'V',  dp: 2 },
      { name: 'current',                   f16: true, unit: 'A',  dp: 1 },
      { name: 'average_power_10sec',       f16: true, unit: 'W',  dp: 0 },
      { name: 'remaining_capacity_wh',     f16: true, unit: 'Wh', dp: 1 },
      { name: 'full_charge_capacity_wh',   f16: true, unit: 'Wh', dp: 1 },
      { name: 'hours_to_full_charge',      f16: true, unit: 'h',  dp: 2 },
      { name: 'status_flags',              bits: 11, hex: true },
      { name: 'state_of_health_pct',       bits: 7, unit: '%' },
      { name: 'state_of_charge_pct',       bits: 7, unit: '%' },
      { name: 'state_of_charge_pct_stdev', bits: 7, unit: '%' },
      { name: 'battery_id',                bits: 8 },
      { name: 'model_instance_id',         bits: 32 },
      // model_name is uint8[<32] AND LAST: tail array optimization, sent empty -> zero bits.
    ],
  },
  1063: {
    id: 1063, name: 'uavcan.equipment.gnss.Fix2', short: 'Fix2',
    sigHex: 'CA41E7000F37435F', priority: 20, bits: 400,
    fields: [
      { name: 'timestamp_usec',      bits: 56 },      // uavcan.Timestamp, inlined
      { name: 'gnss_timestamp_usec', bits: 56 },
      { name: 'gnss_time_standard',  bits: 3, map: DC_TIME_STD },
      { name: 'void13',              bits: 13, hide: true },
      { name: 'num_leap_seconds',    bits: 8 },
      // longitude comes FIRST in the DSDL, before latitude. Getting that pair the wrong way
      // round is the sort of error that still looks like a plausible position.
      { name: 'longitude_deg_1e8',   bits: 37, signed: true },
      { name: 'latitude_deg_1e8',    bits: 37, signed: true },
      { name: 'height_ellipsoid_mm', bits: 27, signed: true, unit: 'mm' },
      { name: 'height_msl_mm',       bits: 27, signed: true, unit: 'mm' },
      { name: 'ned_velocity_n',      bits: 32, f32bits: true, unit: 'm/s' },
      { name: 'ned_velocity_e',      bits: 32, f32bits: true, unit: 'm/s' },
      { name: 'ned_velocity_d',      bits: 32, f32bits: true, unit: 'm/s' },
      { name: 'sats_used',           bits: 6 },
      { name: 'status',              bits: 2, map: DC_FIX_STATUS },
      { name: 'mode',                bits: 4, map: DC_GNSS_MODE },
      { name: 'sub_mode',            bits: 6 },
      { name: 'covariance_len',      bits: 6 },       // float16[<=36], sent empty
      { name: 'pdop',                f16: true, unit: 'DOP', dp: 2 },
      // ecef_position_velocity is ECEFPositionVelocity[<=1] AND LAST: tail array
      // optimization again, sent empty -> zero bits.
    ],
  },
  1050: {
    id: 1050, name: 'uavcan.equipment.range_sensor.Measurement', short: 'range.Measurement',
    sigHex: '68FFFE70FC771952', priority: 20, bits: 120,
    fields: [
      { name: 'timestamp_usec',      bits: 56 },
      { name: 'sensor_id',           bits: 8 },
      // uavcan.CoarseOrientation, inlined: int5[3] fixed_axis_roll_pitch_yaw + a bool.
      { name: 'beam_roll',           bits: 5, signed: true },
      { name: 'beam_pitch',          bits: 5, signed: true },
      { name: 'beam_yaw',            bits: 5, signed: true },
      { name: 'orientation_defined', bits: 1 },
      { name: 'field_of_view',       f16: true, unit: 'rad', dp: 3 },
      { name: 'sensor_type',         bits: 5, map: DC_SENSOR_TYPE },
      { name: 'reading_type',        bits: 3, map: DC_READING },
      { name: 'range',               f16: true, unit: 'm', dp: 2 },
    ],
  },
  1000: {
    id: 1000, name: 'uavcan.equipment.ahrs.Solution', short: 'ahrs.Solution',
    sigHex: '72A63A3C6F41FA9B', priority: 20, bits: 232,
    fields: [
      { name: 'timestamp_usec',                  bits: 56 },
      // float16[4] orientation_xyzw, a FIXED array: four fields, no length prefix.
      { name: 'orientation_x',                   f16: true, dp: 4 },
      { name: 'orientation_y',                   f16: true, dp: 4 },
      { name: 'orientation_z',                   f16: true, dp: 4 },
      { name: 'orientation_w',                   f16: true, dp: 4 },
      { name: 'void4_a',                         bits: 4, hide: true },
      { name: 'orientation_covariance_len',      bits: 4 },   // float16[<=9], sent empty
      { name: 'angular_velocity_x',              f16: true, unit: 'rad/s', dp: 3 },
      { name: 'angular_velocity_y',              f16: true, unit: 'rad/s', dp: 3 },
      { name: 'angular_velocity_z',              f16: true, unit: 'rad/s', dp: 3 },
      { name: 'void4_b',                         bits: 4, hide: true },
      { name: 'angular_velocity_covariance_len', bits: 4 },
      { name: 'linear_acceleration_x',           f16: true, unit: 'm/s^2', dp: 2 },
      { name: 'linear_acceleration_y',           f16: true, unit: 'm/s^2', dp: 2 },
      { name: 'linear_acceleration_z',           f16: true, unit: 'm/s^2', dp: 2 },
      // linear_acceleration_covariance is float16[<=9] AND LAST: tail array optimization.
    ],
  },
  1100: {
    id: 1100, name: 'uavcan.equipment.safety.ArmingStatus', short: 'ArmingStatus',
    // A one-byte payload is a single frame, and a single-frame transfer carries no transfer
    // CRC - so this signature is never actually fed to dcCrc16. It is still taken off the
    // DSDL rather than left at a plausible-looking constant: a wrong value here would be
    // invisible today and wrong the moment anything else uses the table.
    // Priority 16 rather than the 20 the telemetry messages use: arming is a safety
    // statement, and DroneCAN leaves per-message priority to the implementer.
    sigHex: '8700F375556A8003', priority: 16, bits: 8,
    fields: [
      { name: 'status', bits: 8, map: DC_ARMING },
    ],
  },
  1071: {
    id: 1071, name: 'uavcan.equipment.hardpoint.Status', short: 'hardpoint.Status',
    sigHex: '624A519D42553D82', priority: 20, bits: 56,
    fields: [
      { name: 'hardpoint_id',            bits: 8 },
      // NEWTON, not kilogram - the DSDL says so, and the contract's `payload_weight` carries the
      // same unit for the same reason: a latch measures a force on itself.
      { name: 'payload_weight',          f16: true, unit: 'N', dp: 2 },
      { name: 'payload_weight_variance', f16: true, dp: 3 },
      // "Meaning is the same as for the command field in the Command message", i.e. the binary
      // case: 0 = released, 1 = holding.
      { name: 'status',                  bits: 16 },
    ],
  },
  1044: {
    id: 1044, name: 'uavcan.equipment.camera_gimbal.Status', short: 'gimbal.Status',
    // camera_orientation_in_body_frame_covariance is float16[<=9] AND LAST: tail array
    // optimization, sent empty -> zero bits. `mode` is uavcan.equipment.camera_gimbal.Mode,
    // a nested struct of ONE uint8, inlined here as that byte.
    sigHex: 'B9F127865BE0D61E', priority: 20, bits: 80,
    fields: [
      { name: 'gimbal_id',   bits: 8 },
      { name: 'mode',        bits: 8, map: DC_GIMBAL_MODE },
      // float16[4], a FIXED array: four fields, no length prefix (the ahrs.Solution rule).
      { name: 'orientation_x', f16: true, dp: 4 },
      { name: 'orientation_y', f16: true, dp: 4 },
      { name: 'orientation_z', f16: true, dp: 4 },
      { name: 'orientation_w', f16: true, dp: 4 },
    ],
  },
  1028: {
    id: 1028, name: 'uavcan.equipment.air_data.StaticPressure', short: 'StaticPressure',
    sigHex: 'CDC7C43412BDC89A', priority: 20, bits: 48,
    fields: [
      // A REAL float32, not an f16: the same `f32bits` path Fix2.ned_velocity uses. It has to be
      // - 101325 Pa is past float16's integer resolution, and a barometer rounded to the nearest
      // 64 Pa would quantise the altitude this whole signal group exists to disagree about.
      { name: 'static_pressure',          bits: 32, f32bits: true, unit: 'Pa' },
      { name: 'static_pressure_variance', f16: true, unit: 'Pa^2', dp: 1 },
    ],
  },
  1027: {
    id: 1027, name: 'uavcan.equipment.air_data.RawAirData', short: 'RawAirData',
    // covariance is float16[<=16] AND LAST: tail array optimization, sent empty.
    sigHex: 'C77DF38BA122F5DA', priority: 20, bits: 136,
    fields: [
      { name: 'flags',                                 bits: 8, hex: true },
      { name: 'static_pressure',                       bits: 32, f32bits: true, unit: 'Pa' },
      { name: 'differential_pressure',                 bits: 32, f32bits: true, unit: 'Pa' },
      { name: 'static_pressure_sensor_temperature',    f16: true, unit: 'K', dp: 1 },
      { name: 'differential_pressure_sensor_temperature', f16: true, unit: 'K', dp: 1 },
      { name: 'static_air_temperature',                f16: true, unit: 'K', dp: 1 },
      { name: 'pitot_temperature',                     f16: true, unit: 'K', dp: 1 },
    ],
  },
  // ── The COMMANDS ────────────────────────────────────────────────────────────
  // Every other message in this table is a peripheral reporting ITSELF. These two flow the other
  // way - from the flight controller TOWARD the peripherals - which is why dcBuildFrames emits
  // them from dcCfg.fcNode rather than from a roster id, and why they are sent ON CHANGE rather
  // than on the periodic tick (a command spammed at 10 Hz is not what a real bus looks like).
  1081: {
    id: 1081, name: 'uavcan.equipment.indication.LightsCommand', short: 'LightsCommand',
    // SingleLightCommand[<=20] commands: the array is LAST with >= 8-bit elements, so the DSDL v0
    // tail array optimization drops the length prefix - ONE command is literally light_id plus the
    // 16 colour bits and nothing else. uavcan.RGB565 is inlined as its three fields rather than
    // packed into one uint16 by hand: MSB-first 5/6/5 IS the wire layout, and letting dcBitWriter
    // lay it out is what keeps that true.
    sigHex: '2031D93C8BDD1EC4', priority: 20, bits: 24,
    fields: [
      { name: 'light_id', bits: 8 },
      { name: 'red',      bits: 5 },
      { name: 'green',    bits: 6 },
      { name: 'blue',     bits: 5 },
    ],
  },
  1080: {
    id: 1080, name: 'uavcan.equipment.indication.BeepCommand', short: 'BeepCommand',
    sigHex: 'BE9EA9FEC2B15D52', priority: 20, bits: 32,
    fields: [
      { name: 'frequency', f16: true, unit: 'Hz', dp: 0 },
      { name: 'duration',  f16: true, unit: 's',  dp: 2 },
    ],
  },
  1070: {
    id: 1070, name: 'uavcan.equipment.hardpoint.Command', short: 'hardpoint.Command',
    // The DSDL calls `command` "either a binary command (0 - release, 1+ - hold) or bitmask";
    // the contract's `hardpoint_cmd` is one bit, so this is the binary case and 0/1 is the whole
    // range used. Priority 16 like ArmingStatus rather than the telemetry 20: dropping a load is
    // a safety statement, and the release must not queue behind a battery report.
    sigHex: 'A1A036268B0C3455', priority: 16, bits: 24,
    fields: [
      { name: 'hardpoint_id', bits: 8 },
      { name: 'command',      bits: 16 },
    ],
  },
  1040: {
    id: 1040, name: 'uavcan.equipment.camera_gimbal.AngularCommand', short: 'gimbal.AngularCommand',
    // NOT 1042. The DSDL numbers AngularCommand 1040 and GEOPOICommand 1041; 1042 is not a
    // camera_gimbal type at all, and taking the id off the file name rather than off a plan
    // document is the only reason this is right.
    sigHex: '4AF6E57B2B2BE29C', priority: 20, bits: 80,
    fields: [
      { name: 'gimbal_id',    bits: 8 },
      { name: 'mode',         bits: 8, map: DC_GIMBAL_MODE },
      { name: 'quaternion_x', f16: true, dp: 4 },
      { name: 'quaternion_y', f16: true, dp: 4 },
      { name: 'quaternion_z', f16: true, dp: 4 },
      { name: 'quaternion_w', f16: true, dp: 4 },
    ],
  },
  1010: {
    id: 1010, name: 'uavcan.equipment.actuator.ArrayCommand', short: 'actuator.ArrayCommand',
    // Command[<=15] commands, LAST and with 32-bit elements, so the DSDL v0 tail array
    // optimization drops the length prefix and N commands are literally N repeats of the same
    // three fields. THIS TABLE IS FIXED AT TWO, which is what this airframe has to command: the
    // gimbal's pitch and yaw axes. A third actuator means a third triple here and bits 96 -
    // there is no variable-length encoder in this module and inventing one for a message with
    // exactly one caller would be the wrong trade.
    sigHex: 'D8A7486238EC3AF3', priority: 20, bits: 64,
    fields: [
      { name: 'actuator_id_0',    bits: 8 },
      { name: 'command_type_0',   bits: 8, map: DC_ACTUATOR_TYPE },
      { name: 'command_value_0',  f16: true, unit: 'rad', dp: 3 },
      { name: 'actuator_id_1',    bits: 8 },
      { name: 'command_type_1',   bits: 8, map: DC_ACTUATOR_TYPE },
      { name: 'command_value_1',  f16: true, unit: 'rad', dp: 3 },
    ],
  },
};
for (const k of Object.keys(DC_MSGS)) DC_MSGS[k].sig = dcSigBytes(DC_MSGS[k].sigHex);

// ── Service table ─────────────────────────────────────────────────────────────
// A SERVICE IS A BUS CONCEPT, NOT A GAME-STATE CONCEPT, and that is why nothing below touched
// the contract. Every message above exists because a signal in the contract needs a frame; a
// service exists because a bus needs to be able to ASK. What it asks about is the roster this
// module already keeps and the status those nodes already publish - GetNodeInfo is a question
// whose answer was already on the wire, one field at a time, forever.
//
// Same rules as DC_MSGS: ids come off the DSDL FILE NAMES (1.GetNodeInfo, 5.RestartNode,
// 11.GetSet) and signatures are the 64-bit data type signature, computed from the normalized
// definition exactly as pydronecan's get_data_type_signature does - CRC-64-WE over the
// normalized text, then extended with each nested type's own signature. The method was
// validated by re-deriving all SIXTEEN signatures already in DC_MSGS and getting them back
// identical before a single new one was trusted, which is the same check that let the v30
// messages in. Two of the three below are also the values libcanard publishes as
// UAVCAN_PROTOCOL_GETNODEINFO_SIGNATURE and UAVCAN_PROTOCOL_PARAM_GETSET_SIGNATURE.
//
// A service type has TWO structures, and they are separate data types as far as serialization
// is concerned - hence `req` and `resp`, each with its own field list and its own `bits`. The
// SIGNATURE is shared: it is computed over both halves together, so a request and a response
// that disagree about the layout cannot pass each other's CRC.
const DC_SVCS = {
  1: {
    id: 1, name: 'uavcan.protocol.GetNodeInfo', short: 'GetNodeInfo',
    sigHex: 'EE468A8121C46A9E', priority: 24,
    // THE REQUEST IS EMPTY. Zero bits, one frame, one tail byte of payload and nothing else -
    // the question is the id. That is worth seeing at least once, because it is the cheapest
    // possible thing a bus can carry and the answer is the widest transfer in this module.
    req:  { bits: 0, fields: [] },
    resp: { bits: 328, fields: [
      // uavcan.protocol.NodeStatus, inlined - the SAME five fields message 341 publishes at
      // 1 Hz. That is not duplication, it is the point: GetNodeInfo hands you the heartbeat you
      // would otherwise have to wait for, plus the identity you could never learn from it.
      { name: 'uptime_sec', bits: 32, unit: 's' },
      { name: 'health',     bits: 2, map: DC_HEALTH },
      { name: 'mode',       bits: 3, map: DC_MODE },
      { name: 'sub_mode',   bits: 3 },
      { name: 'vendor_specific_status_code', bits: 16, hex: true },
      // uavcan.protocol.SoftwareVersion, inlined.
      { name: 'sw_major', bits: 8 },
      { name: 'sw_minor', bits: 8 },
      // OPTIONAL_FIELD_FLAG_VCS_COMMIT = 1, OPTIONAL_FIELD_FLAG_IMAGE_CRC = 2. The two fields
      // below are meaningless unless their bit is set here, which is DSDL's way of saying
      // "unknown" for a field that has no NaN.
      { name: 'sw_optional_field_flags', bits: 8, hex: true },
      { name: 'sw_vcs_commit', bits: 32, hex: true },
      // uint64 image_crc, carried as its two 32-bit halves. NOT cosmetic: dcBitWriter runs on
      // JavaScript numbers, so a genuine 64-bit field would silently lose everything past 2^53 -
      // and a firmware hash is exactly the kind of value where the lost bits are the interesting
      // ones. Two halves are the same 8 little-endian bytes on the wire.
      { name: 'sw_image_crc_lo', bits: 32, hide: true },
      { name: 'sw_image_crc_hi', bits: 32, hide: true },
      // uavcan.protocol.HardwareVersion, inlined.
      { name: 'hw_major', bits: 8 },
      { name: 'hw_minor', bits: 8 },
      { name: 'unique_id', bytes: 16 },
      // certificate_of_authenticity is uint8[<=255] and NOT the last field of the response, so
      // the tail array optimization does NOT apply to it and its 8-bit length prefix is on the
      // wire. Sent empty, so the prefix is all of it. Getting this one wrong shifts the node
      // name by a byte and produces a name that decodes as plausible garbage.
      { name: 'coa_len', bits: 8, hide: true },
      // uint8[<=80] name, LAST and 8-bit elements: tail array optimization, no length prefix.
      { name: 'name', tail: true, ascii: true },
    ] },
  },
  5: {
    id: 5, name: 'uavcan.protocol.RestartNode', short: 'RestartNode',
    sigHex: '569E05394A3017F0',
    // Priority 20, not the services' 24: a restart is a command with a physical consequence, the
    // same argument ArmingStatus and hardpoint.Command make for their own priority.
    priority: 20,
    // uint40 MAGIC_NUMBER = 0xACCE551B1E, and the DSDL says outright that "the request should be
    // rejected if magic_number does not equal MAGIC_NUMBER". It is not security - it is on the
    // wire in the clear - it is a guard against a stray frame rebooting an aircraft, and the
    // server below really does reject a wrong one rather than treating the field as decoration.
    req:  { bits: 40, fields: [{ name: 'magic_number', bits: 40, hex: true }] },
    resp: { bits: 1,  fields: [{ name: 'ok', bits: 1 }] },
  },
  11: {
    id: 11, name: 'uavcan.protocol.param.GetSet', short: 'param.GetSet',
    sigHex: 'A7B622F939D1A4D5', priority: 24,
    // THE ONE MESSAGE IN THIS MODULE WITH NO FIELD TABLE, and the reason is structural rather
    // than laziness: param.Value is a DSDL @union, so its width depends on its 3-bit tag - an
    // integer parameter and a string parameter are not the same size. A flat list of
    // fixed-width fields cannot express that, which is precisely what a union is for. Its codec
    // is written out below (dcGetSetEncodeReq and friends) and this entry points at it.
    union: true,
  },
};
for (const k of Object.keys(DC_SVCS)) DC_SVCS[k].sig = dcSigBytes(DC_SVCS[k].sigHex);

// ── param.Value / param.NumericValue, the two unions ──────────────────────────
// Tag widths come off the DSDL's own comments: Value's is "3 bit long, so outer structure has a
// 5-bit prefix to ensure proper alignment", NumericValue's is 2. Those void paddings are not
// decoration - they are what makes every variant land on a byte boundary, which is in turn what
// lets `name` be a tail array of whole bytes at the end of a message full of odd-width fields.
const DC_VAL_EMPTY = 0, DC_VAL_INT = 1, DC_VAL_REAL = 2, DC_VAL_BOOL = 3, DC_VAL_STRING = 4;
const DC_NUM_EMPTY = 0, DC_NUM_INT = 1, DC_NUM_REAL = 2;

// A parameter value as this module hands it around: { kind, v } with kind one of the tags above.
const dcValInt  = (v) => ({ kind: DC_VAL_INT,  v: Math.round(Number(v) || 0) });
const dcValReal = (v) => ({ kind: DC_VAL_REAL, v: Number(v) });
const dcValBool = (v) => ({ kind: DC_VAL_BOOL, v: v ? 1 : 0 });
const dcValEmpty = () => ({ kind: DC_VAL_EMPTY, v: null });
const dcNumInt  = (v) => ({ kind: DC_NUM_INT,  v: Math.round(Number(v) || 0) });

function dcPutValue(w, val) {
  const x = val || dcValEmpty();
  w.put(x.kind, 3);
  if (x.kind === DC_VAL_INT) {
    // int64. The bit writer works in doubles, so anything past 2^53 would be a lie - every
    // parameter here is a small integer and the self-test pins one, but a caller that ever wants
    // a real 64-bit parameter needs a second look at this line rather than a shrug.
    w.put(x.v, 64);
  } else if (x.kind === DC_VAL_REAL) {
    w.put(dcF32ToBits(x.v), 32);          // a genuine float32, as its IEEE-754 pattern
  } else if (x.kind === DC_VAL_BOOL) {
    w.put(x.v ? 1 : 0, 8);                // uint8, "used for alignment reasons" per the DSDL
  } else if (x.kind === DC_VAL_STRING) {
    const b = dcTailBytes(x.v);
    w.put(b.length, 8);                   // uint8[<=128]: an 8-bit prefix, and NOT last here
    for (const c of b) w.put(c, 8);
  }
}
function dcValueBits(val) {
  const x = val || dcValEmpty();
  if (x.kind === DC_VAL_INT) return 3 + 64;
  if (x.kind === DC_VAL_REAL) return 3 + 32;
  if (x.kind === DC_VAL_BOOL) return 3 + 8;
  if (x.kind === DC_VAL_STRING) return 3 + 8 + 8 * dcTailBytes(x.v).length;
  return 3;
}
function dcGetValue(r) {
  const kind = r.get(3);
  if (kind === DC_VAL_INT) return { kind, v: r.get(64, true) };
  if (kind === DC_VAL_REAL) return { kind, v: dcF32FromBits(r.get(32)) };
  if (kind === DC_VAL_BOOL) return { kind, v: r.get(8) };
  if (kind === DC_VAL_STRING) {
    const n = r.get(8), b = [];
    for (let i = 0; i < n; i++) b.push(r.get(8));
    return { kind, v: b };
  }
  return { kind: DC_VAL_EMPTY, v: null };
}
function dcPutNumeric(w, val) {
  const x = val || { kind: DC_NUM_EMPTY, v: null };
  w.put(x.kind, 2);
  if (x.kind === DC_NUM_INT) w.put(x.v, 64);
  else if (x.kind === DC_NUM_REAL) w.put(dcF32ToBits(x.v), 32);
}
function dcNumericBits(val) {
  const x = val || { kind: DC_NUM_EMPTY };
  return 2 + (x.kind === DC_NUM_INT ? 64 : x.kind === DC_NUM_REAL ? 32 : 0);
}
function dcGetNumeric(r) {
  const kind = r.get(2);
  if (kind === DC_NUM_INT) return { kind, v: r.get(64, true) };
  if (kind === DC_NUM_REAL) return { kind, v: dcF32FromBits(r.get(32)) };
  return { kind: DC_NUM_EMPTY, v: null };
}
function dcValueText(x) {
  if (!x || x.kind === DC_VAL_EMPTY) return '-';
  if (x.kind === DC_VAL_BOOL) return x.v ? 'true' : 'false';
  if (x.kind === DC_VAL_STRING) return '"' + dcAscii(x.v) + '"';
  if (x.kind === DC_VAL_REAL) return Number.isFinite(x.v) ? String(Number(x.v.toFixed(4))) : 'NaN';
  return String(x.v);
}

// ── param.GetSet codecs ───────────────────────────────────────────────────────
// Request:  uint13 index, Value value, uint8[<=92] name   (name last -> tail array)
// Response: void5, Value value, void5, Value default_value, void6, NumericValue max_value,
//           void6, NumericValue min_value, uint8[<=92] name
// The name field is a tail array in BOTH, so both end byte-aligned by construction: 13+3 = 16 in
// the request, and 5+3 / 5+3 / 6+2 / 6+2 = 8 apiece in the response, plus each variant's own
// whole number of bytes. That is what the void paddings are FOR.
//
// NAME BEATS INDEX when it is non-empty - the DSDL is explicit, and it also warns that index
// access exists only to enumerate ("persistent ordering is not guaranteed"), which is exactly
// how the client below uses it: walk indices until a nameless answer comes back, then address
// everything found by name.
function dcGetSetEncodeReq(index, value, name) {
  const nb = dcTailBytes(name);
  const w = dcBitWriter(13 + dcValueBits(value));
  w.put(index & 0x1FFF, 13);
  dcPutValue(w, value);
  return w.bytes().concat(nb);
}
function dcGetSetDecodeReq(bytes) {
  const r = dcBitReader(bytes);
  const index = r.get(13);
  const value = dcGetValue(r);
  const fixed = (13 + dcValueBits(value)) >> 3;
  return { index, value, name: dcAscii(Array.from(bytes).slice(fixed)) };
}
function dcGetSetEncodeResp(p) {
  const nb = dcTailBytes(p.name);
  const w = dcBitWriter(5 + dcValueBits(p.value) + 5 + dcValueBits(p.defaultValue) +
                        6 + dcNumericBits(p.maxValue) + 6 + dcNumericBits(p.minValue));
  w.put(0, 5); dcPutValue(w, p.value);
  w.put(0, 5); dcPutValue(w, p.defaultValue);
  w.put(0, 6); dcPutNumeric(w, p.maxValue);
  w.put(0, 6); dcPutNumeric(w, p.minValue);
  return w.bytes().concat(nb);
}
function dcGetSetDecodeResp(bytes) {
  const r = dcBitReader(bytes);
  r.get(5); const value = dcGetValue(r);
  r.get(5); const defaultValue = dcGetValue(r);
  r.get(6); const maxValue = dcGetNumeric(r);
  r.get(6); const minValue = dcGetNumeric(r);
  const fixed = (5 + dcValueBits(value) + 5 + dcValueBits(defaultValue) +
                 6 + dcNumericBits(maxValue) + 6 + dcNumericBits(minValue)) >> 3;
  return { value, defaultValue, maxValue, minValue,
           name: dcAscii(Array.from(bytes).slice(fixed)) };
}
// One line each for the transfer log, in the same shape dcSummary produces for a message.
function dcGetSetReqSummary(q) {
  return `index=${q.index}  name="${q.name}"  value=${dcValueText(q.value)}`;
}
function dcGetSetRespSummary(a) {
  // An EMPTY name AND an empty value is the DSDL's own "there is no such parameter", which is
  // how an index walk knows it has reached the end. Saying so beats printing two blanks.
  if (!a.name && a.value.kind === DC_VAL_EMPTY) return 'no such parameter (end of list)';
  return `name="${a.name}"  value=${dcValueText(a.value)}  default=${dcValueText(a.defaultValue)}` +
         `  min=${dcValueText(a.minValue)}  max=${dcValueText(a.maxValue)}`;
}

// TWO FIELD KINDS THE ORIGINAL NINE MESSAGES DID NOT NEED, both arriving with the services:
//
//   { bytes: N }  a FIXED byte array (GetNodeInfo's uint8[16] unique_id). The flat-field rule
//                 would have inlined it as sixteen separate uint8 fields - identical bits, but
//                 sixteen rows in every summary line - so it is one field whose value is an
//                 array. This is the same construct ahrs.Solution's float16[4] uses, given a
//                 name rather than written out.
//   { tail: true } a VARIABLE-length trailing byte array under the DSDL v0 tail array
//                 optimization (GetNodeInfo's uint8[<=80] name). Being last with >= 8-bit
//                 elements, it carries no length prefix at all - so it is LITERALLY THE BYTES
//                 THAT ARE LEFT, and that is exactly how it is encoded and decoded here. It
//                 must be the last field, and everything ahead of it must be byte-aligned;
//                 dronecanSelfTest() asserts both rather than trusting them.
//
// `m.bits` stays the exact length of the FIXED part - a tail contributes nothing to it, because
// its length is whatever the caller passed.
const dcTailField = (m) => { const f = m.fields[m.fields.length - 1]; return (f && f.tail) ? f : null; };
// A tail's value may be a byte array or a string; a string is ASCII, which is what every
// uint8[<=N] used as text in DSDL means (GetNodeInfo's name is documented as ASCII outright).
function dcTailBytes(v) {
  if (v == null) return [];
  if (typeof v === 'string') return Array.from(v, (c) => c.charCodeAt(0) & 0xFF);
  return Array.from(v, (b) => Number(b) & 0xFF);
}

function dcEncode(m, vals) {
  const w = dcBitWriter(m.bits);
  for (const f of m.fields) {
    if (f.tail) continue;
    if (f.bytes) { const a = dcTailBytes(vals[f.name]); for (let i = 0; i < f.bytes; i++) w.put(a[i] || 0, 8); continue; }
    w.put(f.f16 ? dcFloat16(vals[f.name]) : vals[f.name], f.f16 ? 16 : f.bits);
  }
  const out = w.bytes();
  const tf = dcTailField(m);
  if (tf) out.push(...dcTailBytes(vals[tf.name]));
  return out;
}
function dcDecode(m, bytes) {
  const r = dcBitReader(bytes);
  const o = {};
  for (const f of m.fields) {
    if (f.tail) { o[f.name] = Array.from(bytes).slice(m.bits >> 3); continue; }
    if (f.bytes) { const a = []; for (let i = 0; i < f.bytes; i++) a.push(r.get(8)); o[f.name] = a; continue; }
    o[f.name] = f.f16 ? dcFloat16Decode(r.get(16)) : r.get(f.bits, f.signed);
  }
  return o;
}
const dcHexJoin = (a) => Array.from(a || [], (b) => (b & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join('');
// An ASCII tail printed as text, with anything unprintable shown as a dot rather than smuggled
// into the DOM - the payload is device-controllable and this string reaches innerHTML.
const dcAscii = (a) => Array.from(a || [], (b) => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
function dcSummary(m, v) {
  // `hide` drops DSDL void padding, which carries nothing by definition; `f32bits` reads a
  // float32 back out of the 32-bit pattern it rides in, so an unknown velocity prints NaN
  // instead of 2143289344. Both are display concerns only - the encoder and the decoder
  // never look at either flag.
  return m.fields.filter(f => !f.hide).map(f => {
    if (f.bytes) return `${f.name}=${dcHexJoin(v[f.name])}`;
    if (f.tail) return `${f.name}=${f.ascii ? '"' + dcAscii(v[f.name]) + '"' : (dcHexJoin(v[f.name]) || '-')}`;
    const raw = f.f32bits ? dcF32FromBits(v[f.name]) : v[f.name];
    let s = raw;
    if (f.map) s = f.map[s] != null ? f.map[s] : s;
    else if (f.hex) s = dcH(s, 4);
    else if (typeof s === 'number' && !Number.isInteger(s)) s = Number.isFinite(s) ? s.toFixed(f.dp == null ? 2 : f.dp) : 'NaN';
    return `${f.name}=${s}${f.unit && Number.isFinite(raw) ? ' ' + f.unit : ''}`;
  }).join('  ');
}

// ── Transfer reassembly ───────────────────────────────────────────────────────
// State is passed in so the self-test can reassemble into a scratch map without disturbing
// (or being disturbed by) whatever is happening on the live bus.
function dcNewRxState() { return { asm: new Map(), err: { crc: 0, toggle: 0, tid: 0, orphan: 0 } }; }

// What a 29-bit id says about itself, before any table is consulted. THE REASSEMBLY KEY COMES
// FROM HERE, and it is why this function exists rather than three call sites: a message is keyed
// by (type, source), but a service by (type, source, destination, direction) - two nodes both
// answering GetNodeInfo to two different tools are four independent transfers sharing one
// service type id, and a key that dropped the destination would splice them together.
function dcParseAnyId(id) {
  if ((id >>> 7) & 1) {
    const h = dcParseSvcId(id);
    h.kind = 'svc';
    h.dataTypeId = null;
    h.key = `s${h.svcTypeId}:${h.srcNode}:${h.destNode}:${h.isRequest ? 1 : 0}`;
    return h;
  }
  if (!(id & 0x7F)) {
    const h = dcParseAnonId(id);
    h.kind = 'anon';
    h.srcNode = 0;
    h.dataTypeId = null;
    h.key = `a${h.msgTypeIdLow}:${h.discriminator}`;
    return h;
  }
  const h = dcParseMsgId(id);
  h.kind = 'msg';
  h.key = `m${h.dataTypeId}:${h.srcNode}`;
  return h;
}
// The signature a multi-frame transfer's CRC is seeded with. Unknown type -> null, which the
// caller reports as "cannot be checked" rather than as a failure.
function dcSigFor(h) {
  if (h.kind === 'svc') { const v = DC_SVCS[h.svcTypeId]; return v ? v.sig : null; }
  const m = DC_MSGS[h.dataTypeId];
  return m ? m.sig : null;
}

// Returns null while a transfer is still in flight, otherwise
// { kind, srcNode, dataTypeId, svcTypeId, isRequest, destNode, tid, payload, frames, crcOk, error }.
function dcFeedFrame(st, id, data) {
  if (!data || !data.length) return null;
  const h = dcParseAnyId(id);
  const tail = data[data.length - 1] & 0xFF;
  const sot = (tail >> 7) & 1, eot = (tail >> 6) & 1, tog = (tail >> 5) & 1, tid = tail & 0x1F;
  const chunk = Array.from(data).slice(0, data.length - 1);
  const key = h.key;
  const out = (payload, frames, crcOk, error) => ({
    kind: h.kind, srcNode: h.srcNode, dataTypeId: h.dataTypeId,
    svcTypeId: h.svcTypeId, isRequest: h.isRequest, destNode: h.destNode,
    discriminator: h.discriminator, priority: h.priority,
    tid, payload, frames, crcOk, error,
  });

  if (sot && eot) {                                   // single frame: no CRC, toggle must be 0
    st.asm.delete(key);
    return out(chunk, 1, null, tog ? 'toggle' : null);
  }
  // An anonymous transfer cannot be multi-frame - there is no source node id to key a buffer on,
  // so two anonymous nodes would splice into one plausible-looking payload. Count it and drop it
  // rather than reassembling something nobody sent.
  if (h.kind === 'anon') { st.err.orphan++; return null; }
  if (sot) {                                          // first frame of a multi-frame transfer
    st.asm.set(key, { tid, expect: 1, bytes: chunk, frames: 1 });
    return null;
  }
  const a = st.asm.get(key);
  if (!a) { st.err.orphan++; return null; }           // joined mid-transfer; wait for the next SOT
  if (tid !== a.tid) { st.err.tid++; st.asm.delete(key); return null; }
  if (tog !== a.expect) { st.err.toggle++; st.asm.delete(key); return null; }
  a.bytes = a.bytes.concat(chunk);
  a.expect ^= 1;
  a.frames++;
  if (!eot) return null;
  st.asm.delete(key);
  if (a.bytes.length < 2) { st.err.crc++; return null; }
  const want = (a.bytes[0] | (a.bytes[1] << 8)) & 0xFFFF;
  const payload = a.bytes.slice(2);
  const sig = dcSigFor(h);
  // An unknown data type has no signature, so its CRC can't be checked - report null, not false.
  const crcOk = sig ? (dcCrc16(payload, sig) === want) : null;
  if (crcOk === false) st.err.crc++;
  return out(payload, a.frames, crcOk, crcOk === false ? 'crc' : null);
}

// ── Live state ────────────────────────────────────────────────────────────────
const dcCfg = { txEnabled: true, fcNode: 1 };
const dcRx = dcNewRxState();
const dcNodes = new Map();        // node id -> { lastSeen, msgs:Set, last: {name, vals} }
let dcTxCount = 0, dcLastTx = 0;

function dronecanIngestFrame(frame) {
  if (!frame || !frame.isExt || frame.isRtr) return;
  const done = dcFeedFrame(dcRx, frame.id, frame.data);
  if (!done) { if (dcRx.err.orphan || dcRx.err.toggle || dcRx.err.tid || dcRx.err.crc) dcTab.markDirty(); return; }
  const now = Date.now();

  // A SERVICE TRANSFER IS NOT A NODE ANNOUNCING ITSELF, so it deliberately does not touch
  // dcNodes: a node that answers a question has not thereby published a heartbeat, and letting a
  // GetNodeInfo response refresh the roster's "last seen" would hide exactly the case the roster
  // exists to show. It goes to the service layer and to the log, and nowhere else.
  if (done.kind === 'svc') { dcSvcIngest(done, frame.id, now); return; }
  if (done.kind === 'anon') { dcAnonIngest(done, frame.id, now); return; }

  const m = DC_MSGS[done.dataTypeId];
  const vals = m ? dcDecode(m, done.payload) : null;

  let n = dcNodes.get(done.srcNode);
  if (!n) { n = { lastSeen: 0, msgs: new Set(), last: null }; dcNodes.set(done.srcNode, n); }
  n.lastSeen = now;
  n.msgs.add(m ? m.short : dcH(done.dataTypeId, 4));
  if (vals) n.last = { name: m.short, vals };
  // The heartbeat is tracked apart from `last`, which any later message overwrites: the roster
  // view reads presence off NodeStatus alone, so it needs that message's own timestamp.
  // uptime_sec rides along because a RESTART is only visible as that number going backwards.
  if (vals && m && m.id === 341) { n.nsAt = now; n.health = vals.health; n.uptime = vals.uptime_sec; }
  // A NON-anonymous Allocation is the allocator talking, and the bench allocatee is listening for
  // it exactly the way a real one does - off the bus, with no idea the allocator is in the same
  // file. This is the line that makes the exchange a protocol rather than a re-enactment.
  if (vals && m && m.id === 1) dcAllocateeHeard(vals);

  dcTab.pushLog({
    ts: now,
    id: frame.id >>> 0,
    node: done.srcNode,
    dtid: done.dataTypeId,
    name: m ? m.short : ('type ' + done.dataTypeId),
    known: !!m,
    frames: done.frames,
    bad: done.crcOk === false || !!done.error,
    crcOk: done.crcOk,
    data: done.payload,
    summary: vals ? dcSummary(m, vals) : '',
    escIndex: vals && m && m.id === 1034 ? vals.esc_index : null,
  });
}

// ── Carlito flavor packer ─────────────────────────────────────────────────────
// carlito.js calls this with each telemetry tick from the game. Everything here is
// dronecan-flavored contract signal -> DroneCAN message; the frames go back to carlito.js,
// which puts them through its canForward gateway.

// Read a number out of the contract rather than typing it here, so a derived value can't
// drift when the game retunes the model behind it. `key` is 'max' for the top of `range`,
// otherwise a scalar property such as 'warn'.
const _dcContractNums = new Map();
function dcContractNum(name, key, fallback) {
  const ck = name + '.' + key;
  if (_dcContractNums.has(ck)) return _dcContractNums.get(ck);
  const c = window.CARLITO_CONTRACT;
  const s = c && c.signals && c.signals.find(x => x.name === name && x.dir === 'out');
  let v = fallback;
  if (s) v = key === 'max' ? (Array.isArray(s.range) ? s.range[1] : fallback) : s[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) v = fallback;
  _dcContractNums.set(ck, v);
  return v;
}
function dcEscCurrentMax() { return dcContractNum('esc_current', 'max', 80); }

// The contract's own enum tables, READ rather than retyped - the same rule dcContractNum follows
// for numbers, and what carlito.js already does with the gear byte. A retyped table is a copy that
// goes wrong silently the day the contract adds a mode.
function dcEnumTable(name, dir) {
  const c = window.CARLITO_CONTRACT;
  const s = c && c.signals && c.signals.find(x => x.name === name && x.dir === dir);
  return (s && s.enum) || {};
}
// Numeric keys in order, so a selector's positions come off the contract too.
function dcEnumKeys(name, dir) {
  return Object.keys(dcEnumTable(name, dir)).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}
function dcEnumLabel(name, dir, v) {
  const t = dcEnumTable(name, dir);
  const k = Math.round(Number(v));
  return t[k] != null ? t[k] : String(Number.isFinite(k) ? k : '-');
}

// ── The node roster ───────────────────────────────────────────────────────────
// THE ONE PLACE A NODE ID IS DECLARED. Order is the contract's node_health element order and the
// bit order of node_online / node_fail, both of which the contract states in PROSE only (the
// descs of node_health and node_fail; the game declares the same roster once, in drone_bus.gd).
// It superseded the old dcCfg.escBaseNode, which was a second, independent id source: an ESC base
// dragged up to 17..20 would have landed an ESC on top of the GNSS node with nothing to say so.
const DC_ROSTER = [
  { name: 'ESC1', id: 11 }, { name: 'ESC2', id: 12 },
  { name: 'ESC3', id: 13 }, { name: 'ESC4', id: 14 },
  { name: 'GNSS', id: 20 }, { name: 'POWER', id: 21 },
  { name: 'AHRS', id: 22 }, { name: 'RANGE', id: 23 },
];
// Roster indices for the four non-ESC emitters, so dcBuildFrames addresses the table rather than
// a literal id.
const DC_I_ESC0 = 0, DC_I_GNSS = 4, DC_I_POWER = 5, DC_I_AHRS = 6, DC_I_RANGE = 7;
const DC_ESC_COUNT = DC_I_GNSS - DC_I_ESC0;
// Every roster bit set - what an ABSENT node_online means (see dcOnlineMask).
const DC_ALL_ONLINE = (1 << DC_ROSTER.length) - 1;
// A node is SILENT after three missed heartbeats, which is the only way presence can be read off
// a bus: node_online is not decoded here, and must not be - a listener learns it from the absence
// of frames, and the roster view is that listener.
const DC_NODE_STALE_MS = 3000;
// The contract's node_health `count` is the ONLY machine-readable half of the roster - the ids and
// the order are prose - so it is the one thing that can be asserted, and it is what makes growing
// the roster on the game side a loud failure here instead of frames addressed to the wrong node.
(function checkRoster() {
  const n = dcContractNum('node_health', 'count', 0);
  if (n && n !== DC_ROSTER.length) {
    console.warn(`DroneCAN: node roster is ${DC_ROSTER.length} entries but the contract's node_health ` +
      `declares count ${n} - the game's roster has changed and DC_ROSTER has not followed.`);
  }
})();

const dcEscErrCount = [];
let dcEscFaultPrev = 0;
let dcT0 = 0;

// ── The bench controls (they ride the UPLINK, not a DroneCAN message) ─────────
// node_fail and flight_mode are not DroneCAN concepts and must not be given invented vendor
// messages: node_fail is a bench switch, and the mode is an FC concept whose CONSEQUENCE the bus
// carries (mode_actual, and the frames a degraded mode changes). led and beep DO have messages,
// and they do both - see dcCmdPending.
//
// THE GAME'S Y AND Z KEYS WALK THE SAME LATCHES, AND THE TWO FIGHT. The game's arbitration is
// wholesale: while bridge values are fresh (300 ms), InputRouter reads node_fail / flight_mode
// out of the payload and IGNORES its local latch entirely, so the bridge wins outright - and
// omitting the field would not hand it back, because an absent value reads as 0 there too. The
// keyboard drives again when the Carlito window's Up toggle goes off and the values go stale.
// That is the contract's design (a bridge that has taken the aircraft has taken it), not a defect.
let dcFailMask = 0;                                  // node_fail: bit i = roster index i off the bus
const dcCtl = {
  mode: 0, led: 0, beep: false,                      // flight_mode / led (RGB565) / beep
  hook: false, gimbalPitch: 0, gimbalYaw: 0,         // hardpoint_cmd / gimbal_pitch / gimbal_yaw
};

window.carlitoUplinkSources = window.carlitoUplinkSources || {};
Object.assign(window.carlitoUplinkSources, {
  // Unlike the unwired signals carlito.js OMITS, these four have a real control behind them, so
  // sending 0 is a statement ("the switch is off / STABILIZE") rather than an invented default.
  node_fail:   () => dcFailMask,
  flight_mode: () => dcCtl.mode,
  led:         () => dcCtl.led,
  beep:        () => (dcCtl.beep ? 1 : 0),
  // The cargo hook and the two gimbal axes, added with contract v30. Same rule as the four
  // above: there is a real control behind each, so sending a value is a statement rather than
  // an invented default. The gimbal pair goes out in contract DEGREES - the signal's units and
  // the mount's units are the same, which is the whole reason the contract chose degrees.
  hardpoint_cmd: () => (dcCtl.hook ? 1 : 0),
  gimbal_pitch:  () => dcCtl.gimbalPitch,
  gimbal_yaw:    () => dcCtl.gimbalYaw,
});

// BatteryInfo.average_power_10sec is a real 10-second mean of pack V * I, not a stand-in:
// every slow tick pushes one sample and the window drops anything older than 10 s. It is a
// plain sample mean rather than time-weighted because the slow tick is regular, so the two
// agree; an empty window (nothing sampled yet) is NaN, DSDL's "not known".
const DC_PWR_WINDOW_MS = 10000;
const dcPwrWin = [];
function dcAvgPower10s(w, now) {
  if (Number.isFinite(w)) dcPwrWin.push({ t: now, w });
  while (dcPwrWin.length && now - dcPwrWin[0].t > DC_PWR_WINDOW_MS) dcPwrWin.shift();
  if (!dcPwrWin.length) return NaN;
  let s = 0;
  for (const e of dcPwrWin) s += e.w;
  return s / dcPwrWin.length;
}

// Attitude quaternion (x, y, z, w) from the contract's pitch/roll in DEGREES.
//
// THE SIGNS ALREADY AGREE, and that is worth stating rather than assuming: DSDL is body-frame
// NED (x forward, y right, z down), where a positive rotation about x puts the RIGHT SIDE DOWN
// and a positive rotation about y puts the NOSE UP - which is exactly what the contract says
// its 'roll' and 'pitch' mean. So the conversion is degrees -> radians and the standard ZYX
// (yaw-pitch-roll) quaternion, with NO sign flip on either angle.
//
// Yaw is zero because THE GAME PUBLISHES NO HEADING: its 'yaw' signal is a RATE (rad/s), which
// belongs in angular_velocity and is already there. So this quaternion is a levelling solution,
// not a heading reference, and a consumer reading a heading out of it would be reading the
// absence of one. (The angular_velocity triple below is where the one real sign flip lives.)
function dcQuatFromPitchRoll(pitchDeg, rollDeg) {
  const p = (Number(pitchDeg) || 0) * Math.PI / 360;   // half angle, degrees -> radians
  const r = (Number(rollDeg) || 0) * Math.PI / 360;
  const cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  return [sr * cp, cr * sp, -sr * sp, cr * cp];
}

// Gimbal orientation, body frame, from the contract's two Euler angles in DEGREES. YAW FIRST
// (about body up), then pitch about the yawed right axis - the same "pan, then tilt" order the
// game builds the mount's basis in (drone_gimbal.gd), and reversing it tilts the pan axis over
// with the camera. Returned xyzw, the DSDL order.
//
// DSDL body frame is NED (x forward, y right, z DOWN), and NEITHER angle negates - which is worth
// stating, because the ahrs.Solution conversion beside this one DOES negate its yaw and the two
// look like they should agree. They do not, and the difference is real: that one carries a yaw
// RATE read off the game's UP axis, where + is nose LEFT, while `gimbal_yaw` is declared + = right
// in the contract, which is already NED's sense. Pitch is + up in both. So a mount looking down
// comes out with a negative y and a mount panned right with a positive z, and the self-test pins
// exactly those two signs - a flipped one produces a perfectly valid quaternion pointing the
// wrong way, which nothing else would catch.
function dcQuatFromPitchYaw(pitchDeg, yawDeg) {
  const p = (Number(pitchDeg) || 0) * Math.PI / 360;   // half angle, degrees -> radians
  const y = (Number(yawDeg) || 0) * Math.PI / 360;
  const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  // q = qz(yaw) * qy(pitch), with NED z DOWN so a + yaw (right) is a + rotation about z.
  return [-sy * sp, cy * sp, sy * cp, cy * cp];
}

// The last arming picture the game sent, for the tab's pre-arm readout. It is deliberately
// NOT on the wire - see the ArmingStatus block in dcBuildFrames.
const DC_PREARM_BITS = ['ATTITUDE', 'BATTERY', 'ESC', 'AHRS', 'STICK', 'FAILSAFE', 'GPS'];
const DC_ARM_STATE = { 0: 'DISARMED', 1: 'BLOCKED', 2: 'ARMED' };
let dcArm = null;

// The last flight-mode picture the game sent, for the tab's request/actual/failsafe readout.
// home_dist rides here for the same reason: it is derived FC state with no DroneCAN message.
let dcFlight = null;

// ── Presence ──────────────────────────────────────────────────────────────────
// AN ABSENT node_online MEANS EVERY NODE ONLINE, never "every node silent". A game build older
// than this signal, and the demo dict before it grew one, simply do not carry the key - and
// defaulting a missing presence bitfield to zero would take the whole bus off the air on the
// strength of a field nobody sent.
function dcOnlineMask(t) {
  const v = t ? t.node_online : null;
  const base = (v == null) ? DC_ALL_ONLINE : (Number(v) | 0);
  // ...minus anything mid-restart. A node that accepted a RestartNode really does leave the bus,
  // and that is the whole visible effect of the service: the row goes silent for a moment and
  // comes back with uptime_sec at 0. A restart whose only sign was a counter resetting would
  // teach that rebooting is a number rather than an absence. The mask is the same one node_fail
  // rides, so a rebooting node stops publishing by exactly the mechanism a failed one does.
  const now = Date.now();
  let out = base;
  for (let i = 0; i < DC_ROSTER.length; i++)
    if (dcRebootAt[i] && now - dcRebootAt[i] < DC_REBOOT_MS) out &= ~(1 << i);
  return out;
}
// A node's own health, verbatim out of the game's node_health array (it is DERIVED there, from
// the failure mask plus the craft's state, so re-deriving it here would be a second model). An
// absent or short array reads OK rather than inventing a fault.
function dcNodeHealth(t, i) {
  const a = t && t.node_health;
  const v = Array.isArray(a) ? Math.round(Number(a[i])) : 0;
  return Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 0;
}

const dcNodeUpAt = [];    // per roster index: when it came online. Feeds NodeStatus.uptime_sec.

function dcBuildFrames(t) {
  if (!t || !Array.isArray(t.esc_rpm)) return [];   // not the drone - nothing to say
  if (!dcT0) dcT0 = Date.now();
  const fault = (Number(t.esc_fault) || 0) & 0xFF;
  const online = dcOnlineMask(t);
  const iMax = dcEscCurrentMax();
  const msg = DC_MSGS[1034];
  const out = [];
  // Bounded by the ROSTER, not by the array: an id has to come from somewhere, and a fifth ESC
  // in the telemetry is a roster that has grown on the game side (which checkRoster warns about)
  // rather than a node this module can address.
  for (let i = 0; i < t.esc_rpm.length && i < DC_ESC_COUNT; i++) {
    // error_count is a COUNT in DSDL, so count: rising edges of this ESC's fault bit. Counted for
    // an OFFLINE node too - the count belongs to the ESC, and losing it while the node is off the
    // bus would reset the tally every time it came back.
    if (((fault >> i) & 1) && !((dcEscFaultPrev >> i) & 1)) dcEscErrCount[i] = (dcEscErrCount[i] || 0) + 1;
    // AN OFFLINE NODE STOPS PUBLISHING. The game holds a dropped ESC's telemetry at its last value
    // ON PURPOSE - that is what a node which stopped talking leaves behind - so re-broadcasting
    // those held numbers would put stale readings on the wire as LIVE frames from a node that is
    // supposed to be silent, and a listener would see a healthy quad while the aircraft fell.
    // Silence is the reading.
    if (!((online >> i) & 1)) continue;
    const amps = Array.isArray(t.esc_current) ? Number(t.esc_current[i]) : NaN;
    const degC = Array.isArray(t.esc_temp)    ? Number(t.esc_temp[i])    : NaN;
    out.push(...dcTransfer(msg, DC_ROSTER[DC_I_ESC0 + i].id & 0x7F, dcEncode(msg, {
      error_count: dcEscErrCount[i] || 0,
      voltage: Number(t.battery),                                  // pack volts; NaN if absent
      current: amps,
      temperature: Number.isFinite(degC) ? degC + 273.15 : NaN,    // contract is degC, DSDL is Kelvin
      rpm: Math.round(Number(t.esc_rpm[i]) || 0),
      // The sim has no rated motor power, so this is a LABELLED PROXY: percent of the
      // contract's own esc_current envelope. It is not a claim about a real power rating.
      power_rating_pct: Number.isFinite(amps) ? Math.max(0, Math.min(100, Math.round(100 * amps / iMax))) : 0,
      esc_index: i,
    })));
  }
  dcEscFaultPrev = fault;

  const now = Date.now();

  // The four single-node emitters below, gated on the same presence bitfield the ESC loop uses:
  // a GNSS node that keeps publishing Fix2 after it has been taken off the bus is the same lie in
  // a different message. The roster is what turns an index into the id the frame is sent from.
  const emit = (idx, m, vals) => {
    if ((online >> idx) & 1) out.push(...dcTransfer(m, DC_ROSTER[idx].id, dcEncode(m, vals)));
  };

  // ── POWER node: uavcan.equipment.power.BatteryInfo ──────────────────────────
  // The four contract signals the plan names map straight across; everything else is either
  // a DSDL "unknown" constant or a documented zero, never an invented number.
  const bi = DC_MSGS[1092];
  const packV = Number(t.battery), packA = Number(t.pack_current), packC = Number(t.pack_temp);
  emit(DC_I_POWER, bi, {
    temperature: Number.isFinite(packC) ? packC + 273.15 : NaN,   // contract degC, DSDL Kelvin
    voltage: packV,
    current: packA,
    average_power_10sec: dcAvgPower10s(packV * packA, now),
    // NOT INVENTED. The pack's 10 Ah / 4S sizing lives in the contract's PROSE and in no
    // machine-readable field, so a watt-hour figure computed here would be a constant that
    // silently goes wrong the day the game resizes the pack - and there is no charger in the
    // game at all, so hours_to_full_charge has nothing behind it in any case. NaN is DSDL's
    // own "this field is not known" (the f16 half of it is dcFloat16's 0x7E00), and it is a
    // truer answer than a zero a consumer would read as "flat pack, charging complete".
    remaining_capacity_wh: NaN,
    full_charge_capacity_wh: NaN,
    hours_to_full_charge: NaN,
    status_flags: DC_BATT_IN_USE | (packC > dcContractNum('pack_temp', 'warn', 60) ? DC_BATT_TEMP_HOT : 0),
    state_of_health_pct: DC_SOH_UNKNOWN,
    state_of_charge_pct: Math.max(0, Math.min(100, Math.round(Number(t.soc) || 0))),
    // The one field where 0 is a claim we can actually make: the game's soc IS the coulomb
    // count rather than an estimate of one, so its error really is zero. That is a different
    // statement from the NaNs above, which is why it is not one of them.
    state_of_charge_pct_stdev: 0,
    battery_id: 0,            // one pack, and 0 is DSDL's "primary battery"
    model_instance_id: 0,     // DSDL: "set to zero if not applicable"
  });

  // ── GNSS node: uavcan.equipment.gnss.Fix2 ───────────────────────────────────
  const fx = DC_MSGS[1063];
  const lat = Number(t.lat), lon = Number(t.lon);
  // The game's `altitude` is height above sea level (world Y, water at y=0), so it is the MSL
  // height. The ellipsoid height gets the same number: a real receiver's two differ by the
  // local geoid undulation, and the game's world has no geoid model to undulate against.
  const altMm = Math.round((Number(t.altitude) || 0) * 1000);
  emit(DC_I_GNSS, fx, {
    timestamp_usec: 0,        // no network-synchronised time in the game; DSDL says zero
    gnss_timestamp_usec: 0,
    gnss_time_standard: 0,    // GNSS_TIME_STANDARD_NONE - the time above is unknown, not TAI
    void13: 0,
    num_leap_seconds: 0,      // NUM_LEAP_SECONDS_UNKNOWN
    longitude_deg_1e8: Math.round((Number.isFinite(lon) ? lon : 0) * 1e8),
    latitude_deg_1e8: Math.round((Number.isFinite(lat) ? lat : 0) * 1e8),
    // LAT/LON ARE PUBLISHED UNGATED BY fix_type, DELIBERATELY, and this file must not "fix"
    // that. The contract's fix_type desc says so outright: lat/lon are the shared base
    // signals every vehicle publishes and freezing them under NO_FIX would be a second model
    // of where the craft is. So NO_FIX beside a live position is the reading - what the
    // receiver can report and what the airframe knows are different things - and zeroing the
    // position here would be this side inventing the gate the game refused to build.
    height_ellipsoid_mm: altMm,
    height_msl_mm: altMm,
    // Fixed-size float32[3] and therefore always on the wire, but the contract's GNSS block
    // has no velocity signal - deriving one from speed and a heading would be a second model
    // of the same motion. NaN is DSDL's "not known".
    ned_velocity_n: DC_F32_NAN,
    ned_velocity_e: DC_F32_NAN,
    ned_velocity_d: DC_F32_NAN,
    sats_used: Math.max(0, Math.min(63, Math.round(Number(t.sats) || 0))),
    status: Math.max(0, Math.min(3, Math.round(Number(t.fix_type) || 0))),  // contract enum IS the DSDL enum
    mode: 0,          // MODE_SINGLE: no differential corrections exist in the game
    sub_mode: 0,      // meaningless under MODE_SINGLE (the sub-mode table is DGPS/RTK only)
    covariance_len: 0,
    // PDOP IS NOT HDOP, and neither name is being bent to fit the other. Fix2 carries only
    // pdop - the POSITION (3D) dilution - while the contract publishes hdop, the HORIZONTAL
    // one, described in its own desc as a labelled model of the visible rays' angular spread.
    // The horizontal component of a 3D figure is what lands here, so a consumer reading this
    // as a true PDOP reads slightly low; that is the honest cost of the only DOP field the
    // message has, and it beats renaming a quantity on either side to hide the mismatch.
    pdop: Number(t.hdop),
  });

  // ── RANGE node: uavcan.equipment.range_sensor.Measurement ───────────────────
  const rm = DC_MSGS[1050];
  const agl = Number(t.agl);
  // agl = -1 is the contract's ONLY invalid reading, and it means one of two things the game
  // deliberately does not distinguish: nothing inside the 100 m range, or the RANGE node off
  // the bus. READING_TYPE_UNDEFINED ("range is unknown") is the honest map for both - TOO_FAR
  // would claim to know which one it was. The range field goes to NaN, NOT ZERO: zero is
  // exactly the value a landing detector would act on, which is the failure the game's -1
  // exists to prevent, and reintroducing it on the wire would undo that here.
  const aglValid = Number.isFinite(agl) && agl >= 0;
  emit(DC_I_RANGE, rm, {
    timestamp_usec: 0,
    sensor_id: 0,
    // CoarseOrientation describes the beam's fixed direction in the BODY frame, and this beam
    // does not have one: the contract casts it along WORLD down (tilt-corrected), so under a
    // lean it is not aligned with any body axis. orientation_defined = false is DSDL's own way
    // of saying that, and it beats writing an angle triple that is wrong the moment it matters.
    beam_roll: 0, beam_pitch: 0, beam_yaw: 0, orientation_defined: 0,
    // Genuinely zero, not unknown: the sim casts ONE ray, and a ray has no beam width.
    field_of_view: 0,
    sensor_type: 2,   // SENSOR_TYPE_LIDAR - the contract's desc calls it a lidar
    reading_type: aglValid ? 1 : 0,   // VALID_RANGE / UNDEFINED
    range: aglValid ? agl : NaN,
  });

  // ── AHRS node: uavcan.equipment.ahrs.Solution ───────────────────────────────
  const so = DC_MSGS[1000];
  const q = dcQuatFromPitchRoll(t.pitch, t.roll);
  emit(DC_I_AHRS, so, {
    timestamp_usec: 0,
    orientation_x: q[0], orientation_y: q[1], orientation_z: q[2], orientation_w: q[3],
    void4_a: 0, orientation_covariance_len: 0,
    // THE ONE SIGN FLIP IN THE WHOLE CONVERSION, and the reason each axis is written out
    // rather than passed as a triple. DSDL body frame is NED, so the angular rates are about
    // x = forward, y = right, z = DOWN:
    //   roll_rate  is + right side down about the forward axis -> NED x, as published;
    //   pitch_rate is + nose up about the right axis           -> NED y, as published;
    //   yaw        is read off the game's UP axis, so + is nose LEFT (Godot's +Y is up and
    //              the right-hand rule turns the nose to port). NED's z points DOWN, where
    //              + is nose right. Hence the negation - and a missing one here would produce
    //              an attitude solution that looks entirely plausible and yaws the wrong way.
    angular_velocity_x: Number(t.roll_rate),
    angular_velocity_y: Number(t.pitch_rate),
    angular_velocity_z: -Number(t.yaw),
    void4_b: 0, angular_velocity_covariance_len: 0,
    // Same frame, same reasoning: accLong is + forward -> x, accLat is + right -> y, and
    // acc_vert is + UP along the body up axis while NED z is DOWN, so it negates too.
    // These are the game's KINEMATIC accelerations and carry no gravity term (acc_vert's desc
    // says so): a hovering craft reads 0 here, where a real accelerometer would read +9.8 up.
    linear_acceleration_x: Number(t.accLong),
    linear_acceleration_y: Number(t.accLat),
    linear_acceleration_z: -Number(t.acc_vert),
  });

  // ── FC node: uavcan.equipment.safety.ArmingStatus ───────────────────────────
  // ArmingStatus IS two-state (DISARMED / FULLY_ARMED), and the game's `armed` bool carries
  // it verbatim - that bool is precisely what an ESC gates on, which is what the message is
  // for. The contract's THIRD state, BLOCKED, has no field here and is not going to get one
  // by bending the enum: a real flight controller does not report a refusal through
  // ArmingStatus either, it publishes pre-arm messages saying which check said no. So the
  // asymmetry on the wire is the real one, and BLOCKED plus prearm_fail are surfaced in the
  // tab below instead - the same shape, one message short of a full DroneCAN FC.
  const as = DC_MSGS[1100];
  out.push(...dcTransfer(as, dcCfg.fcNode & 0x7F, dcEncode(as, {
    status: t.armed ? 255 : 0,   // STATUS_FULLY_ARMED / STATUS_DISARMED
  })));
  dcArm = {
    armed: !!t.armed,
    state: Math.round(Number(t.arming_state)),
    fail: (Number(t.prearm_fail) || 0) & 0xFFFF,
    at: now,
  };

  // ── FC node: the hardpoint, the gimbal and the barometer ────────────────────
  // ALL THREE PUBLISH FROM THE FC NODE, and that is a real limitation stated rather than papered
  // over. A cargo hook, a gimbal and an air-data probe are separate nodes on a real airframe, but
  // the roster here IS the contract's node_health index space - growing it is a contract change
  // and a paired promote - so these three ride the FC's id like ArmingStatus does. The visible
  // consequence: node_fail cannot take any of them off the bus, where it can take any ESC, the
  // GNSS, the pack or the rangefinder.
  const hp = DC_MSGS[1071];
  out.push(...dcTransfer(hp, dcCfg.fcNode & 0x7F, dcEncode(hp, {
    hardpoint_id: DC_HARDPOINT_ID,
    // NEWTON, straight off the contract - the game already publishes the force rather than a
    // mass, because that is the unit this message specifies.
    payload_weight: Number(t.payload_weight),
    // The game measures the mass exactly (it is a body property, not a load cell), so the
    // variance is a true zero rather than DSDL's "unknown" NaN.
    payload_weight_variance: 0,
    status: t.hardpoint_state ? DC_HOOK_HOLD : DC_HOOK_RELEASE,
  })));

  const gs = DC_MSGS[1044];
  const gq = dcQuatFromPitchYaw(t.gimbal_pitch_actual, t.gimbal_yaw_actual);
  out.push(...dcTransfer(gs, dcCfg.fcNode & 0x7F, dcEncode(gs, {
    gimbal_id: DC_GIMBAL_ID,
    // ORIENTATION_BODY_FRAME, matching the field name: the contract's actuals are the camera's
    // angle relative to the AIRFRAME, so a banked craft with a centred mount still reads level.
    mode: 2,
    orientation_x: gq[0], orientation_y: gq[1], orientation_z: gq[2], orientation_w: gq[3],
  })));

  // The barometer, as BOTH messages the contract names. That is not duplication: StaticPressure
  // is the dedicated one-value message a real baro node publishes fastest, and RawAirData is the
  // whole probe in one frame. A listener may reasonably subscribe to either.
  const sp = DC_MSGS[1028];
  const pressPa = Number(t.static_press);
  const oatK = Number(t.oat) + 273.15;   // contract is degC, DSDL is Kelvin
  out.push(...dcTransfer(sp, dcCfg.fcNode & 0x7F, dcEncode(sp, {
    static_pressure: dcF32ToBits(pressPa),
    // The game's barometer has no noise model at all - its two error terms are deterministic
    // (a drifting QNH and a speed-squared port error), so there is no variance to report and 0
    // is the honest number rather than an invented one.
    static_pressure_variance: 0,
  })));
  const rad = DC_MSGS[1027];
  out.push(...dcTransfer(rad, dcCfg.fcNode & 0x7F, dcEncode(rad, {
    // No heater on this probe, so no heater flag is true. 0 is a statement here, not a default.
    flags: 0,
    static_pressure: dcF32ToBits(pressPa),
    // NaN, DSDL's "not known": there is no pitot on this airframe and no airspeed signal in the
    // contract, so a differential pressure of 0 would claim a measured zero airspeed.
    differential_pressure: DC_F32_NAN,
    static_pressure_sensor_temperature: oatK,
    differential_pressure_sensor_temperature: NaN,
    static_air_temperature: oatK,
    pitot_temperature: NaN,
  })));

  // The mode triple, cached for the tab exactly as dcArm is. NONE of the three is on the wire:
  // the mode is an FC concept and the bus carries its consequence, and home_dist is derived
  // state DroneCAN has no message for at all (see the packer's `unpackable`).
  dcFlight = {
    req: Math.round(Number(dcCtl.mode)) || 0,
    actual: Math.round(Number(t.mode_actual)) || 0,
    fs: Math.round(Number(t.failsafe)) || 0,
    home: Number(t.home_dist),
    at: now,
  };

  // ── NodeStatus, ONE PER ONLINE NODE, at ~1 Hz ───────────────────────────────
  // This is what a DroneCAN bus actually looks like: every node announces itself, from its OWN
  // id, with its OWN health. The single heartbeat this replaced was published from the FC with a
  // health synthesised out of esc_fault - a judgement nothing on the aircraft had made. The game
  // publishes real per-node health now, so it is used verbatim.
  //
  // THE FC ITSELF NO LONGER SENDS ONE. It has no roster element, so any health for it would have
  // to be invented again; it still sources ArmingStatus and the two indication commands below.
  // THE SWEEP IS PER NODE, not one clock for all eight, because each node's publication period
  // is a real parameter its param.GetSet server can write (uavcan.node.status_period_ms). A
  // single shared clock would have made that parameter a number in a struct; a clock each makes
  // it the thing it claims to be - set one node to 4000 ms and its row goes stale at the 3 s
  // threshold while its neighbours stay green, which is what a misconfigured node looks like.
  const ns = DC_MSGS[341];
  for (let i = 0; i < DC_ROSTER.length; i++) {
    if (!((online >> i) & 1)) { dcNodeUpAt[i] = 0; dcNsLastAt[i] = 0; continue; }   // offline: silent, and its clock stops
    // uptime_sec is PER NODE and RESTARTS when the node comes back, because that is what a
    // rebooted node reports - a node that returned with the FC's uptime never rebooted.
    if (!dcNodeUpAt[i]) dcNodeUpAt[i] = now;
    if (now - (dcNsLastAt[i] || 0) < dcNodeParams[i].statusPeriodMs) continue;
    dcNsLastAt[i] = now;
    out.push(...dcTransfer(ns, DC_ROSTER[i].id, dcEncode(ns, {
      uptime_sec: Math.floor((now - dcNodeUpAt[i]) / 1000),
      health: dcNodeHealth(t, i),
      mode: 0,      // MODE_OPERATIONAL: an online node is running. The old MAINTENANCE-when-
                    // disarmed was an FC statement, and an ESC is not disarmed, it is idle.
      sub_mode: 0,
      // Vendor-specific by definition, and this module is not the vendor: health already carries
      // the node's judgement of itself, so a code invented here would say nothing true.
      vendor_specific_status_code: 0,
    })));
  }

  out.push(...dcFlushCommands());
  return out;
}

// ── The indication commands, emitted ON CHANGE ────────────────────────────────
// Latched by the control handler, flushed by the next dcBuildFrames so the frames ride the same
// canForward gateway every other frame in this module uses - one transmit path, one FW dump entry.
// They are NEVER sent on the periodic tick: a command spammed at 10 Hz is not what a real bus
// looks like. With no drone on the link dcBuildFrames returns early, so there is no bus to command
// and the latch simply waits (the same is true while Publish drone telemetry is off).
//
// NO LOCAL BLINK TIMER, ON EITHER SIDE. If the LEDs pulse it is because this control is toggling
// the colour, exactly as the turn lamps blink because the source toggles the bit.
const DC_BEEP_HZ = 2400;   // a labelled constant: the resonant pitch of a typical airframe piezo
let dcCmdPending = null;   // { led?, beep?, hook?, gimbal? } - see dcFlushCommands
function dcFlushCommands() {
  if (!dcCmdPending) return [];
  const p = dcCmdPending;
  dcCmdPending = null;
  const out = [];
  if (p.led != null) {
    const lc = DC_MSGS[1081];
    out.push(...dcTransfer(lc, dcCfg.fcNode & 0x7F, dcEncode(lc, {
      // light_id 0, not one of DSDL's named aircraft lights (246 ANTI_COLLISION, 249 WING, ...):
      // the airframe has ONE lamp group and the contract's `led` carries no light id at all, so
      // naming one would be a claim the game does not make.
      light_id: 0,
      red: (p.led >> 11) & 0x1F, green: (p.led >> 5) & 0x3F, blue: p.led & 0x1F,
    })));
  }
  if (p.hook != null) {
    // The cargo hook, in the DSDL's binary form. This is the one command here with a physical
    // consequence rather than an indication, which is why it carries ArmingStatus's priority.
    const hc = DC_MSGS[1070];
    out.push(...dcTransfer(hc, dcCfg.fcNode & 0x7F, dcEncode(hc, {
      hardpoint_id: DC_HARDPOINT_ID,
      command: p.hook ? DC_HOOK_HOLD : DC_HOOK_RELEASE,
    })));
  }
  if (p.gimbal != null) {
    // THE GIMBAL GOES OUT TWICE, ON PURPOSE, and the pair is the lesson rather than a belt and
    // braces. AngularCommand is how you command a CAMERA MOUNT - an orientation, in a named
    // frame, addressed to a gimbal - and ArrayCommand is how you command two ACTUATORS, as raw
    // positions in radians addressed by actuator id. Both are real DroneCAN, both describe the
    // same intent, and which one a peripheral answers to is a property of the peripheral. Sending
    // both is what a ground station with no idea which is fitted actually does.
    const ac = DC_MSGS[1040];
    const q = dcQuatFromPitchYaw(p.gimbal.pitch, p.gimbal.yaw);
    out.push(...dcTransfer(ac, dcCfg.fcNode & 0x7F, dcEncode(ac, {
      gimbal_id: DC_GIMBAL_ID,
      mode: 2,   // COMMAND_MODE_ORIENTATION_BODY_FRAME
      quaternion_x: q[0], quaternion_y: q[1], quaternion_z: q[2], quaternion_w: q[3],
    })));
    const arr = DC_MSGS[1010];
    out.push(...dcTransfer(arr, dcCfg.fcNode & 0x7F, dcEncode(arr, {
      // COMMAND_TYPE_POSITION, whose unit the DSDL gives as "meter or radian" - a rotary axis
      // takes the radian, so the contract's degrees convert here and nowhere else.
      actuator_id_0: 0, command_type_0: 1, command_value_0: p.gimbal.pitch * Math.PI / 180,
      actuator_id_1: 1, command_type_1: 1, command_value_1: p.gimbal.yaw * Math.PI / 180,
    })));
  }
  if (p.beep != null) {
    const bc = DC_MSGS[1080];
    // BeepCommand IS A ONE-SHOT (a frequency and a duration) and the contract's `beep` is a
    // LATCH. That asymmetry is real - the same shape as ArmingStatus having no BLOCKED - and it
    // is not closed by inventing a duration here, which would be a local timer wearing a hat.
    // A switch thrown on says "sound", a switch thrown off says "stop", and duration 0 is how a
    // latch states its own absence of one.
    out.push(...dcTransfer(bc, dcCfg.fcNode & 0x7F, dcEncode(bc, {
      frequency: p.beep ? DC_BEEP_HZ : 0,
      duration: 0,
    })));
  }
  return out;
}

// Emitted on the slow (~10 Hz) telemetry tick only. The budget, per tick, with every node online:
//   4 x esc.Status  3 frames each   12
//   Fix2            8                8   (50-byte payload - the widest transfer here)
//   ahrs.Solution   5                5
//   BatteryInfo     4                4
//   range           3                3
//   ArmingStatus    1                1
//   8 x NodeStatus  1 frame each     8 on one tick in ten (~0.8/tick averaged)
//                                   33 frames a tick + the 1 Hz sweep, ~340 frames/s
// Every one of those is gated on its node's presence bit, so a failed node reduces the budget -
// which is the point. The two indication commands are aperiodic and cost nothing at rest.
// That is 2.6x what this used to be, and it is the number to look at first if SLCAN starts
// dropping. Real airframes rate-split these (BatteryInfo at 0.2-1 Hz per its own DSDL note,
// AHRS far faster than 10 Hz); everything rides one tick here because the game has exactly
// one slow tick to hang them on, and a second cadence would be a timer inventing a rate the
// telemetry does not have.
function dcPackCarlito(t, slow) {
  if (!dcCfg.txEnabled || !slow) return [];
  const frames = dcBuildFrames(t);
  if (frames.length) { dcTxCount += frames.length; dcLastTx = Date.now(); dcTab.markDirty(); }
  return frames;
}

window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
window.carlitoFlavorPackers.push({
  flavor: 'dronecan',
  // What this module accounts for; `unpackable` is what it declares it will never pack, which
  // carlito.js's coverage check subtracts from the gap list and reports separately.
  // arming_state and prearm_fail are claimed but do NOT ride a frame, and that is the point
  // of the ArmingStatus comment above: DroneCAN has no field for either, so this module
  // accounts for them the way a real FC does - by publishing the two-state message from
  // `armed` and reporting the refusal separately, here as the tab's pre-arm readout.
  // pitch / roll / yaw / roll_rate / pitch_rate / accLong / accLat / acc_vert are absent on
  // purpose: they go out in ahrs.Solution, but they are UNFLAVORED shared signals that every
  // vehicle publishes, so they belong to CAN_MAP's side of the coverage check, not this one.
  // node_health rides the per-node NodeStatus.health, and node_online is what decides WHICH nodes
  // publish at all - so it is carried by the absence of frames rather than by a field, which is
  // how a real listener learns it. mode_actual and failsafe are read into the tab's mode triple:
  // neither is a DroneCAN message (the bus carries a degraded mode's CONSEQUENCE), and claiming
  // them is the same statement the ArmingStatus/BLOCKED note makes.
  signals: ['esc_rpm', 'esc_current', 'esc_temp', 'esc_fault', 'armed',
            'pack_current', 'soc', 'pack_temp', 'agl', 'sats', 'fix_type', 'hdop',
            'arming_state', 'prearm_fail', 'node_health', 'node_online',
            'mode_actual', 'failsafe',
            // Contract v30. hardpoint_state and payload_weight are the two fields of
            // hardpoint.Status; the gimbal pair is camera_gimbal.Status's orientation resolved
            // back to Euler; static_press and oat are air_data's own fields.
            'hardpoint_state', 'payload_weight',
            'gimbal_pitch_actual', 'gimbal_yaw_actual', 'static_press', 'oat'],
  unpackable: {
    rotor_rpm: 'the mean of the four esc_rpm values; esc.Status has no field for a fleet average',
    baro_alt: 'a SOLVED altitude, and air_data carries no altitude field because a barometer does not measure one - it measures a pressure. static_press IS that pressure and is packed, so a listener solves its own altitude out of it under its own QNH, which is exactly the disagreement this signal group exists to teach',
    home_dist: 'derived flight-controller state - the horizontal distance to the position the craft armed at. DroneCAN has no message carrying it, so it is a readout in the tab and may honestly stay one forever',
  },
  pack: dcPackCarlito,
});

// ── SERVICES ──────────────────────────────────────────────────────────────────
// Everything above this line is one-way: a node decides something is worth publishing and
// publishes it, and a listener either heard it or did not. A SERVICE is the other shape - a
// question addressed to one node, and that node's answer addressed back. It is a bus concept
// and NOT a game-state concept, which is why none of it touched the contract: what these
// services talk about is the roster this module already declares and the status those nodes
// already publish, so the answers were on the wire all along, one field at a time, forever.
//
// Both halves live here. The SERVER stands in for the eight roster nodes; the CLIENT is the bar
// in the tab, a maintenance tool at node 127. They talk over the bus rather than through a
// function call - a request really is transmitted and really does come back through
// ingestFrame - so the transfer log shows the whole exchange the way a real one looks.

// The tool's own node id. DroneCAN reserves the top two ids for exactly this: the Allocation
// DSDL says an allocator must skip "126 and 127, that are reserved for network maintenance
// tools", so claiming one is not squatting, it is what they are for.
const DC_TOOL_NODE = 127;
// A response is expected within this long. Nothing retries: on a bench bus a lost response is
// information, and a retry would paper over the node that stopped answering.
const DC_SVC_TIMEOUT_MS = 1500;
// A restarted node is OFF THE BUS for this long before it comes back with uptime 0. That is not
// theatre - it is what a reboot IS, and a RestartNode whose only visible effect was a counter
// resetting would teach that a restart is a number rather than an absence.
const DC_REBOOT_MS = 1600;

// Per roster index. `statusPeriodMs` is a real, writable parameter: it is the period this
// module publishes that node's NodeStatus at, so setting it past the 3 s staleness threshold
// really does make the row go silent while its neighbours stay green.
const DC_NS_PERIOD_MS = 1000;                  // the DSDL's own recommended heartbeat period
const dcNodeParams = DC_ROSTER.map(() => ({ statusPeriodMs: DC_NS_PERIOD_MS }));
const dcRebootAt = [];                         // per roster index: when a restart took it off the bus
const dcNsLastAt = [];                         // per roster index: last NodeStatus published

// Node identity, for GetNodeInfo. NOT INVENTED, in the sense that matters: every field is either
// a real property of this module's model of that node or a DSDL "unknown" constant.
//   - the name is the roster's, in DSDL's own reversed-domain style (it asks for lowercase
//     ASCII, dots, dashes and underscores, and rejects nothing else here);
//   - the unique id is DERIVED FROM THE NODE ID by a fixed rule rather than randomised, because
//     a unique id that changed every reload is not a unique id - it is the one field a real
//     node burns in at manufacture and never changes again;
//   - hardware and software version are this module's own version numbers, which are the only
//     versions there are to report;
//   - vcs_commit and image_crc are left at zero WITH THEIR FLAG BITS CLEAR, which is DSDL's way
//     of saying "not known" for a field that has no NaN. Setting a flag and a zero would claim
//     a build identity that does not exist.
const DC_SW_MAJOR = 1, DC_SW_MINOR = 0;
const DC_HW_MAJOR = 1, DC_HW_MINOR = 0;
function dcNodeName(i) { return 'org.sloppycan.carlito.' + DC_ROSTER[i].name.toLowerCase(); }
function dcUniqueId(i) {
  // A stable 16-byte id: a fixed prefix that says which fleet this is, then the node id, then a
  // simple mix so two nodes do not differ in one byte. Deterministic on purpose - see above.
  const id = DC_ROSTER[i].id & 0x7F;
  const u = [0x53, 0x43, 0x41, 0x4E];           // 'SCAN'
  for (let k = 0; k < 12; k++) u.push((id * 31 + k * 17 + 0x5A) & 0xFF);
  return u;
}

// The parameters each node exposes. EVERY ONE IS A REAL PROPERTY OF THIS MODULE - there is no
// pretend parameter store behind them, because a GetSet that wrote into a private object nobody
// reads would be a form with no building attached. Two are read-only reflections of things the
// roster declares, and the DSDL already says what to do about a write it will not honour: the
// response "should contain the actual parameter value after the set request was executed... to
// let the client know if the value could not be updated", so a rejected write answers with the
// unchanged value and the client sees it did not take.
function dcNodeParamDefs(i) {
  const defs = [
    { name: 'uavcan.node.id', get: () => DC_ROSTER[i].id, min: 1, max: 127, def: DC_ROSTER[i].id },
    { name: 'uavcan.node.status_period_ms',
      get: () => dcNodeParams[i].statusPeriodMs,
      set: (v) => { dcNodeParams[i].statusPeriodMs = Math.max(100, Math.min(10000, Math.round(v))); },
      min: 100, max: 10000, def: DC_NS_PERIOD_MS },
  ];
  // An ESC additionally reports which of the four it is - the index it stamps into every
  // esc.Status. Read-only for the same reason the node id is: DC_ROSTER is the ONE place an id
  // is declared, and a parameter that could move it would be a second place.
  if (i < DC_ESC_COUNT) defs.push({ name: 'esc.index', get: () => i, min: 0, max: 15, def: i });
  return defs;
}

// A node is answerable when it is PUBLISHING - read off its own decoded NodeStatus, the same
// fact and the same freshness the roster view reads. A node taken off the bus by node_fail, or
// one in its reboot window, or a whole aircraft that is not on the link, answers NOTHING. That
// silence is the reading: a request that goes unanswered is how you learn a node is gone, and
// putting a response in its place would be inventing the node back.
function dcNodeLive(i) {
  const n = dcNodes.get(DC_ROSTER[i].id);
  if (!n || !n.nsAt) return false;
  if (Date.now() - n.nsAt > DC_NODE_STALE_MS) return false;
  return !(dcRebootAt[i] && Date.now() - dcRebootAt[i] < DC_REBOOT_MS);
}
const dcRosterIndexOf = (nodeId) => DC_ROSTER.findIndex(r => r.id === nodeId);

// Everything the service layer puts on the wire goes through the SAME gateway carlito.js's
// telemetry rides - ingested once for the decoders and transmitted when a bus is open. It is
// deferred by a tick rather than emitted inside ingestFrame: a node answers a moment after it is
// asked, not inside the same call stack, and the deferral keeps the re-entrancy depth at one.
function dcEmit(frames) {
  if (!frames || !frames.length) return;
  setTimeout(() => {
    for (const f of frames) {
      const fr = { id: f.id, isExt: true, isRtr: false, dlc: f.data.length, data: f.data };
      if (window.canForward) window.canForward(fr);
      else if (window.ingestFrame) window.ingestFrame(fr);
    }
  }, 0);
}

// ── The server ────────────────────────────────────────────────────────────────
function dcServeRequest(done) {
  const i = dcRosterIndexOf(done.destNode);
  if (i < 0 || !dcNodeLive(i)) return;          // not one of ours, or not on the bus - silence
  const svc = DC_SVCS[done.svcTypeId];
  if (!svc) return;                              // a service this node does not implement
  const reply = (payload) =>
    // The request's OWN transfer id and priority, echoed - see dcSvcTransfer.
    dcEmit(dcSvcTransfer(svc, false, done.destNode, done.srcNode, payload, done.tid, done.priority));

  if (svc.id === 1) {                            // GetNodeInfo
    const n = dcNodes.get(DC_ROSTER[i].id);
    reply(dcEncode(svc.resp, {
      // Straight out of the roster and the node's own last heartbeat. The uptime is the one this
      // module is publishing for that node, so a restart shows here first.
      uptime_sec: dcNodeUpAt[i] ? Math.floor((Date.now() - dcNodeUpAt[i]) / 1000) : 0,
      health: (n && n.health != null) ? n.health : 0,
      mode: 0,
      sub_mode: 0,
      vendor_specific_status_code: 0,
      sw_major: DC_SW_MAJOR, sw_minor: DC_SW_MINOR,
      sw_optional_field_flags: 0,               // neither vcs_commit nor image_crc is known
      sw_vcs_commit: 0, sw_image_crc_lo: 0, sw_image_crc_hi: 0,
      hw_major: DC_HW_MAJOR, hw_minor: DC_HW_MINOR,
      unique_id: dcUniqueId(i),
      coa_len: 0,                                // no certificate of authenticity
      name: dcNodeName(i),
    }));
    return;
  }

  if (svc.id === 5) {                            // RestartNode
    const q = dcDecode(svc.req, done.payload);
    const ok = q.magic_number === DC_RESTART_MAGIC;
    reply(dcEncode(svc.resp, { ok: ok ? 1 : 0 }));
    if (!ok) return;
    // Answer first, THEN go away - which is the order a real node does it in, and the reason the
    // ok=true is not a lie about a node that is about to stop talking.
    dcRebootAt[i] = Date.now();
    dcNodeUpAt[i] = 0;                           // its clock restarts when it comes back
    dcNsLastAt[i] = 0;
    dcTab.markDirty();
    return;
  }

  if (svc.id === 11) {                           // param.GetSet
    const q = dcGetSetDecodeReq(done.payload);
    const defs = dcNodeParamDefs(i);
    // Name beats index whenever it is non-empty - the DSDL says so outright.
    const def = q.name ? defs.find(d => d.name === q.name) : defs[q.index];
    if (!def) {
      // "Empty name (and/or empty value) in response indicates that there is no such parameter."
      // That IS the end-of-list marker an index walk stops on; there is no count to ask for.
      reply(dcGetSetEncodeResp({ value: dcValEmpty(), defaultValue: dcValEmpty(),
                                 maxValue: { kind: DC_NUM_EMPTY }, minValue: { kind: DC_NUM_EMPTY }, name: '' }));
      return;
    }
    // A set request carries a non-empty value. A read-only parameter simply does not apply it,
    // and the response reports the value that IS there - see dcNodeParamDefs.
    if (q.value && q.value.kind !== DC_VAL_EMPTY && def.set) def.set(Number(q.value.v));
    reply(dcGetSetEncodeResp({
      value: dcValInt(def.get()),
      defaultValue: dcValInt(def.def),
      maxValue: dcNumInt(def.max),
      minValue: dcNumInt(def.min),
      name: def.name,
    }));
    dcTab.markDirty();
    return;
  }
}
// uint40 MAGIC_NUMBER = 0xACCE551B1E, straight off the DSDL. Written as a decimal because a
// 40-bit hex literal is fine in JavaScript but the comparison below is against a number the bit
// reader produced, and 0xACCE551B1E is exactly representable either way.
const DC_RESTART_MAGIC = 0xACCE551B1E;

// ── Service results, for the tab ──────────────────────────────────────────────
const dcSvcPending = new Map();   // 'svc:dest:tid' -> { ts, kind, dest }
const dcNodeInfo = new Map();     // node id -> the decoded GetNodeInfo response
const dcNodeParamsSeen = new Map(); // node id -> [{ name, value, min, max, def }]
let dcSvcNote = '';               // one line of "what just happened", for the pane

function dcSvcIngest(done, id, now) {
  const svc = DC_SVCS[done.svcTypeId];
  const key = `${done.svcTypeId}:${done.srcNode}:${done.tid}`;
  let summary = '', name = svc ? svc.short : ('service ' + done.svcTypeId);
  name += done.isRequest ? ' req' : ' resp';

  if (svc && done.crcOk !== false) {
    try {
      if (svc.id === 11) {
        summary = done.isRequest ? dcGetSetReqSummary(dcGetSetDecodeReq(done.payload))
                                 : dcGetSetRespSummary(dcGetSetDecodeResp(done.payload));
      } else {
        const half = done.isRequest ? svc.req : svc.resp;
        summary = half.fields.length ? dcSummary(half, dcDecode(half, done.payload)) : '(empty)';
      }
    } catch (e) { summary = 'decode failed'; }
  }

  // A request addressed to a roster node is answered by the server; one addressed to the tool is
  // an answer to something the tool asked.
  if (done.isRequest) {
    dcServeRequest(done);
  } else if (dcSvcPending.has(key)) {
    const p = dcSvcPending.get(key);
    dcSvcPending.delete(key);
    dcSvcResolve(svc, done, p);
  }

  dcTab.pushLog({
    ts: now, id: id >>> 0,
    node: done.srcNode,
    dtid: done.svcTypeId,
    name: name + ' →' + done.destNode,
    known: !!svc,
    frames: done.frames,
    bad: done.crcOk === false || !!done.error,
    crcOk: done.crcOk,
    data: done.payload,
    summary,
    escIndex: null,
  });
  dcTab.markDirty();
}

function dcSvcResolve(svc, done, pending) {
  if (!svc) return;
  if (svc.id === 1) {
    const v = dcDecode(svc.resp, done.payload);
    v.nameText = dcAscii(v.name);
    v.uidHex = dcHexJoin(v.unique_id);
    dcNodeInfo.set(done.srcNode, v);
    dcSvcNote = `GetNodeInfo from node ${done.srcNode}: ${v.nameText}`;
  } else if (svc.id === 5) {
    const v = dcDecode(svc.resp, done.payload);
    dcSvcNote = v.ok ? `node ${done.srcNode} accepted the restart - watch its row go silent, then come back at uptime 0`
                     : `node ${done.srcNode} REJECTED the restart (wrong magic number)`;
  } else if (svc.id === 11) {
    const a = dcGetSetDecodeResp(done.payload);
    const list = dcNodeParamsSeen.get(done.srcNode) || [];
    if (!a.name && a.value.kind === DC_VAL_EMPTY) {
      dcSvcNote = `node ${done.srcNode}: ${list.length} parameter${list.length === 1 ? '' : 's'} enumerated`;
    } else {
      const at = list.findIndex(x => x.name === a.name);
      const row = { name: a.name, value: a.value, def: a.defaultValue, min: a.minValue, max: a.maxValue };
      if (at >= 0) list[at] = row; else list.push(row);
      dcNodeParamsSeen.set(done.srcNode, list);
      dcSvcNote = `node ${done.srcNode}: ${a.name} = ${dcValueText(a.value)}`;
      // Walk on. The DSDL is clear that index access is ONLY for enumerating, so the client asks
      // for index+1 and stops at the nameless answer rather than asking for a count that does
      // not exist. One request in flight at a time, which is also why this chains off the reply.
      if (pending && pending.walk != null) dcParamRequest(done.srcNode, pending.walk + 1, null, '', pending.walk + 1);
    }
  }
  dcTab.markDirty();
}

// ── The client ────────────────────────────────────────────────────────────────
function dcSendRequest(svcId, destNode, payload, extra) {
  const svc = DC_SVCS[svcId];
  if (!svc) return;
  const tid = dcNextTid('svc' + svcId + ':' + DC_TOOL_NODE + ':' + destNode);
  dcSvcPending.set(`${svcId}:${destNode}:${tid}`, Object.assign({ ts: Date.now(), dest: destNode }, extra || {}));
  dcEmit(dcSvcTransfer(svc, true, DC_TOOL_NODE, destNode, payload, tid));
  // Expire rather than retry - an unanswered request is the reading, not a transport problem.
  setTimeout(() => {
    const k = `${svcId}:${destNode}:${tid}`;
    if (!dcSvcPending.has(k)) return;
    dcSvcPending.delete(k);
    dcSvcNote = `no answer from node ${destNode} - it is not on the bus`;
    dcTab.markDirty();
  }, DC_SVC_TIMEOUT_MS);
}
function dcParamRequest(destNode, index, value, name, walk) {
  dcSendRequest(11, destNode, dcGetSetEncodeReq(index, value || dcValEmpty(), name || ''), { walk });
}

function dcSelectedNode() {
  const el = document.getElementById('dcSvcNode');
  const v = el ? parseInt(el.value, 10) : NaN;
  return Number.isFinite(v) ? v : DC_ROSTER[0].id;
}
function dronecanGetNodeInfo() {
  const node = dcSelectedNode();
  dcSvcNote = `asking node ${node} who it is...`;
  dcSendRequest(1, node, []);            // an empty request: the question IS the id
  dcTab.markDirty(); dcTab.render();
}
function dronecanReadParams() {
  const node = dcSelectedNode();
  dcNodeParamsSeen.delete(node);
  dcSvcNote = `enumerating node ${node}'s parameters by index...`;
  dcParamRequest(node, 0, null, '', 0);
  dcTab.markDirty(); dcTab.render();
}
function dronecanRestartNode() {
  const node = dcSelectedNode();
  dcSvcNote = `asking node ${node} to restart...`;
  dcSendRequest(5, node, dcEncode(DC_SVCS[5].req, { magic_number: DC_RESTART_MAGIC }));
  dcTab.markDirty(); dcTab.render();
}
// The same request with the magic number one short, so the rejection can be seen rather than
// taken on trust. A guard nobody has watched refuse anything is a guard nobody has tested.
function dronecanRestartBadMagic() {
  const node = dcSelectedNode();
  dcSvcNote = `asking node ${node} to restart with a WRONG magic number...`;
  dcSendRequest(5, node, dcEncode(DC_SVCS[5].req, { magic_number: DC_RESTART_MAGIC - 1 }));
  dcTab.markDirty(); dcTab.render();
}
// Write the one writable parameter, from the box beside the buttons. Sending a value is what
// makes it a SET; sending an empty one is a get, which is what every button above does.
function dronecanSetPeriod() {
  const node = dcSelectedNode();
  const el = document.getElementById('dcSvcPeriod');
  const v = el ? parseInt(el.value, 10) : NaN;
  if (!Number.isFinite(v)) return;
  dcSvcNote = `setting node ${node}'s NodeStatus period to ${v} ms...`;
  dcParamRequest(node, 0, dcValInt(v), 'uavcan.node.status_period_ms');
  dcTab.markDirty(); dcTab.render();
}

// ── DYNAMIC NODE ID ALLOCATION ────────────────────────────────────────────────
// The one protocol here that has to work before anything else does. Every id in DC_ROSTER is
// declared - somebody sat down and decided the GNSS node is 20 - and that is fine for eight
// nodes on one airframe and untenable the moment a fleet shares parts. So DroneCAN defines a way
// for a node with NO id to ask for one, over a bus whose addressing is built out of node ids.
//
// The trick is the anonymous frame (dcAnonId above): source node id 0, and 14 bits of random
// DISCRIMINATOR where the message type id would have been, purely so two nodes asking at the
// same instant do not transmit byte-identical frames and annihilate each other under CAN
// arbitration. What is left is six bytes of payload per request - hence the DSDL's own
// MAX_LENGTH_OF_UNIQUE_ID_IN_REQUEST = 6, and hence the whole three-stage dance: a 16-byte
// unique id does not fit in one anonymous frame, so it is sent six bytes at a time, and the
// allocator echoes back what it has so the allocatee knows how much got through.
//
// BOTH ENDS ARE HERE AND THEY TALK OVER THE BUS. The allocator answers any allocatee; the bench
// allocatee (the button) is a real node emitting real anonymous frames that come back through
// ingestFrame. Neither can see the other's variables, which is the only way the exchange in the
// transfer log is the actual protocol rather than a re-enactment of it.
const DC_ALLOC = DC_MSGS[1];
const DC_UID_LEN = 16;
const DC_UID_CHUNK = 6;              // MAX_LENGTH_OF_UNIQUE_ID_IN_REQUEST
const DC_FOLLOWUP_TIMEOUT_MS = 500;  // FOLLOWUP_TIMEOUT_MS - the allocator forgets a stalled request
const DC_MAX_FOLLOWUP_DELAY_MS = 400;// MAX_FOLLOWUP_DELAY_MS, the allocatee's randomised wait
// 126 and 127 are reserved for maintenance tools, so the search stops at 125 - the DSDL spells
// out the whole algorithm, including that an allocatee with no preference gets the HIGHEST free
// id rather than the lowest, which keeps dynamic ids out of the way of declared ones.
const DC_ALLOC_MAX_ID = 125;

const dcAllocTable = new Map();      // unique id (hex) -> granted node id
let dcAllocSession = null;           // { uid: [bytes], ts } - one at a time, per the DSDL
const dcAllocLog = [];               // what the allocator did, for the pane
const DC_ALLOC_LOG_MAX = 12;

function dcAllocOccupied() {
  const set = new Set(DC_ROSTER.map(r => r.id));
  set.add(dcCfg.fcNode & 0x7F);
  set.add(DC_TOOL_NODE);
  for (const v of dcAllocTable.values()) set.add(v);
  return set;
}
// The DSDL's own pseudocode, transcribed: search UP from the preferred id (or 125 when there is
// no preference), then DOWN from it, and report failure rather than handing out a duplicate.
function dcAllocFindFree(preferred) {
  const busy = dcAllocOccupied();
  // The preference is CLAMPED to 125 first. node_id is a uint7, so an allocatee is free to ask
  // for 126 or 127 - and the downward search would have handed one over, because the reserved
  // pair is reserved by convention rather than by being in the occupied set. Clamping is what
  // makes "except 126 and 127" true of both directions rather than only the upward one.
  const pref = Math.min(Math.max(preferred | 0, 0), DC_ALLOC_MAX_ID);
  let c = pref > 0 ? pref : DC_ALLOC_MAX_ID;
  while (c <= DC_ALLOC_MAX_ID) { if (!busy.has(c)) return c; c++; }
  c = pref > 0 ? pref : DC_ALLOC_MAX_ID;
  while (c > 0) { if (!busy.has(c)) return c; c--; }
  return -1;
}
function dcAllocSay(text) {
  dcAllocLog.push({ ts: Date.now(), text });
  while (dcAllocLog.length > DC_ALLOC_LOG_MAX) dcAllocLog.shift();
  dcTab.markDirty();
}
// The allocator's own reply: a NON-anonymous Allocation from the allocator node, carrying the
// unique-id bytes it has accumulated. node_id is 0 while the id is still incomplete and the
// granted id once it is - which is the entire signalling protocol, in one field.
function dcAllocReply(nodeId, uid) {
  dcEmit(dcTransfer(DC_ALLOC, dcCfg.fcNode & 0x7F, dcEncode(DC_ALLOC, {
    node_id: nodeId & 0x7F,
    first_part_of_unique_id: 0,       // meaningless from a non-anonymous source; the DSDL says zero it
    unique_id: uid,
  })));
}

function dcAnonIngest(done, id, now) {
  let summary = '', v = null;
  try { v = dcDecode(DC_ALLOC, done.payload); summary = dcSummary(DC_ALLOC, v); } catch (e) { summary = 'decode failed'; }

  dcTab.pushLog({
    ts: now, id: id >>> 0, node: 0, dtid: DC_ALLOC.id,
    name: 'Allocation (anonymous)', known: true,
    frames: done.frames, bad: !!done.error, crcOk: done.crcOk,
    data: done.payload, summary, escIndex: null,
  });

  if (!v) return;
  const chunk = v.unique_id || [];
  if (v.first_part_of_unique_id) {
    dcAllocSession = { uid: chunk.slice(0, DC_UID_CHUNK), ts: now };
    dcAllocSay(`stage 1: a node with no id offered ${chunk.length} bytes of unique id (preferred id ${v.node_id || 'any'})`);
  } else {
    // A follow-up with no session, or one that arrived after the allocator gave up, is dropped -
    // the allocatee's own Request Timer will start it over, which is what that timer is for.
    if (!dcAllocSession || now - dcAllocSession.ts > DC_FOLLOWUP_TIMEOUT_MS) {
      dcAllocSay('a follow-up arrived with no live request - ignored (the allocatee will start over)');
      dcAllocSession = null;
      return;
    }
    dcAllocSession.uid = dcAllocSession.uid.concat(chunk).slice(0, DC_UID_LEN);
    dcAllocSession.ts = now;
    dcAllocSay(`follow-up: ${dcAllocSession.uid.length} of ${DC_UID_LEN} unique-id bytes received`);
  }
  const uid = dcAllocSession.uid;
  if (uid.length < DC_UID_LEN) { dcAllocReply(0, uid); return; }   // echo what we have, grant nothing yet

  const hexUid = dcHexJoin(uid);
  let granted = dcAllocTable.get(hexUid);
  if (granted == null) {
    granted = dcAllocFindFree(v.node_id | 0);
    if (granted < 0) { dcAllocSay('the allocation table is full - no free node id'); dcAllocSession = null; return; }
    dcAllocTable.set(hexUid, granted);
  }
  // The same unique id asked twice gets the SAME id back, which is the property that makes this
  // survivable: a node that reboots mid-flight rejoins as itself rather than as a new device.
  dcAllocReply(granted, uid);
  dcAllocSay(`granted node id ${granted} to ${hexUid}`);
  dcAllocSession = null;
}

// ── The bench allocatee ───────────────────────────────────────────────────────
// A pretend device with a unique id and no node id, driven by the rules in the DSDL: send the
// first six bytes, wait, send the next six when the allocator echoes back what it heard, and
// stop when a grant with the full id comes past. It reads the allocator's replies OFF THE BUS,
// so it is subject to everything a real one is.
let dcAllocatee = null;   // { uid: [16], sent, timer }
function dcAllocateeSend() {
  if (!dcAllocatee) return;
  const off = dcAllocatee.sent;
  const chunk = dcAllocatee.uid.slice(off, off + DC_UID_CHUNK);
  dcEmit(dcAnonTransfer(DC_ALLOC, dcEncode(DC_ALLOC, {
    node_id: 0,                                // ANY_NODE_ID: no preference, so it will be handed 125
    first_part_of_unique_id: off === 0 ? 1 : 0,
    unique_id: chunk,
  })));
}
function dronecanRequestAllocation() {
  // A fresh unique id each time, because each click is a different device being plugged in. This
  // is the ONE place in this module a random number is right: a unique id that is not unique is
  // not a unique id, and the allocator keys its table on it.
  const uid = [];
  for (let k = 0; k < DC_UID_LEN; k++) uid.push(Math.floor(Math.random() * 256));
  dcAllocatee = { uid, sent: 0 };
  dcAllocSay(`a new device (${dcHexJoin(uid)}) is asking for a node id`);
  dcAllocateeSend();
  dcTab.markDirty(); dcTab.render();
}
// Rule D / rule E, off the allocator's non-anonymous replies.
function dcAllocateeHeard(v) {
  if (!dcAllocatee) return;
  const heard = v.unique_id || [];
  const mine = dcAllocatee.uid;
  // Only ours: the reply must be a PREFIX of our unique id, or it is another node's exchange.
  for (let k = 0; k < heard.length; k++) if (heard[k] !== mine[k]) return;
  if (heard.length >= DC_UID_LEN && v.node_id) {
    dcAllocSay(`the device accepted node id ${v.node_id} and stopped asking`);
    dcAllocatee = null;
    return;
  }
  dcAllocatee.sent = heard.length;
  if (dcAllocatee.sent >= DC_UID_LEN) return;
  // Tfollowup: a randomised wait in [MIN_FOLLOWUP_DELAY_MS, MAX_FOLLOWUP_DELAY_MS), during which
  // a real allocatee listens and abandons its follow-up if it hears anyone else. Randomised
  // rather than fixed for the same reason the discriminator is random - so two devices that
  // started together do not stay in lockstep.
  setTimeout(dcAllocateeSend, Math.floor(Math.random() * DC_MAX_FOLLOWUP_DELAY_MS));
}


function dronecanClear() {
  dcNodes.clear();
  dcRx.asm.clear();
  dcRx.err.crc = dcRx.err.toggle = dcRx.err.tid = dcRx.err.orphan = 0;
  dcTxCount = 0; dcLastTx = 0; dcArm = null; dcFlight = null;
  // Bus state, all of it: the per-node uptime clocks and the heartbeat sweep. dcFailMask and
  // dcCtl deliberately survive - they are operator intent, not something the bus told us.
  dcNodeUpAt.length = 0; dcNsLastAt.length = 0; dcRebootAt.length = 0; dcCmdPending = null;
  // The service and allocation layers are bus state too - what a node answered, and which ids
  // have been handed out, are both things this side learned FROM the bus rather than decided.
  // The per-node parameters survive for the same reason dcFailMask does: a period somebody set
  // is operator intent. dcAllocatee survives nothing - an allocatee mid-handshake on a bus that
  // just went away has no handshake left.
  dcSvcPending.clear(); dcNodeInfo.clear(); dcNodeParamsSeen.clear();
  dcAllocTable.clear(); dcAllocLog.length = 0; dcAllocSession = null; dcAllocatee = null;
  dcSvcNote = '';
  dcTab.clearLog();
}

function dronecanStop() { dcDemoStop(); }

// ── Demo ──────────────────────────────────────────────────────────────────────
// Synthesises a hovering quad and pushes it through the SAME encoder, so demo mode
// exercises the real encode -> reassemble -> decode path with no hardware and no game.
let dcDemoTimer = null;
function dcDemoStart() {
  dcDemoStop();
  const t0 = Date.now();
  dcDemoTimer = setInterval(() => {
    if (!window.ingestFrame) return;
    const s = (Date.now() - t0) / 1000;
    const base = 6500 + 300 * Math.sin(s * 0.7);
    const lean = 900 * Math.sin(s * 0.31);           // front/back split
    const yaw  = 500 * Math.sin(s * 0.19);           // counter-rotating diagonals
    const rpm = [base + lean + yaw, base + lean - yaw, base - lean - yaw, base - lean + yaw];
    const amps = rpm.map(r => 15 + (r - 6500) / 60);
    const temp = amps.map(a => 20 + a * 0.9);
    const fault = temp.reduce((m, c, i) => c > 90 ? (m | (1 << i)) : m, 0);
    const packA = amps.reduce((a, b) => a + b, 0) + 1.5;   // + the avionics draw, as the game does
    const soc = Math.max(0, 100 - s * 0.17);
    // A slow orbit over the Paris origin, drifting in and out of a satellite shadow so the
    // Fix2 payload, sats and hdop all move; agl dips to the -1 sentinel once a lap so the
    // range sensor's UNDEFINED branch is exercised too.
    const sats = Math.max(0, Math.round(9 + 7 * Math.sin(s * 0.23)));
    // The GNSS node off the bus for part of each lap, on its own phase (the agl sentinel below is
    // the RANGE node's business and they are different nodes).
    const gnssDown = Math.sin(s * 0.09) < -0.9;
    const needFix = dcCtl.mode === 2 || dcCtl.mode === 3;   // LOITER / RTL want a position fix
    const alt = 40 + 12 * Math.sin(s * 0.11);
    for (const f of dcBuildFrames({
      esc_rpm: rpm, esc_current: amps, esc_temp: temp, esc_fault: fault,
      battery: 16.8 - 0.042 * (100 - soc), armed: true,
      pack_current: packA, soc: soc, pack_temp: 20 + packA * 0.12,
      lat: 48.8566 + 0.0004 * Math.sin(s * 0.13), lon: 2.3522 + 0.0004 * Math.cos(s * 0.13),
      altitude: alt, sats: sats, fix_type: sats >= 4 ? 3 : (sats >= 3 ? 2 : (sats ? 1 : 0)),
      hdop: sats >= 4 ? 0.9 + 6 / Math.max(1, sats) : 10,
      agl: Math.sin(s * 0.13) < -0.95 ? -1 : alt - 8,
      pitch: 6 * Math.sin(s * 0.31), roll: -12 * Math.sin(s * 0.19),
      roll_rate: 0.4 * Math.cos(s * 0.19), pitch_rate: 0.3 * Math.cos(s * 0.31),
      yaw: 0.5 * Math.sin(s * 0.07),
      accLong: 1.5 * Math.sin(s * 0.41), accLat: 0.8 * Math.cos(s * 0.29),
      acc_vert: 0.6 * Math.sin(s * 0.17),
      arming_state: 2, prearm_fail: 0,
      // The GNSS node drops off the bus for part of each lap, which is what makes Demo mode
      // exercise the whole of this phase with no game attached: its Fix2 frames stop and its
      // roster row goes silent, and if LOITER or RTL is selected in the bar the mode degrades to
      // ALT HOLD with failsafe GPS_LOST - the readings the aircraft gives when it is killed for
      // real. The synthesised mode_actual otherwise follows the selector, so an idle demo shows
      // agreement rather than a disagreement nothing caused.
      node_online: gnssDown ? (DC_ALL_ONLINE & ~(1 << DC_I_GNSS)) : DC_ALL_ONLINE,
      node_health: DC_ROSTER.map((_, i) =>
        (gnssDown && i === DC_I_GNSS) ? 3 : (((fault >> i) & 1) ? 1 : 0)),
      mode_actual: (gnssDown && needFix) ? 1 : dcCtl.mode,
      failsafe: (gnssDown && needFix) ? 3 : 0,
      home_dist: 40 + 30 * Math.abs(Math.sin(s * 0.13)),
      // The cargo hook, picked up and put down once a lap so hardpoint.Status is exercised in
      // BOTH states rather than sitting empty: the weight follows the latch, in NEWTON.
      hardpoint_state: Math.sin(s * 0.05) > 0,
      payload_weight: Math.sin(s * 0.05) > 0 ? 19.6 : 0,
      // The gimbal, panning and tilting on its own phases so the quaternion in gimbal.Status is
      // never the identity for long (an identity quaternion is exactly what a sign error looks
      // like when it is right).
      gimbal_pitch_actual: -30 + 30 * Math.sin(s * 0.17),
      gimbal_yaw_actual: 60 * Math.sin(s * 0.11),
      // The barometer, solved through the same ISA the game uses, with the demo's own altitude
      // and a slow QNH wander - so the pressure REALLY corresponds to the altitude beside it and
      // baro_alt really disagrees, rather than being two unrelated sines.
      static_press: (101325 + 100 * Math.sin(s * 0.026)) * Math.pow(1 - 0.0065 * alt / 288.15, 5.255876),
      oat: 15 - 0.0065 * alt,
    })) window.ingestFrame({ id: f.id, isExt: true, isRtr: false, dlc: f.data.length, data: f.data });
  }, 100);
}
function dcDemoStop() { if (dcDemoTimer) { clearInterval(dcDemoTimer); dcDemoTimer = null; } }

// ── Config ────────────────────────────────────────────────────────────────────
function dcClampNode(el, def) {
  if (!el) return def;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) ? Math.max(1, Math.min(127, v)) : def;
}
function dronecanCfgChange() {
  const en = document.getElementById('dcTxEnabled');
  if (en) dcCfg.txEnabled = !!en.checked;
  dcCfg.fcNode      = dcClampNode(document.getElementById('dcFcNode'), 1);
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dronecanOnShow();
}

// ── Controls ──────────────────────────────────────────────────────────────────
// RGB565 is the LightsCommand wire layout AND the contract's `led` low 16 bits, so one packed
// value feeds both. The picker is 24-bit and the wire is 5/6/5, so the round trip QUANTISES -
// a colour comes back a shade off, which is the LEDs' real resolution and not a rounding bug.
function dcRgb565FromHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xFF, g = (v >> 8) & 0xFF, b = v & 0xFF;
  return ((Math.round(r * 31 / 255) & 0x1F) << 11) | ((Math.round(g * 63 / 255) & 0x3F) << 5) | (Math.round(b * 31 / 255) & 0x1F);
}
function dcHexFromRgb565(c) {
  const r = Math.round(((c >> 11) & 0x1F) * 255 / 31);
  const g = Math.round(((c >> 5) & 0x3F) * 255 / 63);
  const b = Math.round((c & 0x1F) * 255 / 31);
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Read the three bench controls out of the bar. Only a CHANGE latches an indication command -
// see dcFlushCommands.
function dronecanCtlChange() {
  const md = document.getElementById('dcFlightMode');
  if (md) dcCtl.mode = parseInt(md.value, 10) || 0;

  const col = document.getElementById('dcLedColor');
  if (col) {
    const led = dcRgb565FromHex(col.value);
    if (led !== dcCtl.led) { dcCtl.led = led; (dcCmdPending = dcCmdPending || {}).led = led; }
  }
  const bp = document.getElementById('dcBeep');
  if (bp && !!bp.checked !== dcCtl.beep) {
    dcCtl.beep = !!bp.checked;
    (dcCmdPending = dcCmdPending || {}).beep = dcCtl.beep;
  }
  const hk = document.getElementById('dcHook');
  if (hk && !!hk.checked !== dcCtl.hook) {
    dcCtl.hook = !!hk.checked;
    (dcCmdPending = dcCmdPending || {}).hook = dcCtl.hook;
  }
  // The gimbal's two axes latch ONE command between them: an orientation is both angles, so
  // sending half of one is sending a lie about the other. Ranges come off the CONTRACT rather
  // than being typed here, the flight_mode-selector rule - the mount's stops and the signal's
  // range are one number, declared once.
  const gp = document.getElementById('dcGimbalPitch');
  const gy = document.getElementById('dcGimbalYaw');
  if (gp || gy) {
    const pitch = dcClampToRange('gimbal_pitch', gp ? parseFloat(gp.value) : dcCtl.gimbalPitch);
    const yaw = dcClampToRange('gimbal_yaw', gy ? parseFloat(gy.value) : dcCtl.gimbalYaw);
    if (pitch !== dcCtl.gimbalPitch || yaw !== dcCtl.gimbalYaw) {
      dcCtl.gimbalPitch = pitch;
      dcCtl.gimbalYaw = yaw;
      (dcCmdPending = dcCmdPending || {}).gimbal = { pitch: pitch, yaw: yaw };
    }
    dcGimbalReadout();
  }
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dcTab.markDirty();
}
// Clamp a value to a contract "in" signal's own declared range, rounded to the whole degrees the
// i8 on the wire carries. A signal with no range passes through - the contract is the authority
// on whether there is a stop, not this function.
function dcClampToRange(name, v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const sig = (window.CARLITO_CONTRACT ? window.CARLITO_CONTRACT.signals : [])
    .find(x => x.name === name && x.dir === 'in');
  const r = sig && sig.range;
  return (Array.isArray(r) && r.length === 2)
    ? Math.max(r[0], Math.min(r[1], Math.round(n))) : Math.round(n);
}
// Print the commanded angles beside their sliders. The mount's ACTUAL angles are separate
// signals and are read off the telemetry in the pane below - a slider showing where the camera
// IS would hide the slew, which is the whole reason there are two pairs of signals.
function dcGimbalReadout() {
  const out = document.getElementById('dcGimbalOut');
  if (out) out.textContent = `${dcCtl.gimbalPitch >= 0 ? '+' : ''}${dcCtl.gimbalPitch}\u00B0 / ` +
    `${dcCtl.gimbalYaw >= 0 ? '+' : ''}${dcCtl.gimbalYaw}\u00B0`;
}
function dronecanGimbalCentre() {
  const gp = document.getElementById('dcGimbalPitch');
  const gy = document.getElementById('dcGimbalYaw');
  if (gp) gp.value = '0';
  if (gy) gy.value = '0';
  dronecanCtlChange();
}
function dronecanLedOff() {
  const col = document.getElementById('dcLedColor');
  if (col) col.value = '#000000';
  if (dcCtl.led !== 0) { dcCtl.led = 0; (dcCmdPending = dcCmdPending || {}).led = 0; }
  if (window.dronecanScheduleSave) window.dronecanScheduleSave();
  dcTab.markDirty();
}
// Failure injection: flip one roster bit of node_fail. A bench SWITCH, not a DroneCAN message and
// not damage - which is why nothing here reports a fault; the node simply stops publishing and
// the game does the rest (an offline ESC's mixer command is forced to zero at the motor).
function dronecanToggleNodeFail(i) {
  if (!(i >= 0 && i < DC_ROSTER.length)) return;
  dcFailMask ^= (1 << i);
  dcTab.markDirty(); dcTab.render();
}

function dronecanOnShow() {
  const en = document.getElementById('dcTxEnabled');
  if (en) en.checked = dcCfg.txEnabled;
  // The service bar's node list comes off DC_ROSTER, never typed into the markup - the roster is
  // the ONE place a node id is declared, and a hand-written <option> would be a second.
  const sn = document.getElementById('dcSvcNode');
  if (sn && !sn.options.length) {
    sn.innerHTML = DC_ROSTER.map(r => `<option value="${r.id}">${r.id} ${dcEscHtml(r.name)}</option>`).join('');
  }
  const fc = document.getElementById('dcFcNode');
  if (fc) fc.value = dcCfg.fcNode;
  const md = document.getElementById('dcFlightMode');
  if (md) {
    // Positions and labels come off the CONTRACT's own enum table (built once), never retyped -
    // the same rule the mode_actual / failsafe readouts follow.
    if (!md.options.length) {
      md.innerHTML = dcEnumKeys('flight_mode', 'in')
        .map(k => `<option value="${k}">${dcEscHtml(dcEnumLabel('flight_mode', 'in', k))}</option>`).join('');
    }
    md.value = String(dcCtl.mode);
  }
  const col = document.getElementById('dcLedColor');
  if (col) col.value = dcHexFromRgb565(dcCtl.led);
  const bp = document.getElementById('dcBeep');
  if (bp) bp.checked = dcCtl.beep;
  const hk = document.getElementById('dcHook');
  if (hk) hk.checked = dcCtl.hook;
  // Slider bounds come off the CONTRACT's own ranges, never retyped - the same rule the flight
  // mode selector's options follow. A contract that moves a gimbal stop moves the slider with it.
  for (const [id, name] of [['dcGimbalPitch', 'gimbal_pitch'], ['dcGimbalYaw', 'gimbal_yaw']]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const sig = (window.CARLITO_CONTRACT ? window.CARLITO_CONTRACT.signals : [])
      .find(x => x.name === name && x.dir === 'in');
    if (sig && Array.isArray(sig.range) && sig.range.length === 2) {
      el.min = String(sig.range[0]);
      el.max = String(sig.range[1]);
    }
  }
  const gp = document.getElementById('dcGimbalPitch');
  if (gp) gp.value = String(dcCtl.gimbalPitch);
  const gy = document.getElementById('dcGimbalYaw');
  if (gy) gy.value = String(dcCtl.gimbalYaw);
  dcGimbalReadout();
  dcTab.markDirty(); dcTab.render();
}

// ── Render ────────────────────────────────────────────────────────────────────
function dcRenderTop() {
  const el = document.getElementById('dc-panes');
  if (!el) return;

  // ESC roster, from what has actually been decoded off the bus (ours included - the frames
  // we forward come straight back through ingestFrame, so this doubles as an encoder check).
  const escRows = [];
  for (const [node, n] of [...dcNodes.entries()].sort((a, b) => a[0] - b[0])) {
    if (!n.last || n.last.name !== 'esc.Status') continue;
    const v = n.last.vals;
    escRows.push(`<tr>
      <td class="dc-node">${v.esc_index}</td>
      <td>${node}</td>
      <td>${Math.round(v.rpm)}</td>
      <td>${Number.isFinite(v.current) ? v.current.toFixed(1) : '-'}</td>
      <td>${Number.isFinite(v.temperature) ? (v.temperature - 273.15).toFixed(1) : '-'}</td>
      <td>${Number.isFinite(v.voltage) ? v.voltage.toFixed(2) : '-'}</td>
      <td>${v.power_rating_pct}</td>
      <td><span class="dc-chip ${v.error_count ? 'warn' : 'ok'}">${v.error_count}</span></td>
    </tr>`);
  }
  const escTbl = escRows.length
    ? `<table class="dc-tbl"><thead><tr><th>esc_index</th><th>Node</th><th>RPM</th><th>A</th><th>°C</th><th>V</th><th>Pwr %</th><th>Errors</th></tr></thead><tbody>${escRows.join('')}</tbody></table>`
    : `<div class="dc-empty">No esc.Status decoded yet.<br>Fly the <b>drone</b> in the Carlito window, or press <b>Demo</b> with this tab open for a simulated quad - no hardware needed.</div>`;

  // ── The roster view ─────────────────────────────────────────────────────────
  // DRIVEN OFF THE DECODED NodeStatus TRAFFIC, never off the telemetry dict, and that is what
  // makes it a bus monitor rather than a second copy of the game's own node strip: a node going
  // quiet shows up AS SILENCE, which is how a real DroneCAN listener learns a node is gone. A
  // stale row is therefore the correct reading of a failed node - never red-but-live.
  const nowMs = Date.now();
  const rosterRows = DC_ROSTER.map((r, i) => {
    const n = dcNodes.get(r.id);
    const seen = n && n.nsAt;
    const stale = !seen || (nowMs - seen) > DC_NODE_STALE_MS;   // 3x the 1 Hz heartbeat
    const h = n && n.health != null ? n.health : null;
    const killed = (dcFailMask >> i) & 1;
    const rebooting = dcRebootAt[i] && (nowMs - dcRebootAt[i]) < DC_REBOOT_MS;
    const health = !seen ? '<span class="dc-chip off">never seen</span>'
      : stale ? '<span class="dc-chip off">silent</span>'
      : `<span class="dc-chip ${h ? 'warn' : 'ok'}">${h == null ? '-' : dcEscHtml(DC_HEALTH[h] || String(h))}</span>`;
    // uptime_sec straight out of the node's own last NodeStatus, which is the ONLY place a
    // restart is visible: the number goes backwards. Reading it off the decoded heartbeat rather
    // than off dcNodeUpAt keeps this a bus monitor - it shows what the node SAID, not what this
    // module knows it would have said.
    const upt = (n && n.uptime != null && !stale) ? n.uptime + ' s' : '-';
    // The publication period is a parameter a param.GetSet can write, so a row whose period has
    // been pushed past the staleness threshold says so - otherwise "silent" reads as a failure.
    const per = dcNodeParams[i].statusPeriodMs;
    const perNote = per !== DC_NS_PERIOD_MS ? ` <span class="dc-chip warn">${per} ms</span>` : '';
    const state = rebooting ? '<span class="dc-chip warn">restarting</span>'
      : killed ? '<span class="dc-chip warn">commanded off</span>'
      : '<span class="dc-chip off">on bus</span>';
    return `<tr onclick="dronecanToggleNodeFail(${i})" style="cursor:pointer" title="Click to take this node off the bus (contract node_fail bit ${i})">
      <td class="dc-node">${dcEscHtml(r.name)}</td>
      <td>${r.id}</td>
      <td>${health}</td>
      <td>${upt}${perNote}</td>
      <td class="dc-ts">${seen ? dcRelTs(seen) : '-'}</td>
      <td>${state}</td>
    </tr>`;
  }).join('');
  const rosterTbl = `<table class="dc-tbl"><thead><tr><th>Node</th><th>ID</th><th>Health</th><th>Uptime</th><th>Last seen</th><th>State</th></tr></thead><tbody>${rosterRows}</tbody></table>`;

  // ── The services pane ───────────────────────────────────────────────────────
  // What the roster ANSWERED, kept apart from what it publishes: a service response is not a
  // heartbeat, and a node that answered a question five seconds ago may be off the bus now. So
  // this is a record of exchanges, timestamped, rather than a live view of anything.
  const infoRows = [...dcNodeInfo.entries()].sort((a, b) => a[0] - b[0]).map(([node, v]) => `<tr>
      <td class="dc-node">${node}</td>
      <td class="dc-msg">${dcEscHtml(v.nameText)}</td>
      <td>${v.sw_major}.${v.sw_minor} / ${v.hw_major}.${v.hw_minor}</td>
      <td class="dc-raw">${dcEscHtml(v.uidHex)}</td>
      <td>${v.uptime_sec} s</td>
      <td><span class="dc-chip ${v.health ? 'warn' : 'ok'}">${dcEscHtml(DC_HEALTH[v.health] || String(v.health))}</span></td>
    </tr>`).join('');
  const infoTbl = infoRows
    ? `<table class="dc-tbl"><thead><tr><th>Node</th><th>Name</th><th>SW / HW</th><th>Unique ID</th><th>Uptime</th><th>Health</th></tr></thead><tbody>${infoRows}</tbody></table>`
    : '<div class="dc-empty">No node has been asked who it is yet.<br>Pick a node in the bar above and press <b>Get node info</b> - the request is an EMPTY transfer, and the answer is the widest one on this bus.</div>';

  const paramRows = [...dcNodeParamsSeen.entries()].sort((a, b) => a[0] - b[0]).flatMap(([node, list]) =>
    list.map((p, k) => `<tr>
      <td class="dc-node">${k ? '' : node}</td>
      <td class="dc-msg">${dcEscHtml(p.name)}</td>
      <td>${dcEscHtml(dcValueText(p.value))}</td>
      <td class="dc-raw">${dcEscHtml(dcValueText(p.def))}</td>
      <td class="dc-raw">${dcEscHtml(dcValueText(p.min))} … ${dcEscHtml(dcValueText(p.max))}</td>
    </tr>`)).join('');
  const paramTbl = paramRows
    ? `<table class="dc-tbl"><thead><tr><th>Node</th><th>Parameter</th><th>Value</th><th>Default</th><th>Range</th></tr></thead><tbody>${paramRows}</tbody></table>`
    : '<div class="dc-empty">No parameters read yet. <b>Read parameters</b> walks them by index until a nameless answer says there are no more - there is no count to ask for.</div>';

  const allocRows = [...dcAllocTable.entries()].map(([uid, id]) => `<tr>
      <td class="dc-node">${id}</td><td class="dc-raw">${dcEscHtml(uid)}</td>
    </tr>`).join('');
  const allocTbl = allocRows
    ? `<table class="dc-tbl"><thead><tr><th>Granted ID</th><th>Unique ID (16 bytes)</th></tr></thead><tbody>${allocRows}</tbody></table>`
    : '';
  const allocLog = dcAllocLog.length
    ? `<div class="dc-readout">${dcAllocLog.map(e => dcEscHtml(e.text)).join('<br>')}</div>`
    : '<div class="dc-empty">Nothing has asked for a node id yet.<br>The eight roster ids above are DECLARED - somebody decided the GNSS node is 20. <b>New node asks for an ID</b> plugs in a device that has only a 16-byte unique id, and it has to negotiate one over a bus whose addressing is built out of node ids.</div>';

  const svcHtml = `<div class="dc-readout">${dcSvcNote ? dcEscHtml(dcSvcNote) : 'A service is a question addressed to one node, and that node&#39;s answer addressed back - the only two-way traffic on this bus.'}</div>` +
    infoTbl + paramTbl;

  // ── The mode triple ─────────────────────────────────────────────────────────
  // THE PAIR IS THE POINT: a request and an actual mode that disagree is the reading, so the two
  // states must not look alike. Agreement is one plain chip; a disagreement grows an arrow and
  // turns the actual chip amber, and `failsafe` beside them says WHY - without it a LOITER that
  // dropped to ALT HOLD looks the same whether the receiver died or someone moved a switch.
  let modeHtml = '<div class="dc-empty">No flight mode yet - it arrives with the drone\'s telemetry.</div>';
  if (dcFlight) {
    const req = dcEnumLabel('flight_mode', 'in', dcFlight.req);
    const act = dcEnumLabel('mode_actual', 'out', dcFlight.actual);
    const agree = dcFlight.req === dcFlight.actual;
    const modeCell = agree
      ? `<span class="dc-chip ok">${dcEscHtml(act)}</span>`
      : `<span class="dc-chip">${dcEscHtml(req)}</span> <b style="color:var(--amber)">&rarr;</b> <span class="dc-chip warn">${dcEscHtml(act)}</span>`;
    const fs = dcEnumLabel('failsafe', 'out', dcFlight.fs);
    modeHtml = `<table class="dc-tbl"><tbody>
      <tr><td>${agree ? 'flight_mode' : 'flight_mode &rarr; mode_actual'}</td><td>${modeCell}${agree ? '' : ' <span style="color:var(--text3)">the flight controller is not flying what was asked for</span>'}</td></tr>
      <tr><td colspan="2" style="color:var(--text3)">The request is THIS BAR'S selector - with the Carlito window's Up link off it is not being sent, and the craft is flying whatever its own Z key selected.</td></tr>
      <tr><td>failsafe</td><td><span class="dc-chip ${dcFlight.fs ? 'warn' : 'off'}">${dcEscHtml(fs)}</span></td></tr>
      <tr><td>home_dist</td><td>${Number.isFinite(dcFlight.home) ? dcFlight.home.toFixed(1) + ' m' : '-'} <span style="color:var(--text3)">derived FC state - no DroneCAN message carries it</span></td></tr>
    </tbody></table>`;
  }

  const nodeRows = [...dcNodes.entries()].sort((a, b) => a[0] - b[0]).map(([node, n]) => `<tr>
      <td class="dc-node">${node}</td>
      <td class="dc-msg">${dcEscHtml([...n.msgs].join(', '))}</td>
      <td class="dc-ts">${dcRelTs(n.lastSeen)}</td>
    </tr>`).join('');
  const nodeTbl = nodeRows
    ? `<table class="dc-tbl"><thead><tr><th>Node</th><th>Messages</th><th>Last seen</th></tr></thead><tbody>${nodeRows}</tbody></table>`
    : '<div class="dc-empty">No DroneCAN nodes seen yet.</div>';

  // Arming, and the pre-arm readout that is the whole reason BLOCKED does not go on the wire.
  // A set prearm_fail bit is a FAILED check (0 = everything passes), and the seven names are
  // the contract's own, frozen in the same way `status` is - a new check appends at bit 7.
  // prearm_fail PUBLISHES 0 WHILE ARMED BY DESIGN, because a flying craft deflects its stick
  // and leans past ten degrees constantly and live bits would light STICK and ATTITUDE through
  // every manoeuvre. So "all checks pass" while airborne is the correct reading, not a decode
  // that has failed, and the readout says which of the two it is looking at.
  let armHtml = '<div class="dc-empty">No arming state yet - it arrives with the drone\'s telemetry.</div>';
  if (dcArm) {
    const state = DC_ARM_STATE[dcArm.state] || 'DISARMED';
    const cls = dcArm.state === 2 ? 'ok' : dcArm.state === 1 ? 'warn' : 'off';
    const bits = [];
    for (let i = 0; i < 16; i++) {
      if (!((dcArm.fail >> i) & 1)) continue;
      bits.push(DC_PREARM_BITS[i] || ('bit ' + i));
    }
    const checks = bits.length
      ? bits.map(b => `<span class="dc-chip warn">${dcEscHtml(b)}</span>`).join(' ')
      : `<span class="dc-chip ok">all checks pass</span>${dcArm.armed ? ' <span style="color:var(--text3)">(armed - the FC stops running pre-arm checks, so 0 is expected here)</span>' : ''}`;
    armHtml = `<table class="dc-tbl"><tbody>
      <tr><td>ArmingStatus on the wire</td><td class="dc-msg">${dcArm.armed ? 'FULLY_ARMED' : 'DISARMED'}</td></tr>
      <tr><td>arming_state (game)</td><td><span class="dc-chip ${cls}">${state}</span>${dcArm.state === 1 ? ' <span style="color:var(--text3)">the FC was asked to arm and refused - ArmingStatus has no field for this</span>' : ''}</td></tr>
      <tr><td>prearm_fail ${dcH(dcArm.fail, 4)}</td><td>${checks}</td></tr>
    </tbody></table>`;
  }

  const txState = !dcCfg.txEnabled
    ? '<span class="dc-chip off">TX off</span>'
    : dcLastTx && (Date.now() - dcLastTx) < 2000
      ? `<span class="dc-chip ok">publishing</span> ${dcTxCount} frames`
      : `<span class="dc-chip off">idle</span> ${dcTxCount} frames${dcLastTx ? ' · last ' + dcRelTs(dcLastTx) : ''}`;

  el.innerHTML =
    `<div><div class="dc-grp-title">Node roster (uavcan.protocol.NodeStatus, msg 341 - click a row to fail it)</div>${rosterTbl}</div>` +
    `<div><div class="dc-grp-title">Services (GetNodeInfo 1 · RestartNode 5 · param.GetSet 11)</div>${svcHtml}</div>` +
    `<div><div class="dc-grp-title">Dynamic node ID allocation (uavcan.protocol.dynamic_node_id.Allocation, msg 1, anonymous)</div>${allocTbl}${allocLog}</div>` +
    `<div><div class="dc-grp-title">Flight mode</div>${modeHtml}</div>` +
    `<div><div class="dc-grp-title">ESC status (uavcan.equipment.esc.Status, msg 1034)</div>${escTbl}</div>` +
    `<div><div class="dc-grp-title">Arming (uavcan.equipment.safety.ArmingStatus, msg 1100)</div>${armHtml}</div>` +
    `<div><div class="dc-grp-title">Everything else on the bus</div>${nodeTbl}</div>` +
    `<div class="dc-readout">Publishing to the bus: ${txState}</div>`;

  // Transfer-level errors live on the log bar, next to the log they explain. `orphan` is not a
  // fault - it counts transfers we joined mid-flight, which is normal right after connecting.
  const errEl = document.getElementById('dc-errs');
  if (errEl) {
    const e = dcRx.err;
    const part = (label, v) => v ? `<b>${label} ${v}</b>` : `${label} ${v}`;
    errEl.innerHTML = `${part('CRC', e.crc)} · ${part('toggle', e.toggle)} · ${part('transfer-id', e.tid)} · joined mid-transfer ${e.orphan}`;
  }
}

// ── Stacked log tab (render loop + transfer-log table via the shared factory) ──
// One row per REASSEMBLED transfer, not per CAN frame - the frame count is a column.
const dcTab = (window.makeStackedLogTab || dcNullTab)({
  wrapId: 'dronecanWrap', logElId: 'dc-log',
  tableClass: 'dc-tbl', logMax: DC_LOG_MAX,
  theadHtml: '<tr><th>Time</th><th>CAN ID</th><th>Node</th><th>Message</th><th>Frm</th><th>CRC</th><th>Payload</th><th>Decoded</th></tr>',
  emptyHtml: '<div class="dc-empty">No DroneCAN transfers yet.<br>' +
    'A 29-bit id splits into priority / message type id / source node; multi-frame transfers are reassembled here and their CRC checked.<br>' +
    'Press <b>Demo</b> with this tab open for a simulated quad, or fly the drone in the Carlito window.</div>',
  renderTop: dcRenderTop,
  rowHtml: (e) => {
    const cnt = e.count && e.count > 1 ? ` <span style="color:var(--text3)">×${e.count}</span>` : '';
    const crc = e.crcOk === null ? '<span class="dc-chip off">n/a</span>'
      : e.crcOk ? '<span class="dc-chip ok">ok</span>' : '<span class="dc-chip warn">FAIL</span>';
    const raw = e.data.length ? dcHexBytes(e.data.slice(0, 14)) + (e.data.length > 14 ? '…' : '') : '-';
    return `<tr class="${e.bad ? 'dc-bad' : ''}">
        <td class="dc-ts"><a href="#" onclick="isotpSeeCanTraffic(${e.ts});return false" title="See this frame in the Traffic Dump" class="dc-seecan">⊞</a> ${dcRelTs(e.ts)}</td>
        <td class="dc-id">${dcH(e.id, 8)}</td>
        <td class="dc-node">${e.node}</td>
        <td class="dc-msg">${dcEscHtml(e.name)}</td>
        <td>${e.frames}</td>
        <td>${crc}</td>
        <td class="dc-raw">${raw}</td>
        <td class="dc-dec">${dcEscHtml(e.summary)}${cnt}</td>
      </tr>`;
  },
});

// ── Self-test ─────────────────────────────────────────────────────────────────
// Run from the console: window.dronecanSelfTest(). Covers the three things that are easy to
// get backwards and impossible to eyeball - DSDL bit order, the tail byte / framing, and the
// transfer CRC round-trip.
function dronecanSelfTest() {
  const failures = [];
  const eq = (what, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) failures.push(`${what}: got ${g}, want ${w}`);
  };

  // 1. Bit order. health=2 (uint2 at bit offset 32) must land in the TOP two bits of byte 4,
  //    and the u16 vendor code must come out little-endian.
  eq('NodeStatus bit order',
    dcEncode(DC_MSGS[341], { uptime_sec: 1, health: 2, mode: 0, sub_mode: 0, vendor_specific_status_code: 0x1234 }),
    [0x01, 0x00, 0x00, 0x00, 0x80, 0x34, 0x12]);
  eq('NodeStatus is single-frame',
    dcTransfer(DC_MSGS[341], 1, dcEncode(DC_MSGS[341], { uptime_sec: 0, health: 0, mode: 0, sub_mode: 0, vendor_specific_status_code: 0 }), 3)
      .map(f => f.data[f.data.length - 1]),
    [0xC3]);   // SOT|EOT, toggle 0, tid 3

  // 2. float16.
  eq('f16 1.0', dcFloat16(1), 0x3C00);
  eq('f16 -2.0', dcFloat16(-2), 0xC000);
  eq('f16 NaN for absent', dcFloat16(undefined), 0x7E00);
  eq('f16 round-trip 14.8', Math.round(dcFloat16Decode(dcFloat16(14.8)) * 100) / 100, 14.8);

  // 3. esc.Status: 110 bits -> 14 bytes -> 16 with the CRC -> 3 frames of 7/7/2 (+tail).
  const vals = { error_count: 7, voltage: 14.8, current: 15.5, temperature: 303.15, rpm: -6543, power_rating_pct: 19, esc_index: 3 };
  const payload = dcEncode(DC_MSGS[1034], vals);
  eq('esc.Status payload length', payload.length, 14);
  const frames = dcTransfer(DC_MSGS[1034], 14, payload, 5);
  eq('esc.Status frame dlcs', frames.map(f => f.data.length), [8, 8, 3]);
  eq('esc.Status tails', frames.map(f => f.data[f.data.length - 1]), [0x85, 0x25, 0x45]);
  //   SOT tog0 tid5 = 0x85, mid tog1 tid5 = 0x25, EOT tog0 tid5 = 0x45
  eq('esc.Status can id', frames[0].id, dcMsgId(20, 1034, 14));
  eq('esc.Status id fields', dcParseMsgId(frames[0].id), { priority: 20, dataTypeId: 1034, service: 0, srcNode: 14 });

  // 4. Full round-trip through the reassembler (CRC included).
  const st = dcNewRxState();
  let done = null;
  for (const f of frames) done = dcFeedFrame(st, f.id, f.data) || done;
  if (!done) failures.push('esc.Status round-trip: transfer never completed');
  else {
    eq('esc.Status round-trip crc', done.crcOk, true);
    eq('esc.Status round-trip frames', done.frames, 3);
    const back = dcDecode(DC_MSGS[1034], done.payload);
    eq('esc.Status round-trip rpm', back.rpm, -6543);
    eq('esc.Status round-trip esc_index', back.esc_index, 3);
    eq('esc.Status round-trip error_count', back.error_count, 7);
    eq('esc.Status round-trip power_rating_pct', back.power_rating_pct, 19);
    eq('esc.Status round-trip current', Math.round(back.current * 10) / 10, 15.5);
  }

  // 5. A corrupted payload byte must be caught by the CRC.
  const bad = frames.map(f => ({ id: f.id, data: f.data.slice() }));
  bad[1].data[0] ^= 0xFF;
  const st2 = dcNewRxState();
  let done2 = null;
  for (const f of bad) done2 = dcFeedFrame(st2, f.id, f.data) || done2;
  eq('corrupt payload fails CRC', done2 && done2.crcOk, false);

  // 6. The five messages phase 3 added, one encode -> reassemble -> decode round trip each.
  //    The pinned payload vectors are not this module marking its own homework: each one was
  //    generated by pydronecan from the same field values and compared byte for byte, so they
  //    pin the DSDL layout (void padding, inlined nested types, array length prefixes, the
  //    tail array optimization) against an independent implementation. The ONE deliberate
  //    difference is the float16 NaN pattern - pydronecan writes 0x7FFF, this module writes
  //    0x7E00, and both are quiet NaNs.
  const roundTrip = (label, m, vals, node, wantPayload, wantDlcs) => {
    const p = dcEncode(m, vals);
    if (wantPayload) eq(label + ' payload', p, wantPayload);   // null = framing/decode only
    const fr = dcTransfer(m, node, p, 9);
    eq(label + ' frame dlcs', fr.map(f => f.data.length), wantDlcs);
    const s = dcNewRxState();
    let d = null;
    for (const f of fr) d = dcFeedFrame(s, f.id, f.data) || d;
    if (!d) { failures.push(label + ' round-trip: transfer never completed'); return null; }
    if (fr.length > 1) eq(label + ' round-trip crc', d.crcOk, true);
    eq(label + ' round-trip srcNode', d.srcNode, node);
    eq(label + ' round-trip dataTypeId', d.dataTypeId, m.id);
    return dcDecode(m, d.payload);
  };

  const bi = roundTrip('BatteryInfo', DC_MSGS[1092], {
    temperature: 303.15, voltage: 14.8, current: 61, average_power_10sec: 902.8,
    remaining_capacity_wh: NaN, full_charge_capacity_wh: NaN, hours_to_full_charge: NaN,
    status_flags: DC_BATT_IN_USE, state_of_health_pct: DC_SOH_UNKNOWN,
    state_of_charge_pct: 77, state_of_charge_pct_stdev: 0,
    battery_id: 0, model_instance_id: 0,
  }, DC_ROSTER[DC_I_POWER].id, [
    0xBD, 0x5C, 0x66, 0x4B, 0xA0, 0x53, 0x0E, 0x63, 0x00, 0x7E, 0x00, 0x7E,
    0x00, 0x7E, 0x01, 0x1F, 0xE6, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  ], [8, 8, 8, 5]);
  if (bi) {
    eq('BatteryInfo soc', bi.state_of_charge_pct, 77);
    eq('BatteryInfo health unknown', bi.state_of_health_pct, DC_SOH_UNKNOWN);
    eq('BatteryInfo volts', Math.round(bi.voltage * 100) / 100, 14.8);
    eq('BatteryInfo capacity stays unknown', Number.isNaN(bi.full_charge_capacity_wh), true);
  }

  const fx = roundTrip('Fix2', DC_MSGS[1063], {
    timestamp_usec: 0, gnss_timestamp_usec: 0, gnss_time_standard: 0, void13: 0,
    num_leap_seconds: 0,
    longitude_deg_1e8: 235220000, latitude_deg_1e8: 4885660000,
    height_ellipsoid_mm: 123456, height_msl_mm: 123456,
    ned_velocity_n: DC_F32_NAN, ned_velocity_e: DC_F32_NAN, ned_velocity_d: DC_F32_NAN,
    sats_used: 11, status: 3, mode: 0, sub_mode: 0, covariance_len: 0, pdop: 0.9,
  }, DC_ROSTER[DC_I_GNSS].id, [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x20, 0x2C, 0x05, 0x0E, 0x03, 0x02, 0x09, 0xA9, 0x18,
    0x50, 0x38, 0x80, 0x42, 0x07, 0x10, 0x08, 0x00, 0x00, 0xC0, 0x7F, 0x00, 0x00,
    0xC0, 0x7F, 0x00, 0x00, 0xC0, 0x7F, 0x2F, 0x00, 0x00, 0x33, 0x3B,
  ], [8, 8, 8, 8, 8, 8, 8, 4]);
  if (fx) {
    // The signed 37-bit pair is the one field width nothing else in the module exercises.
    eq('Fix2 latitude', fx.latitude_deg_1e8, 4885660000);
    eq('Fix2 longitude', fx.longitude_deg_1e8, 235220000);
    eq('Fix2 sats/status', [fx.sats_used, fx.status], [11, 3]);
    eq('Fix2 ned velocity is NaN', Number.isNaN(dcF32FromBits(fx.ned_velocity_d)), true);
  }
  // A southern/western position must come back negative, not as a huge unsigned number.
  const fxNeg = roundTrip('Fix2 negative', DC_MSGS[1063], {
    timestamp_usec: 0, gnss_timestamp_usec: 0, gnss_time_standard: 0, void13: 0,
    num_leap_seconds: 0,
    longitude_deg_1e8: -17750000000, latitude_deg_1e8: -3385660000,
    height_ellipsoid_mm: -1234, height_msl_mm: -1234,
    ned_velocity_n: DC_F32_NAN, ned_velocity_e: DC_F32_NAN, ned_velocity_d: DC_F32_NAN,
    sats_used: 0, status: 0, mode: 0, sub_mode: 0, covariance_len: 0, pdop: 10,
  }, DC_ROSTER[DC_I_GNSS].id, null, [8, 8, 8, 8, 8, 8, 8, 4]);
  if (fxNeg) {
    eq('Fix2 negative lon', fxNeg.longitude_deg_1e8, -17750000000);
    eq('Fix2 negative lat', fxNeg.latitude_deg_1e8, -3385660000);
    eq('Fix2 negative msl', fxNeg.height_msl_mm, -1234);
  }

  const rm = roundTrip('range.Measurement', DC_MSGS[1050], {
    timestamp_usec: 0, sensor_id: 0,
    beam_roll: 0, beam_pitch: 0, beam_yaw: 0, orientation_defined: 0,
    field_of_view: 0, sensor_type: 2, reading_type: 1, range: 12.5,
  }, DC_ROSTER[DC_I_RANGE].id, [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x11, 0x40, 0x4A,
  ], [8, 8, 4]);
  if (rm) eq('range valid reading', [rm.reading_type, rm.range], [1, 12.5]);

  const so = roundTrip('ahrs.Solution', DC_MSGS[1000], {
    timestamp_usec: 0,
    orientation_x: -0.10438521064158734, orientation_y: 0.05204925439864352,
    orientation_z: 0.005470597079718074, orientation_w: 0.9931589376748557,
    void4_a: 0, orientation_covariance_len: 0,
    angular_velocity_x: 0.1, angular_velocity_y: -0.2, angular_velocity_z: -0.3,
    void4_b: 0, angular_velocity_covariance_len: 0,
    linear_acceleration_x: 1.5, linear_acceleration_y: -0.5, linear_acceleration_z: -0.3,
  }, DC_ROSTER[DC_I_AHRS].id, [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xAE, 0xAE, 0xAA, 0x2A, 0x9A, 0x1D,
    0xF2, 0x3B, 0x00, 0x66, 0x2E, 0x66, 0xB2, 0xCD, 0xB4, 0x00, 0x00, 0x3E, 0x00,
    0xB8, 0xCD, 0xB4,
  ], [8, 8, 8, 8, 4]);
  if (so) eq('Solution quaternion is unit', Math.round(1000 * (
    so.orientation_x * so.orientation_x + so.orientation_y * so.orientation_y +
    so.orientation_z * so.orientation_z + so.orientation_w * so.orientation_w)) / 1000, 1);

  // The quaternion helper against the same pitch/roll, to three decimals.
  eq('quat from pitch 6 / roll -12',
    dcQuatFromPitchRoll(6, -12).map(x => Math.round(x * 1000) / 1000),
    [-0.104, 0.052, 0.005, 0.993]);
  eq('quat level is identity', dcQuatFromPitchRoll(0, 0), [0, 0, 0, 1]);

  const am = roundTrip('ArmingStatus', DC_MSGS[1100], { status: 255 }, dcCfg.fcNode, [0xFF], [2]);
  if (am) eq('ArmingStatus armed', am.status, 255);

  // The two indication commands. The RGB565 vector is the one thing here a hand-packed uint16
  // would get backwards: red 1 / green 2 / blue 3 is 00001 000010 00011, i.e. 0x0843 MSB-first,
  // and a little-endian uint16 of the same colour would come out 0x4308.
  const lc = roundTrip('LightsCommand', DC_MSGS[1081],
    { light_id: 0, red: 1, green: 2, blue: 3 }, dcCfg.fcNode, [0x00, 0x08, 0x43], [4]);
  if (lc) eq('LightsCommand colour channels', [lc.light_id, lc.red, lc.green, lc.blue], [0, 1, 2, 3]);
  const bc = roundTrip('BeepCommand', DC_MSGS[1080],
    { frequency: DC_BEEP_HZ, duration: 0 }, dcCfg.fcNode, [0xB0, 0x68, 0x00, 0x00], [5]);
  if (bc) eq('BeepCommand frequency', bc.frequency, DC_BEEP_HZ);
  // ── The seven messages contract v30 added ───────────────────────────────────
  // Same rule as the block above: every pinned vector was generated by pydronecan from these
  // exact field values and compared byte for byte, so they pin the DSDL layout against an
  // independent implementation rather than against this module's own encoder. The signatures
  // were taken the same way, and the METHOD was validated by re-deriving all nine that were
  // already in DC_MSGS and getting them back identical - which is the only reason the seven new
  // ones can be trusted, since a wrong signature is invisible at runtime on a single-frame
  // transfer and produces frames this decoder accepts on a multi-frame one.
  const hc = roundTrip('hardpoint.Command', DC_MSGS[1070],
    { hardpoint_id: 0, command: DC_HOOK_HOLD }, dcCfg.fcNode, [0x00, 0x01, 0x00], [4]);
  if (hc) eq('hardpoint.Command holds', hc.command, DC_HOOK_HOLD);
  // 19.6 N is 2 kg at g - the shipped crate, so this vector is a real load rather than a
  // round number. float16 rounds it to 19.594, which is what the decode comes back as.
  const hs = roundTrip('hardpoint.Status', DC_MSGS[1071],
    { hardpoint_id: 0, payload_weight: 19.6, payload_weight_variance: 0, status: DC_HOOK_HOLD },
    dcCfg.fcNode, [0x00, 0xE6, 0x4C, 0x00, 0x00, 0x01, 0x00], [8]);
  if (hs) {
    eq('hardpoint.Status latched', hs.status, DC_HOOK_HOLD);
    eq('hardpoint.Status weight is Newton', Math.abs(hs.payload_weight - 19.6) < 0.02, true);
  }
  // The IDENTITY quaternion, deliberately: a level, centred mount is the one case where a sign
  // error in dcQuatFromPitchYaw is invisible, so the pinned bytes cover the LAYOUT and the two
  // sign checks below cover the conversion.
  const gac = roundTrip('gimbal.AngularCommand', DC_MSGS[1040],
    { gimbal_id: 0, mode: 2, quaternion_x: 0, quaternion_y: 0, quaternion_z: 0, quaternion_w: 1 },
    dcCfg.fcNode, [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3C], [8, 6]);
  if (gac) eq('gimbal.AngularCommand is body frame', gac.mode, 2);
  const gst = roundTrip('gimbal.Status', DC_MSGS[1044],
    { gimbal_id: 0, mode: 2, orientation_x: 0, orientation_y: 0, orientation_z: 0, orientation_w: 1 },
    dcCfg.fcNode, [0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3C], [8, 6]);
  if (gst) eq('gimbal.Status is body frame', gst.mode, 2);
  // THE TWO SIGNS. DSDL body frame is NED (z DOWN), the contract's angles are the game's
  // (+ pitch = up, + yaw = right), so a mount looking DOWN must produce a NEGATIVE-w-relative
  // y component and a pan to the RIGHT a positive z. Getting either backwards produces a
  // perfectly valid quaternion pointing the wrong way, which nothing else here would catch.
  eq('gimbal quat level is identity', dcQuatFromPitchYaw(0, 0), [0, 0, 0, 1]);
  eq('gimbal quat pitched down has -y', dcQuatFromPitchYaw(-90, 0)[1] < 0, true);
  eq('gimbal quat yawed right has +z', dcQuatFromPitchYaw(0, 90)[2] > 0, true);
  // ArrayCommand's tail array optimization: TWO commands back to back with no length prefix,
  // which is what makes the payload exactly 8 bytes rather than 9. A length prefix would put a
  // byte at the front and every field after it would decode one nibble out.
  const arr = roundTrip('actuator.ArrayCommand', DC_MSGS[1010],
    { actuator_id_0: 0, command_type_0: 1, command_value_0: 0.5,
      actuator_id_1: 1, command_type_1: 1, command_value_1: -0.25 },
    dcCfg.fcNode, [0x00, 0x01, 0x00, 0x38, 0x01, 0x01, 0x00, 0xB4], [8, 4]);
  if (arr) eq('ArrayCommand carries two POSITION axes',
    [arr.actuator_id_0, arr.command_type_0, arr.command_value_0,
     arr.actuator_id_1, arr.command_type_1, arr.command_value_1], [0, 1, 0.5, 1, 1, -0.25]);
  // A REAL float32, and this vector is the reason it has to be: 101325 Pa in float16 is
  // Infinity, so an f16 field here would put an unusable pressure on the wire and the decode
  // would still look plausible.
  const sp = roundTrip('StaticPressure', DC_MSGS[1028],
    { static_pressure: dcF32ToBits(101325), static_pressure_variance: 0 },
    dcCfg.fcNode, [0x80, 0xE6, 0xC5, 0x47, 0x00, 0x00], [7]);
  // Decoded back THROUGH the pattern, which is the half of `f32bits` a caller gets wrong: the
  // field holds a bit pattern both ways, and comparing it to 101325 as a number would pass only
  // for the mistake this check exists to catch.
  if (sp) eq('StaticPressure is sea-level standard', dcF32FromBits(sp.static_pressure), 101325);
  // Finite temperatures rather than the NaNs the live packer sends, for the reason the block
  // above gives: pydronecan writes float16 NaN as 0x7FFF and this module writes 0x7E00, so a
  // NaN in a pinned vector would compare a real difference that is not a defect.
  const rad = roundTrip('RawAirData', DC_MSGS[1027],
    { flags: 0, static_pressure: dcF32ToBits(101325), differential_pressure: dcF32ToBits(0),
      static_pressure_sensor_temperature: 288.25,
      differential_pressure_sensor_temperature: 288.25,
      static_air_temperature: 288.25, pitot_temperature: 288.25 },
    dcCfg.fcNode,
    [0x00, 0x80, 0xE6, 0xC5, 0x47, 0x00, 0x00, 0x00, 0x00,
     0x81, 0x5C, 0x81, 0x5C, 0x81, 0x5C, 0x81, 0x5C], [8, 8, 6]);
  if (rad) eq('RawAirData static air temperature is Kelvin',
    Math.abs(rad.static_air_temperature - 288.25) < 0.1, true);

  // The picker's own round trip. 24-bit in, 5/6/5 out: #FF8000 quantises, and the check is that
  // it quantises to the RIGHT bits rather than that it comes back unchanged.
  eq('picker -> RGB565', dcRgb565FromHex('#FF8000'), (31 << 11) | (32 << 5) | 0);
  eq('RGB565 -> picker', dcHexFromRgb565((31 << 11) | (32 << 5) | 0), '#ff8200');
  eq('black is off', dcRgb565FromHex('#000000'), 0);

  // The roster against the contract's node_health count - the assertion that makes a grown
  // game-side roster fail here rather than address the wrong node.
  eq('roster length matches contract node_health count',
    DC_ROSTER.length, dcContractNum('node_health', 'count', DC_ROSTER.length));

  // 7. The conversions, end to end through dcBuildFrames. These are the ones a wrong sign or
  //    a zeroed sentinel would hide: nothing about the frames would look unusual. Unlike
  //    every check above, this one drives the LIVE packer, so it leaves a power sample in
  //    the 10 s window and overwrites dcArm - both are refreshed by the next real tick.
  const pick = (frames, dtid) => {
    const s = dcNewRxState();
    let d = null;
    for (const f of frames) {
      const r = dcFeedFrame(s, f.id, f.data);
      if (r && r.dataTypeId === dtid) d = r;
    }
    return d ? dcDecode(DC_MSGS[dtid], d.payload) : null;
  };
  const built = dcBuildFrames({
    esc_rpm: [6500, 6500, 6500, 6500], esc_current: [15, 15, 15, 15],
    esc_temp: [30, 30, 30, 30], esc_fault: 0, battery: 14.8, armed: false,
    pack_current: 61.5, soc: 77, pack_temp: 30,
    lat: 48.8566, lon: 2.3522, altitude: 123.456, sats: 11, fix_type: 3, hdop: 0.9,
    agl: -1,
    pitch: 6, roll: -12, roll_rate: 0.1, pitch_rate: -0.2, yaw: 0.3,
    accLong: 1.5, accLat: -0.5, acc_vert: 0.3,
    arming_state: 1, prearm_fail: 0x01,
  });
  const bSol = pick(built, 1000), bRange = pick(built, 1050), bArm = pick(built, 1100);
  if (bSol) {
    // NED: roll_rate and pitch_rate pass straight through, yaw NEGATES (the game reads it
    // about its own UP axis, DSDL's z points DOWN), and acc_vert negates for the same reason.
    eq('Solution rates -> NED', [bSol.angular_velocity_x, bSol.angular_velocity_y, bSol.angular_velocity_z]
      .map(x => Math.round(x * 1000) / 1000), [0.1, -0.2, -0.3]);
    eq('Solution accel -> NED', [bSol.linear_acceleration_x, bSol.linear_acceleration_y, bSol.linear_acceleration_z]
      .map(x => Math.round(x * 100) / 100), [1.5, -0.5, -0.3]);
  }
  if (bRange) {
    // agl = -1 must become "no reading", and the range field must NOT become 0 - a landing
    // detector acting on a zero is exactly the failure the sentinel exists to prevent.
    eq('agl -1 -> READING_TYPE_UNDEFINED', bRange.reading_type, 0);
    eq('agl -1 -> range NaN, never 0', Number.isNaN(bRange.range), true);
  }
  // BLOCKED is not on the wire: the game asked, the FC refused, and ArmingStatus still says
  // DISARMED because it has no third state to say it with.
  if (bArm) eq('BLOCKED still encodes DISARMED', bArm.status, 0);
  eq('BLOCKED and its failed check reach the tab', dcArm && [dcArm.state, dcArm.fail], [1, 0x01]);

  // 8. PRESENCE. The phase's whole point, and the one behaviour that looks completely normal on
  //    the wire when it is wrong - four healthy ESCs from an aircraft flying on three.
  const escIndices = (frames) => {
    const st3 = dcNewRxState();
    const seen = [];
    for (const f of frames) {
      const r = dcFeedFrame(st3, f.id, f.data);
      if (r && r.dataTypeId === 1034) seen.push(dcDecode(DC_MSGS[1034], r.payload).esc_index);
    }
    return seen.sort();
  };
  const nodeIds = (frames) => {
    const st4 = dcNewRxState();
    const seen = [];
    for (const f of frames) {
      const r = dcFeedFrame(st4, f.id, f.data);
      if (r && r.dataTypeId === 341) seen.push(r.srcNode);
    }
    return seen.sort((a, b) => a - b);
  };
  const flying = {
    esc_rpm: [6500, 6500, 6500, 6500], esc_current: [15, 15, 15, 15],
    esc_temp: [30, 30, 30, 30], esc_fault: 0, battery: 14.8, armed: true,
    pack_current: 61.5, soc: 77, pack_temp: 30,
    lat: 48.8566, lon: 2.3522, altitude: 40, sats: 11, fix_type: 3, hdop: 0.9, agl: 32,
    pitch: 0, roll: 0, roll_rate: 0, pitch_rate: 0, yaw: 0,
    accLong: 0, accLat: 0, acc_vert: 0, arming_state: 2, prearm_fail: 0,
  };
  // A node_online with ESC2 (roster index 1) clear: no esc.Status for esc_index 1, and no
  // heartbeat from node 12 - the node is SILENT, which is the only way a bus says "gone".
  dcNsLastAt.length = 0;
  eq('offline ESC2 publishes no esc.Status',
    escIndices(dcBuildFrames(Object.assign({}, flying, { node_online: DC_ALL_ONLINE & ~(1 << 1) }))),
    [0, 2, 3]);
  dcNsLastAt.length = 0;
  eq('offline ESC2 sends no NodeStatus',
    nodeIds(dcBuildFrames(Object.assign({}, flying, { node_online: DC_ALL_ONLINE & ~(1 << 1) }))),
    [11, 13, 14, 20, 21, 22, 23]);
  // An ABSENT node_online is every node online, not every node silent: an older game build, and
  // any telemetry dict predating the signal, must not take the whole bus off the air.
  dcNsLastAt.length = 0;
  eq('absent node_online means all online', escIndices(dcBuildFrames(flying)), [0, 1, 2, 3]);
  dcNsLastAt.length = 0;
  eq('absent node_online heartbeats the whole roster',
    nodeIds(dcBuildFrames(flying)), DC_ROSTER.map(r => r.id));
  // health comes off the game's array verbatim rather than being re-derived from esc_fault.
  dcNsLastAt.length = 0;
  const hb = dcBuildFrames(Object.assign({}, flying, { node_health: [0, 1, 0, 0, 0, 0, 0, 3] }));
  const stH = dcNewRxState();
  const healths = {};
  for (const f of hb) {
    const r = dcFeedFrame(stH, f.id, f.data);
    if (r && r.dataTypeId === 341) healths[r.srcNode] = dcDecode(DC_MSGS[341], r.payload).health;
  }
  eq('per-node health is published verbatim', [healths[11], healths[12], healths[23]], [0, 1, 3]);

  // 9. The commands are APERIODIC: a tick with nothing latched carries neither of them.
  dcCmdPending = null;
  eq('no indication command on a quiet tick', dcFlushCommands(), []);
  dcCmdPending = { led: (1 << 11) | (2 << 5) | 3, beep: true };
  const cmd = dcFlushCommands();
  eq('a change emits one LightsCommand and one BeepCommand',
    cmd.map(f => dcParseMsgId(f.id).dataTypeId).sort((a, b) => a - b), [1080, 1081]);
  eq('commands come from the FC, not a peripheral',
    cmd.every(f => dcParseMsgId(f.id).srcNode === (dcCfg.fcNode & 0x7F)), true);
  eq('the latch is spent', dcFlushCommands(), []);
  dcNsLastAt.length = 0;   // leave the per-node sweep clocks where a real tick expects them

  // ── 10. THE SERVICES ────────────────────────────────────────────────────────
  //     A different id layout, a different reassembly key and two new field kinds, none of
  //     which the nine broadcast messages exercised. Everything below is arithmetic that is
  //     impossible to eyeball and silently plausible when it is wrong.

  // 10a. The service id, and the fact that it is NOT a message id. The bit that decides is bit
  //      7, and a parser that read a service frame with dcParseMsgId would report a message
  //      type id built out of the service id and the destination - a number that looks fine.
  const svcIdA = dcSvcId(24, 1, true, 20, 127);
  eq('service id bits', svcIdA.toString(16).toUpperCase(), '180194FF');
  eq('service id round-trips', dcParseSvcId(svcIdA),
    { priority: 24, svcTypeId: 1, isRequest: true, destNode: 20, srcNode: 127 });
  eq('a service frame is not read as a message', dcParseAnyId(svcIdA).kind, 'svc');
  eq('a response clears the request bit', dcParseSvcId(dcSvcId(24, 1, false, 127, 20)).isRequest, false);
  //      ...and the reassembly key keeps two nodes answering two tools apart. Same service type,
  //      same source, different destination: four independent transfers, not one spliced one.
  eq('service transfers key on both ends',
    dcParseAnyId(dcSvcId(24, 1, false, 127, 20)).key !== dcParseAnyId(dcSvcId(24, 1, false, 126, 20)).key, true);

  // 10b. The anonymous id. Source node id 0, only the LOW TWO BITS of the message type id, and
  //      14 bits of discriminator - which is why an anonymous transfer identifies almost
  //      nothing and can only be used for a protocol both ends already agree on.
  const anonA = dcAnonId(24, 1, 0x2ABC);
  const anonP = dcParseAnonId(anonA);
  eq('anonymous keeps only the low 2 bits of the type id', anonP.msgTypeIdLow, 1);
  eq('anonymous discriminator round-trips', anonP.discriminator, 0x2ABC);
  eq('anonymous source node id is zero', anonA & 0x7F, 0);
  eq('an anonymous frame is read as anonymous', dcParseAnyId(anonA).kind, 'anon');

  // 10c. The two new field kinds. A fixed byte array is inlined; a TAIL array is literally the
  //      bytes that are left, which only works because everything ahead of it is byte-aligned -
  //      so that is asserted rather than assumed. A tail that started mid-byte would shift the
  //      node name by a bit and decode as garbage that still looks like a name.
  const gni = DC_SVCS[1].resp;
  eq('GetNodeInfo response is byte-aligned before its tail array', gni.bits % 8, 0);
  eq('a tail field is last', gni.fields[gni.fields.length - 1].tail, true);
  const gniVals = {
    uptime_sec: 4242, health: 1, mode: 0, sub_mode: 0, vendor_specific_status_code: 0,
    sw_major: 1, sw_minor: 0, sw_optional_field_flags: 0, sw_vcs_commit: 0,
    sw_image_crc_lo: 0, sw_image_crc_hi: 0, hw_major: 1, hw_minor: 0,
    unique_id: dcUniqueId(DC_I_GNSS), coa_len: 0, name: 'org.example.node',
  };
  const gniBytes = dcEncode(gni, gniVals);
  eq('GetNodeInfo response length is the fixed part plus the tail', gniBytes.length, (gni.bits >> 3) + 16);
  const gniBack = dcDecode(gni, gniBytes);
  eq('GetNodeInfo uptime round-trips', gniBack.uptime_sec, 4242);
  eq('GetNodeInfo health round-trips', gniBack.health, 1);
  eq('GetNodeInfo unique id round-trips', gniBack.unique_id, dcUniqueId(DC_I_GNSS));
  eq('GetNodeInfo name round-trips', dcAscii(gniBack.name), 'org.example.node');
  //      ...and it is a MULTI-frame transfer, so its CRC is seeded with the SERVICE's signature.
  //      A wrong signature here is invisible on the single-frame RestartNode and fatal on this.
  const gniFrames = dcSvcTransfer(DC_SVCS[1], false, 20, 127, gniBytes, 7);
  const stG = dcNewRxState();
  let gniDone = null;
  for (const f of gniFrames) gniDone = dcFeedFrame(stG, f.id, f.data) || gniDone;
  eq('GetNodeInfo response reassembles', gniDone && gniDone.crcOk, true);
  eq('GetNodeInfo response is nine frames', gniDone && gniDone.frames, 9);
  eq('the response carries the request transfer id', gniDone && gniDone.tid, 7);
  eq('the response is a response', gniDone && gniDone.isRequest, false);

  // 10d. THE 64-BIT WRAP. put(20, 64) used to write a ZERO, because `20 + 2**64` is not exactly
  //      representable and the modulo dance rounded it away - so every parameter value, default
  //      and range came back 0 and looked like an encoder that had never been wired up. Pinned
  //      here at three widths, because 32 bits was fine and 64 was not.
  const w64 = dcBitWriter(64); w64.put(20, 64);
  eq('a small value survives a 64-bit field', dcBitReader(w64.bytes()).get(64), 20);
  const w32 = dcBitWriter(32); w32.put(4000, 32);
  eq('a small value survives a 32-bit field', dcBitReader(w32.bytes()).get(32), 4000);
  const wNeg = dcBitWriter(64); wNeg.put(-1, 64);
  eq("a negative still wraps to two's complement", dcBitReader(wNeg.bytes()).get(64, true), -1);

  // 10e. RestartNode's magic number, which the DSDL says must be checked. 0xACCE551B1E is a
  //      uint40, so it is neither a byte count nor a 32-bit value - both of which it would
  //      silently become if the field width were wrong.
  eq('the restart magic is 40 bits', DC_SVCS[5].req.bits, 40);
  const magicBytes = dcEncode(DC_SVCS[5].req, { magic_number: DC_RESTART_MAGIC });
  eq('the restart magic encodes little-endian', magicBytes.map(b => dcH(b)).join(' '), '0x1E 0x1B 0x55 0xCE 0xAC');
  eq('the restart magic round-trips', dcDecode(DC_SVCS[5].req, magicBytes).magic_number, DC_RESTART_MAGIC);

  // 10f. param.GetSet, the one message with no field table - a union's width depends on its tag.
  //      The void paddings are what keep every variant byte-aligned, so the name tail lands on a
  //      boundary; a missing void5 would shift the whole response by five bits.
  const gsReq = dcGetSetEncodeReq(3, dcValInt(4000), 'uavcan.node.status_period_ms');
  const gsReqBack = dcGetSetDecodeReq(gsReq);
  eq('GetSet request index round-trips', gsReqBack.index, 3);
  eq('GetSet request name round-trips', gsReqBack.name, 'uavcan.node.status_period_ms');
  eq('GetSet request value round-trips', [gsReqBack.value.kind, gsReqBack.value.v], [DC_VAL_INT, 4000]);
  const gsEmpty = dcGetSetDecodeReq(dcGetSetEncodeReq(0, dcValEmpty(), ''));
  eq('an EMPTY value is a get, not a set of zero', gsEmpty.value.kind, DC_VAL_EMPTY);
  const gsResp = dcGetSetDecodeResp(dcGetSetEncodeResp({
    value: dcValInt(1000), defaultValue: dcValInt(1000),
    maxValue: dcNumInt(10000), minValue: dcNumInt(100), name: 'uavcan.node.status_period_ms' }));
  eq('GetSet response value round-trips', gsResp.value.v, 1000);
  eq('GetSet response range round-trips', [gsResp.minValue.v, gsResp.maxValue.v], [100, 10000]);
  eq('GetSet response name round-trips', gsResp.name, 'uavcan.node.status_period_ms');
  //      An empty name AND an empty value is the DSDL's "no such parameter", which is the only
  //      thing that ends an index walk - there is no count to ask for.
  const gsNone = dcGetSetDecodeResp(dcGetSetEncodeResp({
    value: dcValEmpty(), defaultValue: dcValEmpty(),
    maxValue: { kind: DC_NUM_EMPTY }, minValue: { kind: DC_NUM_EMPTY }, name: '' }));
  eq('the end of the parameter list is an empty name and an empty value',
    [gsNone.name, gsNone.value.kind], ['', DC_VAL_EMPTY]);
  //      A float parameter takes a different amount of room from an integer one, which is the
  //      whole reason this message has no field table.
  eq("a union's width follows its tag",
    [dcValueBits(dcValEmpty()), dcValueBits(dcValBool(1)), dcValueBits(dcValReal(1.5)), dcValueBits(dcValInt(1))],
    [3, 11, 35, 67]);

  // 10g. Allocation. The DSDL's allocation algorithm hands an allocatee with NO preference the
  //      HIGHEST free id rather than the lowest, which is what keeps dynamically allocated nodes
  //      out of the way of declared ones - and 126/127 are skipped because they belong to tools.
  eq('no preference gets the highest free id', dcAllocFindFree(0), DC_ALLOC_MAX_ID);
  eq('the tool id is never handed out', dcAllocFindFree(127) <= DC_ALLOC_MAX_ID, true);
  eq('a preferred id that is free is granted', dcAllocFindFree(60), 60);
  // The four ESCs occupy 11-14, so a request preferring 11 walks up past all four to 15.
  eq('a preferred id that is taken searches upward', dcAllocFindFree(11), 15);
  //      The message: node_id is a uint7 in the TOP seven bits and first_part_of_unique_id is
  //      the bottom one, which is exactly the byte libcanard builds by hand as
  //      `(PREFERRED_NODE_ID << 1) | 1`. unique_id is a tail array, so a first-stage request is
  //      seven payload bytes and a grant is seventeen - the same message, two lengths.
  const allocFirst = dcEncode(DC_ALLOC, { node_id: 0, first_part_of_unique_id: 1, unique_id: [1, 2, 3, 4, 5, 6] });
  eq('a first-stage request is one byte plus six', allocFirst.length, 7);
  eq('node_id sits above the first-part bit', allocFirst[0], 0x01);
  eq('a preferred id shifts left by one', dcEncode(DC_ALLOC, { node_id: 42, first_part_of_unique_id: 1, unique_id: [] })[0], (42 << 1) | 1);
  const allocBack = dcDecode(DC_ALLOC, allocFirst);
  eq('the unique-id chunk round-trips', allocBack.unique_id, [1, 2, 3, 4, 5, 6]);
  //      ...and it is single-frame BY CONSTRUCTION. A multi-frame anonymous transfer has no
  //      source node id to key a reassembly buffer on, so two allocatees would splice together.
  eq('an anonymous transfer is one frame', dcAnonTransfer(DC_ALLOC, allocFirst, 0).length, 1);
  let anonThrew = false;
  try { dcAnonTransfer(DC_ALLOC, new Array(9).fill(0), 0); } catch (e) { anonThrew = true; }
  eq('an oversized anonymous transfer is refused rather than truncated', anonThrew, true);

  return { pass: failures.length === 0, failures };
}

// ── Persistence ───────────────────────────────────────────────────────────────
// Only the LED colour joins the config: the flight mode, the beep and the node-failure mask are
// bench switches, and a workspace that re-killed ESC2 on load would be a trap rather than a setting.
function dronecanCollect() { return { txEnabled: dcCfg.txEnabled, fcNode: dcCfg.fcNode, led: dcCtl.led }; }
function dronecanApply(p) {
  p = p || {};
  dcCfg.txEnabled   = typeof p.txEnabled === 'boolean' ? p.txEnabled : true;
  // An older workspace's escBaseNode is ignored: the roster is the only id source now.
  dcCtl.led = typeof p.led === 'number' ? (p.led & 0xFFFF) : 0;
  dcCfg.fcNode      = typeof p.fcNode === 'number' ? Math.max(1, Math.min(127, p.fcNode)) : 1;
  if (document.getElementById('dcTxEnabled')) dronecanOnShow();
  dcTab.markDirty();
}

// ── Exports ───────────────────────────────────────────────────────────────────
window.dronecanIngestFrame = dronecanIngestFrame;
window.dronecanClear = dronecanClear;
window.dronecanStop = dronecanStop;
window.dronecanDemoStart = dcDemoStart;   // demo base-traffic engine starts/stops the quad
window.dronecanDemoStop = dcDemoStop;
window.dronecanOnShow = dronecanOnShow;
window.dronecanCfgChange = dronecanCfgChange;
window.dronecanCtlChange = dronecanCtlChange;
window.dronecanLedOff = dronecanLedOff;
window.dronecanToggleNodeFail = dronecanToggleNodeFail;
window.dronecanGetNodeInfo = dronecanGetNodeInfo;
window.dronecanReadParams = dronecanReadParams;
window.dronecanSetPeriod = dronecanSetPeriod;
window.dronecanRestartNode = dronecanRestartNode;
window.dronecanRestartBadMagic = dronecanRestartBadMagic;
window.dronecanRequestAllocation = dronecanRequestAllocation;
window.dronecanCollect = dronecanCollect;
window.dronecanApply = dronecanApply;
window.dronecanSelfTest = dronecanSelfTest;
// Wire primitives, exported so they can be driven directly from the console / self-test.
window.dcTransfer = dcTransfer;
window.dcEncode = dcEncode;
window.dcDecode = dcDecode;
window.dcMsgId = dcMsgId;
window.dcParseMsgId = dcParseMsgId;
window.dcCrc16 = dcCrc16;
window.dcFloat16 = dcFloat16;
window.dcF32ToBits = dcF32ToBits;
window.dcF32FromBits = dcF32FromBits;
window.DC_MSGS = DC_MSGS;
window.DC_SVCS = DC_SVCS;
window.dcSvcId = dcSvcId;
window.dcParseSvcId = dcParseSvcId;
window.dcAnonId = dcAnonId;
window.dcParseAnonId = dcParseAnonId;
if (window._dronecanPending) dronecanApply(window._dronecanPending);
