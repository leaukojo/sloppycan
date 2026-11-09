// ── SAE J1939 — the carlito `j1939` flavor packer ─────────────────────────────
// The contract says a flavor borrows a protocol's signal names/semantics "without implementing
// its CAN frames - frame layout stays on the sloppyCAN side", and this file is that side for the
// truck's four `j1939`-flavored out signals. It registers on window.carlitoFlavorPackers, which
// carlito.js reads for both packing and its checkCanCoverage assertion. Same bolt-on pattern as
// isobus.js, and for the same reason it has no tab: j1939.js's decoder already renders every
// frame this file emits, and a second view would be a second, worse one.
//
// THE FILE IS NOT NAMED j1939.js BECAUSE THAT NAME IS TAKEN by the tab module, which is a
// different thing: that one DECODES the bus and owns the request path, this one PACKS four game
// signals into three parameter groups. They are separate files for a load-order reason as well -
// carlito-bridge.html loads this and not j1939.js, so the truck keeps its frames on that page.
//
// ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
// This is the one carlito flavor whose layout is entirely LOOKED UP rather than decided: every
// signal here has a real SPN, so no proprietary id is invented for any of them. Every PGN, SPN,
// resolution, offset, transmission repetition rate and default priority below was read off
// SAE J1939-71 itself (the December 2001 application layer document), never off a plan document -
// the dronecan.js/isobus.js rule, and the reason this file can be trusted at all:
//   61440 ERC1  100 ms, prio 6, PDU2. 1.1 SPN 900 Retarder Torque Mode (4 bits);
//               byte 2 SPN 520 Actual Retarder - Percent Torque, 1 %/bit, -125 offset.
//   65198 AIR1  1 s, prio 6, PDU2. Byte 3 SPN 1087 Service Brake Air Pressure Circuit #1 and
//               byte 4 SPN 1088 Circuit #2, both 8 kPa/bit, 0 offset, range 0-2000 kPa.
//   65258 VW    ON REQUEST, prio 6, PDU2. Byte 1 SPN 928 Axle Location;
//               bytes 2-3 SPN 582 Axle Weight, 0.5 kg/bit, 0 offset.
//   65103 VDC1  100 ms, prio 6, PDU2. 2-bit states (00 off/passive, 01 on/active, 11 n/a):
//               1.1 SPN 1813 VDC Information Signal, 1.3 SPN 1814 VDC Fully Operational (not,
//               when "disabled by a switch"), 1.5 SPN 1815 VDC brake light request; 2.1 SPN 1816
//               ROP Engine, 2.3 SPN 1818 ROP Brake, 2.5 SPN 1817 YC Engine, 2.7 SPN 1819 YC Brake
//               Control active. (pp. 222-223, 322.)
//   61449 VDC2  10 ms, prio 6, PDU2. Bytes 1-2 SPN 1807 Steering Wheel Angle; 3.1 SPN 1811 /
//               3.7 SPN 1812; bytes 4-5 SPN 1808 Yaw Rate, 1/8192 rad/s, -3.92 offset, + turning
//               counter-clockwise; 6-7 SPN 1809 Lateral Acceleration, 1/2048 m/s², -15.687, + to
//               the left; byte 8 SPN 1810 Longitudinal Acceleration, 0.1 m/s², -12.5, + "when the
//               vehicle speed increases, regardless of driving the vehicle forward or backward".
//               (pp. 220-221, 308.)
// And the five MIRRORS (see "Decision 1" below), off the same document's group and SPN pages:
//   61444 EEC1  engine speed dependent, prio 3. Bytes 4-5 SPN 190 Engine Speed, 0.125 rpm/bit.
//   65265 CCVS  100 ms, prio 6. Bytes 2-3 SPN 84 Wheel-Based Vehicle Speed, 1/256 km/h per bit.
//   65262 ET1   1 s, prio 6. Byte 1 SPN 110 Engine Coolant Temperature, 1 degC/bit, -40 offset.
//   65276 DD    1 s, prio 6. Byte 2 SPN 96 Fuel Level, 0.4 %/bit.
//   65271 VEP1  1 s, prio 6 ("VEP" in that edition). Bytes 5-6 SPN 168 Electrical Potential
//               (Voltage), 0.05 V/bit.
// Source addresses come off j1939.js's own J1939_SA table (checked against isobus.net's
// SourceAddress table). All three groups are in j1939.js's J1939_DB with their neighbouring
// SPNs, so they decode named and scaled - a decode table is not scoped to what this packer
// happens to emit.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   index.html           <script src="j1939-flavor.js" defer> after carlito-registry.js and
//                        j1939-pack.js
//   carlito-bridge.html  same script tag. That page loads neither sloppycan.js nor j1939.js,
//                        so every cross-module read here is typeof-guarded.
//   j1939-tables.js      J1939_DB += 0xF000 ERC1 / 0xFEAE AIR1 / 0xFEEA VW / 0xFE4F VDC1, and
//                        EBC1 / VDC2 / TC1 / CCVS SPN 70 for the driver demand (VDC2 also its
//                        sensor SPNs)
//   j1939.js             the VW entry on J1939_REQ_SERVERS that answers a request for
//                        axle_load, and its demo sends j1939DriveFrames; window.j1939DemoDrive
//                        is the demand merged into the game's EEC2 / VDC2 / CCVS. Its base
//                        traffic builds EEC1 / ET1 / CCVS / VEP1 / DD through
//                        window.j1939FlavorFrames and paces them by window.j1939FlavorMsgs' `ms`
//   isobus.js            sends EEC1 (with its engine_load) through window.j1939Eec1Frame
//   carlito-registry.js  window.carlitoJ1939Network, the mirrors' truck-or-tractor gate;
//                        window.carlitoUplinkClaim (DRIVER DEMAND, read by carlito.js)
//   carlito.js           window.carlitoUplinkDecoders (DRIVER DEMAND)
//
// Telemetry TX rides carlito.js's canForward gateway, which is what puts these on the wire and
// in the dump as FW entries. No transport code here.

