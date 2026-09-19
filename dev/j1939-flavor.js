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
// Source addresses come off j1939.js's own J1939_SA table (itself corrected against isobus.net's
// SourceAddress table when isobus.js needed 0xF0). All three groups were ADDED to j1939.js's
// J1939_DB in the same change, with their neighbouring SPNs, so they decode named and scaled -
// a decode table is not scoped to what this packer happens to emit.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   index.html           <script src="j1939-flavor.js" defer> after carlito_contract.js and
//                        BEFORE carlito.js (the packer must be registered by the time carlito.js
//                        evaluates its coverage check)
//   carlito-bridge.html  same script tag. That page loads neither sloppycan.js nor j1939.js,
//                        so every cross-module read here is typeof-guarded.
//   j1939-tables.js      J1939_DB += 0xF000 ERC1 / 0xFEAE AIR1 / 0xFEEA VW, and EBC1 / VDC2 /
//                        TC1 / CCVS SPN 70 for the driver demand
//   j1939.js             the VW entry on J1939_REQ_SERVERS that answers a request for
//                        axle_load, and its demo sends j1939DriveFrames
//   carlito.js           window.carlitoUplinkDecoders + carlitoUplinkOverrides (DRIVER DEMAND)
//
// Telemetry TX rides carlito.js's canForward gateway, which is what puts these on the wire and
// in the dump as FW entries. No transport code here.

