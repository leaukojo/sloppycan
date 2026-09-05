// ── ISOBUS (ISO 11783) — the carlito `isobus` flavor packer ───────────────────
// The contract deliberately says a flavor borrows a protocol's signal names/semantics
// "without implementing its CAN frames - frame layout stays on the sloppyCAN side", and this
// file is that side for ISOBUS. It registers on window.carlitoFlavorPackers, which carlito.js
// reads for both packing and its checkCanCoverage assertion. Same bolt-on pattern as
// dronecan.js, minus the tab: ISOBUS is J1939 at the wire level, so j1939.js's existing
// decoder ALREADY renders every frame this file emits (switch its Mode dropdown to ISO 11783)
// and a second view would be a second, worse one.
//
// ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
// Every PGN, SPN, resolution, offset, transmission rate, priority and preferred source address
// below was read off a primary source, never off a plan document - the dronecan.js rule, and
// the reason this file can be trusted at all:
//   - ISO 11783-7 messages (65091 / 65093 / 65096 / 65097): the ISOBUS Data Dictionary at
//     isobus.net, which is the standard's own electronic database.
//   - SAE J1939-71 messages (61443 EEC2, 61446 EAC1, 64991 FWD): the J1939-71 document.
//   - Preferred source addresses: isobus.net's SourceAddress table.
//   - The NAME bit layout: SAE J1939-81.
// FOUR of those lookups contradicted what this repo already believed, and correcting j1939.js's
// decode tables was part of the same change - each is called out at the point it bites below.
//
// ── WHAT IS NOT HERE ─────────────────────────────────────────────────────────
// `scv_flow` and `guidance_curvature` are contract dir="in" signals. A flavor packer is handed
// TELEMETRY, so there is nothing for it to pack: the real carriers exist (Auxiliary Valve
// Command, PGNs 65072-65087, and Guidance System Command, PGN 44288) and are simply waiting
// for a side that owns the control, the way dronecan.js owns its gimbal sliders. Naming them
// here rather than leaving the omission silent.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   index.html           <script src="isobus.js" defer> after carlito_contract.js and BEFORE
//                        carlito.js (the packer must be registered by the time carlito.js
//                        evaluates its coverage check)
//   carlito-bridge.html  same script tag. That page loads neither sloppycan.js nor j1939.js,
//                        so every cross-module read here is typeof-guarded.
//   j1939.js             decode-table corrections, so the frames render named and scaled
//
// Telemetry TX rides carlito.js's canForward gateway, which is what puts these on the wire and
// in the dump as FW entries. No transport code here.

