// ── can-link.js - shared CAN transport layer ───────────────────────────────────
// Device + protocol primitives extracted from sloppycan.js so that BOTH the full
// SloppyCAN monitor (index.html) and the standalone Carlito↔RAMN bridge
// (carlito-bridge.html) can reuse one battle-tested transport instead of forking it.
//
// LOAD ORDER: this is a classic (non-defer) script and MUST load before
// `sloppycan.js` (and may load before/after `diag-parse.js`). All three share one
// global lexical scope, so the connection state + functions declared here are the
// SAME bindings the rest of sloppycan.js references - no window.* indirection needed.
//
// HOST CONTRACT: the functions below reference, AT CALL TIME ONLY, a handful of
// globals that the hosting page must provide (they never run at eval time here):
//   log(msg, level)            - status/diagnostic logging
//   ingestFrame(frame)         - sink for a parsed RX frame
//   paused                     - when true, RX frames are counted but not ingested
//   demoMode                   - when true, SLCAN writes are suppressed
//   terminalMode, termLog(d,l) - SLCAN serial-terminal passthrough (SloppyCAN only)
//   escHtml(s)                 - HTML-escape for raw-line diagnostics
//   parseErrors, totalFrames, frameRateBuffer, bytesReceived - RX stat counters
//   disconnectSerial()         - page teardown, called when a read loop dies
//   DOM ids #statBytes, #deviceInfo, #baudRate
// On index.html these are defined by sloppycan.js; carlito-bridge.js supplies its own.

// ── Connection / protocol state ────────────────────────────────────────────────
let connMode = 'serial';       // 'serial' (Web Serial + Android CDC) | 'gsusb'
let port = null;
let reader = null;
let usbSerDev = null;
let usbSerIn  = null;
let usbSerOut = null;
let busIsOpen = false;
let frameBuffer = '';
let termBuffer  = ''; // accumulates bytes for terminal line display

const _onAndroid = /Android/i.test(navigator.userAgent);
const SERIAL_USB_FILTERS = [
  {vendorId: 0x0483, productId: 0x5740},
  {vendorId: 0x1d50, productId: 0x606f}
];

// ── gs_usb (candleLight / CANable-native) ──────────────────────────────────────
// Binary WebUSB protocol - does NOT use SLCAN text. Selected via the Adapter dropdown.
let gsFclk   = 48000000;       // CAN clock (Hz), refined from BT_CONST at connect
let gsIface  = 0;              // gs_usb vendor interface number (for control transfers)
let gsEchoId = 0;              // rotating TX echo id (avoids reusing a busy echo slot)
// gs_usb bit-timing segment/brp limits - refined from BT_CONST, defaults are bxCAN's.
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

const SLCAN_BITRATE_HZ = {
  S0: 10000, S1: 20000, S2: 50000, S3: 100000, S4: 125000,
  S5: 250000, S6: 500000, S7: 800000, S8: 1000000
};
function getBitrateHz() {
  // Guard the lookup: the stripped carlito-bridge.html has no #baudRate, so fall back to 500k
  // rather than throwing if a gs_usb path ever reaches gsCalcBitTiming there.
  const el = document.getElementById('baudRate');
  return (el && SLCAN_BITRATE_HZ[el.value]) || 500000;
}

// ── SLCAN write path ─────────────────────────────────────────────────────────
function encodeCmd(trimmed) {
  const bytes = new Uint8Array(trimmed.length + 1);
  for (let i = 0; i < trimmed.length; i++) bytes[i] = trimmed.charCodeAt(i);
  bytes[trimmed.length] = 0x0D;
  return bytes;
}

// Serialize all SLCAN writes. Callers like the Carlito telemetry forward (canForward) fire bursts of
// un-awaited sends; without this they overlap on the single port - Web Serial getWriter() throws
// "stream already locked" (frames silently dropped) and WebUSB transferOut() interleaves bytes into
// invalid SLCAN that the adapter rejects with BELL (0x07). The chain runs one write at a time, in
// order; a failure doesn't poison the queue, and direct awaiters still see the real result.
let serialWriteChain = Promise.resolve();
// Returns the write's own promise so direct awaiters (busOpen, TX scheduler) see real failures.
// The internal `.catch` only protects the shared chain from being poisoned - it does NOT cover the
// returned promise. CONTRACT: a caller that fires sendCommand() un-awaited (e.g. a telemetry burst)
// MUST attach its own `.catch()`, or a write failure (port closed mid-burst) surfaces as an
// unhandled rejection. Current un-awaited callers all await inside try/catch or `.catch()` already.
function sendCommand(cmd) {
  const p = serialWriteChain.then(() => sendCommandRaw(cmd));
  serialWriteChain = p.catch(() => {});
  return p;
}

