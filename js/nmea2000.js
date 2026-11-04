// ── NMEA 2000 — the carlito `nmea2000` flavor packer ─────────────────────────
// The direct sibling of isobus.js / j1939-flavor.js / dronecan.js: registers
// { flavor, signals, pack(t, slow) } on window.carlitoFlavorPackers, which carlito.js reads for
// both packing and its checkCanCoverage assertion. NMEA 2000 is J1939 at the wire level, so
// j1939.js's existing decoder already renders every frame this file emits (switch its Mode
// dropdown to J1939 / N2K, nmea2000 mode) - a second view would be a second, worse one, the
// isobus.js precedent exactly.
//
// ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
// Every field this file WRITES was checked field-for-field against j1939-tables.js's own NMEA2K_DB
// (the primary source lives there, never here): the self-test round-trips every frame through
// j1939DecodePGN. 127245 Rudder, 127237 Heading/Track Control and 130577 Direction Data are
// there off ttlappalainen's NMEA2000 library (N2kMessages.cpp SetN2kPGN127245 /
// SetN2kPGN127237 / SetN2kPGN130577) - the closest thing to a public reference for a PGN
// NMEA's own documents keep behind a paywall.
//
// ── THE COMMANDS, AND WHAT IS NOT HERE ───────────────────────────────────────
// `nav_mode` and `heading_cmd` are contract dir="in" signals this file OWNS: boat-pilot.js's
// control head is a view over them, and a PGN 127237 from another address drives them too - see
// "The autopilot COMMANDS" below. `rudder` is this file's too, decoded off PGN 127245 Rudder's
// Angle Order (the same frame this file's OUT half builds for `rudder_actual`, which leaves the
// order unavailable) - see "The rudder ORDER" below. Absent that, the boat is steered on the RAMN
// steer axis, which the game accepts as the rudder when `rudder` is absent.
//
// `sheet` and `sail_angle` are NOT this file's signals either, and for a different reason: NMEA
// 2000 defines no sail PGN at all, so this file has no flavor to belong to for either one.
// `sail_angle` is the base CAN map's job (contract v41, `carlito.js`'s 0x52B frame); `sheet` is
// `dir:"in"` and rides the same uplink path the base `in` signals do.
//
// `battery`, `coolant`, `engine_hours`, `heading`, `pitch` and `roll` are all UNFLAVORED despite
// their own desc text citing a PGN (127508 / 127489 / 127489 / 127250 / 127257 / 127257
// respectively) - the `engine_hours` precedent exactly: those signals are shared with vehicle
// families that do not speak NMEA 2000 at all (plane, drone, car, truck, tractor), so the PGN
// citation is a naming reference, not a claim about which protocol owns the wire. They are the
// base CAN map's job, and packing them here would fail checkCanCoverage's own logic for the
// wrong reason - the signal would look covered twice, once honestly and once not. The one
// deliberate exception is declared rather than hidden: a BOAT also carries `heading` / `lat` /
// `lon` in 127250 / 129025 (`mirrors` below - decision 1's reasoning, applied to the boat: an NMEA
// 2000 view of a boat with no heading or position is the stranger result). Both layouts are
// NMEA2K_DB's, round-tripped by the self-test like every other frame here.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   index.html            <script src="nmea2000.js" defer> after carlito-registry.js and
//                         j1939-pack.js
//   carlito-bridge.html   same script tag. That page loads neither sloppycan.js nor j1939.js,
//                         so every cross-module read here is typeof-guarded.
//
// Telemetry TX rides carlito.js's canForward gateway, which is what puts these on the wire and
// in the dump as FW entries. No transport code here.

