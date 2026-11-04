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
// THIS FILE IS HALF THE MODULE: the half carlito-bridge.html runs, and it touches no DOM - the
// DSDL codec (wire primitives, id layouts, message and service tables, transfer build and
// reassembly), the node roster, the flavor packer, the dcCtl uplink sources and the bus-command
// decoder. dronecan.js, loaded right after it on index.html only, is the rest: the receive path,
// services, allocation, the tab, the demo quad and the self-test. Both are classic scripts in one
// global scope, so every name is declared in exactly one of the two.

// ── The tab handle ────────────────────────────────────────────────────────────
// dronecan.js replaces both with the tab's own; carlito-bridge.html loads only this file, so there
// they stay no-ops.
function dcNullTab() { return { markDirty() {}, pushLog() {}, clearLog() {}, render() {}, ready: () => false }; }
let dcTab = dcNullTab();
let dcCtlChanged = () => {};   // a bus command changed dcCtl (dcUplinkDecode): refresh the tab

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
      // that expression is not exact: `20 + 2**64` rounds to `2**64`, so an in-range 20 would
      // come out as a ZERO, and `-1 + 2**64` rounds the same way. Every param.GetSet value,
      // default and range is an int64, so the whole parameter server would read as zeroes.
      // Instead the magnitude is laid out as little-endian bytes and a negative is negated across
      // them (invert, add one), which is exact at every width. Anything above `bits` simply is
      // not written (the same wrap a modulo would give).
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
// accepts and every real DroneCAN tool rejects. All of them are taken from the DSDL itself
// (dronecan/DSDL, via pydronecan's get_data_type_signature), and NodeStatus/esc.Status matching
// independently known constants is what says that source is the right one. The single-frame ones
// (ArmingStatus and the two indication COMMANDS) never reach dcCrc16 at all, so a wrong constant
// there would be invisible at runtime - which is why they are checked against the DSDL rather
// than tested into.
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
// whose answer is already on the wire, one field at a time, forever.
//
// Same rules as DC_MSGS: ids come off the DSDL FILE NAMES (1.GetNodeInfo, 5.RestartNode,
// 11.GetSet) and signatures are the 64-bit data type signature, computed from the normalized
// definition exactly as pydronecan's get_data_type_signature does - CRC-64-WE over the
// normalized text, then extended with each nested type's own signature. The method is
// validated by re-deriving every signature in DC_MSGS and getting it back identical. Two of the
// three below are also the values libcanard publishes as UAVCAN_PROTOCOL_GETNODEINFO_SIGNATURE
// and UAVCAN_PROTOCOL_PARAM_GETSET_SIGNATURE.
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
function dcNewRxState() { return { asm: new Map(), err: { crc: 0, toggle: 0, tid: 0, orphan: 0, oversize: 0 } }; }
// An unfinished transfer idle this long is dropped (a start of transfer with no end would hold its
// buffer forever otherwise).
const DC_ASM_IDLE_MS = 2000;
// The longest transfer any type here can be: GetNodeInfo's response (DC_SVCS[1]) - NodeStatus 7 +
// SoftwareVersion 15 + HardwareVersion 2 + unique_id 16 + certificate_of_authenticity 1 + 255 +
// name 80 = 376 bytes, plus the 2-byte transfer CRC. param.GetSet's response (370) is next; no
// DC_MSGS message comes close. A type with no entry here (file.Write, a vendor type) can be longer,
// so it gets DC_MAX_UNKNOWN_XFER_BYTES instead - a memory bound, not a DSDL number.
const DC_MAX_XFER_BYTES = 378;
const DC_MAX_UNKNOWN_XFER_BYTES = 4096;

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
  const now = Date.now();
  if (now - (st.prunedAt || 0) >= 500) {               // a start with no end is dropped after DC_ASM_IDLE_MS
    st.prunedAt = now;
    for (const [k, a] of st.asm) if (now - a.ts > DC_ASM_IDLE_MS) st.asm.delete(k);
  }
  const tail = data[data.length - 1] & 0xFF;
  const sot = (tail >> 7) & 1, eot = (tail >> 6) & 1, tog = (tail >> 5) & 1, tid = tail & 0x1F;
  // The cheap reject, before any parse or copy: a continuation of nothing in flight.
  if (!sot && !st.asm.size) { st.err.orphan++; return null; }
  const h = dcParseAnyId(id);
  const chunk = Array.prototype.slice.call(data, 0, data.length - 1);
  const key = h.key;
  const out = (payload, frames, crcOk, error) => ({
    kind: h.kind, srcNode: h.srcNode, dataTypeId: h.dataTypeId,
    svcTypeId: h.svcTypeId, isRequest: h.isRequest, destNode: h.destNode,
    discriminator: h.discriminator, msgTypeIdLow: h.msgTypeIdLow, priority: h.priority,
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
    st.asm.set(key, { tid, expect: 1, bytes: chunk, frames: 1, ts: now,
      max: dcSigFor(h) ? DC_MAX_XFER_BYTES : DC_MAX_UNKNOWN_XFER_BYTES });
    return null;
  }
  const a = st.asm.get(key);
  if (!a) { st.err.orphan++; return null; }           // joined mid-transfer; wait for the next SOT
  if (tid !== a.tid) { st.err.tid++; st.asm.delete(key); return null; }
  if (tog !== a.expect) { st.err.toggle++; st.asm.delete(key); return null; }
  if (a.bytes.length + chunk.length > a.max) { st.err.oversize++; st.asm.delete(key); return null; }
  a.ts = now;
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
let dcTxCount = 0, dcLastTx = 0;

// IS DRONECAN ON THIS BUS? The one place that decides it, and the gate on everything this module
// transmits IN ANSWER TO a received frame and on the bus commands that steer the game's drone. A
// 29-bit id alone cannot say: every J1939 frame from SA 0x00 or 0x80 parses as an anonymous
// DroneCAN message, and the anonymous id keeps only two bits of type id, so without this the
// allocator would grant node ids to an engine controller - onto the real bus. Only EVIDENCE
// counts here: the tab on show is somebody looking, not consent to transmit onto a truck's bus,
// so it widens what is DISPLAYED (dcShown) and nothing else. The cost is a bus whose only
// DroneCAN devices are anonymous nodes asking for an id: the allocator stays quiet there until
// some node publishes a NodeStatus.
const DC_PRESENT_NS_MS = 5000;
let dcNsHeardAt = 0;              // last structurally valid single-frame NodeStatus from a node id
// A drone on the Carlito link, read off the telemetry this module's own packer is handed (both
// pages call it) through carlito-registry.js's carlitoIsFamily, which both pages load.
let dcDroneLinkAt = 0;
function dcPresent() {
  if (window.demoGetBaseTraffic && window.demoGetBaseTraffic() === 'dronecan') return true;
  const now = Date.now();
  if (dcDroneLinkAt && now - dcDroneLinkAt < DC_PRESENT_NS_MS) return true;
  return !!(dcNsHeardAt && now - dcNsHeardAt < DC_PRESENT_NS_MS);
}

// The NodeStatus test the full parse makes (a single-frame, toggle-0, 7-byte type 341 from a node
// id), read straight off the id and the tail byte. It runs on every 29-bit frame because
// dronecanIngestFrame (dronecan.js) and dcUplinkDecode (below) skip the parse until dcShown() /
// dcPresent(), and NodeStatus is how a real bus becomes present at all. True (and the evidence recorded) on a match.
function dcSniffNodeStatus(frame) {
  const id = frame.id, d = frame.data;
  if (!d || d.length !== 8 || ((id >>> 7) & 1) || !(id & 0x7F) || ((id >>> 8) & 0xFFFF) !== 341 ||
      (d[7] & 0xE0) !== 0xC0) return false;
  dcNsHeardAt = Date.now();
  return true;
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
// A second, independent id source (an ESC base offset) would let an ESC land on top of the GNSS
// node with nothing to say so.
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
  // THE TWO WITH NO WIDGET IN #dronecanWrap. arm and climb are the flight controls rather than
  // bench switches - they belong on the floating Drone Control panel (drone.js), where the
  // sticks are, not in a tab you cannot watch the aircraft from. They live here anyway so that
  // every one of the drone's inbound signals has ONE owner: the panel is a view over this
  // object, and a second copy of the arm latch is how two switches stop agreeing.
  arm: false, climb: 0,                              // arm (latched request) / climb (i8 %)
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
  // arm and climb. SENT UNCONDITIONALLY, like the seven above and unlike the drone panel's
  // stick overrides: an absent `arm` reads as 0 = disarmed at the game, which is the same thing
  // a lowered switch says, so there is nothing to hand back by going quiet. The panel being
  // closed is not an aircraft arming itself.
  arm:   () => (dcCtl.arm ? 1 : 0),
  climb: () => dcCtl.climb,
});