(function () {
  'use strict';

  // ── Wire primitives ─────────────────────────────────────────────────────────
  // J1939/ISO 11783 29-bit id:
  //   [28:26] priority  [25] EDP  [24] DP  [23:16] PDU format  [15:8] PDU specific  [7:0] SA
  // PDU2 (PF >= 0xF0) is a broadcast and PS is part of the PGN; PDU1 (PF < 0xF0) puts the
  // DESTINATION address in PS and the PGN does not include it. Address Claim (60928, PF 0xEE)
  // is the one PDU1 message here, and its destination is the global address.
  function ibId(pgn, prio, sa, da) {
    const dp = (pgn >>> 16) & 1;
    const pf = (pgn >>> 8) & 0xFF;
    const ps = pf < 0xF0 ? ((da == null ? 0xFF : da) & 0xFF) : (pgn & 0xFF);
    return ((((prio & 7) << 26) >>> 0) | (dp << 24) | (pf << 16) | (ps << 8) | (sa & 0xFF)) >>> 0;
  }

  // A frame's data starts as eight 0xFF bytes and fields are written INTO it. That is not
  // laziness: in J1939 an all-ones field IS "not available", so a byte this module never
  // touches states "no source for this" rather than claiming a zero - the same statement
  // carlito.js's uplink makes by OMITTING an unwired signal.
  function ibBlank() { return [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; }

  // A scaled unsigned SPN, little-endian, in j1939DecodeSPN's own {b,n,f,o} vocabulary so the
  // two are exact inverses. Non-finite input writes nothing and the 0xFF..FF default stands.
  // The top two raw codes are reserved (0xFF..FE error, 0xFF..FF not available), so a real
  // value clamps below them rather than colliding with one.
  function ibPut(d, b, n, val, f, o) {
    const v = Number(val);
    if (!Number.isFinite(v)) return;
    const max = Math.pow(2, 8 * n) - 1;
    let raw = Math.round((v - (o || 0)) / f);
    raw = Math.max(0, Math.min(max - 2, raw));
    for (let i = 0; i < n; i++) { d[b + i] = raw % 256; raw = Math.floor(raw / 256); }
  }
  // A bit-level SPN. `bit` is the 0-based LSB position within byte `b`, matching
  // j1939DecodeSPN - so the standard's "5.7" (byte 5, bit 7 counting from 1) is b=4, bit=6.
  function ibBits(d, b, bit, nbits, val) {
    const mask = (((1 << nbits) - 1) << bit) & 0xFF;
    d[b] = ((d[b] & ~mask) | ((val << bit) & mask)) & 0xFF;
  }

  // The two-bit state vocabulary shared by nearly every discrete SPN in this file:
  // 00 off/disengaged/not-in-work, 01 on/engaged/in-work, 10 error, 11 not available.
  const IB_OFF = 0, IB_ON = 1;

  // ── Preferred source addresses ──────────────────────────────────────────────
  // THE ONE PLACE AN ADDRESS IS DECLARED (dronecan.js's DC_ROSTER rule). All come off
  // isobus.net's SourceAddress table, and the Tractor ECU one is the load-bearing find:
  // SA 240 is "a gateway (see ISO 11783-4) between the tractor and the implement bus
  // representing the tractor and its messages on the 11783 network" - which is exactly what
  // this module is standing in for, so the four ISO 11783-7 messages come FROM it.
  // j1939.js's own J1939_SA table disagreed with that table on most of its entries (it had
  // 0x21/0x22/0x23 as the axles, where the real ones are 0x08/0x09/0x0A) - corrected there.
  const SA_TECU      = 240;   // 0xF0 Tractor ECU
  const SA_ENGINE    = 0;     // 0x00 Engine #1
  const SA_AXLE_DRV1 = 9;     // 0x09 Axle - Drive #1  (the rear axle, whose diff lock EAC1 reports)
  const SA_AXLE_STR  = 8;     // 0x08 Axle - Steering  (a tractor's front axle IS its steering axle,
                              //      and Front Wheel Drive Status is a statement about that axle)
  // The implement claims out of the 128-237 range ISO 11783-5 recommends for implement
  // applications rather than a preferred address, because it is not a preferred-address
  // function - its identity is its NAME, which is the whole point of the claim below.
  const SA_IMPLEMENT = 128;

  // ── Message table ───────────────────────────────────────────────────────────
  // Data, not call sites. `ms` is the standard's own transmission rate, recorded so the gate in
  // ibPack can be checked against it - no cadence in this file is invented, and the two 100 ms
  // groups line up exactly with carlito.js's own fast/slow ticks. It is documentation rather
  // than a value the gate reads: a wall clock at 50 ms sampled by a ~50 ms caller skips a tick
  // whenever jitter goes the wrong way, and halving EEC2's rate to avoid a magic number would
  // be the worse trade.
  const IB_MSGS = {
    // SAE J1939-71. EEC2 byte 3 is SPN 92 Percent Load At Current Speed. NOT EEC1: J1939-71
    // gives EEC1 (61444) bytes 2 and 3 as SPN 512 / 513, the two TORQUE parameters, and
    // j1939.js's table had SPN 91/92 there - corrected in the same change as this file.
    EEC2: { pgn: 61443, prio: 3, sa: SA_ENGINE,    ms: 50 },
    // Electronic Axle Controller 1. 2.5 is SPN 569 Differential Lock State - Rear Axle 1.
    EAC1: { pgn: 61446, prio: 6, sa: SA_AXLE_DRV1, ms: 500 },
    // Front Wheel Drive Status. 1.1 is SPN 2612 Front Wheel Drive Actuator Status.
    FWD:  { pgn: 64991, prio: 7, sa: SA_AXLE_STR,  ms: 500 },
    // ISO 11783-7. THE PGN PAIRS ARE THE OTHER WAY ROUND FROM WHAT THIS REPO BELIEVED:
    // 65091 is the rear PTO and 65093 is the rear hitch, per isobus.net ("Primary or Rear
    // Power Take off Output Shaft" / "Primary or Rear Hitch Status"). j1939.js's ISOBUS_DB had
    // 0xFE43 and 0xFE45 swapped, so a correct frame would have decoded under the wrong name -
    // corrected alongside this file. 65091's rate is "100 ms when engaged, otherwise on
    // request", which is why a disengaged PTO still publishes here: the alternative is a
    // request path this module does not have, and silence would read as a missing node.
    RPTO: { pgn: 65091, prio: 3, sa: SA_TECU, ms: 100 },
    RHS:  { pgn: 65093, prio: 3, sa: SA_TECU, ms: 100 },
    WBSD: { pgn: 65096, prio: 3, sa: SA_TECU, ms: 100 },
    GBSD: { pgn: 65097, prio: 3, sa: SA_TECU, ms: 100 },
    // Address Claim: PDU1, global destination, and aperiodic by definition (see ibClaim).
    ACL:  { pgn: 60928, prio: 6, sa: SA_IMPLEMENT, da: 0xFF, ms: 0 },
  };
  function ibFrame(m, data) { return { id: ibId(m.pgn, m.prio, m.sa, m.da), isExt: true, data }; }

  // ── Telemetry presence ──────────────────────────────────────────────────────
  // dronecan.js gates its whole packer on one signature signal, because a drone is the only
  // vehicle that publishes any of its flavor. ISOBUS CANNOT: `engine_load`, `engine_hours` and
  // `pto_state` are declared for the TRUCK as well as the tractor (the contract says so in
  // engine_load's own desc - "SPN 92 is a J1939 signal and the tractor's was always the
  // borrowed one"), so a vehicle gate would either drop the truck's engine load or invent a
  // tractor's hitch. Each message is therefore gated on ITS OWN signals: the game publishes
  // signals_for_vehicle, so an absent key is a real absence and not a zero.
  const has = (t, k) => t && t[k] !== undefined && t[k] !== null;

  // Contract `status` bit assignments. The layout is frozen by the contract, and these are the
  // only two bits this file reads - `status` itself stays CAN_MAP's signal to pack.
  const ST_IGNITION = 1 << 0;
  const ST_REVERSE  = 1 << 3;
  const stat = (t) => (Number(t && t.status) || 0);

  // km/h (the contract's unit for both speeds) -> m/s (the SPNs' unit).
  const KMH_TO_MS = 1 / 3.6;

  // ── Builders ────────────────────────────────────────────────────────────────
  function ibEec2(t) {
    const d = ibBlank();
    // SPN 92, byte 3, 1 %/bit, offset 0. Byte 2 (SPN 91 Accelerator Pedal Position) and byte 4
    // (SPN 974 Remote Accelerator) stay "not available": the pedal is an UNFLAVORED contract
    // signal and belongs to CAN_MAP's side of the coverage check, not this one.
    ibPut(d, 2, 1, t.engine_load, 1, 0);
    return ibFrame(IB_MSGS.EEC2, d);
  }

  function ibEac1(t) {
    const d = ibBlank();
    // Byte 1 is SPN 927 Location, which identifies WHICH of several similar devices is
    // speaking. There is one axle controller here and no position number to give, so it stays
    // 0xFF - the standard's own "not available" - rather than an invented 0 meaning "front
    // left". 2.5 = byte 2, bit index 4.
    ibBits(d, 1, 4, 2, t.diff_lock_state ? IB_ON : IB_OFF);
    return ibFrame(IB_MSGS.EAC1, d);
  }

  function ibFwd(t) {
    const d = ibBlank();
    ibBits(d, 0, 0, 2, t.fwd_drive_state ? IB_ON : IB_OFF);
    return ibFrame(IB_MSGS.FWD, d);
  }

  function ibRpto(t) {
    const d = ibBlank();
    // Bytes 1-2 SPN 1883 Rear PTO output shaft speed, 0.125 1/min per bit. Absent on the truck,
    // whose chassis PTO the contract also flavors isobus but gives no shaft speed - so the
    // field states "not available" there rather than reporting a stopped shaft.
    // A KNOWN WART on the truck, stated rather than papered over: this goes out from the
    // Tractor ECU address, because `pto_state` carries the isobus flavor for both vehicles and
    // this module has one message for it. A truck's chassis PTO is really SPN 976 in PGN 65264,
    // which is the j1939 packer's flavor and not this one's - the split is the contract's, and
    // moving it would be a contract edit rather than a change here.
    if (has(t, 'pto_rpm')) ibPut(d, 0, 2, t.pto_rpm, 0.125, 0);
    // Bytes 3-4 SPN 1885 set point: the requested speed is an inbound signal (`pto_mode`), so
    // there is no set point on this side to report.
    // 5.7 = byte 5, bit index 6: SPN 2408 Rear Power Take Off Engagement.
    ibBits(d, 4, 6, 2, t.pto_state ? IB_ON : IB_OFF);
    return ibFrame(IB_MSGS.RPTO, d);
  }

  function ibRhs(t) {
    const d = ibBlank();
    ibPut(d, 0, 1, t.hitch_pos_actual, 0.4, 0);            // SPN 1873, byte 1, 0.4 %/bit
    // 2.7 SPN 1877 Rear Hitch In-work Indication stays "not available": in-work is whether the
    // implement is DOING ITS JOB, and the game has no such signal. Deriving it from
    // draft_force > 0 would be wrong for every implement that works above the ground - a mower
    // is in work and pulls no draft at all.
    // Byte 3 SPN 1881 Rear Nominal Lower Link Force: 0.8 %/bit, offset -100, so its scale runs
    // -100..+100 % and the contract's 0..100 % draft lands in the top half. Note this is NOT
    // bytes 4-5 (SPN 1879 Rear Draft, 10 N/bit): draft_force is a PERCENTAGE of the tractor's
    // rated draft and SPN 1881 is the percentage field; the newton field has no source here
    // and stays "not available", which is the honest half of the pair to leave empty.
    ibPut(d, 2, 1, t.draft_force, 0.8, -100);
    return ibFrame(IB_MSGS.RHS, d);
  }

  // Both speed messages share a shape: a 16-bit speed, a 32-bit free-running distance and a
  // 2-bit direction in byte 8. The DISTANCE stays "not available" in both, and that is a
  // decision rather than a gap: the game's odometer is the UNFLAVORED `odo` signal, packed
  // once by CAN_MAP in 0x526. Repeating it here would put the same number on the wire twice
  // under two identities, and claiming `odo` would fail the coverage check for good reason.
  function ibSpeedBody(t, kmh) {
    const d = ibBlank();
    ibPut(d, 0, 2, Number(kmh) * KMH_TO_MS, 0.001, 0);
    // Direction comes off the contract's frozen `status` reverse-gear bit, which is the only
    // direction statement the telemetry makes - both speed signals are unsigned. GATED ON
    // `status` BEING PRESENT: a payload without it (an older game build, a partial frame) would
    // otherwise read 0 here and claim FORWARD, which is a statement no source made. Every other
    // field in this file leaves 0xFF standing for exactly that reason, and this one is only not
    // a plain ibPut because it is two bits.
    if (has(t, 'status')) ibBits(d, 7, 0, 2, (stat(t) & ST_REVERSE) ? IB_OFF : IB_ON);
    return d;
  }
  function ibWbsd(t) {
    const d = ibSpeedBody(t, t.wheel_speed);
    // 8.3 SPN 1865 Key switch state: 00 off, 01 not off. The contract's status bit 0 IS the
    // key, so this is mirrored rather than modelled - and absent for the same reason as above
    // when `status` is, rather than claiming the key is off.
    if (has(t, 'status')) ibBits(d, 7, 2, 2, (stat(t) & ST_IGNITION) ? IB_ON : IB_OFF);
    // Byte 7 SPN 1866 Maximum Time of Tractor Power stays "not available": the tractor holds
    // power for as long as the game is running, which is not a number of minutes.
    return ibFrame(IB_MSGS.WBSD, d);
  }
  function ibGbsd(t) {
    return ibFrame(IB_MSGS.GBSD, ibSpeedBody(t, t.ground_speed));
  }

  // ── The implement's Address Claim ───────────────────────────────────────────
  // implement_connected and implement_type are ONE frame, and it is not a status message: the
  // contract's own desc says "An implement has claimed an address on the implement bus.
  // Attaching IS the claim", and ISO 11783 means that literally. An implement announces itself
  // with PGN 60928 carrying its 64-bit NAME, whose Vehicle System field (bits 49-55) is its
  // device class - and the contract's implement_type enum values ARE ISO device classes
  // (2 tillage, 3 secondary tillage, 5 fertilizer, 9 forage), which is why they go into that
  // field unmapped. The enum is READ from the contract below rather than retyped.
  //
  // SO IT IS SENT ON CHANGE, NEVER PERIODICALLY. A claim is made when a control function joins
  // the bus, and there is no "unclaim" message in J1939 at all: an implement that leaves simply
  // stops talking and its address ages out. Unhitching therefore emits nothing, which is the
  // same statement dronecan.js's offline nodes make by going silent.
  const IB_MFR_CODE = 0;      // no manufacturer code is registered to this project, and 0 is the
                              // unassigned value - inventing someone else's would be a false claim
  const IB_IDENTITY = 1;      // serial number within the manufacturer code
  const IB_FUNCTION = 0;      // J1939-81 functions 0-127 are industry-group independent, and 0 is
                              // "Non-specific" - right here, because this implement's identity is
                              // carried entirely by its device class
  const IB_INDUSTRY_AG = 2;   // Agricultural and forestry equipment

  // J1939-81 NAME, little-endian:
  //   0-20 identity · 21-31 manufacturer code · 32-34 ECU instance · 35-39 function instance
  //   40-47 function · 48 reserved · 49-55 vehicle system (= ISO device class)
  //   56-59 vehicle system instance · 60-62 industry group · 63 arbitrary address capable
  // j1939DecodeName had the last two at bits 57-59 and 60, so an industry group written
  // correctly here decoded as something else - corrected alongside this file.
  function ibName(devClass) {
    const lo = ((IB_IDENTITY & 0x1FFFFF) | ((IB_MFR_CODE & 0x7FF) << 21)) >>> 0;
    const hi = (((IB_FUNCTION & 0xFF) << 8) | ((devClass & 0x7F) << 17) |
                ((IB_INDUSTRY_AG & 7) << 28) | (1 << 31)) >>> 0;   // hi bit 31 = NAME bit 63
    return [lo & 0xFF, (lo >>> 8) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 24) & 0xFF,
            hi & 0xFF, (hi >>> 8) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 24) & 0xFF];
  }

  let ibLastClaim = null;   // last (connected ? device class : -1) actually announced
  function ibClaim(t) {
    if (!has(t, 'implement_connected')) return [];
    const conn = !!t.implement_connected;
    const key = conn ? (Math.round(Number(t.implement_type) || 0) & 0x7F) : -1;
    if (key === ibLastClaim) return [];
    ibLastClaim = key;
    if (!conn) return [];
    ibWarnDeviceClass(key);
    return [ibFrame(IB_MSGS.ACL, ibName(key))];
  }

  // The contract's implement_type enum is the machine-readable half of this claim, so it is the
  // one thing that can be asserted - and a value that is not an ISO device class would put a
  // plausible-looking implement on the bus under the wrong identity. Warn once per value.
  const ibWarnedClasses = new Set();
  function ibWarnDeviceClass(v) {
    if (ibWarnedClasses.has(v)) return;
    ibWarnedClasses.add(v);
    const c = window.CARLITO_CONTRACT;
    const s = c && c.signals && c.signals.find(x => x.name === 'implement_type' && x.dir === 'out');
    if (s && s.enum && s.enum[v] == null) {
      console.warn('ISOBUS: implement_type ' + v + ' is not in the contract enum - claiming it ' +
        'as an ISO 11783 device class anyway, but one of the two has moved.');
    }
  }

  // ── Pack ────────────────────────────────────────────────────────────────────
  // carlito.js calls this on every telemetry message with `slow` alternating, so the natural
  // cadences are ~20 Hz (every call) and ~10 Hz (on `slow`). The 500 ms messages get a
  // wall-clock gate rather than a counter - the same shape as dronecan.js's 1 Hz NodeStatus
  // sweep - because 500 ms is the standard's rate and must not drift with the frame rate.
  let ibLast500 = 0;
  function ibPack(t, slow) {
    if (!t) return [];
    const out = [];
    const now = Date.now();

    if (has(t, 'engine_load')) out.push(ibEec2(t));                    // 50 ms

    if (slow) {                                                        // 100 ms
      if (has(t, 'pto_state')) out.push(ibRpto(t));
      if (has(t, 'hitch_pos_actual') || has(t, 'draft_force')) out.push(ibRhs(t));
      if (has(t, 'wheel_speed')) out.push(ibWbsd(t));
      if (has(t, 'ground_speed')) out.push(ibGbsd(t));
    }

    if (now - ibLast500 >= 500) {                                      // 500 ms
      const five = [];
      if (has(t, 'diff_lock_state')) five.push(ibEac1(t));
      if (has(t, 'fwd_drive_state')) five.push(ibFwd(t));
      // Only move the clock when there WAS something to send, so a vehicle with neither signal
      // does not leave the gate permanently open for the vehicle that follows it.
      if (five.length) { ibLast500 = now; out.push(...five); }
    }

    out.push(...ibClaim(t));                                           // on change
    return out;
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'isobus',
    signals: ['engine_load', 'diff_lock_state', 'fwd_drive_state',
              'pto_state', 'pto_rpm', 'hitch_pos_actual', 'draft_force',
              'wheel_speed', 'ground_speed',
              'implement_connected', 'implement_type'],
    // Carried, but not on a clock. SPN 247 rides PGN 65253 (HOURS), whose J1939-71 transmission
    // repetition rate is literally "On request" - so it has no periodic frame by design, which is
    // why it was an `unpackable` entry here until there was a request path to point at. There is
    // now: j1939.js answers a PGN 59904 request for 65253 out of the game's telemetry. That entry
    // said the same path would retire it and `speed_limit` together, and it did. This packer
    // still packs nothing for it, which is why it is not in `signals` either.
    onRequest: {
      engine_hours: 'SPN 247 rides PGN 65253 (HOURS), whose J1939-71 transmission repetition ' +
        'rate is "On request" - there is no periodic frame to put it in, and broadcasting it at ' +
        '10 Hz would misstate its rate. j1939.js answers a PGN 59904 request for it instead',
    },
    unpackable: {
      wheel_slip: 'no SPN exists for it. Wheel slip IS wheel_speed running ahead of ground_speed, ' +
        'which is exactly why ISO 11783-7 defines the two speeds as separate messages (SPN 1862 in ' +
        'WBSD, SPN 1859 in GBSD) and no third one for their difference - both are packed here, so a ' +
        'listener computes the same number the game did. The contract desc cites "J1939 SPN 1858"; ' +
        'that number is unassigned in the ISOBUS Data Dictionary, so the citation is wrong rather ' +
        'than the signal being unimplemented',
    },
    pack: ibPack,
  });

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.isobusSelfTest(). Covers the things that are easy to get
  // backwards and impossible to eyeball - the 29-bit id build, each SPN's scale and offset,
  // bit-level field placement, and the NAME layout. Where j1939.js is loaded the frames are
  // additionally round-tripped through ITS decoder, so this module's encoder is checked by an
  // independent implementation that was already here rather than by its own arithmetic.
  function isobusSelfTest() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (d) => d.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    // 1. Id build. WBSD from the TECU: priority 3, PDU2, PF 0xFE, PS 0x48, SA 0xF0.
    eq('WBSD id', ibId(65096, 3, SA_TECU).toString(16).toUpperCase(), 'CFE48F0');
    // Address Claim is PDU1: PS is the GLOBAL DESTINATION, not part of the PGN.
    eq('Address Claim id', ibId(60928, 6, SA_IMPLEMENT, 0xFF).toString(16).toUpperCase(), '18EEFF80');
    if (typeof j1939ParseId === 'function') {
      eq('WBSD id parses back', j1939ParseId(ibId(65096, 3, SA_TECU)),
        { priority: 3, dp: 0, pf: 0xFE, pgn: 65096, da: 0xFF, sa: 240 });
      eq('Address Claim id parses back', j1939ParseId(ibId(60928, 6, SA_IMPLEMENT, 0xFF)),
        { priority: 6, dp: 0, pf: 0xEE, pgn: 60928, da: 0xFF, sa: 128 });
    }

    // 2. Scales, one pinned frame each. Every untouched byte must still read 0xFF.
    //    18 km/h = 5 m/s = raw 5000 = 0x1388, little-endian 88 13. Byte 8 = 0b11110101:
    //    direction 01 forward, key 01 not off, and the two upper pairs still 11 "not available".
    eq('WBSD 18 km/h forward, key on',
      hex(ibWbsd({ wheel_speed: 18, status: ST_IGNITION }).data),
      '88 13 FF FF FF FF FF F5');
    eq('GBSD 18 km/h in reverse',
      hex(ibGbsd({ ground_speed: 18, status: ST_REVERSE }).data),
      '88 13 FF FF FF FF FF FC');
    //    hitch 62 % -> 62/0.4 = 155 = 0x9B; draft 60 % -> (60+100)/0.8 = 200 = 0xC8.
    eq('RHS hitch 62 %, draft 60 %',
      hex(ibRhs({ hitch_pos_actual: 62, draft_force: 60 }).data),
      '9B FF C8 FF FF FF FF FF');
    //    1000 rpm -> 8000 = 0x1F40, little-endian 40 1F; engagement 01 in byte 5 bits 7-8.
    eq('RPTO 1000 rpm engaged',
      hex(ibRpto({ pto_rpm: 1000, pto_state: true }).data),
      '40 1F FF FF 7F FF FF FF');
    eq('RPTO disengaged with no shaft speed (the truck case)',
      hex(ibRpto({ pto_state: false }).data),
      'FF FF FF FF 3F FF FF FF');
    eq('EEC2 42 % load', hex(ibEec2({ engine_load: 42 }).data), 'FF FF 2A FF FF FF FF FF');
    eq('EAC1 rear diff locked', hex(ibEac1({ diff_lock_state: true }).data), 'FF DF FF FF FF FF FF FF');
    eq('EAC1 rear diff open',   hex(ibEac1({ diff_lock_state: false }).data), 'FF CF FF FF FF FF FF FF');
    eq('FWD engaged', hex(ibFwd({ fwd_drive_state: true }).data), 'FD FF FF FF FF FF FF FF');

    // 3. A signal the game did not publish must leave "not available" standing, not write a 0 -
    //    and a real 0 must still be written as a 0.
    eq('absent draft leaves 0xFF, a real zero does not',
      hex(ibRhs({ hitch_pos_actual: 0 }).data), '00 FF FF FF FF FF FF FF');
    //    ...and the two BIT fields obey the same rule: no `status`, no direction and no key
    //    state, rather than a 0 that reads as "forward, key off".
    eq('no status leaves direction and key not-available',
      hex(ibWbsd({ wheel_speed: 18 }).data), '88 13 FF FF FF FF FF FF');
    eq('a real key-off status still says off',
      hex(ibWbsd({ wheel_speed: 18, status: 0 }).data), '88 13 FF FF FF FF FF F1');
    //    ...and a value past the top of the scale clamps BELOW the two reserved codes.
    eq('over-range clamps under the reserved codes', ibEec2({ engine_load: 9999 }).data[2], 0xFD);

    // 4. The NAME. Tillage (device class 2), agriculture (industry group 2), self-configurable.
    const nm = ibName(2);
    //    hi = (2 << 28) | (1 << 31) = 0xA0000000, plus (2 << 17) = 0x00040000 for the class.
    eq('NAME bytes', hex(nm), '01 00 00 00 00 00 04 A0');
    if (typeof j1939DecodeName === 'function') {
      const back = j1939DecodeName(nm);
      eq('NAME device class', back.devClass, 2);
      eq('NAME industry group', back.industryGrp, IB_INDUSTRY_AG);
      eq('NAME arbitrary address capable', back.arbitrary, 1);
      eq('NAME function', back.fn, IB_FUNCTION);
    }

    // 5. Round-trip every frame through j1939.js's own decoder. It reads the ACTIVE database,
    //    so the ISO 11783-7 messages only resolve with the J1939 tab in ISO 11783 mode - say so
    //    rather than skipping silently, because a silent skip is how a check rots.
    if (typeof j1939DecodePGN === 'function') {
      const rt = (label, pgn, frame, want) => {
        const got = j1939DecodePGN(pgn, frame.data);
        if (!got.length) {
          failures.push(label + ': no decoder entry for PGN ' + pgn + ' in the active database ' +
            '(switch the J1939 tab to ISO 11783 mode and re-run)');
          return;
        }
        for (const name of Object.keys(want)) {
          const f = got.find(x => x.name === name);
          if (!f) { failures.push(label + ': decoder returned no field "' + name + '"'); continue; }
          // j1939DecodeSPN joins value and unit with a NON-BREAKING space, so the comparison
          // normalises rather than this file carrying invisible U+00A0 in its expectations.
          eq(label + ' ' + name, String(f.display).replace(/\u00A0/g, ' '), want[name]);
        }
      };
      rt('EEC2', 61443, ibEec2({ engine_load: 42 }), { 'Percent Load At Current Speed': '42 %' });
      rt('WBSD', 65096, ibWbsd({ wheel_speed: 18, status: ST_IGNITION }),
        { 'Wheel-based machine speed': '5.000 m/s', 'Wheel-based machine direction': 'Forward' });
      rt('GBSD', 65097, ibGbsd({ ground_speed: 18, status: 0 }),
        { 'Ground-based machine speed': '5.000 m/s' });
      rt('RHS', 65093, ibRhs({ hitch_pos_actual: 62, draft_force: 60 }),
        { 'Rear Hitch Position': '62 %', 'Rear Nominal Lower Link Force': '60 %' });
      rt('RPTO', 65091, ibRpto({ pto_rpm: 1000, pto_state: true }),
        { 'Rear PTO output shaft speed': '1000.0 rpm', 'Rear PTO engagement': 'Engaged' });
    }

    // 6. The claim is aperiodic: the same implement must not re-announce, and unhitching must
    //    emit nothing at all (J1939 has no "unclaim").
    const saved = ibLastClaim;
    ibLastClaim = null;
    eq('claim on attach', ibClaim({ implement_connected: true, implement_type: 2 }).length, 1);
    eq('no re-claim while unchanged', ibClaim({ implement_connected: true, implement_type: 2 }).length, 0);
    eq('a different implement re-claims', ibClaim({ implement_connected: true, implement_type: 5 }).length, 1);
    eq('detach is silence', ibClaim({ implement_connected: false, implement_type: 0 }).length, 0);
    eq('no implement signal, no claim', ibClaim({}).length, 0);
    ibLastClaim = saved;

    if (failures.length) console.error('ISOBUS self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('ISOBUS self-test: all checks passed.');
    return failures;
  }
  window.isobusSelfTest = isobusSelfTest;
})();