(function () {
  'use strict';

  // ── Shared angle constant, aliased with a fallback ────────────────────────────
  // j1939-tables.js declares N2K_ANG (0.0001 rad/bit, in degrees) as a top-level `const`, which a
  // later classic <script> can read by name - but carlito-bridge.html does not load j1939-tables.js at
  // all, so the alias keeps its own copy rather than throwing there.
  const NF_ANG = (typeof N2K_ANG !== 'undefined') ? N2K_ANG : 0.0001 * (180 / Math.PI);

  // ── Wire primitives ─────────────────────────────────────────────────────────
  // j1939-pack.js (window.J1939Pack). Every PGN below is a PDU2 broadcast (all are >= 126720, so
  // PF is always >= 0xF0), so no id here carries a destination. Every field is byte-aligned, and
  // every bit-level one fits inside a single byte.
  const jp = window.J1939Pack;
  // NMEA 2000 reserves the top TWO codes of a field, not J1939's top-byte range, so every scaled
  // field here goes through the 'n2k' rule - which this wrapper is the one place to state.
  const NF_U = { rule: 'n2k' }, NF_S = { rule: 'n2k', signed: true };
  // A SIGNED field's "not available" is its maximum positive value (little-endian FF .. 7F), not the
  // all-ones blank, which a decoder reads as -1: so a signed field with no value gets it here, and
  // every builder marks the signed fields it never writes with nfNaSigned.
  const nfPut = (d, b, n, val, f, o, signed) => {
    if (signed && !Number.isFinite(Number(val))) return nfNaSigned(d, b, n);
    jp.put(d, b, n, val, f, o, signed ? NF_S : NF_U);
  };
  function nfNaSigned(d, b, n) { for (let i = 0; i < n - 1; i++) d[b + i] = 0xFF; d[b + n - 1] = 0x7F; }

  // ── Fast Packet framing ────────────────────────────────────────────────────
  // Same shape j1939.js's own NMEA demo already builds for 127489 (j1939DemoFrames): first
  // frame is [(seq<<5)|0, totalLength, ...first 6 payload bytes], each continuation is
  // [(seq<<5)|frameCounter, ...next 7 payload bytes], padded with 0xFF past the payload's end.
  // Keyed per (PGN, SA) so two Fast Packet messages from different addresses do not share a
  // rolling sequence counter.
  const nfSeq = new Map();
  function nfNextSeq(key) { const v = (nfSeq.get(key) || 0) & 0x07; nfSeq.set(key, (v + 1) & 0x07); return v; }
  function nfFastPacket(pgn, prio, sa, payload) {
    const seq = nfNextSeq(pgn + ':' + sa);
    const total = payload.length;
    const frames = [];
    let idx = 0;
    const f0 = [(seq << 5) | 0, total];
    for (let i = 0; i < 6; i++) f0.push(idx < total ? payload[idx++] : 0xFF);
    frames.push(jp.frame(jp.buildId(pgn, prio, sa), f0));
    for (let fc = 1; idx < total; fc++) {
      const fr = [(seq << 5) | fc];
      for (let i = 0; i < 7; i++) fr.push(idx < total ? payload[idx++] : 0xFF);
      frames.push(jp.frame(jp.buildId(pgn, prio, sa), fr));
    }
    return frames;
  }

  // ── Source addresses ────────────────────────────────────────────────────────
  // THE ONE PLACE AN ADDRESS IS DECLARED (dronecan-core.js's / isobus.js's rule). NMEA 2000 has no
  // preferred-address table the way J1939 does (isobus.net's SourceAddress table) - a real
  // network claims arbitrary addresses via Address Claim - so these are this file's own choice,
  // one per logical instrument, grouped by NMEA_DEVICE_CLASS (j1939-tables.js): the engine block is
  // Propulsion (50), the helm/autopilot is Steering and Control (40), the nav computer is
  // Navigation (60), the tank sender is Instrumentation/General (80).
  const SA_ENGINE = 0;
  const SA_HELM   = 1;
  const SA_NAV    = 2;
  const SA_TANK   = 3;
  const SA_STEER_HEAD = 4;   // the demo's steering control head, which orders rudder angles

  // Full rudder throw, in degrees, for converting the contract's `rudder`/`rudder_actual`
  // PERCENTAGE onto PGN 127245's Position/Angle Order fields, which are real angles. 35 degrees
  // is the conventional hard-over figure most small-craft wheel/tiller steering systems use
  // (the isobus.js precedent for a percentage-to-real-unit choice with no contract constant to
  // read it from - draft_force's Rear Nominal Lower Link Force offset is the same kind of
  // declared-once conversion). Stated here rather than encoded silently.
  const RUDDER_MAX_DEG = 35;

  const has = jp.has;

  // ── Message table ───────────────────────────────────────────────────────────
  const NF_MSGS = {
    RUDDER:   { pgn: 127245, prio: 2, sa: SA_HELM },
    ENGRAPID: { pgn: 127488, prio: 2, sa: SA_ENGINE },
    WIND:     { pgn: 130306, prio: 2, sa: SA_NAV },
    SPDWTR:   { pgn: 128259, prio: 2, sa: SA_NAV },
    COGSOG:   { pgn: 129026, prio: 2, sa: SA_NAV },
    DEPTH:    { pgn: 128267, prio: 3, sa: SA_NAV },
    ENGDYN:   { pgn: 127489, prio: 2, sa: SA_ENGINE },
    FLUID:    { pgn: 127505, prio: 6, sa: SA_TANK },
    DIRDATA:  { pgn: 130577, prio: 3, sa: SA_NAV },
    HTC:      { pgn: 127237, prio: 2, sa: SA_HELM },
    // The two mirrors, from the navigation address that already sends 129026 COG & SOG: one GNSS /
    // compass source for the boat's whole position solution.
    HEADING:  { pgn: 127250, prio: 2, sa: SA_NAV },
    POSRAPID: { pgn: 129025, prio: 2, sa: SA_NAV },
  };

  // A bearing wraps into N2K's own 0..2*pi range rather than carrying a sign - Wind Angle,
  // COG, Set and Heading-To-Steer are all declared UNSIGNED in NMEA2K_DB (unlike Deviation/
  // Variation, which really can be negative), so `awa`'s port-side negative degrees must land
  // in the TOP half of the range, not clamp to zero.
  const wrap360 = (deg) => ((deg % 360) + 360) % 360;

  // ── Builders ────────────────────────────────────────────────────────────────
  function nfRudder(t) {
    const d = jp.blank(8);
    // Instance, Direction Order (byte 1) and the Angle Order (bytes 2-3, the COMMANDED angle a
    // real autopilot orders) all stay "not available": this file has only the applied position,
    // never a distinct order for it.
    nfNaSigned(d, 2, 2);
    nfPut(d, 4, 2, has(t, 'rudder_actual') ? Number(t.rudder_actual) / 100 * RUDDER_MAX_DEG : NaN, NF_ANG, 0, true);
    return jp.msgFrame(NF_MSGS.RUDDER, d);
  }

  function nfEngineRapid(t) {
    const d = jp.blank(8);
    // Engine Speed (bytes 1-2) and Boost Pressure (bytes 3-4) stay "not available": `rpm` is not
    // a boat contract signal and the boat has no boost pressure reading.
    if (has(t, 'trim')) nfPut(d, 5, 1, t.trim, 1, 0, true);
    return jp.msgFrame(NF_MSGS.ENGRAPID, d);
  }

  // Shared by the apparent and true Wind Data frames - a real anemometer sends both as two
  // separate frames from the same address, one per Reference value, which is exactly this.
  function nfWindFrame(sa, angleDeg, speedMs, refCode) {
    const d = jp.blank(8);
    nfPut(d, 1, 2, speedMs, 0.01, 0, false);
    const a = Number(angleDeg);
    if (Number.isFinite(a)) nfPut(d, 3, 2, wrap360(a), NF_ANG, 0, false);
    jp.bits(d, 5, 0, 3, refCode);
    return jp.frame(jp.buildId(NF_MSGS.WIND.pgn, NF_MSGS.WIND.prio, sa), d);
  }

  function nfSpeedWater(t) {
    const d = jp.blank(8);
    // Speed (Ground) (bytes 3-4) and Sensor Type (byte 5) stay "not available": `sog` already
    // has its own dedicated PGN (129026) and repeating it here would be the 'odo' problem.
    nfPut(d, 1, 2, t.stw, 0.01, 0, false);
    return jp.msgFrame(NF_MSGS.SPDWTR, d);
  }

  function nfCogSog(t) {
    const d = jp.blank(8);
    // COG Ref only gets written alongside a real COG - a course over ground from this sim is a
    // GPS-derived ground track, which is always true-referenced (0), never magnetic.
    const c = Number(t.cog);
    if (Number.isFinite(c)) {
      jp.bits(d, 1, 0, 2, 0);
      nfPut(d, 2, 2, wrap360(c), NF_ANG, 0, false);
    }
    nfPut(d, 4, 2, t.sog, 0.01, 0, false);
    return jp.msgFrame(NF_MSGS.COGSOG, d);
  }

  // 127250 Vessel Heading: SID (byte 1) stays "not available", Heading at bytes 2-3 (0.0001 rad,
  // unsigned, so it wraps like COG), Deviation and Variation at 4-5 / 6-7 are SIGNED and so read
  // "not available" as 0x7FFF, not the 0xFFFF blank (which a decoder takes for -1). Reference
  // (8.1-8.2) is True: the game's compass is world north, and it models no magnetic field.
  function nfHeading(t) {
    const d = jp.blank(8);
    const h = Number(t.heading);
    if (Number.isFinite(h)) {
      nfPut(d, 1, 2, wrap360(h), NF_ANG, 0, false);
      jp.bits(d, 7, 0, 2, 0);
    }
    nfNaSigned(d, 3, 2); nfNaSigned(d, 5, 2);
    return jp.msgFrame(NF_MSGS.HEADING, d);
  }

  // 129025 Position, Rapid Update: latitude then longitude, each a signed 32-bit 1e-7 degree. An
  // absent one is the signed "not available" 0x7FFFFFFF, not the blank (which reads as -1e-7 deg).
  function nfPosition(t) {
    const d = jp.blank(8);
    for (const [b, k] of [[0, 'lat'], [4, 'lon']]) nfPut(d, b, 4, has(t, k) ? t[k] : NaN, 1e-7, 0, true);
    return jp.msgFrame(NF_MSGS.POSRAPID, d);
  }

  function nfWaterDepth(t) {
    const d = jp.blank(8);
    const depth = Number(t.depth);
    // depth === -1 is the contract's OWN sentinel for "no reading" (outside every terrain's
    // extent, or the hull out of the water). N2K's Depth field has no negative range at all, so
    // the honest wire statement for that case is "not available", not a clamped zero - the same
    // trap isobus.js's WBSD/GBSD direction bit avoids by gating on `status` being present at all.
    if (Number.isFinite(depth) && depth >= 0) nfPut(d, 1, 4, depth, 0.01, 0, false);
    nfNaSigned(d, 5, 2);   // Offset (transducer to waterline / keel): no such reading here
    return jp.msgFrame(NF_MSGS.DEPTH, d);
  }

  // The Fast Packet payload alone (no FP header), so the self-test can round-trip it through
  // j1939DecodePGN directly rather than through the chunked frames.
  function nfEngineDynamicPayload(t) {
    const d = jp.blank(26);
    // Oil Temp, Coolant Temp, Alternator, Engine Hours, Coolant/Fuel Pressure, discrete status
    // and Engine Load/Torque all stay "not available": `coolant`/`engine_hours` are UNFLAVORED
    // (the base CAN map's job, see header) and this game has no other source for the rest.
    if (has(t, 'oil_press')) nfPut(d, 1, 2, t.oil_press, 0.1, 0, false);
    nfPut(d, 9, 2, has(t, 'fuel_rate') ? t.fuel_rate : NaN, 0.1, 0, true);
    nfNaSigned(d, 7, 2); nfNaSigned(d, 24, 1); nfNaSigned(d, 25, 1);   // Alternator, Load, Torque
    return d;
  }
  function nfEngineDynamic(t) {
    return nfFastPacket(NF_MSGS.ENGDYN.pgn, NF_MSGS.ENGDYN.prio, NF_MSGS.ENGDYN.sa,
      nfEngineDynamicPayload(t));
  }

  // `tank_level` index 0 = fresh water, 1 = waste, 2 = live-well (the contract's own instancing).
  // Type codes are NMEA2K_DB's Fluid Level Type enum: 1 Water, 5 Black Water, 3 Live Well - Black
  // Water rather than Gray Water for the waste tank, because the contract's `fuel` signal is
  // already the boat's one fuel reading and this array deliberately excludes it (the header's
  // 'battery'/'pack_voltage' rule), so index 1 is sewage, not greywater.
  const NF_TANK_TYPE = [1, 5, 3];
  function nfFluidLevel(inst, levelPct) {
    const d = jp.blank(8);
    jp.bits(d, 0, 0, 4, inst);
    jp.bits(d, 0, 4, 4, NF_TANK_TYPE[inst]);
    nfPut(d, 1, 2, levelPct, 0.004, 0, true);
    // Capacity (bytes 3-6) stays "not available": no tank in this game has a modeled litre size.
    return jp.frame(jp.buildId(NF_MSGS.FLUID.pgn, NF_MSGS.FLUID.prio, SA_TANK), d);
  }

  function nfDirectionDataPayload(t) {
    const d = jp.blank(14);
    // Data Mode, COG Reference, SID, COG, SOG, Heading and Speed Through Water all stay "not
    // available": COG/SOG/STW/Heading each already have their own dedicated PGN with their own
    // SA above, and repeating them here is the same 'odo' problem nfSpeedWater avoids.
    const set = Number(t.current_set);
    if (Number.isFinite(set)) nfPut(d, 10, 2, wrap360(set), NF_ANG, 0, false);
    nfPut(d, 12, 2, t.current_drift, 0.01, 0, false);
    return d;
  }
  function nfDirectionData(t) {
    return nfFastPacket(NF_MSGS.DIRDATA.pgn, NF_MSGS.DIRDATA.prio, NF_MSGS.DIRDATA.sa,
      nfDirectionDataPayload(t));
  }

  function nfHeadingTrackControlPayload(t) {
    const d = jp.blank(21);
    // The four limit-exceeded/override flags, Turn Mode, Heading Reference, Commanded Rudder
    // Direction/Angle, Track, both limits, both turn orders, Off-Track Limit and Vessel Heading
    // all stay "not available" - see the header note on this PGN. `nav_mode_actual` HEADING HOLD
    // maps to Heading Control Standalone (3) rather than Heading Control (4): this pilot has no
    // network of its own to be "Heading Control" over, and the contract says so outright ("no
    // routes and no cross-track error").
    if (has(t, 'nav_mode_actual')) jp.bits(d, 1, 0, 3, Number(t.nav_mode_actual) ? 3 : 0);
    const hts = Number(t.heading_target);
    if (Number.isFinite(hts)) nfPut(d, 5, 2, wrap360(hts), NF_ANG, 0, false);
    // The signed ones among them: Commanded Rudder Angle, Radius / Rate of Turn Order, Off-Track Limit.
    nfNaSigned(d, 3, 2); nfNaSigned(d, 13, 2); nfNaSigned(d, 15, 2); nfNaSigned(d, 17, 2);
    return d;
  }
  function nfHeadingTrackControl(t) {
    return nfFastPacket(NF_MSGS.HTC.pgn, NF_MSGS.HTC.prio, NF_MSGS.HTC.sa,
      nfHeadingTrackControlPayload(t));
  }

  // ── Pack ────────────────────────────────────────────────────────────────────
  // carlito.js calls this on every telemetry message with `slow` alternating (~20 Hz / ~10 Hz).
  // The ~100 ms group rides `slow` directly, like isobus.js's own 100 ms group; everything
  // slower gets its own wall-clock gate, the same shape as isobus.js's 500 ms EAC1/FWD sweep -
  // each only moves its clock when there was something to send.
  let nfLast250 = 0, nfLast500 = 0, nfLast1s = 0, nfLast2500 = 0;
  function nfPack(t, slow) {
    if (!t) return [];
    const out = [];
    const now = Date.now();

    if (has(t, 'rudder_actual')) nfBoatAt = now;   // a boat is on the link (the rudder order's gate)
    // The mirrors are the boat's alone (carlito-registry.js's shared rule): every vehicle publishes
    // heading and position, and only the boat has an NMEA 2000 network to put them on.
    const mirror = !!window.carlitoIsFamily && window.carlitoIsFamily('boat', t);
    if (slow) {                                                          // ~100 ms
      if (mirror && has(t, 'heading')) out.push(nfHeading(t));
      if (mirror && (has(t, 'lat') || has(t, 'lon'))) out.push(nfPosition(t));
      if (has(t, 'rudder_actual')) out.push(nfRudder(t));
      if (has(t, 'trim')) out.push(nfEngineRapid(t));
      if (has(t, 'awa') || has(t, 'aws')) out.push(nfWindFrame(SA_NAV, t.awa, t.aws, 2));
      // True wind is also declared on car/truck/tractor (their dashboards' compass rose), which
      // carry no NMEA 2000 network: 130306 goes on the bus only with a boat on the link.
      if (has(t, 'rudder_actual') && (has(t, 'twd') || has(t, 'tws')))
        out.push(nfWindFrame(SA_NAV, t.twd, t.tws, 0));
    }

    if (now - nfLast250 >= 250) {
      if (has(t, 'cog') || has(t, 'sog')) { nfLast250 = now; out.push(nfCogSog(t)); }
    }

    if (now - nfLast500 >= 500) {
      // fuel_rate is also declared on car/truck/tractor, which carry no NMEA 2000 network (a
      // truck or tractor's burn goes out as J1939 LFE1, isobus.js): 127489 is the boat's alone.
      if (has(t, 'rudder_actual') && (has(t, 'oil_press') || has(t, 'fuel_rate'))) {
        nfLast500 = now; out.push(...nfEngineDynamic(t));
      }
    }

    if (now - nfLast1s >= 1000) {
      const sec = [];
      if (has(t, 'stw')) sec.push(nfSpeedWater(t));
      if (has(t, 'depth')) sec.push(nfWaterDepth(t));
      if (has(t, 'current_set') || has(t, 'current_drift')) sec.push(...nfDirectionData(t));
      if (has(t, 'nav_mode_actual') || has(t, 'heading_target')) sec.push(...nfHeadingTrackControl(t));
      if (sec.length) { nfLast1s = now; out.push(...sec); }
    }

    if (now - nfLast2500 >= 2500) {
      if (Array.isArray(t.tank_level)) {
        const five = [];
        for (let i = 0; i < t.tank_level.length; i++) {
          if (t.tank_level[i] !== undefined && t.tank_level[i] !== null) five.push(nfFluidLevel(i, t.tank_level[i]));
        }
        if (five.length) { nfLast2500 = now; out.push(...five); }
      }
    }

    return out;
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'nmea2000',
    signals: ['rudder_actual', 'trim', 'awa', 'aws', 'twd', 'tws', 'stw', 'sog', 'cog',
              'current_set', 'current_drift', 'depth', 'fuel_rate', 'oil_press', 'tank_level',
              'nav_mode_actual', 'heading_target'],
    // CAN_MAP's signals, carried AGAIN in their NMEA 2000 groups for a boat (0x524 / 0x525 keep them).
    mirrors: {
      heading: '127250 Vessel Heading, boat only',
      lat:     '129025 Position, Rapid Update, boat only',
      lon:     '129025 Position, Rapid Update, boat only',
    },
    pack: nfPack,
  });

  // ── The autopilot COMMANDS (contract `nav_mode` / `heading_cmd`, dir "in") ───
  // This file owns both, the inbound twin of the 127237 it packs: boat-pilot.js's control head is
  // a view over this state (window.nmea2000PilotCtl / nmea2000SetPilot), and a PGN 127237
  // Heading/Track Control from another address drives it exactly as the control head does. Last
  // writer wins and a value holds until the next one, like the control head's own buttons - a
  // pilot stays engaged until something disengages it.
  //
  // READING 127237 AS THE COMMAND is this side's choice, stated: NMEA 2000 commands a pilot by
  // writing 127237's fields through a 126208 Group Function, which is out of scope here, so a
  // plain 127237 from a control head's address is taken as what that head is asking for. Steering
  // Mode 0-2 (main steering, the two hand devices) reads STANDBY; 3-4 (heading control) reads
  // HEADING HOLD; 5, track control, is a mode this pilot does not have and is ignored. A valid
  // Heading-To-Steer commands `heading_cmd`; an unavailable one leaves it alone.
  //
  // PRESENCE: `heading_cmd` sends nothing until something commands a heading - the contract's
  // rule that its presence IS the command.
  //
  // THE OWN-ADDRESS RULE (carlito.js's decoder registry): this file publishes 127237 from SA_HELM
  // with the pilot's ACTUAL mode, and canForward ingests that echo - reading it back would latch
  // the pilot to whatever it last did. So a 127237 from SA_HELM is skipped, which also means a
  // control head on the bus must not claim address 1.
  const nfPilot = { navMode: 0, headingCmd: null };

  // Fast Packet reassembly for the one inbound PGN, keyed per source address - the inverse of
  // nfFastPacket above, and local for the same load-order reason (j1939.js's reassembler is not
  // on carlito-bridge.html). A frame out of sequence drops the transfer: splicing two would build
  // a plausible command nobody sent.
  const nfFpRx = new Map();
  function nfFastPacketFeed(sa, d) {
    const seq = d[0] >> 5, fc = d[0] & 0x1F;
    if (fc === 0) {
      if (d.length < 2) { nfFpRx.delete(sa); return null; }   // no length byte: nothing to reassemble against
      const st = { seq, total: d[1], next: 1, bytes: d.slice(2, 8) };
      if (st.bytes.length >= st.total) { nfFpRx.delete(sa); return st.bytes.slice(0, st.total); }
      nfFpRx.set(sa, st);
      return null;
    }
    const st = nfFpRx.get(sa);
    if (!st || st.seq !== seq || st.next !== fc) { nfFpRx.delete(sa); return null; }
    st.bytes.push(...d.slice(1, 8));
    st.next++;
    if (st.bytes.length < st.total) return null;
    nfFpRx.delete(sa);
    return st.bytes.slice(0, st.total);
  }

  // ── The rudder ORDER (contract `rudder`, dir "in") ────────────────────────────
  // PGN 127245 bytes 3-4, Angle Order, 0.0001 rad signed, 0x7FFF not available (0x7FFE out of
  // range), converted to the contract's percentage through RUDDER_MAX_DEG - the exact inverse of
  // nfRudder's Position. 127245 is periodic (100 ms), so an order that stops arriving is
  // withdrawn after NF_RUDDER_TTL_MS, this side's own three missed periods.
  //
  // PRESENCE: the game lets a present `rudder` override `steer` for ANY vehicle, so the source
  // also requires a boat on the link - nfPack stamps nfBoatAt whenever the telemetry carries
  // `rudder_actual` - or an order on the bus would steer a car.
  //
  // THE OWN-ADDRESS RULE: this file publishes 127245 from SA_HELM, with the order unavailable, so
  // SA_HELM is skipped on both counts.
  const NF_RUDDER_TTL_MS = 300;
  const NF_BOAT_GATE_MS = 300;   // a few telemetry ticks: a boat -> car swap must not steer the car
  let nfBoatAt = 0;
  const nfRudderOrder = { bus: undefined, at: 0 };
  function nfRudderLive() {
    const now = Date.now();
    if (now - nfBoatAt > NF_BOAT_GATE_MS) return undefined;
    if (nfRudderOrder.bus === undefined || now - nfRudderOrder.at > NF_RUDDER_TTL_MS) return undefined;
    return nfRudderOrder.bus;
  }
  // The demo's order frame for a steer percentage (-100 port .. +100 starboard), from the
  // steering control head. Direction Order follows the sign.
  function nfRudderOrderFrame(pct) {
    const d = jp.blank(8);
    const p = Math.max(-100, Math.min(100, Number(pct) || 0));
    jp.bits(d, 1, 0, 3, p > 0 ? 1 : p < 0 ? 2 : 0);
    nfPut(d, 2, 2, p / 100 * RUDDER_MAX_DEG, NF_ANG, 0, true);
    nfNaSigned(d, 4, 2);   // Position: an order, not a measurement
    return jp.frame(jp.buildId(NF_MSGS.RUDDER.pgn, NF_MSGS.RUDDER.prio, SA_STEER_HEAD), d);
  }

  function nfDecodeCommand(frame) {
    if (!frame.isExt || frame.isRtr || !frame.data || !frame.data.length) return;
    const { pgn, sa } = jp.parseId(frame.id);
    if (pgn === NF_MSGS.RUDDER.pgn) {
      if (sa === NF_MSGS.RUDDER.sa || frame.data.length < 4) return;
      let raw = (frame.data[2] & 0xFF) | ((frame.data[3] & 0xFF) << 8);
      if (raw >= 0x7FFE && raw <= 0x7FFF) return;
      if (raw >= 0x8000) raw -= 0x10000;
      nfRudderOrder.bus = Math.max(-100, Math.min(100, raw * NF_ANG / RUDDER_MAX_DEG * 100));
      nfRudderOrder.at = Date.now();
      return;
    }
    if (pgn !== NF_MSGS.HTC.pgn || sa === NF_MSGS.HTC.sa) return;
    const p = nfFastPacketFeed(sa, Array.from(frame.data, b => b & 0xFF));
    if (!p) return;
    // Byte 1 bits 0-2 Steering Mode, bytes 5-6 Heading-To-Steer - the fields nfHeadingTrackControlPayload writes.
    const mode = p.length > 1 ? (p[1] & 0x07) : 7;
    if (mode <= 2) nfPilot.navMode = 0;
    else if (mode <= 4) nfPilot.navMode = 1;
    if (p.length > 6) {
      const raw = p[5] | (p[6] << 8);
      if (raw < 0xFFFE) nfPilot.headingCmd = Math.round(wrap360(raw * NF_ANG)) % 360;
    }
  }

  window.carlitoUplinkDecoders = window.carlitoUplinkDecoders || [];
  window.carlitoUplinkDecoders.push(nfDecodeCommand);
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, {
    nav_mode:    () => nfPilot.navMode,
    heading_cmd: () => (nfPilot.headingCmd === null ? undefined : nfPilot.headingCmd),
    rudder:      nfRudderLive,
  });
  window.nmea2000RudderOrderFrame = nfRudderOrderFrame;   // <- j1939.js's NMEA 2000 demo
  window.nmea2000PilotCtl = () => ({ navMode: nfPilot.navMode, headingCmd: nfPilot.headingCmd });
  window.nmea2000SetPilot = (p) => {
    if (!p) return;
    if ('navMode' in p) nfPilot.navMode = Number(p.navMode) ? 1 : 0;
    if ('headingCmd' in p) nfPilot.headingCmd = p.headingCmd === null ? null : Math.round(wrap360(Number(p.headingCmd) || 0)) % 360;
  };

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.nmea2000SelfTest(). Where j1939.js is loaded the frames are
  // additionally round-tripped through ITS decoder in NMEA 2000 mode, so this module's encoder
  // is checked by an independent implementation rather than by its own arithmetic - the
  // isobus.js/j1939-flavor.js pattern.
  // HERMETIC: the state the checks touch is snapshotted here and put back in a `finally`, so a
  // check that throws cannot leave a test value driving the game.
  function nmea2000SelfTest() {
    const pilot = Object.assign({}, nfPilot), order = Object.assign({}, nfRudderOrder), boat = nfBoatAt;
    const fp = new Map(nfFpRx);
    try { return nfSelfTestChecks(); }
    finally {
      Object.assign(nfPilot, pilot); Object.assign(nfRudderOrder, order); nfBoatAt = boat;
      nfFpRx.clear(); for (const [k, v] of fp) nfFpRx.set(k, v);
    }
  }
  function nfSelfTestChecks() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (d) => d.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    // 1. Id build is a PDU2 broadcast and parses back to the PGN/SA that went in. The literal is
    //    the independent check: j1939ParseId is J1939Pack.parseId, buildId's own inverse.
    eq('Rudder id', jp.buildId(127245, 2, SA_HELM).toString(16).toUpperCase(), '9F10D01');
    if (typeof j1939ParseId === 'function') {
      eq('Rudder id parses back', j1939ParseId(jp.buildId(127245, 2, SA_HELM)),
        { priority: 2, dp: (127245 >>> 16) & 1, pf: (127245 >>> 8) & 0xFF, pgn: 127245, da: 0xFF, sa: SA_HELM });
    }

    // 2. Sentinels: depth's own -1 must leave the Depth field "not available", never a clamped
    //    zero - N2K's Depth field cannot represent a negative reading at all.
    //    (Bytes 6-7 are the signed Offset, whose "not available" is 0x7FFF: FF 7F.)
    eq('no depth signal leaves the field not-available', hex(nfWaterDepth({}).data),
      'FF FF FF FF FF FF 7F FF');
    eq('the -1 sentinel leaves the field not-available too, not a clamped zero',
      hex(nfWaterDepth({ depth: -1 }).data), 'FF FF FF FF FF FF 7F FF');
    eq('a real depth is written', nfWaterDepth({ depth: 2.5 }).data.slice(1, 5), [250, 0, 0, 0]);

    // 3. Trim is a plain signed byte; a negative value round-trips through two's complement
    //    (-40 -> 216 = 0xD8).
    eq('trim -40 %', hex(nfEngineRapid({ trim: -40 }).data), 'FF FF FF FF FF D8 FF FF');

    // 4. A signal the game did not publish leaves the byte at 0xFF, not a written zero.
    //    Angle Order and Position are signed: "not available" is 0x7FFF (FF 7F), never the blank.
    eq('no rudder_actual leaves Position not-available', hex(nfRudder({}).data),
      'FF FF FF 7F FF 7F FF FF');
    //    The mirrors. 90 deg = 1.5708 rad -> 15708 = 0x3D5C; Deviation / Variation 0x7FFF; True.
    //    48.8566 deg -> 488566000 = 0x1D1EECF0; -2.3522 deg -> -23522000 = 0xFE991530.
    eq('Vessel Heading 90 deg true', hex(nfHeading({ heading: 90 }).data), 'FF 5C 3D FF 7F FF 7F FC');
    eq('Position 48.8566 / -2.3522', hex(nfPosition({ lat: 48.8566, lon: -2.3522 }).data),
      'F0 EC 1E 1D 30 15 99 FE');
    eq('Position with no lon leaves it 0x7FFFFFFF', hex(nfPosition({ lat: 48.8566 }).data),
      'F0 EC 1E 1D FF FF FF 7F');
    const mirrored = (t) => nfPack(t, true).map(f => jp.parseId(f.id).pgn).filter(p => p === 127250 || p === 129025);
    eq('a boat carries both mirrors', mirrored({ rudder_actual: 0, heading: 90, lat: 1, lon: 2 }), [127250, 129025]);
    eq('a car carries neither', mirrored({ heading: 90, lat: 1, lon: 2 }), []);

    // 5. Round-trip every frame through j1939.js's own decoder, in its NMEA 2000 database. This is the
    //    real check on every scale/offset above.
    if (typeof j1939DecodePGN === 'function') {
      const rt = (label, pgn, data, want) => {
        const got = j1939DecodePGN(pgn, data, NMEA2K_DB);   // explicitly, never the tab's active mode
        if (!got.length) { failures.push(label + ': no decoder entry for PGN ' + pgn); return; }
        for (const name of Object.keys(want)) {
          const f = got.find(x => x.name === name);
          if (!f) { failures.push(label + ': decoder returned no field "' + name + '"'); continue; }
          eq(label + ' ' + name, String(f.display), want[name]);
        }
      };
      rt('Rudder', 127245, nfRudder({ rudder_actual: 100 }).data,
        { 'Position': RUDDER_MAX_DEG.toFixed(1) + ' °', 'Angle Order': 'N/A' });
      rt('Engine Rapid', 127488, nfEngineRapid({ trim: 25 }).data, { 'Tilt/Trim': '25 %' });
      rt('Wind (apparent, wraps port-side negative)', 130306, nfWindFrame(SA_NAV, -60, 5, 2).data,
        { 'Wind Speed': '5.00 m/s', 'Wind Angle': '300.0 °', 'Reference': 'Apparent' });
      rt('Wind (true)', 130306, nfWindFrame(SA_NAV, 45, 6, 0).data,
        { 'Wind Angle': '45.0 °', 'Reference': 'True (North)' });
      rt('Speed Water Ref', 128259, nfSpeedWater({ stw: 3.5 }).data, { 'Speed (Water)': '3.50 m/s' });
      rt('COG & SOG', 129026, nfCogSog({ cog: 45, sog: 2 }).data,
        { 'COG': '45.0 °', 'SOG': '2.00 m/s', 'COG Ref': 'True' });
      rt('Water Depth', 128267, nfWaterDepth({ depth: 4.2 }).data, { 'Depth': '4.20 m', 'Offset': 'N/A' });
      rt('Engine Dynamic', 127489, nfEngineDynamicPayload({ oil_press: 350, fuel_rate: -12 }),
        { 'Oil Pressure': '350.0 kPa', 'Fuel Rate': '-12.0 L/h',
          'Alternator': 'N/A', 'Engine Load': 'N/A', 'Engine Torque': 'N/A' });
      rt('Engine Dynamic, no fuel rate', 127489, nfEngineDynamicPayload({ oil_press: 350 }), { 'Fuel Rate': 'N/A' });
      rt('Fluid Level (fresh water)', 127505, nfFluidLevel(0, 62).data,
        { 'Level': '62.0 %', 'Type': 'Water' });
      rt('Fluid Level (waste)', 127505, nfFluidLevel(1, 80).data,
        { 'Level': '80.0 %', 'Type': 'Black Water' });
      rt('Direction Data', 130577, nfDirectionDataPayload({ current_set: 200, current_drift: 0.4 }),
        { 'Set': '200.0 °', 'Drift': '0.40 m/s' });
      rt('Heading/Track Control', 127237,
        nfHeadingTrackControlPayload({ nav_mode_actual: 1, heading_target: 90 }),
        { 'Steering Mode': 'Heading Control Standalone', 'Heading-To-Steer (Course)': '90.0 °',
          'Commanded Rudder Angle': 'N/A', 'Radius of Turn Order': 'N/A', 'Rate of Turn Order': 'N/A',
          'Off-Track Limit': 'N/A' });
      rt('Vessel Heading', 127250, nfHeading({ heading: 270 }).data,
        { 'Heading': '270.0 °', 'Deviation': 'N/A', 'Variation': 'N/A', 'Reference': 'True' });
      rt('Position, Rapid Update', 129025, nfPosition({ lat: 48.8566, lon: -2.3522 }).data,
        { 'Latitude': '48.856600 °', 'Longitude': '-2.352200 °' });
    } else {
      failures.push('j1939.js is not loaded on this page, ' +
        'so the round-trip decode was not checked - expected on carlito-bridge.html, a failure ' +
        'anywhere else');
    }

    // 6. The autopilot command: a 127237 from a control head drives the pilot state, one from this
    //    file's own helm address is its own echo and is skipped, an unavailable Heading-To-Steer
    //    leaves the heading alone, and a transfer with a missing frame is dropped whole. Built with
    //    this file's own Fast Packet encoder, so the reassembler is checked against it.
    nfPilot.navMode = 0; nfPilot.headingCmd = null;
    const feed = (sa, t) => {
      for (const fr of nfFastPacket(127237, 2, sa, nfHeadingTrackControlPayload(t))) nfDecodeCommand(fr);
    };
    feed(SA_HELM, { nav_mode_actual: 1, heading_target: 45 });
    eq('its own helm echo is not a command', [nfPilot.navMode, nfPilot.headingCmd], [0, null]);
    feed(9, { nav_mode_actual: 1, heading_target: 90 });
    eq('a control head engages HEADING HOLD on 90',
      [window.carlitoUplinkSources.nav_mode(), window.carlitoUplinkSources.heading_cmd()], [1, 90]);
    feed(9, { nav_mode_actual: 0 });
    eq('STANDBY with no heading leaves the heading', [nfPilot.navMode, nfPilot.headingCmd], [0, 90]);
    const fps = nfFastPacket(127237, 2, 9, nfHeadingTrackControlPayload({ nav_mode_actual: 1, heading_target: 200 }));
    nfDecodeCommand(fps[0]); nfDecodeCommand(fps[2]);
    eq('a frame out of sequence drops the transfer', [nfPilot.navMode, nfPilot.headingCmd], [0, 90]);

    // 7. The rudder order: 17.5 deg starboard (50 %) from the control head reads back as 50 %,
    //    only while a boat is on the link; the helm's own 127245 is skipped; a stale order declines.
    nfRudderOrder.bus = undefined;
    const ord = nfRudderOrderFrame(50);
    //    17.5 deg = 0.30543 rad -> 3054 = 0x0BEE; Direction Order 1 = starboard.
    eq('rudder order frame', hex(ord.data), 'FF F9 EE 0B FF 7F FF FF');
    nfDecodeCommand(ord);
    nfBoatAt = 0;
    eq('no boat on the link, no rudder', nfRudderLive(), undefined);
    nfBoatAt = Date.now();
    eq('a boat on the link takes the order', Math.round(nfRudderLive()), 50);
    nfDecodeCommand(nfRudderOrderFrame(-100));
    eq('full port is -100', Math.round(nfRudderLive()), -100);
    nfDecodeCommand(nfRudder({ rudder_actual: 20 }));
    eq('its own helm 127245 is not an order', Math.round(nfRudderLive()), -100);
    nfRudderOrder.at = Date.now() - NF_RUDDER_TTL_MS - 1;
    eq('a withdrawn order declines', nfRudderLive(), undefined);

    if (failures.length) console.error('NMEA 2000 flavor self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('NMEA 2000 flavor self-test: all checks passed.');
    return failures;
  }
  window.nmea2000SelfTest = nmea2000SelfTest;
})();