async function sendCommandRaw(cmd) {
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
    recentTxPush(trimmed);
    return;
  }
  // Throw (don't silently resolve) so the serialized chain and direct awaiters (busOpen, TX
  // scheduler) see the failure instead of proceeding as if the write happened. serialWriteChain
  // (.catch above) keeps the queue from being poisoned.
  if (!port || !port.writable) throw new Error('Not connected');
  const writer = port.writable.getWriter();
  try {
    await writer.write(encodeCmd(trimmed));
    termLog('tx', trimmed + '\\r');
    recentTxPush(trimmed);
  } finally {
    writer.releaseLock();
  }
}
// Diagnostic ring of the last few SLCAN commands actually written, surfaced when the adapter BELLs.
const recentTx = [];
function recentTxPush(cmd) { recentTx.push(cmd); if (recentTx.length > 8) recentTx.shift(); }

async function openWebUSBCDC() {
  const dev = await navigator.usb.requestDevice({filters: SERIAL_USB_FILTERS});
  await dev.open();
  // Wrap post-open() setup: a throw here (interface not found, failing claimInterface) would
  // otherwise leave the device claimed until page reload, so a retry can't re-acquire it.
  try {
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
  } catch (e) {
    try { await dev.close(); } catch (_) { /* best-effort */ }
    throw e;
  }
}

// ── gs_usb transport ───────────────────────────────────────────────────────────
// Open a gs_usb device: claim its vendor interface, find bulk endpoints, send the
// host-format marker, and read BT_CONST for the CAN clock. Structurally mirrors
// openWebUSBCDC but speaks the gs_usb vendor protocol instead of CDC-ACM.
async function openGsUsb() {
  const dev = await navigator.usb.requestDevice({filters: GSUSB_FILTERS});
  await dev.open();
  // Wrap post-open() setup: a throw here (vendor interface not found, failing claimInterface or
  // HOST_FORMAT transfer) would otherwise leave the device claimed until reload.
  try {
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

    // GS_USB_BREQ_HOST_FORMAT - little-endian byte-order marker (0x0000beef)
    const hf = new ArrayBuffer(4);
    new DataView(hf).setUint32(0, 0x0000beef, true);
    await dev.controlTransferOut(
      {requestType: 'vendor', recipient: 'interface', request: GS_BREQ.HOST_FORMAT, value: 1, index: iface},
      hf
    );

    // GS_USB_BREQ_BT_CONST - read the CAN clock and bit-timing limits (struct gs_device_bt_const,
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
  } catch (e) {
    try { await dev.close(); } catch (_) { /* best-effort */ }
    throw e;
  }
}