(function () {
  'use strict';

  // ── Wire primitives ─────────────────────────────────────────────────────────
  // Local copies of j1939.js's j1939BuildIdDa / j1939Blank / j1939EncodeSPN, for the load-order
  // reason in the header: carlito-bridge.html does not load j1939.js, and a packer that went
  // silent there would be a coverage regression nothing warns about. Identical arithmetic, and
  // the self-test round-trips these against j1939.js's own decoder wherever it IS loaded.
  //
  // J1939 29-bit id: [28:26] priority [25] EDP [24] DP [23:16] PDU format [15:8] PDU specific
  // [7:0] SA. All three groups here are PDU2 (PF >= 0xF0), so PS is part of the PGN and there is
  // no destination to carry - they are broadcasts, which is what a status message is.
  function jfId(pgn, prio, sa) {
    const dp = (pgn >>> 16) & 1;
    const pf = (pgn >>> 8) & 0xFF;
    const ps = pf < 0xF0 ? 0xFF : (pgn & 0xFF);
    return ((((prio & 7) << 26) >>> 0) | (dp << 24) | (pf << 16) | (ps << 8) | (sa & 0xFF)) >>> 0;
  }

  // A frame's data starts as eight 0xFF bytes and fields are written INTO it. In J1939 an
  // all-ones field IS "not available", so a byte this module never touches states "no source for
  // this" rather than claiming a zero - the same statement carlito.js's uplink makes by OMITTING
  // an unwired signal.
  function jfBlank() { return [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; }

  // A scaled SPN, little-endian, in j1939DecodeSPN's own {b,n,f,o} vocabulary so the two are
  // exact inverses. Non-finite input writes nothing and the 0xFF..FF default stands. J1939-71
  // Table 1 reserves every raw value whose top byte is above 0xFA, so a real value clamps to
  // 0xFA, 0xFAFF, ... rather than colliding with an indicator, error or not-available code.
  function jfPut(d, b, n, val, f, o) {
    const v = Number(val);
    if (!Number.isFinite(v)) return;
    const max = 0xFB * Math.pow(2, 8 * (n - 1)) - 1;
    let raw = Math.max(0, Math.min(max, Math.round((v - (o || 0)) / f)));
    for (let i = 0; i < n; i++) { d[b + i] = raw % 256; raw = Math.floor(raw / 256); }
  }
  // A bit-level SPN. `bit` is the 0-based LSB position within byte `b`, matching j1939DecodeSPN -
  // so the standard's "1.1" (byte 1, bit 1 counting from 1) is b=0, bit=0.
  function jfBits(d, b, bit, nbits, val) {
    const mask = (((1 << nbits) - 1) << bit) & 0xFF;
    d[b] = ((d[b] & ~mask) | ((val << bit) & mask)) & 0xFF;
  }

  // ── Source addresses ────────────────────────────────────────────────────────
  // THE ONE PLACE AN ADDRESS IS DECLARED (dronecan.js's DC_ROSTER rule), all off J1939_SA.
  // The retarder one is a real choice rather than a lookup: J1939-71's own ERC1 note says the
  // message is sent by several kinds of retarding device and "the source address of the message
  // will indicate which one". The contract's `retarder` desc says A REAL BRAKE ACTING THROUGH THE
  // DRIVELINE ON THE DRIVEN AXLE - so it is the driveline retarder at 0x10, not the engine
  // retarder at 0x0F, and picking 0x0F would misname the device on the wire.
  const SA_RETARDER = 0x10;   // Retarder - Driveline
  const SA_BRAKES   = 0x0B;   // Brakes - System Controller (the ECU that knows the reservoirs)
  const SA_AXLE_DRV1 = 0x09;  // Axle - Drive #1; the address isobus.js already sources EAC1 from

  // ── Message table ───────────────────────────────────────────────────────────
  // Data, not call sites. `ms` is the standard's own transmission repetition rate, recorded so
  // the gate in jfPack can be checked against it - no cadence in this file is invented.
  // VW HAS NO ENTRY HERE ON PURPOSE: its rate is literally "On request", so it is not a message
  // this packer sends at all. It lives on J1939_REQ_SERVERS in j1939.js - see `onRequest` below.
  const JF_MSGS = {
    ERC1: { pgn: 61440, prio: 6, sa: SA_RETARDER, ms: 100 },
    AIR1: { pgn: 65198, prio: 6, sa: SA_BRAKES,   ms: 1000 },
  };
  function jfFrame(m, data) { return { id: jfId(m.pgn, m.prio, m.sa), isExt: true, data }; }

  // ── Telemetry presence ──────────────────────────────────────────────────────
  // Gated per SIGNAL, never per vehicle - isobus.js's rule, and it holds here for the same
  // reason: the game publishes signals_for_vehicle, so an absent key is a real absence and not a
  // zero. Today all four of these are the truck's alone, but a vehicle gate would be a second
  // place the contract's `vehicles` list is written down, and it would be the one that rots.
  const has = (t, k) => t && t[k] !== undefined && t[k] !== null;

  const BAR_TO_KPA = 100;   // the contract's unit for both air pressures -> the SPNs' unit

  // ── Builders ────────────────────────────────────────────────────────────────
  // SPN 520 IS NEGATIVE AND `retarder_state` IS A MAGNITUDE, and this is the one place that sign
  // lives. J1939-71 gives SPN 520 an operating range of -125..0 % because a retarder is a brake;
  // the contract publishes 0..100 deliberately ("the dashboard generates its bars straight from
  // 'range' and a [-100, 0] range would fill the RET bar backwards... the sign convention is
  // documented here rather than encoded"). So the game's number is negated on its way to the
  // wire, and a listener reading -40 % and a driver reading a 40 % bar are seeing one fact.
  function jfErc1(t) {
    const d = jfBlank();
    jfPut(d, 1, 1, -Number(t.retarder_state), 1, -125);
    // 1.1 SPN 900 Retarder Torque Mode, 4 bits. Mode 0000b is the one value J1939-71 states in
    // the text: "'No request': ... retarder torque = 0 (no braking)". The other fifteen live in
    // TABLE SPN899_A, which is a FIGURE in the document and did not come out of it - so a
    // retarder that is doing something leaves the field at 1111b "not available" rather than
    // claiming a mode name this file never read. Stating the gap beats guessing 0001b.
    if (Number(t.retarder_state) === 0) jfBits(d, 0, 0, 4, 0);
    return jfFrame(JF_MSGS.ERC1, d);
  }

  function jfAir1(t) {
    const d = jfBlank();
    // Bytes 3 and 4 (0-indexed 2 and 3), 8 kPa/bit. Byte 1 SPN 46 Pneumatic Supply Pressure (the
    // wet tank) and byte 2 SPN 1086 Parking and/or Trailer Air Pressure stay "not available": the
    // contract models exactly two service circuits, and the truck's spring brakes are a
    // CONSEQUENCE of the minimum of the two rather than a third reservoir with a pressure of its
    // own. Filling either from air_primary would put the same number on the wire twice.
    if (has(t, 'air_primary'))   jfPut(d, 2, 1, Number(t.air_primary) * BAR_TO_KPA, 8, 0);
    if (has(t, 'air_secondary')) jfPut(d, 3, 1, Number(t.air_secondary) * BAR_TO_KPA, 8, 0);
    return jfFrame(JF_MSGS.AIR1, d);
  }

  // ── Pack ────────────────────────────────────────────────────────────────────
  // carlito.js calls this on every telemetry message with `slow` alternating, so the natural
  // cadences are ~20 Hz (every call) and ~10 Hz (on `slow`). ERC1's 100 ms IS the slow tick.
  // AIR1's 1 s gets a wall-clock gate rather than a counter - the same shape as isobus.js's
  // 500 ms sweep - because 1 s is the standard's rate and must not drift with the frame rate.
  let jfLast1s = 0;
  function jfPack(t, slow) {
    if (!t) return [];
    const out = [];

    if (slow && has(t, 'retarder_state')) out.push(jfErc1(t));          // 100 ms

    if (Date.now() - jfLast1s >= 1000) {                                // 1 s
      if (has(t, 'air_primary') || has(t, 'air_secondary')) {
        // Only move the clock when there WAS something to send, so a vehicle with neither signal
        // does not leave the gate permanently open for the vehicle that follows it.
        jfLast1s = Date.now();
        out.push(jfAir1(t));
      }
    }
    return out;
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'j1939',
    signals: ['air_primary', 'air_secondary', 'retarder_state'],
    // Carried, but not on a clock. SPN 582 Axle Weight rides PGN 65258 (VW), whose J1939-71
    // transmission repetition rate is literally "On request" - so it has no periodic frame by
    // design, and broadcasting it at 10 Hz would misstate its rate the same way broadcasting
    // speed_limit would have. j1939.js's request path answers a PGN 59904 request for it out of
    // the live telemetry, exactly as it already does for CCSS and HOURS. This packer sends
    // nothing for it, which is why it is not in `signals` either.
    onRequest: {
      axle_load: 'SPN 582 Axle Weight rides PGN 65258 (VW), whose J1939-71 transmission ' +
        'repetition rate is "On request" - there is no periodic frame to put it in, and the ' +
        'group\'s own note ("respond with as many messages as necessary") is about a REQUEST ' +
        'being answered, not about a broadcast. j1939.js answers a PGN 59904 request for it ' +
        'from Axle - Drive #1, with SPN 928 Axle Location saying which axle the weight is',
    },
    pack: jfPack,
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
  //   61441 EBC1  100 ms. byte 2 SPN 521 Brake Pedal Position, 0.4 %/bit.
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
  // here: isobus.js publishes EEC2 from the engine with SPN 91 left at 0xFF, so its echo reads as
  // "no pedal"; nothing in sloppyCAN transmits EBC1, VDC2, TC1 or CCVS SPN 70 at all.
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
  const SA_ENGINE = 0x00;          // Engine #1 - EEC2's and (in the demo) CCVS's sender
  const SA_TRANSMISSION = 0x03;    // Transmission #1 - TC1's destination
  const SA_SHIFT_CONSOLE = 0x05;   // Shift Console - Primary (isobus.net SourceAddress table)
  const PGN_EEC2 = 61443, PGN_EBC1 = 61441, PGN_VDC2 = 61449, PGN_TC1 = 256, PGN_CCVS = 65265;
  const GEAR_R_BYTE = 0xFF;        // the contract's reverse byte
  const jfDrive = {
    accel:     { bus: undefined, at: 0 },
    brake:     { bus: undefined, at: 0 },
    steer:     { bus: undefined, at: 0 },
    gear:      { bus: undefined, at: 0 },
    handbrake: { bus: undefined, at: 0 },
    brakeLamp: { bus: undefined, at: 0 },
  };
  const jfDriveFresh = (r) => r.bus !== undefined && Date.now() - r.at <= JF_DRIVE_TTL_MS;
  function jfDriveHold(name, v) { const r = jfDrive[name]; r.bus = v; r.at = Date.now(); }

  // PDU1 id: PS is the destination, not part of the PGN.
  function jfIdDa(pgn, prio, sa, da) {
    return ((((prio & 7) << 26) >>> 0) | (((pgn >>> 16) & 1) << 24) | (((pgn >>> 8) & 0xFF) << 16) |
      ((da & 0xFF) << 8) | (sa & 0xFF)) >>> 0;
  }
  function jfParseId(id) {
    const dp = (id >>> 24) & 1, pf = (id >>> 16) & 0xFF, ps = (id >>> 8) & 0xFF;
    return { pgn: (dp << 16) | (pf << 8) | (pf < 0xF0 ? 0 : ps), da: pf < 0xF0 ? ps : 0xFF, sa: id & 0xFF };
  }

  // Contract gear byte -> SPN 525 raw, and back. Park reads as N: the parking brake is SPN 70's.
  // The contract's byte 0 is "no gear opinion" to an automatic (D once the pedal is down), so a
  // bus asking for Park or Neutral with a pedal still moves forward - the RAMN gear byte's rule,
  // not this map's. Forward Drive maps to 1, which a MANUAL gearbox holds as first gear.
  function jfGearRaw(g) {
    if (g === 'R' || g === GEAR_R_BYTE) return 125 - 1;
    const n = Math.round(Number(g)) || 0;
    return 125 + Math.max(0, Math.min(6, n));
  }
  // A gear is the operating range, -64..64 (raw 61..189). Everything else is a parameter-specific
  // code, and only Forward Drive and Park have a contract meaning; Hold, the shift requests and
  // the selector positions refresh nothing. J1939-71's reserved list (0x00-0x3D) overlaps raw 61,
  // the operating range's -64; the operating range wins here.
  function jfGearFromRaw(raw) {
    if (raw === 0xFC) return 1;            // Forward Drive position: a D intent
    if (raw === 0xFB) return 0;            // Park
    const g = raw - 125;
    if (g < -64 || g > 64) return undefined;
    if (g < 0) return GEAR_R_BYTE;
    return Math.min(6, g);
  }

  // The four frames the demo sends for a control state { accel, brake, steer, gear } (RAMN panel
  // shape: % / % / -100 L..+100 R / 1..6 or 'R'). The parking brake and brake switch ride a CCVS
  // the demo already sends, so they are a patch onto its data rather than a frame of their own.
  function j1939DriveFrames(c) {
    const eec2 = jfBlank(), ebc1 = jfBlank(), vdc2 = jfBlank(), tc1 = jfBlank();
    jfPut(eec2, 1, 1, Math.max(0, Math.min(100, Number(c.accel) || 0)), 0.4, 0);
    jfPut(ebc1, 1, 1, Math.max(0, Math.min(100, Number(c.brake) || 0)), 0.4, 0);
    const rad = -Math.max(-100, Math.min(100, Number(c.steer) || 0)) / 100 * FULL_LOCK_RAD;
    jfPut(vdc2, 0, 2, rad, 1 / 1024, -31.374);
    tc1[2] = jfGearRaw(c.gear);
    return [
      { id: jfId(PGN_EEC2, 3, SA_ENGINE), isExt: true, isRtr: false, dlc: 8, data: eec2 },
      { id: jfId(PGN_EBC1, 6, SA_BRAKES), isExt: true, isRtr: false, dlc: 8, data: ebc1 },
      { id: jfId(PGN_VDC2, 6, SA_BRAKES), isExt: true, isRtr: false, dlc: 8, data: vdc2 },
      { id: jfIdDa(PGN_TC1, 3, SA_SHIFT_CONSOLE, SA_TRANSMISSION), isExt: true, isRtr: false, dlc: 8, data: tc1 },
    ];
  }
  // Writes SPN 70 (1.3, from `handbrake`) and SPN 597 (4.5, the pedal is down) into CCVS data,
  // leaving every neighbouring field as it was.
  function j1939CcvsPatch(d, c) {
    jfBits(d, 0, 2, 2, c.handbrake ? 1 : 0);
    jfBits(d, 3, 4, 2, (Number(c.brake) || 0) > 0 ? 1 : 0);
    return d;
  }

  const jfB = (d, i) => (d && i < d.length) ? (d[i] & 0xFF) : 0xFF;
  function jfDecodeDrive(frame) {
    if (!frame.isExt || frame.isRtr || !frame.data) return;
    const { pgn, da } = jfParseId(frame.id >>> 0);
    const d = frame.data;
    if (pgn === PGN_EEC2) {
      const r = jfB(d, 1);
      if (r <= 250) jfDriveHold('accel', Math.min(100, r * 0.4));
    } else if (pgn === PGN_EBC1) {
      const r = jfB(d, 1);
      if (r <= 250) jfDriveHold('brake', Math.min(100, r * 0.4));
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
  // COMPOSE - an earlier registrant's entry is asked first (drone.js composes the other way round,
  // so the Drone Control panel wins whichever file loads first).
  window.carlitoUplinkOverrides = window.carlitoUplinkOverrides || {};
  const jfClaim = (name) => jfDriveFresh(jfDrive[name]) ? jfDrive[name].bus : undefined;
  for (const name of Object.keys(jfDrive)) {
    const prev = window.carlitoUplinkOverrides[name];
    const mine = () => jfClaim(name);
    window.carlitoUplinkOverrides[name] = prev
      ? (st) => { const v = prev(st); return v !== undefined ? v : mine(); }
      : mine;
  }
  window.j1939DriveFrames = j1939DriveFrames;
  window.j1939CcvsPatch = j1939CcvsPatch;

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.j1939FlavorSelfTest(). Covers the things that are easy to get
  // backwards and impossible to eyeball - the 29-bit id build, each SPN's scale and offset, the
  // NEGATION, bit-level field placement, and the on-request builder. Where j1939.js is loaded the
  // frames are additionally round-tripped through ITS decoder, so this module's encoder is
  // checked by an independent implementation rather than by its own arithmetic.
  function j1939FlavorSelfTest() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (d) => d.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    // 1. Id build. All three are PDU2 broadcasts; PS is the low PGN byte, never a destination.
    eq('ERC1 id', jfId(61440, 6, SA_RETARDER).toString(16).toUpperCase(), '18F00010');
    eq('AIR1 id', jfId(65198, 6, SA_BRAKES).toString(16).toUpperCase(), '18FEAE0B');
    eq('VW id',   jfId(65258, 6, SA_AXLE_DRV1).toString(16).toUpperCase(), '18FEEA09');
    if (typeof j1939ParseId === 'function') {
      eq('ERC1 id parses back', j1939ParseId(jfId(61440, 6, SA_RETARDER)),
        { priority: 6, dp: 0, pf: 0xF0, pgn: 61440, da: 0xFF, sa: 0x10 });
      eq('AIR1 id parses back', j1939ParseId(jfId(65198, 6, SA_BRAKES)),
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
    //    ...and a value past the top of the scale clamps to the top of the valid range.
    eq('over-range clamps under the reserved codes', jfAir1({ air_primary: 9999 }).data[2], 0xFA);

    // 4. The on-request half, which lives in j1939.js but is this flavor's coverage. Only
    //    checked where that module is loaded - and said out loud when it is not, because a
    //    silent skip is how a check rots.
    if (typeof window.j1939RequestServers !== 'undefined') {
      const vw = (window.j1939RequestServers || []).find(s => s.pgn === 0xFEEA);
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
        const got = j1939DecodePGN(pgn, frame.data);
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
      rt('AIR1', 65198, jfAir1({ air_primary: 8, air_secondary: 7.2 }),
        { 'Service Brake Air Pressure Circuit #1': '800 kPa',
          'Service Brake Air Pressure Circuit #2': '720 kPa' });
    }

    // 6. Driver demand. The decoder writes live state, so it is saved and restored around the test.
    const saved = JSON.stringify(jfDrive);
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
    //    Not available refreshes nothing: isobus.js's EEC2 (SPN 91 = 0xFF) must not zero the pedal.
    jfDecodeDrive({ id: jfId(PGN_EEC2, 3, SA_ENGINE), isExt: true, data: [0xFF, 0xFF, 42, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    eq('an EEC2 with SPN 91 not available leaves the pedal', Math.round(live('accel')), 40);
    //    Park and Forward Drive; a Hold refreshes nothing.
    const tcRaw = (raw) => jfDecodeDrive({ id: jfIdDa(PGN_TC1, 3, SA_SHIFT_CONSOLE, SA_TRANSMISSION), isExt: true, data: [0xFF, 0xFF, raw, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    tcRaw(0xFC); eq('Forward Drive reads D', live('gear'), 1);
    tcRaw(0xFB); eq('Park reads N', live('gear'), 0);
    tcRaw(0xFD); eq('Hold refreshes nothing', live('gear'), 0);
    //    A TC1 to another destination is not the transmission's.
    jfDecodeDrive({ id: jfIdDa(PGN_TC1, 3, SA_SHIFT_CONSOLE, 0x04), isExt: true, data: [0xFF, 0xFF, 128, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF] });
    eq('TC1 to Transmission #2 ignored', live('gear'), 0);
    //    SPN 70 in bits 3-4 of CCVS byte 1 and SPN 597 in bits 5-6 of byte 4, neighbours untouched.
    eq('CCVS switches', hex(j1939CcvsPatch(jfBlank(), { handbrake: 1, brake: 30 })), 'F7 FF FF DF FF FF FF FF');
    jfDecodeDrive({ id: jfId(PGN_CCVS, 6, SA_ENGINE), isExt: true, data: [0xF7, 0, 0, 0x10, 0, 0, 0, 0] });
    eq('decoded handbrake', live('handbrake'), 1);
    eq('decoded brake switch', live('brakeLamp'), 1);
    jfDecodeDrive({ id: jfId(PGN_CCVS, 6, SA_ENGINE), isExt: true, data: [0xFF, 0, 0, 0, 0, 0, 0, 0] });
    eq('CCVS with SPN 70 not available leaves it', live('handbrake'), 1);
    //    A withdrawn group expires, and the claim then declines.
    jfDrive.accel.at = Date.now() - JF_DRIVE_TTL_MS - 1;
    eq('stale pedal declines the claim', jfClaim('accel'), undefined);
    //    Round-trip through j1939.js's decoder, where it is loaded.
    if (typeof j1939DecodePGN === 'function') {
      const dec = (pgn, data, name) => (j1939DecodePGN(pgn, data).find(x => x.name === name) || {}).display;
      eq('EBC1 round trip', String(dec(PGN_EBC1, ebc1.data, 'Brake Pedal Position')).replace(/ /g, ' '), '100 %');
      eq('VDC2 round trip', String(dec(PGN_VDC2, vdc2.data, 'Steering Wheel Angle')).replace(/ /g, ' '), '9.425 rad');
      eq('TC1 round trip', dec(PGN_TC1, tc1.data, 'Requested Gear'), '-1');
      eq('CCVS round trip', dec(PGN_CCVS, [0xF7, 0, 0, 0x10, 0, 0, 0, 0], 'Parking Brake Switch'), 'Set');
      eq('CCVS brake switch round trip', dec(PGN_CCVS, [0xF7, 0, 0, 0x10, 0, 0, 0, 0], 'Brake Switch'), 'On');
    }
    Object.assign(jfDrive, JSON.parse(saved));

    if (failures.length) console.error('J1939 flavor self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('J1939 flavor self-test: all checks passed.');
    return failures;
  }
  window.j1939FlavorSelfTest = j1939FlavorSelfTest;
})();