// ── The same commands, off the BUS ────────────────────────────────────────────
// A LightsCommand / hardpoint.Command / camera_gimbal.AngularCommand from any node drives dcCtl
// exactly as the tab's widgets and drone.js do - the one-owner rule above, so the uplink sources
// need no second copy. It reassembles into its OWN state rather than the tab's dcRx, because it
// runs on carlito-bridge.html too, where the tab's ingest is never called.
//
// THE OWN-ADDRESS RULE (carlito.js's decoder registry): dcFlushCommands emits these three from
// dcCfg.fcNode and canForward ingests that echo, so a transfer from the FC node is this side
// talking and is skipped.
//
// A bus command does NOT latch dcCmdPending: the FC relaying a command it just received would put
// a second copy on the bus under its own id. And it holds until the next one, with no timeout -
// all three are sent on change, and a light keeps its colour until it is told otherwise.
const dcUpRx = dcNewRxState();
function dcUplinkDecode(frame) {
  if (!frame || !frame.isExt || frame.isRtr) return;
  // A J1939 XBR (PGN 1024) to the right destination address carries one of these type ids, and a
  // latched command steers the game's drone - so only a bus shown to be DroneCAN is listened to,
  // and until then only the evidence is looked for.
  if (!dcPresent()) { dcSniffNodeStatus(frame); return; }
  const done = dcFeedFrame(dcUpRx, frame.id, frame.data);
  if (!done || done.kind !== 'msg' || done.crcOk === false || done.error) return;
  // The presence evidence dronecanIngestFrame records, recorded here too: carlito-bridge.html
  // routes frames only through this decoder, so without it dcPresent() is never true there.
  if (done.dataTypeId === 341 && done.frames === 1 && done.payload.length === 7) dcNsHeardAt = Date.now();
  if (done.srcNode === (dcCfg.fcNode & 0x7F)) return;
  const m = DC_MSGS[done.dataTypeId];
  if (!m || (m.id !== 1081 && m.id !== 1070 && m.id !== 1040)) return;
  // A payload short of the message's fixed part would decode its missing bytes as zeros - an
  // empty LightsCommand as "light 0 off", a truncated hardpoint.Command as RELEASE - a command
  // nobody sent. LightsCommand's fixed part is ONE SingleLightCommand, so an empty array (legal,
  // and a statement of nothing) is ignored too.
  if (done.payload.length < (m.bits >> 3)) return;
  const v = dcDecode(m, done.payload);
  const was = [dcCtl.led, dcCtl.hook, dcCtl.gimbalPitch, dcCtl.gimbalYaw].join('|');
  if (m.id === 1081) {
    // The FIRST SingleLightCommand, and only for light 0 - the one lamp group this side itself
    // commands (dcFlushCommands' light_id note).
    if (v.light_id !== 0) return;
    dcCtl.led = dcBusCmd.led = ((v.red & 0x1F) << 11) | ((v.green & 0x3F) << 5) | (v.blue & 0x1F);
  } else if (m.id === 1070) {
    if (v.hardpoint_id !== DC_HARDPOINT_ID) return;
    dcCtl.hook = dcBusCmd.hook = v.command !== DC_HOOK_RELEASE;   // DSDL: 0 release, 1+ hold
  } else {
    // Only the mode dcFlushCommands sends, ORIENTATION_BODY_FRAME: the other modes name a rate or
    // a fixed frame, and reading one as body-frame angles would point the camera somewhere else.
    if (v.gimbal_id !== DC_GIMBAL_ID || v.mode !== 2) return;
    const a = dcPitchYawFromQuat(v.quaternion_x, v.quaternion_y, v.quaternion_z, v.quaternion_w);
    dcCtl.gimbalPitch = dcClampToRange('gimbal_pitch', a.pitch);
    dcCtl.gimbalYaw = dcClampToRange('gimbal_yaw', a.yaw);
    dcBusCmd.gimbal = [dcCtl.gimbalPitch, dcCtl.gimbalYaw];
  }
  // A repeated command changes nothing, and a sender streaming one must not re-render the tab (or
  // pull a slider out from under the user) on every frame.
  if ([dcCtl.led, dcCtl.hook, dcCtl.gimbalPitch, dcCtl.gimbalYaw].join('|') === was) return;
  dcCtlChanged();
}
// The inverse of dcQuatFromPitchYaw (q = qz(yaw) * qy(pitch), NED), in degrees. Pan-then-tilt has
// no roll, so the body RIGHT axis stays level at every pitch and yaw is read off it - which is what
// keeps a mount pointing straight down (the contract's -90 stop) from losing its pan. Pitch is
// atan2 against the forward axis's horizontal length rather than asin, whose slope is infinite at
// that same stop (float16 rounding alone reads a commanded -90 as -88.8 through asin). Both are
// quadratic in q, so q and -q - one rotation - decode alike. A quaternion carrying roll, which the
// mount cannot follow, decodes to the pan of its right axis and the tilt of its forward axis.
function dcPitchYawFromQuat(x, y, z, w) {
  const fx = 1 - 2 * (y * y + z * z), fy = 2 * (w * z + x * y);   // forward axis, horizontal part
  return {
    pitch: Math.atan2(2 * (w * y - z * x), Math.hypot(fx, fy)) * 180 / Math.PI,
    yaw: Math.atan2(2 * (w * z - x * y), 1 - 2 * (x * x + z * z)) * 180 / Math.PI,
  };
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
window.carlitoUplinkDecoders = window.carlitoUplinkDecoders || [];
window.carlitoUplinkDecoders.push(dcUplinkDecode);

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

// The services (dronecan.js) write these and the publisher reads them, so they live here.
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
  // tab (dronecan.js) instead - the same shape, one message short of a full DroneCAN FC.
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
  // id, with its OWN health. The game publishes real per-node health, so it is used verbatim.
  //
  // THE FC ITSELF SENDS NONE. It has no roster element, so any health for it would have
  // to be invented; it still sources ArmingStatus and the two indication commands below.
  // THE SWEEP IS PER NODE, not one clock for all eight, because each node's publication period
  // is a real parameter its param.GetSet server can write (uavcan.node.status_period_ms). A
  // single shared clock would make that parameter a number in a struct; a clock each makes
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
      mode: 0,      // MODE_OPERATIONAL: an online node is running. (MAINTENANCE-when-disarmed
                    // would be an FC statement, and an ESC is not disarmed, it is idle.)
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
// DECISION 2: KEEP THE LATCH, AND RE-EMIT ON LINK-UP. The game obeys the uplink's led / beep /
// hardpoint_cmd / gimbal the instant a drone appears, whatever is on CAN, so dropping a command
// would only make the bus disagree with what the game has been told. And on the drone's link-up
// edge - the packer's first drone tick after none, or after its `reset` (a bus opening, the link
// ending or resuming) - all four go out once, so the bus record always matches the commanded
// state. The edge is the PACKER'S (dcNoteLink, called from dcPackCarlito only): the demo quad
// shares dcBuildFrames, and a car on the link beside it must not read as a drone arriving on
// every demo tick. And it is never a RELAY: a command whose current value another node put on the
// bus (dcUplinkDecode, recorded in dcBusCmd) is already on the bus record, so it is left out -
// except beep, which is never read back.
//
// NO LOCAL BLINK TIMER, ON EITHER SIDE. If the LEDs pulse it is because this control is toggling
// the colour, exactly as the turn lamps blink because the source toggles the bit.
const DC_BEEP_HZ = 2400;   // a labelled constant: the resonant pitch of a typical airframe piezo
let dcCmdPending = null;   // { led?, beep?, hook?, gimbal? } - see dcFlushCommands
let dcLinkUp = false;      // a drone was in the packer's last tick (decision 2)
// The value dcUplinkDecode last latched from ANOTHER node, per command; cleared once the FC sends
// that command itself, because from then on the value on the bus is this node's statement.
let dcBusCmd = { led: undefined, hook: undefined, gimbal: undefined };   // gimbal: [pitch, yaw]
// The link-up edge (decision 2): not a drone clears it; the first drone after none latches every
// command's CURRENT state once - minus any that only repeats what another node commanded.
function dcNoteLink(t) {
  if (!t || !Array.isArray(t.esc_rpm)) { dcLinkUp = false; return; }
  if (dcLinkUp) return;
  dcLinkUp = true;
  const p = { beep: dcCtl.beep };
  if (dcCtl.led !== dcBusCmd.led) p.led = dcCtl.led;
  if (dcCtl.hook !== dcBusCmd.hook) p.hook = dcCtl.hook;
  const g = dcBusCmd.gimbal;
  if (!g || g[0] !== dcCtl.gimbalPitch || g[1] !== dcCtl.gimbalYaw) p.gimbal = { pitch: dcCtl.gimbalPitch, yaw: dcCtl.gimbalYaw };
  dcCmdPending = p;
}
function dcFlushCommands() {
  if (!dcCmdPending) return [];
  const p = dcCmdPending;
  dcCmdPending = null;
  const out = [];
  if (p.led != null) dcBusCmd.led = undefined;
  if (p.hook != null) dcBusCmd.hook = undefined;
  if (p.gimbal != null) dcBusCmd.gimbal = undefined;
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
// This is the number to look at first if SLCAN starts
// dropping. Real airframes rate-split these (BatteryInfo at 0.2-1 Hz per its own DSDL note,
// AHRS far faster than 10 Hz); everything rides one tick here because the game has exactly
// one slow tick to hang them on, and a second cadence would be a timer inventing a rate the
// telemetry does not have.
function dcPackCarlito(t, slow) {
  if (window.carlitoIsFamily && window.carlitoIsFamily('drone', t)) dcDroneLinkAt = Date.now();   // (dcPresent)
  if (!dcCfg.txEnabled || !slow) return [];
  dcNoteLink(t);
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
  reset: () => { dcLinkUp = false; },   // the next drone tick is a link-up edge (decision 2)
});

// ── Exports ───────────────────────────────────────────────────────────────────
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