(function () {
  'use strict';

  // ── Wire primitives ─────────────────────────────────────────────────────────
  // j1939-pack.js (window.J1939Pack): id build/parse, the 0xFF blank, the Table 1 clamp and the
  // bit writer. The self-test round-trips its frames against j1939.js's own decoder wherever that
  // IS loaded. All the status groups here are PDU2 broadcasts; TC1 is the one PDU1 (to the
  // transmission). A bit position is 0-based within its byte, so the standard's "1.1" is b=0, bit=0.
  const jp = window.J1939Pack;

  // ── Source addresses ────────────────────────────────────────────────────────
  // THE ONE PLACE AN ADDRESS IS DECLARED (dronecan-core.js's DC_ROSTER rule), all off J1939_SA.
  // The retarder one is a real choice rather than a lookup: J1939-71's own ERC1 note says the
  // message is sent by several kinds of retarding device and "the source address of the message
  // will indicate which one". The contract's `retarder` desc says A REAL BRAKE ACTING THROUGH THE
  // DRIVELINE ON THE DRIVEN AXLE - so it is the driveline retarder at 0x10, not the engine
  // retarder at 0x0F, and picking 0x0F would misname the device on the wire.
  const SA_RETARDER = 0x10;   // Retarder - Driveline
  const SA_BRAKES   = 0x0B;   // Brakes - System Controller (the ECU that knows the reservoirs)
  const SA_AXLE_DRV1 = 0x09;  // Axle - Drive #1; the address isobus.js already sources EAC1 from
  const SA_TRANSMISSION = 0x03;  // Transmission #1 - ETC2's sender and TC1's destination
  // Engine #1 sends EEC1 / EEC2 / ET1 / VEP1 (its own speed, load, coolant and supply voltage) and
  // CCVS: cruise control is an engine-controller function, regulating on the wheel-based speed
  // that group carries.
  const SA_ENGINE = 0x00;
  // Instrument Cluster #1 sends DD: the fuel level sender is wired to the cluster, which drives the
  // gauge and publishes the level - an engine controller is a DD listener, not its source.
  const SA_CLUSTER = 0x17;

  // ── Message table ───────────────────────────────────────────────────────────
  // Data, not call sites. `ms` is the standard's own transmission repetition rate - no cadence in
  // this file is invented. j1939.js's demo traffic gates on it; jfPack's ticks below are chosen
  // to match it, as far as the bridge's ~50 ms message rate allows.
  // VW HAS NO ENTRY HERE ON PURPOSE: its rate is literally "On request", so it is not a message
  // this packer sends at all. It lives on J1939_REQ_SERVERS in j1939.js - see `onRequest` below.
  const JF_MSGS = {
    ERC1: { pgn: 61440, prio: 6, sa: SA_RETARDER, ms: 100 },
    AIR1: { pgn: 65198, prio: 6, sa: SA_BRAKES,   ms: 1000 },
    ETC2: { pgn: 61445, prio: 6, sa: SA_TRANSMISSION, ms: 100 },
    // The stability unit lives in the brake system controller (the EBS that brakes the wheels).
    VDC1: { pgn: 65103, prio: 6, sa: SA_BRAKES, ms: 100 },
    VDC2: { pgn: 61449, prio: 6, sa: SA_BRAKES, ms: 10 },
    // EEC2 carries the demo's pedal only (SPN 91): the game publishes no pedal position, and
    // `engine_load` is NOT EEC2's SPN 92 (the contract says so) - see EEC1.
    EEC2: { pgn: 61443, prio: 3, sa: SA_ENGINE, ms: 50 },
    // EEC1: the rpm mirror (SPN 190) and `engine_load` (SPN 513 Actual Engine - Percent Torque,
    // J1939-71 p.56: byte 3, 1 %/bit, -125 % offset - the contract's "SPN 513-like"). Its rate
    // is "engine speed dependent", so 0: it rides every call.
    EEC1: { pgn: 61444, prio: 3, sa: SA_ENGINE,  ms: 0 },
    CCVS: { pgn: 65265, prio: 6, sa: SA_ENGINE,  ms: 100 },
    ET1:  { pgn: 65262, prio: 6, sa: SA_ENGINE,  ms: 1000 },
    DD:   { pgn: 65276, prio: 6, sa: SA_CLUSTER, ms: 1000 },
    VEP1: { pgn: 65271, prio: 6, sa: SA_ENGINE,  ms: 1000 },
  };

  // ── Telemetry presence ──────────────────────────────────────────────────────
  // Gated per SIGNAL, never per vehicle - isobus.js's rule, and it holds here for the same
  // reason: the game publishes signals_for_vehicle, so an absent key is a real absence and not a
  // zero. axle_load is already the tractor's as well as the truck's (the other three are the
  // truck's alone), and a vehicle gate would be a second place the contract's `vehicles` list is
  // written down, and it would be the one that rots. (The decision-1 mirrors below are the one
  // exception, and they say why.)
  const has = jp.has;

  const BAR_TO_KPA = 100;   // the contract's unit for both air pressures -> the SPNs' unit

  // ── Builders ────────────────────────────────────────────────────────────────
  // SPN 520 IS NEGATIVE AND `retarder_state` IS A MAGNITUDE, and this is the one place that sign
  // lives. J1939-71 gives SPN 520 an operating range of -125..0 % because a retarder is a brake;
  // the contract publishes 0..100 deliberately ("the dashboard generates its bars straight from
  // 'range' and a [-100, 0] range would fill the RET bar backwards... the sign convention is
  // documented here rather than encoded"). So the game's number is negated on its way to the
  // wire, and a listener reading -40 % and a driver reading a 40 % bar are seeing one fact.
  function jfErc1(t) {
    const d = jp.blank();
    jp.put(d, 1, 1, -Number(t.retarder_state), 1, -125);
    // 1.1 SPN 900 Retarder Torque Mode, 4 bits. Mode 0000b is the one value J1939-71 states in
    // the text: "'No request': ... retarder torque = 0 (no braking)". The other fifteen live in
    // TABLE SPN899_A, which is a FIGURE in the document and did not come out of it - so a
    // retarder that is doing something leaves the field at 1111b "not available" rather than
    // claiming a mode name this file never read. Stating the gap beats guessing 0001b.
    if (Number(t.retarder_state) === 0) jp.bits(d, 0, 0, 4, 0);
    return jp.msgFrame(JF_MSGS.ERC1, d);
  }

  // ETC2 (61445): SPN 524 Selected Gear and SPN 523 Current Gear from the contract's engaged `gear`
  // byte (the game reports the gear it engaged, so the two agree; a CVT's is its range), and SPN 526
  // Actual Gear Ratio from `gear_ratio`, 0.001 per bit over bytes 2-3. The gear bytes take TC1's own
  // encoding (jfGearRaw: offset -125, R as -1, P 251); N is gear 0, raw 125.
  function jfEtc2(t) {
    const d = jp.blank();
    if (has(t, 'gear')) d[0] = d[3] = jfGearRaw(Number(t.gear));
    if (has(t, 'gear_ratio')) jp.put(d, 1, 2, Number(t.gear_ratio), 0.001, 0);
    return jp.msgFrame(JF_MSGS.ETC2, d);
  }

  function jfAir1(t) {
    const d = jp.blank();
    // Bytes 3 and 4 (0-indexed 2 and 3), 8 kPa/bit. Byte 1 SPN 46 Pneumatic Supply Pressure (the
    // wet tank) and byte 2 SPN 1086 Parking and/or Trailer Air Pressure stay "not available": the
    // contract models exactly two service circuits, and the truck's spring brakes are a
    // CONSEQUENCE of the minimum of the two rather than a third reservoir with a pressure of its
    // own. Filling either from air_primary would put the same number on the wire twice.
    if (has(t, 'air_primary'))   jp.put(d, 2, 1, Number(t.air_primary) * BAR_TO_KPA, 8, 0);
    if (has(t, 'air_secondary')) jp.put(d, 3, 1, Number(t.air_secondary) * BAR_TO_KPA, 8, 0);
    return jp.msgFrame(JF_MSGS.AIR1, d);
  }

  // The contract's `status` bits VDC reads (VehicleTelemetry.ST_*): ESC braking (yaw or roll),
  // the brake-light request, a fitted ESC switched off, yaw, roll.
  const stBit = (b) => window.carlitoBit('status', b);
  const ST = { ESC: stBit('esc'), BRAKE_LIGHT: stBit('brake_light'), OFF: stBit('esc_off'), YAW: stBit('esc_yaw'), ROLL: stBit('esc_roll') };

  // VDC1 (65103) off the status bits. The lamp (SPN 1813) is on while ESC acts or is switched
  // off; the cluster flashes the first and holds the second (its own rule). Each control's ENGINE
  // state copies its brake state: the game's fuel trim rides the same braking, never alone.
  // Byte 1's bits 7-8 and bytes 3-8 stay 0xFF: SPN 5624 is not in the edition this was read off.
  function jfVdc1(t) {
    const d = jp.blank();
    const s = Number(t.status) || 0;
    const on = (bit) => (s & bit) ? 1 : 0;
    jp.bits(d, 0, 0, 2, (s & (ST.ESC | ST.OFF)) ? 1 : 0);   // 1813 VDC Information Signal
    jp.bits(d, 0, 2, 2, on(ST.OFF) ? 0 : 1);                 // 1814 VDC Fully Operational
    jp.bits(d, 0, 4, 2, on(ST.BRAKE_LIGHT));                 // 1815 VDC brake light request
    jp.bits(d, 1, 0, 2, on(ST.ROLL));                        // 1816 ROP Engine Control active
    jp.bits(d, 1, 2, 2, on(ST.ROLL));                        // 1818 ROP Brake Control active
    jp.bits(d, 1, 4, 2, on(ST.YAW));                         // 1817 YC Engine Control active
    jp.bits(d, 1, 6, 2, on(ST.YAW));                         // 1819 YC Brake Control active
    return jp.msgFrame(JF_MSGS.VDC1, d);
  }

  // ── ONE ENCODER PER GROUP the driver demand shares with the game ─────────────
  // VDC2 and CCVS each carry a driver-demand field (`c`, the demo's RAMN panel state, or null)
  // beside a game field (`t`). While the game's group is on the bus it is the group's ONE
  // producer - j1939.js's demo stops sending its own - so the demand rides inside it: one frame
  // per tick, never two from the same address alternating. The demo's own frames, when the game is
  // not sending the group, come out of the same functions (j1939DriveFrames, t = null).
  // A null `c` leaves its field "not available", so the frame's echo refreshes nothing and the
  // claim lapses on JF_DRIVE_TTL_MS rather than latching the last pedal.
  // EEC2 has no game half (the game sends no EEC2), so it is the demo's alone.
  function jfEec2(c) {
    const d = jp.blank();
    if (c) jp.put(d, 1, 1, Math.max(0, Math.min(100, Number(c.accel) || 0)), 0.4, 0);  // SPN 91
    // Bytes 3-4, SPN 92 and SPN 974 Remote Accelerator, stay "not available".
    return jp.msgFrame(JF_MSGS.EEC2, d);
  }

  // VDC2 (61449) off the unit's sensors as the game measured them, plus SPN 1807 Steering Wheel
  // Angle from the demo's wheel while it drives. Without one it stays 0xFFFF: the game steers road
  // wheels, not a hand wheel, and that is also what keeps this frame's echo out of jfDecodeDrive's
  // steer. The game's `yaw` is + counter-clockwise like SPN 1808; `accLat` is + to the RIGHT, so it
  // is negated for SPN 1809; `accLong` is + forward, so it is signed by the direction of travel for
  // SPN 1810 (+ speeding up either way).
  function jfVdc2(t, c) {
    const d = jp.blank();
    if (c) {
      const rad = -Math.max(-100, Math.min(100, Number(c.steer) || 0)) / 100 * FULL_LOCK_RAD;
      jp.put(d, 0, 2, rad, 1 / 1024, -31.374);
    }
    if (has(t, 'yaw')) jp.put(d, 3, 2, Number(t.yaw), 1 / 8192, -3.92);
    if (has(t, 'accLat')) jp.put(d, 5, 2, -Number(t.accLat), 1 / 2048, -15.687);
    if (has(t, 'accLong')) {
      const dir = Number(t.speed) < 0 ? -1 : 1;
      jp.put(d, 7, 1, dir * Number(t.accLong), 0.1, -12.5);
    }
    return jp.msgFrame(JF_MSGS.VDC2, d);
  }

  // CCVS (65265): SPN 84 from `kmh` (a mirror), SPN 70 / 597 from the demo's switches.
  function jfCcvs(t, c) {
    const d = jp.blank();
    if (has(t, 'kmh')) jp.put(d, 1, 2, Number(t.kmh), 1 / 256, 0);
    if (c) j1939CcvsPatch(d, c);
    return jp.msgFrame(JF_MSGS.CCVS, d);
  }

  // ── DECISION 1: J1939 MIRRORS (truck and tractor only) ─────────────────────
  // rpm / kmh / coolant / fuel / battery are UNFLAVORED, so CAN_MAP owns them (0x521 / 0x520 /
  // 0x528) and keeps them. A truck or tractor ALSO carries them in their J1939 groups, because a
  // J1939 view of a truck with no engine speed is the stranger result: an explicit exception to
  // "the same signal on the wire twice under two identities" (carlito.js, the 0x52B note),
  // declared as `mirrors` so the coverage check reports it instead of hiding it. A car, boat or
  // plane publishes the same five and has no J1939 network, so the gate IS the vehicle here - the
  // one place this file gates per vehicle - on carlito-registry.js's shared rule. Every other field
  // of the five groups stays "not available": the game publishes no torque, no oil temperature.
  const jfMirrored = (t) => !!window.carlitoJ1939Network && window.carlitoJ1939Network(t);
  // EEC1 is ONE frame from Engine #1 carrying two owners' signals: the rpm mirror (this file's)
  // and `engine_load` (isobus.js's flavor). isobus.js sends it whenever `engine_load` is there,
  // through window.j1939Eec1Frame with the rpm inside; jfPack sends it only when it is not - one
  // EEC1 per tick, never two from the engine alternating.
  function jfEec1(t) {
    const d = jp.blank();
    if (has(t, 'engine_load')) jp.put(d, 2, 1, t.engine_load, 1, -125);   // SPN 513
    if (has(t, 'rpm')) jp.put(d, 3, 2, Number(t.rpm), 0.125, 0);          // SPN 190
    return jp.msgFrame(JF_MSGS.EEC1, d);
  }
  function jfEt1(t) {
    const d = jp.blank();
    jp.put(d, 0, 1, Number(t.coolant), 1, -40);                  // SPN 110
    return jp.msgFrame(JF_MSGS.ET1, d);
  }
  function jfDd(t) {
    const d = jp.blank();
    jp.put(d, 1, 1, Number(t.fuel), 0.4, 0);                     // SPN 96
    return jp.msgFrame(JF_MSGS.DD, d);
  }
  function jfVep1(t) {
    const d = jp.blank();
    jp.put(d, 4, 2, Number(t.battery), 0.05, 0);                 // SPN 168
    return jp.msgFrame(JF_MSGS.VEP1, d);
  }

  // The demo's driver demand, from j1939.js (null on carlito-bridge.html, which has no demo).
  const jfDemoDrive = () => typeof window.j1939DemoDrive === 'function' ? window.j1939DemoDrive() : null;

  // ── Pack ────────────────────────────────────────────────────────────────────
  // carlito.js calls this on every telemetry message with `slow` alternating, so the natural
  // cadences are ~20 Hz (every call) and ~10 Hz (on `slow`). ERC1's 100 ms IS the slow tick.
  // AIR1's 1 s gets a wall-clock gate rather than a counter - the same shape as isobus.js's
  // 500 ms sweep - because 1 s is the standard's rate and must not drift with the frame rate.
  let jfLast1s = 0;
  function jfPack(t, slow) {
    if (!t) return [];
    const out = [];
    const drive = jfDemoDrive();
    const mirror = jfMirrored(t);

    if (slow && has(t, 'retarder_state')) out.push(jfErc1(t));          // 100 ms
    if (slow && has(t, 'gear_ratio')) out.push(jfEtc2(t));              // 100 ms
    // VDC rides an air-braked truck's EBS: `air_primary` is the truck's alone, and `status`,
    // `yaw` and the accelerations come from every vehicle, so they cannot gate it. VDC2's
    // standard rate is 10 ms; it goes out on every call (~50 ms), the fastest the bridge carries,
    // never a repeat clock re-sending stale values.
    if (has(t, 'air_primary') && has(t, 'status')) {
      if (slow) out.push(jfVdc1(t));                                     // 100 ms
      out.push(jfVdc2(t, drive));                                        // every call
    }
    // EEC1's rate follows engine speed, faster than the bridge carries: every call, like VDC2.
    // With `engine_load` present it is isobus.js's to send, rpm inside (jfEec1).
    if (mirror && has(t, 'rpm') && !has(t, 'engine_load')) out.push(jfEec1(t));   // every call
    if (mirror && slow && has(t, 'kmh')) out.push(jfCcvs(t, drive));    // 100 ms

    if (Date.now() - jfLast1s >= 1000) {                                // 1 s
      const sec = [];
      if (has(t, 'air_primary') || has(t, 'air_secondary')) sec.push(jfAir1(t));
      if (mirror && has(t, 'coolant')) sec.push(jfEt1(t));
      if (mirror && has(t, 'fuel')) sec.push(jfDd(t));
      if (mirror && has(t, 'battery')) sec.push(jfVep1(t));
      // Only move the clock when there WAS something to send, so a vehicle with none of these
      // does not leave the gate permanently open for the vehicle that follows it.
      if (sec.length) { jfLast1s = Date.now(); out.push(...sec); }
    }
    // Each source claims its address before its first frame (j1939-pack.js).
    return jp.claimFirst(out, t);
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'j1939',
    signals: ['air_primary', 'air_secondary', 'retarder_state', 'gear_ratio'],
    // Carried, but not on a clock. SPN 582 Axle Weight rides PGN 65258 (VW), whose J1939-71
    // transmission repetition rate is literally "On request" - so it has no periodic frame by
    // design, and broadcasting it at 10 Hz would misstate its rate the same way broadcasting
    // speed_limit would have. j1939.js's request path answers a PGN 59904 request for it out of
    // the live telemetry, as it does for CCSS and HOURS. This packer sends
    // nothing for it, which is why it is not in `signals` either.
    onRequest: {
      axle_load: 'SPN 582 Axle Weight rides PGN 65258 (VW), whose J1939-71 transmission ' +
        'repetition rate is "On request" - there is no periodic frame to put it in, and the ' +
        'group\'s own note ("respond with as many messages as necessary") is about a REQUEST ' +
        'being answered, not about a broadcast. j1939.js answers a PGN 59904 request for it ' +
        'from Axle - Drive #1, with SPN 928 Axle Location saying which axle the weight is',
    },
    // Decision 1: CAN_MAP's signals, carried AGAIN in their J1939 groups for a truck or tractor.
    mirrors: {
      rpm:     'EEC1 (61444) SPN 190 Engine Speed, truck and tractor only',
      kmh:     'CCVS (65265) SPN 84 Wheel-Based Vehicle Speed, truck and tractor only',
      coolant: 'ET1 (65262) SPN 110 Engine Coolant Temperature, truck and tractor only',
      fuel:    'DD (65276) SPN 96 Fuel Level, truck and tractor only',
      battery: 'VEP1 (65271) SPN 168 Electrical Potential, truck and tractor only',
    },
    pack: jfPack,
    // A bus that was not listening heard no claim: every source claims again on its next frame.
    reset: () => jp.forgetClaims(),
  });

  // ── The retarder REQUEST (contract `retarder`, dir "in") ─────────────────────
  // This file owns the truck's retarder stalk, the inbound twin of the ERC1 it packs: truck.js's
  // slider is a view over this state through window.j1939FlavorCtl / j1939FlavorSetCtl, and the
  // value leaves through the uplink registry. A stalk has a position whether or not anyone is
  // touching it, so it is always sent, and its resting 0 is the game's own absent-default.
  //
  // NO FRAME DRIVES IT YET. The real carrier is TSC1 (PGN 0, Torque/Speed Control 1) addressed to
  // the driveline retarder at SA_RETARDER, its byte-4 SPN 518 Requested Torque/Torque Limit
  // (1 %/bit, -125 offset) carrying the negative percentage under SPN 695's override mode. The
  // layout is readable off J1939-71 (`pdftotext -layout`); the decoder is simply not written.
  const jfCmd = { retarder: 0 };
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, { retarder: () => jfCmd.retarder });
  window.j1939FlavorCtl = () => ({ retarder: jfCmd.retarder });
  window.j1939FlavorSetCtl = (p) => {
    if (p && 'retarder' in p) jfCmd.retarder = Math.max(0, Math.min(100, Math.round(Number(p.retarder)) || 0));
  };

  // ── DRIVER DEMAND (contract accel / brake / steer / gear / handbrake, dir "in") ─
  // The J1939 parameter groups that carry what the driver is doing, decoded off the bus into the
  // uplink so a truck or tractor is driven by J1939 itself - the demo encodes the RAMN Control
  // Panel into them (j1939.js), and anyone's tooling on a real bus drives the game the same way.
  // Every field below was read off J1939-71 (the `-layout` table's SPN column is shifted a row;
  // the SPNs pair with the bit positions IN ORDER):
  //   61443 EEC2  50 ms.  byte 2 SPN 91 Accelerator Pedal Position 1, 0.4 %/bit.
  //   61441 EBC1  100 ms. byte 2 SPN 521 Brake Pedal Position, 0.4 %/bit; 3.7 SPN 1238 Traction
  //                       Control Override Switch, 00 off / 01 on -> `tcs_off`. (J1939 has no
  //                       driver ESC/VDC off switch - SPN 1814 is VDC reporting itself - so
  //                       `esc_off` has no bus decode; ramn.js's panel is its only source.)
  //   61449 VDC2  10 ms.  bytes 1-2 SPN 1807 Steering Wheel Angle, 1/1024 rad/bit, -31.374 rad,
  //                       and "steered to the left results in a positive steering wheel angle".
  //   256   TC1   50 ms when active, PDU1 to the transmission. byte 3 SPN 525 Requested Gear,
  //                       1/bit, -125 offset, negative = reverse, 0 = neutral; 0xFB Park,
  //                       0xFC Forward Drive, 0xFD Hold and the selector-position codes below it.
  //   65265 CCVS  100 ms. 1.3 SPN 70 Parking Brake Switch, 00 not set / 01 set; 4.5 SPN 597
  //                       Brake Switch -> `brakeLamp`, the rear stop lamps (the bridge owns that
  //                       bit whenever it drives, so a pedal with no switch would brake unlit).
  //
  // NOT AVAILABLE REFRESHES NOTHING: a 1-byte raw of 251+, a 2-byte raw above 0xFAFF and a 2-bit
  // 10/11 are the standard's error / not-available codes. That rule is also THE OWN-ADDRESS RULE
  // here: the game's EEC2 / VDC2 / CCVS (jfEec2 / jfVdc2 / jfCcvs) carry SPN 91 / 1807 / 70 / 597
  // only while the demo drives - the same value its own frames would have carried - and "not
  // available" otherwise, so their echo drives nothing and a lapsed demand times out instead of
  // latching. Only the demo transmits EBC1 and TC1.
  //
  // FRESHNESS: every group is periodic, so one that stops arriving is withdrawn. JF_DRIVE_TTL_MS is
  // this side's own timeout (three missed periods of the slowest group, isobus.js's rule), not a
  // number out of the standard. A stale value returns undefined, so the uplink falls through to
  // the RAMN state and then to omission - the game's keyboard fallback.
  //
  // FULL_LOCK_RAD is DECLARED CONFIGURATION, not a J1939 number: the steering-wheel angle that
  // reads as the contract's full-lock 100 %. 1.5 turns each way.
  const JF_DRIVE_TTL_MS = 300;
  const FULL_LOCK_RAD = 1.5 * 2 * Math.PI;
  const SA_SHIFT_CONSOLE = 0x05;   // Shift Console - Primary (isobus.net SourceAddress table)
  const PGN_EEC2 = 61443, PGN_EBC1 = 61441, PGN_VDC2 = 61449, PGN_TC1 = 256, PGN_CCVS = 65265;
  const GEAR_R_BYTE = 0xFF;        // the contract's reverse byte
  const GEAR_P_BYTE = 0xFE;        // the contract's park byte (v48)
  // The tallest drive byte is carlito-registry.js's window.carlitoGearTop(), read at call time.
  const jfDrive = {
    accel:     { bus: undefined, at: 0 },
    brake:     { bus: undefined, at: 0 },
    steer:     { bus: undefined, at: 0 },
    gear:      { bus: undefined, at: 0 },
    handbrake: { bus: undefined, at: 0 },
    brakeLamp: { bus: undefined, at: 0 },
    tcs_off:   { bus: undefined, at: 0 },   // claimed over ramn.js's panel toggle while fresh
  };
  const jfDriveFresh = (r) => r.bus !== undefined && Date.now() - r.at <= JF_DRIVE_TTL_MS;
  function jfDriveHold(name, v) { const r = jfDrive[name]; r.bus = v; r.at = Date.now(); }

  // Contract gear byte -> SPN 525 raw, and back. Park is the contract's P (254) both ways: the
  // gearbox's pawl, where one is fitted (the parking brake is SPN 70's). The contract's byte 0 is
  // "no gear opinion" to an automatic (D once the pedal is down), so a bus asking for Neutral
  // with a pedal still moves forward - the RAMN gear byte's rule, not this map's. Forward Drive
  // maps to 1, which a MANUAL gearbox holds as first gear.
  function jfGearRaw(g) {
    if (g === 'R' || g === GEAR_R_BYTE) return 125 - 1;
    if (g === 'P' || g === GEAR_P_BYTE) return 0xFB;
    const n = Math.round(Number(g)) || 0;
    return 125 + Math.max(0, Math.min(window.carlitoGearTop(), n));
  }
  // A gear is the operating range, -64..64 (raw 61..189). Everything else is a parameter-specific
  // code, and only Forward Drive and Park have a contract meaning; Hold, the shift requests and
  // the selector positions refresh nothing. J1939-71's reserved list (0x00-0x3D) overlaps raw 61,
  // the operating range's -64; the operating range wins here.
  function jfGearFromRaw(raw) {
    if (raw === 0xFC) return 1;            // Forward Drive position: a D intent
    if (raw === 0xFB) return GEAR_P_BYTE;  // Park
    const g = raw - 125;
    if (g < -64 || g > 64) return undefined;
    if (g < 0) return GEAR_R_BYTE;
    return Math.min(window.carlitoGearTop(), g);
  }

  // The four frames the demo sends for a control state { accel, brake, steer, gear } (RAMN panel
  // shape: % / % / -100 L..+100 R / 1..top gear, 'R' or 'P'). The parking brake and brake switch ride a CCVS
  // the demo already sends, so they are a patch onto its data rather than a frame of their own.
  // EEC2 and VDC2 come out of the encoders the game's groups use, with no game half (t = null).
  function j1939DriveFrames(c) {
    const ebc1 = jp.blank(), tc1 = jp.blank();
    jp.put(ebc1, 1, 1, Math.max(0, Math.min(100, Number(c.brake) || 0)), 0.4, 0);
    tc1[2] = jfGearRaw(c.gear);
    const full = (f) => ({ id: f.id, isExt: true, isRtr: false, dlc: 8, data: f.data });
    return [
      full(jfEec2(c)),
      { id: jp.buildId(PGN_EBC1, 6, SA_BRAKES), isExt: true, isRtr: false, dlc: 8, data: ebc1 },
      full(jfVdc2(null, c)),
      { id: jp.buildId(PGN_TC1, 3, SA_SHIFT_CONSOLE, SA_TRANSMISSION), isExt: true, isRtr: false, dlc: 8, data: tc1 },
    ];
  }
  // Writes SPN 70 (1.3, from `handbrake`) and SPN 597 (4.5, the pedal is down) into CCVS data,
  // leaving every neighbouring field as it was.
  function j1939CcvsPatch(d, c) {
    jp.bits(d, 0, 2, 2, c.handbrake ? 1 : 0);
    jp.bits(d, 3, 4, 2, (Number(c.brake) || 0) > 0 ? 1 : 0);
    return d;
  }

  const jfB = (d, i) => (d && i < d.length) ? (d[i] & 0xFF) : 0xFF;
  function jfDecodeDrive(frame) {
    if (!frame.isExt || frame.isRtr || !frame.data) return;
    const { pgn, da } = jp.parseId(frame.id >>> 0);
    const d = frame.data;
    if (pgn === PGN_EEC2) {
      const r = jfB(d, 1);
      if (r <= 250) jfDriveHold('accel', Math.min(100, r * 0.4));
    } else if (pgn === PGN_EBC1) {
      const r = jfB(d, 1);
      if (r <= 250) jfDriveHold('brake', Math.min(100, r * 0.4));
      const tc = (jfB(d, 2) >> 6) & 3;
      if (tc <= 1) jfDriveHold('tcs_off', tc === 1);
    } else if (pgn === PGN_VDC2) {
      const r = jfB(d, 0) | (jfB(d, 1) << 8);
      if (r > 0xFAFF) return;
      const rad = r / 1024 - 31.374;
      jfDriveHold('steer', Math.max(-100, Math.min(100, -rad / FULL_LOCK_RAD * 100)));
    } else if (pgn === PGN_TC1) {
      if (da !== SA_TRANSMISSION && da !== 0xFF) return;
      const g = jfGearFromRaw(jfB(d, 2));
      if (g !== undefined) jfDriveHold('gear', g);
    } else if (pgn === PGN_CCVS) {
      const p = (jfB(d, 0) >> 2) & 3;
      if (p <= 1) jfDriveHold('handbrake', p);
      const b = (jfB(d, 3) >> 4) & 3;
      if (b <= 1) jfDriveHold('brakeLamp', b);
    }
  }
  window.carlitoUplinkDecoders = window.carlitoUplinkDecoders || [];
  window.carlitoUplinkDecoders.push(jfDecodeDrive);

  // A CLAIM, not a home: these signals belong to the RAMN state in carlito.js,
  // so a bus value that is live takes them over and a stale one hands them straight back. Claims
  // are asked by priority (carlito-registry.js lists it): this is 10, below the Drone Control panel.
  const jfClaim = (name) => jfDriveFresh(jfDrive[name]) ? jfDrive[name].bus : undefined;
  for (const name of Object.keys(jfDrive)) window.carlitoUplinkClaim(name, 10, () => jfClaim(name));
  window.j1939DriveFrames = j1939DriveFrames;
  window.j1939CcvsPatch = j1939CcvsPatch;
  // ← isobus.js, which decides when EEC1 goes out (whenever engine_load is there). The rpm mirror
  // rides inside it only for a truck or tractor, the mirror's own gate.
  window.j1939Eec1Frame = (t) => jfEec1(jfMirrored(t) ? t : { engine_load: t.engine_load });
  // ← j1939.js's demo traffic, which builds the same five groups through these builders (one
  // encoder per wire format) and paces them by JF_MSGS's rates.
  window.j1939FlavorMsgs = JF_MSGS;
  window.j1939FlavorFrames = { EEC1: jfEec1, ET1: jfEt1, CCVS: jfCcvs, VEP1: jfVep1, DD: jfDd };

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.j1939FlavorSelfTest(). Covers the things that are easy to get
  // backwards and impossible to eyeball - the 29-bit id build, each SPN's scale and offset, the
  // NEGATION, bit-level field placement, and the on-request builder. Where j1939.js is loaded the
  // frames are additionally round-tripped through ITS decoder, so this module's encoder is
  // checked by an independent implementation rather than by its own arithmetic.
  // HERMETIC: the state the checks touch is snapshotted here and put back in a `finally`, so a
  // check that throws cannot leave a test value driving the game.
  function j1939FlavorSelfTest() {
    const clock = jfLast1s, drive = {}, claims = jp.claimsSnapshot();
    for (const k of Object.keys(jfDrive)) drive[k] = Object.assign({}, jfDrive[k]);
    try { return jfSelfTestChecks(); }
    finally {
      jfLast1s = clock;
      jp.claimsRestore(claims);
      for (const k of Object.keys(jfDrive)) jfDrive[k] = drive[k];
    }
  }
  function jfSelfTestChecks() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (d) => d.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    // 1. Id build. All three are PDU2 broadcasts; PS is the low PGN byte, never a destination.
    eq('ERC1 id', jp.buildId(61440, 6, SA_RETARDER).toString(16).toUpperCase(), '18F00010');
    eq('AIR1 id', jp.buildId(65198, 6, SA_BRAKES).toString(16).toUpperCase(), '18FEAE0B');
    eq('VW id',   jp.buildId(65258, 6, SA_AXLE_DRV1).toString(16).toUpperCase(), '18FEEA09');
    eq('ETC2 id', jp.buildId(61445, 6, SA_TRANSMISSION).toString(16).toUpperCase(), '18F00503');
    if (typeof j1939ParseId === 'function') {
      eq('ERC1 id parses back', j1939ParseId(jp.buildId(61440, 6, SA_RETARDER)),
        { priority: 6, dp: 0, pf: 0xF0, pgn: 61440, da: 0xFF, sa: 0x10 });
      eq('AIR1 id parses back', j1939ParseId(jp.buildId(65198, 6, SA_BRAKES)),
        { priority: 6, dp: 0, pf: 0xFE, pgn: 65198, da: 0xFF, sa: 0x0B });
    }

    // 2. Scales, one pinned frame each. Every untouched byte must still read 0xFF.
    //    40 % retardation -> SPN 520 = -40 -> raw (-40 + 125) = 85 = 0x55, and the torque mode
    //    stays 1111b because this file never read the mode table.
    eq('ERC1 40 % retardation', hex(jfErc1({ retarder_state: 40 }).data),
      'FF 55 FF FF FF FF FF FF');
    //    Released: raw 125 = 0x7D, and mode 0000b IS documented for exactly this case, so byte 1
    //    drops its low nibble to 0xF0.
    eq('ERC1 released', hex(jfErc1({ retarder_state: 0 }).data), 'F0 7D FF FF FF FF FF FF');
    //    8.0 bar = 800 kPa -> 100 = 0x64; 7.2 bar = 720 kPa -> 90 = 0x5A.
    eq('AIR1 8.0 / 7.2 bar', hex(jfAir1({ air_primary: 8, air_secondary: 7.2 }).data),
      'FF FF 64 5A FF FF FF FF');

    // 3. A signal the game did not publish must leave "not available" standing, not write a 0 -
    //    and a real 0 must still be written as a 0 (a bled-down circuit is a reading).
    eq('one circuit absent leaves 0xFF', hex(jfAir1({ air_primary: 8 }).data),
      'FF FF 64 FF FF FF FF FF');
    eq('a real zero is written', hex(jfAir1({ air_primary: 0, air_secondary: 0 }).data),
      'FF FF 00 00 FF FF FF FF');
    //    D3 at ratio 1.41: gear raw 128 = 0x80 in bytes 1 and 4; 1410 = 0x0582 -> 82 05. A CVT at
    //    active standstill publishes 64.255 = 0xFAFF, the top of the valid range; R is raw 124.
    eq('ETC2 D3 at 1.41', hex(jfEtc2({ gear: 3, gear_ratio: 1.41 }).data),
      '80 82 05 80 FF FF FF FF');
    eq('ETC2 standstill', hex(jfEtc2({ gear: 1, gear_ratio: 64.255 }).data),
      '7E FF FA 7E FF FF FF FF');
    eq('ETC2 reverse', jfEtc2({ gear: 255, gear_ratio: 3.9 }).data[0], 124);
    //    ...and a value past the top of the scale clamps to the top of the valid range.
    eq('over-range clamps under the reserved codes', jfAir1({ air_primary: 9999 }).data[2], 0xFA);
    //    VDC1, byte 1 bits 1-6 then byte 2's four controls; byte 1's bits 7-8 stay 11.
    //    Idle and fitted: lamp off, fully operational (01 at 1.3) -> 1100 0100 = 0xC4.
    eq('VDC1 id', jp.buildId(65103, 6, SA_BRAKES).toString(16).toUpperCase(), '18FE4F0B');
    eq('VDC1 idle', hex(jfVdc1({ status: 0 }).data), 'C4 00 FF FF FF FF FF FF');
    //    Yaw: lamp on -> 0xC5; YC engine and brake at 2.5 / 2.7 -> 0101 0000 = 0x50.
    eq('VDC1 yaw', hex(jfVdc1({ status: ST.ESC | ST.YAW }).data), 'C5 50 FF FF FF FF FF FF');
    //    Roll past the lamp floor: brake light at 1.5 -> 0xD5; ROP at 2.1 / 2.3 -> 0x05.
    eq('VDC1 roll and brake light', hex(jfVdc1({ status: ST.ESC | ST.BRAKE_LIGHT | ST.ROLL }).data),
      'D5 05 FF FF FF FF FF FF');
    //    Switched off: lamp on, not fully operational (00 at 1.3) -> 1100 0001 = 0xC1.
    eq('VDC1 switched off', hex(jfVdc1({ status: ST.OFF }).data), 'C1 00 FF FF FF FF FF FF');
    //    VDC2: yaw 0.5 -> 4.42 * 8192 = 36209 = 0x8D71; accLat -2 (right) is +2 left -> 17.687 *
    //    2048 = 36223 = 0x8D7F; braking forward at -1.5 -> 11 / 0.1 = 110 = 0x6E. 1807, 1811-1812 n/a.
    eq('VDC2 id', jp.buildId(61449, 6, SA_BRAKES).toString(16).toUpperCase(), '18F0090B');
    eq('VDC2 braking in a right-hand bend', hex(jfVdc2({ yaw: 0.5, accLat: -2, accLong: -1.5, speed: 10 }).data),
      'FF FF FF 71 8D 7F 8D 6E');
    //    Speeding up in reverse (accLong -1.5 while speed < 0) reads + 1.5 -> 140 = 0x8C.
    eq('VDC2 speeding up backward is positive', jfVdc2({ accLong: -1.5, speed: -5 }).data[7], 0x8C);
    eq('VDC2 with no sensors stays n/a', hex(jfVdc2({}).data), 'FF FF FF FF FF FF FF FF');
    //    The gate: no air brakes (a car, a tractor), no VDC.
    //    jfPack moves the live AIR1 clock (j1939FlavorSelfTest puts it back).
    const pgns = (t, slow) => jfPack(t, slow).map(f => (f.id >>> 8) & 0xFFFF);
    eq('a car sends no VDC', pgns({ status: ST.ESC, yaw: 0.1 }, true).includes(0xFE4F), false);
    eq('an air-braked truck sends VDC1 on the slow tick', pgns({ status: 0, air_primary: 8 }, true).includes(0xFE4F), true);
    eq('no VDC1 off the slow tick', pgns({ status: 0, air_primary: 8 }, false).includes(0xFE4F), false);
    eq('VDC2 on every call', pgns({ status: 0, air_primary: 8 }, false).includes(0xF009), true);
    //    Address Claim before a source's first frame, once until a reset. The brakes controller
    //    (0x0B): NAME identity 1, function 9 (Brakes - System Controller), industry group 1.
    //    The 1 s clock is held shut, or AIR1 (also from 0x0B) could join on a live-traffic edge.
    jp.forgetClaims();
    jfLast1s = Date.now();
    const first = jfPack({ status: 0, air_primary: 8 }, false);
    eq('the brakes claim 0x0B before VDC2', first.map(f => f.id.toString(16).toUpperCase()), ['18EEFF0B', '18F0090B']);
    eq('the claim NAME', hex(first[0].data), '01 00 00 00 00 09 00 10');
    eq('no second claim', pgns({ status: 0, air_primary: 8 }, false).includes(0xEEFF), false);

    // 4. The on-request half, which lives in j1939.js but is this flavor's coverage. Only
    //    checked where that module is loaded - and said out loud when it is not, because a
    //    silent skip is how a check rots. (Not tested by the registry's existence: carlito-registry.js
    //    creates it on every page.)
    if (typeof window.j1939ServeRequest === 'function') {
      const vw = window.j1939RequestServers.find(s => s.pgn === 0xFEEA);
      if (!vw) failures.push('VW: no request server registered for PGN 65258');
      else {
        //  9000 kg -> 18000 = 0x4650, little-endian 50 46 at bytes 2-3; byte 1 is SPN 928.
        eq('VW 9000 kg from the drive axle', hex(vw.build({ axle_load: 9000 })),
          '10 50 46 FF FF FF FF FF');
        eq('no axle_load, no answer (a NACK, not a zero)', vw.build({}), null);
      }
    } else {
      failures.push('VW: j1939.js is not loaded on this page, so the request path was not ' +
        'checked (expected on carlito-bridge.html, a failure anywhere else)');
    }

    // 5. Round-trip every periodic frame through j1939.js's own decoder.
    if (typeof j1939DecodePGN === 'function') {
      const rt = (label, pgn, frame, want) => {
        const got = j1939DecodePGN(pgn, frame.data, J1939_DB);   // never the tab's active mode
        if (!got.length) { failures.push(label + ': no decoder entry for PGN ' + pgn); return; }
        for (const name of Object.keys(want)) {
          const f = got.find(x => x.name === name);
          if (!f) { failures.push(label + ': decoder returned no field "' + name + '"'); continue; }
          // j1939DecodeSPN joins value and unit with a NON-BREAKING space, so the comparison
          // normalises rather than this file carrying an invisible U+00A0 in its expectations.
          eq(label + ' ' + name, String(f.display).replace(/ /g, ' '), want[name]);
        }
      };
      rt('ERC1', 61440, jfErc1({ retarder_state: 40 }),
        { 'Actual Retarder - Percent Torque': '-40 %' });
      rt('ERC1 released', 61440, jfErc1({ retarder_state: 0 }),
        { 'Actual Retarder - Percent Torque': '0 %', 'Retarder Torque Mode': 'No request' });
      rt('ETC2', 61445, jfEtc2({ gear: 3, gear_ratio: 1.41 }),
        { 'Selected Gear': '3', 'Actual Gear Ratio': '1.410', 'Current Gear': '3' });
      rt('AIR1', 65198, jfAir1({ air_primary: 8, air_secondary: 7.2 }),
        { 'Service Brake Air Pressure Circuit #1': '800 kPa',
          'Service Brake Air Pressure Circuit #2': '720 kPa' });
      rt('VDC1', 65103, jfVdc1({ status: ST.ESC | ST.BRAKE_LIGHT | ST.ROLL }),
        { 'VDC Information Signal': 'On', 'VDC Fully Operational': 'Fully operational',
          'VDC brake light request': 'On', 'ROP Brake Control active': 'Active',
          'ROP Engine Control active': 'Active', 'YC Brake Control active': 'Passive' });
      rt('VDC1 off', 65103, jfVdc1({ status: ST.OFF }),
        { 'VDC Fully Operational': 'Not fully operational' });
      rt('VDC2', 61449, jfVdc2({ yaw: 0.5, accLat: -2, accLong: -1.5, speed: 10 }),
        { 'Steering Wheel Angle': 'N/A', 'Yaw Rate': '0.500 rad/s',
          'Lateral Acceleration': '2.00 m/s²', 'Longitudinal Acceleration': '-1.5 m/s²' });
    }

    // 6. Driver demand. The decoder writes live state (j1939FlavorSelfTest puts it back).
    const feed = (frames) => frames.forEach(jfDecodeDrive);
    const live = (n) => jfDriveFresh(jfDrive[n]) ? jfDrive[n].bus : undefined;
    const [eec2, ebc1, vdc2, tc1] = j1939DriveFrames({ accel: 40, brake: 100, steer: -100, gear: 'R' });
    eq('EEC2 id', eec2.id.toString(16).toUpperCase(), 'CF00300');
    eq('TC1 id is PDU1 to the transmission', tc1.id.toString(16).toUpperCase(), 'C010305');
    //    40 % -> 100 = 0x64 at byte 2; 100 % -> 250 = 0xFA; R -> -1 -> 124 = 0x7C at byte 3.
    eq('EEC2 40 % pedal', hex(eec2.data), 'FF 64 FF FF FF FF FF FF');
    eq('EBC1 full brake', hex(ebc1.data), 'FF FA FF FF FF FF FF FF');
    eq('TC1 reverse', hex(tc1.data), 'FF FF 7C FF FF FF FF FF');
    //    Full LEFT is a POSITIVE wheel angle: (+9.4248 + 31.374) * 1024 = 41777.8 -> 41778 = 0xA332.
    eq('VDC2 full left is positive', hex(vdc2.data), '32 A3 FF FF FF FF FF FF');
    feed([eec2, ebc1, vdc2, tc1]);
    eq('decoded accel', Math.round(live('accel')), 40);
    eq('decoded brake', live('brake'), 100);
    eq('decoded steer (left is negative in the contract)', Math.round(live('steer')), -100);
    eq('decoded gear R', live('gear'), 0xFF);
    feed(j1939DriveFrames({ gear: 3 }).slice(3));
    eq('decoded gear 3', live('gear'), 3);
    //    Not available refreshes nothing: an EEC2 with SPN 91 = 0xFF must not zero the pedal.
    jfDecodeDrive({ id: jp.buildId(PGN_EEC2, 3, SA_ENGINE), isExt: true, data: [0xFF, 0xFF, 42, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    eq('an EEC2 with SPN 91 not available leaves the pedal', Math.round(live('accel')), 40);
    //    The own-address rule for VDC2: this file's sensor frame (SPN 1807 n/a) steers nothing.
    jfDecodeDrive(jfVdc2({ yaw: 0.5, accLat: -2, accLong: -1.5, speed: 10 }));
    eq('our own VDC2 leaves the steer', Math.round(live('steer')), -100);
    //    Park and Forward Drive; a Hold refreshes nothing.
    const tcRaw = (raw) => jfDecodeDrive({ id: jp.buildId(PGN_TC1, 3, SA_SHIFT_CONSOLE, SA_TRANSMISSION), isExt: true, data: [0xFF, 0xFF, raw, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    tcRaw(0xFC); eq('Forward Drive reads D', live('gear'), 1);
    tcRaw(0xFB); eq('Park reads P', live('gear'), GEAR_P_BYTE);
    tcRaw(0xFD); eq('Hold refreshes nothing', live('gear'), GEAR_P_BYTE);
    eq('P encodes as Park', j1939DriveFrames({ gear: 'P' })[3].data[2], 0xFB);
    //    The whole drive range rides SPN 525, D12 and the contract's top gear alike; past it clamps.
    const top = window.carlitoGearTop();
    eq('D12 encodes as 137', j1939DriveFrames({ gear: 12 })[3].data[2], 137);
    eq('the top gear encodes', j1939DriveFrames({ gear: top })[3].data[2], 125 + top);
    eq('past the top gear clamps', j1939DriveFrames({ gear: top + 1 })[3].data[2], 125 + top);
    tcRaw(137); eq('137 reads D12', live('gear'), 12);
    tcRaw(125 + top); eq('the top gear reads back', live('gear'), top);
    tcRaw(125 + top + 1); eq('past the top gear reads the top', live('gear'), top);
    tcRaw(0xFB);
    //    A TC1 to another destination is not the transmission's.
    jfDecodeDrive({ id: jp.buildId(PGN_TC1, 3, SA_SHIFT_CONSOLE, 0x04), isExt: true, data: [0xFF, 0xFF, 128, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    eq('TC1 to Transmission #2 ignored', live('gear'), GEAR_P_BYTE);
    //    SPN 70 in bits 3-4 of CCVS byte 1 and SPN 597 in bits 5-6 of byte 4, neighbours untouched.
    eq('CCVS switches', hex(j1939CcvsPatch(jp.blank(), { handbrake: 1, brake: 30 })), 'F7 FF FF DF FF FF FF FF');
    jfDecodeDrive({ id: jp.buildId(PGN_CCVS, 6, SA_ENGINE), isExt: true, data: [0xF7, 0, 0, 0x10, 0, 0, 0, 0] });
    eq('decoded handbrake', live('handbrake'), 1);
    eq('decoded brake switch', live('brakeLamp'), 1);
    jfDecodeDrive({ id: jp.buildId(PGN_CCVS, 6, SA_ENGINE), isExt: true, data: [0xFF, 0, 0, 0, 0, 0, 0, 0] });
    eq('CCVS with SPN 70 not available leaves it', live('handbrake'), 1);
    //    SPN 1238 at EBC1 3.7: 01 is traction control overridden, 00 is not, 11 refreshes nothing -
    //    which is also why the demo's EBC1 (byte 3 all ones) never touches it.
    const ebc1Tc = (b3) => ({ id: jp.buildId(PGN_EBC1, 6, SA_BRAKES), isExt: true, data: [0xFF, 0xFF, b3, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    jfDrive.tcs_off.bus = undefined; jfDecodeDrive(ebc1);
    eq('the demo EBC1 says nothing about traction control', live('tcs_off'), undefined);
    jfDecodeDrive(ebc1Tc(0x7F)); eq('SPN 1238 on -> tcs_off', jfClaim('tcs_off'), true);
    jfDecodeDrive(ebc1Tc(0xFF)); eq('SPN 1238 not available leaves it', live('tcs_off'), true);
    jfDecodeDrive(ebc1Tc(0x3F)); eq('SPN 1238 off -> TC back on', live('tcs_off'), false);
    //    A withdrawn group expires, and the claim then declines.
    jfDrive.accel.at = Date.now() - JF_DRIVE_TTL_MS - 1;
    eq('stale pedal declines the claim', jfClaim('accel'), undefined);
    //    Round-trip through j1939.js's decoder, where it is loaded.
    if (typeof j1939DecodePGN === 'function') {
      const dec = (pgn, data, name) => (j1939DecodePGN(pgn, data, J1939_DB).find(x => x.name === name) || {}).display;
      eq('EBC1 round trip', String(dec(PGN_EBC1, ebc1.data, 'Brake Pedal Position')).replace(/ /g, ' '), '100 %');
      eq('VDC2 round trip', String(dec(PGN_VDC2, vdc2.data, 'Steering Wheel Angle')).replace(/ /g, ' '), '9.425 rad');
      eq('TC1 round trip', dec(PGN_TC1, tc1.data, 'Requested Gear'), '-1');
      eq('CCVS round trip', dec(PGN_CCVS, [0xF7, 0, 0, 0x10, 0, 0, 0, 0], 'Parking Brake Switch'), 'Set');
      eq('CCVS brake switch round trip', dec(PGN_CCVS, [0xF7, 0, 0, 0x10, 0, 0, 0, 0], 'Brake Switch'), 'On');
      eq('EBC1 SPN 1238 round trip', dec(PGN_EBC1, ebc1Tc(0x7F).data, 'Traction Control Override Switch'), 'On');
    }

    // 7. Decision 1, the mirrors: five groups, from a truck or a tractor and nothing else.
    //    1500 rpm -> 12000 = 0x2EE0 at bytes 4-5; 45 km/h -> 11520 = 0x2D00 at bytes 2-3;
    //    88 degC -> 128 = 0x80; 70 % -> 175 = 0xAF; 24.4 V -> 488 = 0x01E8 at bytes 5-6.
    eq('EEC1 id', jfEec1({ rpm: 1500 }).id.toString(16).toUpperCase(), 'CF00400');
    eq('DD id is the cluster\'s', jfDd({ fuel: 70 }).id.toString(16).toUpperCase(), '18FEFC17');
    eq('EEC1 1500 rpm', hex(jfEec1({ rpm: 1500 }).data), 'FF FF FF E0 2E FF FF FF');
    //    engine_load 42 % -> SPN 513 raw 42 + 125 = 167 = 0xA7 at byte 3, beside the rpm.
    eq('EEC1 load and rpm in one frame', hex(jfEec1({ rpm: 1500, engine_load: 42 }).data), 'FF FF A7 E0 2E FF FF FF');
    eq('EEC1 load 0 % is raw 125', jfEec1({ engine_load: 0 }).data[2], 0x7D);
    eq('a truck with engine_load: jfPack leaves EEC1 to isobus.js',
      pgns({ rpm: 1500, engine_load: 42, air_primary: 8 }, true).includes(0xF004), false);
    eq("isobus.js's EEC1 carries the rpm on a truck",
      hex(window.j1939Eec1Frame({ rpm: 1500, engine_load: 42, air_primary: 8 }).data), 'FF FF A7 E0 2E FF FF FF');
    eq('...and no rpm off one', hex(window.j1939Eec1Frame({ rpm: 1500, engine_load: 42 }).data), 'FF FF A7 FF FF FF FF FF');
    eq('CCVS 45 km/h, no driver', hex(jfCcvs({ kmh: 45 }, null).data), 'FF 00 2D FF FF FF FF FF');
    eq('ET1 88 degC', hex(jfEt1({ coolant: 88 }).data), '80 FF FF FF FF FF FF FF');
    eq('DD 70 %', hex(jfDd({ fuel: 70 }).data), 'FF AF FF FF FF FF FF FF');
    eq('VEP1 24.4 V', hex(jfVep1({ battery: 24.4 }).data), 'FF FF FF FF E8 01 FF FF');
    const MIRRORS = [0xF004, 0xFEF1, 0xFEEE, 0xFEFC, 0xFEF7];
    const shared = { rpm: 1500, kmh: 45, coolant: 88, fuel: 70, battery: 24.4 };
    const mirrored = (t) => { jfLast1s = 0; const p = pgns(t, true); return MIRRORS.filter(g => p.includes(g)).length; };
    eq('a truck carries all five mirrors', mirrored({ ...shared, air_primary: 8 }), 5);
    eq('a tractor carries all five mirrors', mirrored({ ...shared, hitch_pos_actual: 50 }), 5);
    eq('a car carries none', mirrored(shared), 0);
    //    The merged groups: one frame carries the demand beside the game's half, and a null demand
    //    leaves its field not available. EEC2 has no game half: 40 % pedal = 0x64, SPN 92 n/a.
    eq('EEC2 pedal only', hex(jfEec2({ accel: 40 }).data), 'FF 64 FF FF FF FF FF FF');
    eq('EEC2 with no driver leaves SPN 91', hex(jfEec2(null).data), 'FF FF FF FF FF FF FF FF');
    eq('CCVS speed and switches in one frame', hex(jfCcvs({ kmh: 45 }, { handbrake: 1, brake: 30 }).data), 'F7 00 2D DF FF FF FF FF');
    eq('VDC2 wheel and sensors in one frame',
      hex(jfVdc2({ yaw: 0.5, accLat: -2, accLong: -1.5, speed: 10 }, { steer: -100 }).data), '32 A3 FF 71 8D 7F 8D 6E');
    //    The echo: a merged frame drives the claim, and once the demand is gone its field reads not
    //    available and refreshes nothing, so the claim lapses on its TTL instead of latching.
    for (const k of Object.keys(jfDrive)) jfDrive[k] = { bus: undefined, at: 0 };
    jfDecodeDrive(jfEec2({ accel: 40 }));
    eq('the EEC2 echo drives the pedal', Math.round(live('accel')), 40);
    jfDrive.accel.at = Date.now() - JF_DRIVE_TTL_MS - 1;
    jfDecodeDrive(jfEec2(null));
    eq('an EEC2 with the demand gone lets the pedal lapse', live('accel'), undefined);
    jfDecodeDrive(jfCcvs({ kmh: 45 }, null));
    eq('a CCVS with no driver sets no switch', [live('handbrake'), live('brakeLamp')], [undefined, undefined]);
    if (typeof j1939DecodePGN === 'function') {
      const dec = (pgn, f, name) => String((j1939DecodePGN(pgn, f.data, J1939_DB).find(x => x.name === name) || {}).display).replace(/ /g, ' ');
      eq('EEC1 round trip', dec(61444, jfEec1({ rpm: 1500 }), 'Engine Speed'), '1500.0 rpm');
      eq('CCVS speed round trip', dec(65265, jfCcvs({ kmh: 45 }, null), 'Vehicle Speed'), '45.0 km/h');
      eq('ET1 round trip', dec(65262, jfEt1({ coolant: 88 }), 'Coolant Temp'), '88 °C');
      eq('DD round trip', dec(65276, jfDd({ fuel: 70 }), 'Fuel Level'), '70 %');
      eq('VEP1 round trip', dec(65271, jfVep1({ battery: 24.4 }), 'Battery Voltage'), '24.40 V');
      eq('EEC2 pedal round trip', dec(61443, jfEec2({ accel: 40 }), 'Accelerator Pedal Position 1'), '40 %');
      const both = jfEec1({ rpm: 1500, engine_load: 42 });
      eq('EEC1 round trip, both halves',
        [dec(61444, both, 'Engine Speed'), dec(61444, both, 'Actual Engine - Percent Torque')], ['1500.0 rpm', '42 %']);
    }

    if (failures.length) console.error('J1939 flavor self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('J1939 flavor self-test: all checks passed.');
    return failures;
  }
  window.j1939FlavorSelfTest = j1939FlavorSelfTest;
})();