// Solve CAN bit timing for the device clock and target bitrate, targeting an 87.5% sample
// point while respecting the device's segment/brp limits (gsBtConst). Returns the chosen
// {prop_seg, phase_seg1, phase_seg2, sjw, brp} plus {ntq, sp, actual} for logging.
// One bit-timing search pass. strict=true gates on <0.5% bitrate error and rejects any
// candidate whose phase_seg2 overflows tseg2_max; strict=false (relaxed fallback) drops the
// bitrate gate and clamps an overflowing phase_seg2 to tseg2_max (recomputing tseg1). Returns
// the best {…}/null. The strict pass returns early when it finds a hit, so the relaxed pass
// always starts fresh - the two passes never share search state.
function gsBitTimingPass(fclk, bitrate, bt, SP, strict) {
  let best = null, bestScore = Infinity;
  for (let brp = bt.brp_min; brp <= bt.brp_max; brp += bt.brp_inc) {
    const ntq = Math.round(fclk / (brp * bitrate));   // total time quanta incl. sync
    if (ntq < 1 + bt.tseg1_min + bt.tseg2_min) continue;
    const actual = fclk / (brp * ntq);
    const brErr = Math.abs(actual - bitrate) / bitrate;
    if (strict && brErr > 0.005) continue;             // strict pass: <0.5% bitrate error
    let tseg1 = Math.min(Math.max(Math.round(ntq * SP) - 1, bt.tseg1_min), bt.tseg1_max); // prop_seg + phase_seg1
    let tseg2 = ntq - 1 - tseg1;                       // phase_seg2
    if (tseg2 < bt.tseg2_min) continue;
    if (tseg2 > bt.tseg2_max) {
      if (strict) continue;
      tseg2 = bt.tseg2_max; tseg1 = ntq - 1 - tseg2;   // relaxed: clamp and recompute tseg1
      if (tseg1 < bt.tseg1_min || tseg1 > bt.tseg1_max) continue;
    }
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
function gsCalcBitTiming(fclk, bitrate) {
  const bt = gsBtConst, SP = 0.875;
  return gsBitTimingPass(fclk, bitrate, bt, SP, true) || gsBitTimingPass(fclk, bitrate, bt, SP, false);
}

// GS_USB_BREQ_BITTIMING - must be sent while the device is in RESET (before MODE START).
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

// GS_USB_BREQ_MODE - START (open bus) or RESET (close bus).
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
// length - a 12-byte header (echo_id, can_id, dlc, channel, flags, reserved) followed by
// exactly `dlc` data bytes (no padding), plus an optional trailing timestamp we don't enable
// and ignore. (A 20-byte read assumption would silently drop every frame with dlc < 8.)
// A halted IN endpoint surfaces as transferIn resolving with status 'stall'/'babble'
// (not a throw). Clear the halt and retry rather than tearing down the whole connection;
// only disconnect if recovery fails or the stall persists.
// Disconnect after this many stalls with NO successful read in between. `stalls` is reset to 0 by
// any successful transferIn (below), so an intermittent stall-and-recover (stall → clearHalt →
// good read) never accumulates; reaching the cap means the endpoint is wedged with zero progress.
// (A recovered clearHalt deliberately does NOT reset the counter on its own - that would let a
// pure stall/recover loop that never delivers data spin forever.)
const USB_MAX_STALLS = 8;
async function usbRecoverStall() {
  if (!usbSerDev) return false;
  try { await usbSerDev.clearHalt('in', usbSerIn); return true; }
  catch { return false; }
}

async function gsUsbPump() {
  let stalls = 0;
  try {
    while (usbSerDev && connMode === 'gsusb') {
      const r = await usbSerDev.transferIn(usbSerIn, 64);
      if (r.status !== 'ok') {
        if (++stalls > USB_MAX_STALLS || !(await usbRecoverStall())) {
          if (usbSerDev) { log(`Serial read stalled (${r.status}) - disconnecting`, 'err'); disconnectSerial(); }
          return;
        }
        continue;
      }
      stalls = 0;
      if (!r.data || r.data.byteLength < 12) continue;   // need at least one header
      bytesReceived += r.data.byteLength;
      document.getElementById('statBytes').textContent = bytesReceived.toLocaleString();
      const dv = r.data;
      // A bulk-IN transfer can coalesce several variable-length gs_host_frames (12-byte header +
      // dlc data bytes each). Current firmware sends one per URB, but walk the buffer in
      // (12 + dlc) strides so a coalescing device doesn't silently drop every frame after the first.
      let off = 0;
      while (off + 12 <= dv.byteLength) {
        const echo_id = dv.getUint32(off, true);
        const can_id  = dv.getUint32(off + 4, true);
        const dlc     = dv.getUint8(off + 8);
        const n = Math.min(dlc, 8, dv.byteLength - (off + 12));   // bytes actually present
        // echo_id !== 0xFFFFFFFF = TX echo (bookkeeping done in txSendOne); CAN_ERR_FLAG = error
        // frame. Both are skipped for ingest but still consume their (12 + dlc) bytes.
        if (echo_id === 0xFFFFFFFF && !(can_id & CAN_ERR_FLAG)) {
          const isExt = !!(can_id & CAN_EFF_FLAG);
          const isRtr = !!(can_id & CAN_RTR_FLAG);
          const id    = can_id & (isExt ? CAN_EFF_MASK : CAN_SFF_MASK);
          const data = [];
          for (let i = 0; i < n; i++) data.push(dv.getUint8(off + 12 + i));
          totalFrames++;
          frameRateBuffer.push(Date.now());
          // Report dlc as the bytes actually present (n), not the raw header field, so a garbled
          // or short transfer can't make downstream renderers/exporters read phantom bytes.
          if (!paused) ingestFrame({ id, isExt, isRtr, dlc: n, data });
        }
        if (dlc > 8) break;            // corrupt header - stride is untrustworthy, drop the rest
        off += 12 + dlc;
      }
    }
  } catch (e) {
    if (usbSerDev) { log(`Serial read error: ${e.message}`, 'err'); disconnectSerial(); }
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

// Read size: a bulk transferIn resolves on a short packet, so a large buffer never adds latency -
// it only lets us drain many frames per USB round-trip. 512 was too small: at high bus rates (e.g.
// a RAMN board reporting ~435 frames/s) on mobile, where each round-trip has real latency, the host
// couldn't keep up and the adapter's device→host buffer overflowed → corrupted/spliced SLCAN lines
// (raw(unparsed) with out-of-band bytes) and eventually a desync (RX → 0). A big buffer keeps up.
const USB_SERIAL_READ = 16384;
async function usbSerialPump() {
  const decoder = new TextDecoder();
  let stalls = 0;
  try {
    while (usbSerDev) {
      const r = await usbSerDev.transferIn(usbSerIn, USB_SERIAL_READ);
      if (r.status !== 'ok') {
        if (++stalls > USB_MAX_STALLS || !(await usbRecoverStall())) {
          if (usbSerDev) { log(`Serial read stalled (${r.status}) - disconnecting`, 'err'); disconnectSerial(); }
          return;
        }
        continue;
      }
      stalls = 0;
      if (r.data && r.data.byteLength > 0) {
        bytesReceived += r.data.byteLength;
        document.getElementById('statBytes').textContent = bytesReceived.toLocaleString();
        dispatchSerialText(decoder.decode(r.data, { stream: true }));
      }
    }
  } catch(e) {
    if (usbSerDev) { log(`Serial read error: ${e.message}`, 'err'); disconnectSerial(); }
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
      // Vxxyy - hardware xx, firmware yy
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
      // Surface the last few commands actually written so we can tell a corrupt/garbled command
      // (e.g. two SLCAN frames concatenated) from a valid-but-rejected one.
      log('Adapter returned error (bell/0x07) - last sent: ' + (recentTx.slice(-4).join(' | ') || '(none)'), 'err');
      continue;
    }

    parseSLCAN(trimmed);
  }
  // Desync guard: a normal pending partial frame is tiny (<~25 bytes), so >4 KB with no CR means
  // the stream has lost its frame delimiters (adapter buffer corruption). Drop the garbage and let
  // the next CR re-sync, instead of scanning an ever-growing buffer (O(n²)) and stalling RX at 0.
  if (frameBuffer.length > 4096) {
    frameBuffer = '';
    const now = Date.now();
    if (now - lastDesyncWarn > 2000) { lastDesyncWarn = now; log('Serial stream desynced (no frame delimiter) - re-syncing RX buffer', 'warn'); }
  }
}
let lastDesyncWarn = 0;

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
// (malformed/truncated) or throws - recognised status/timestamp lines stay silent.
function parseSLCAN(line) {
  try {
    const type = line[0];
    let frame = null;

    if (type === 't' || type === 'r') {
      // Standard 11-bit
      if (line.length < 5) { parseErrors++; log(`raw(unparsed): ${escRawLine(line)}`, 'warn'); return; }
      const idHex = line.substring(1, 4);
      const dlc = parseInt(line[4], 16);
      const isRtr = type === 'r';
      // Validate before parsing: bad ID/DLC or a short/garbage data field would otherwise
      // push NaN bytes into the frame model (rendered + exported). Drop as a parse error instead.
      if (!isHexStr(idHex) || !(dlc >= 0 && dlc <= 8)) { parseErrors++; log(`raw(unparsed): ${escRawLine(line)}`, 'warn'); return; }
      const dataHex = isRtr ? '' : line.substring(5, 5 + dlc * 2);
      if (dataHex.length !== (isRtr ? 0 : dlc * 2) || !isHexStr(dataHex)) { parseErrors++; log(`raw(unparsed): ${escRawLine(line)}`, 'warn'); return; }
      const id = parseInt(idHex, 16);
      const data = hexToBytes(dataHex);
      frame = { id, dlc, data, isRtr, isExt: false };
    } else if (type === 'T' || type === 'R') {
      // Extended 29-bit
      if (line.length < 10) { parseErrors++; log(`raw(unparsed): ${escRawLine(line)}`, 'warn'); return; }
      const idHex = line.substring(1, 9);
      const dlc = parseInt(line[9], 16);
      const isRtr = type === 'R';
      if (!isHexStr(idHex) || !(dlc >= 0 && dlc <= 8)) { parseErrors++; log(`raw(unparsed): ${escRawLine(line)}`, 'warn'); return; }
      const dataHex = isRtr ? '' : line.substring(10, 10 + dlc * 2);
      if (dataHex.length !== (isRtr ? 0 : dlc * 2) || !isHexStr(dataHex)) { parseErrors++; log(`raw(unparsed): ${escRawLine(line)}`, 'warn'); return; }
      const id = parseInt(idHex, 16);
      const data = hexToBytes(dataHex);
      frame = { id, dlc, data, isRtr, isExt: true };
    } else {
      // status, timestamps, etc - recognised non-frame line, ignore silently
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
    log(`raw(unparsed): ${escRawLine(line)} - ${e.message}`, 'err');
  }
}

// Matches an all-hex string (empty allowed, for RTR / DLC-0 data fields).
const HEX_STR_RE = /^[0-9A-Fa-f]*$/;
function isHexStr(s) { return HEX_STR_RE.test(s); }

function hexToBytes(hex) {
  const bytes = [];
  // Step in full byte-pairs (i+1 < length) so a trailing odd nibble is dropped, not parsed
  // as a partial byte; bail on any non-hex pair rather than pushing NaN into the frame.
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const b = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(b)) break;
    bytes.push(b);
  }
  return bytes;
}
