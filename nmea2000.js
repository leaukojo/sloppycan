// ── NMEA 2000 — the carlito `nmea2000` flavor packer ─────────────────────────
// The direct sibling of isobus.js / j1939-flavor.js / dronecan.js: registers
// { flavor, signals, pack(t, slow) } on window.carlitoFlavorPackers, which carlito.js reads for
// both packing and its checkCanCoverage assertion. NMEA 2000 is J1939 at the wire level, so
// j1939.js's existing decoder already renders every frame this file emits (switch its Mode
// dropdown to J1939 / N2K, nmea2000 mode) - a second view would be a second, worse one, the
// isobus.js precedent exactly.
//
// ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
// Every field this file WRITES was checked field-for-field against j1939.js's own NMEA2K_DB
// (the primary source lives there, never here): the self-test round-trips every frame through
// j1939DecodePGN. 128259 / 129026 / 128267 / 127489 / 127505 / 127488 / 130306 were already in
// that dictionary. 127245 Rudder, 127237 Heading/Track Control and 130577 Direction Data were
// added alongside this file, off ttlappalainen's NMEA2000 library (N2kMessages.cpp
// SetN2kPGN127245 / SetN2kPGN127237 / SetN2kPGN130577) - the closest thing to a public
// reference for a PGN NMEA's own documents keep behind a paywall.
//
// ── THE COMMANDS, AND WHAT IS NOT HERE ───────────────────────────────────────
// `nav_mode` and `heading_cmd` are contract dir="in" signals this file OWNS: boat-pilot.js's
// control head is a view over them, and a PGN 127237 from another address drives them too - see
// "The autopilot COMMANDS" below. `rudder` is the one dir="in" boat signal nothing sources: its
// real carrier is PGN 127245 Rudder (the same frame this file's OUT half builds for
// `rudder_actual`), and the boat is steered on the RAMN steer axis, which the game accepts as
// the rudder when `rudder` is absent.
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
// wrong reason - the signal would look covered twice, once honestly and once not.
//
// INTEGRATION POINTS - the only changes required in the main files:
//   index.html            <script src="nmea2000.js" defer> after carlito_contract.js and
//                         BEFORE carlito.js (the packer must be registered by the time
//                         carlito.js evaluates its coverage check)
//   carlito-bridge.html   same script tag. That page loads neither sloppycan.js nor j1939.js,
//                         so every cross-module read here is typeof-guarded.
//
// Telemetry TX rides carlito.js's canForward gateway, which is what puts these on the wire and
// in the dump as FW entries. No transport code here.

(function () {
  'use strict';

  // ── Shared angle constant, aliased with a fallback ────────────────────────────
  // j1939.js declares N2K_ANG (0.0001 rad/bit, in degrees) as a top-level `const`, which a
  // later classic <script> can read by name - but carlito-bridge.html does not load j1939.js at
  // all, so the alias keeps its own copy rather than throwing there.
  const NF_ANG = (typeof N2K_ANG !== 'undefined') ? N2K_ANG : 0.0001 * (180 / Math.PI);

  // ── Wire primitives ─────────────────────────────────────────────────────────
  // Local copies for the load-order reason in the header: carlito-bridge.html does not load
  // j1939.js. Every PGN below is a PDU2 broadcast (all are >= 126720, so PF is always >= 0xF0),
  // so unlike isobus.js's ibId this never carries a destination.
  function nfId(pgn, prio, sa) {
    const dp = (pgn >>> 16) & 1;
    const pf = (pgn >>> 8) & 0xFF;
    const ps = pgn & 0xFF;
    return ((((prio & 7) << 26) >>> 0) | (dp << 24) | (pf << 16) | (ps << 8) | (sa & 0xFF)) >>> 0;
  }

  // A frame/payload starts as all-ones bytes and fields are written INTO it - in NMEA 2000 an
  // all-ones field IS "not available" (n2kDecodeField's own sentinel), so a byte this module
  // never touches states "no source for this" rather than claiming a zero.
  function nfBlank(n) { return new Array(n).fill(0xFF); }

  // A scaled field, little-endian, in n2kDecodeField's own {bo,bl,scale,offset} vocabulary so
  // the two are exact inverses (b/n here are BYTE index/count, not bit - every field this file
  // writes is byte-aligned). Non-finite input writes nothing and the all-ones default stands.
  // Unsigned fields clamp below the top TWO reserved codes (all-ones "N/A", next "out of
  // range"), matching n2kDecodeField's unsigned branch; signed fields clamp below the top two
  // POSITIVE codes for the same reason, matching its signed branch, and negatives are carried
  // across the bytes as two's complement.
  function nfPut(d, b, n, val, f, o, signed) {
    const v = Number(val);
    if (!Number.isFinite(v)) return;
    const bits = 8 * n;
    let raw = Math.round((v - (o || 0)) / f);
    if (signed) {
      const maxPos = Math.pow(2, bits - 1) - 1;
      raw = Math.max(-Math.pow(2, bits - 1), Math.min(maxPos - 2, raw));
      if (raw < 0) raw += Math.pow(2, bits);
    } else {
      const max = Math.pow(2, bits) - 1;
      raw = Math.max(0, Math.min(max - 2, raw));
    }
    for (let i = 0; i < n; i++) { d[b + i] = raw % 256; raw = Math.floor(raw / 256); }
  }
  // A bit-level field, `bit` the 0-based LSB position within byte `b` - matches
  // n2kDecodeField's own bo/bl extraction (bo & 7 is the same bit position). Every field this
  // file writes at bit level fits inside a single byte, so unlike isobus.js's ibBits there is no
  // cross-byte case to handle.
  function nfBits(d, b, bit, nbits, val) {
    const mask = (((1 << nbits) - 1) << bit) & 0xFF;
    d[b] = ((d[b] & ~mask) | ((val << bit) & mask)) & 0xFF;
  }

  function nfFrame(pgn, prio, sa, data) { return { id: nfId(pgn, prio, sa), isExt: true, data }; }

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
    frames.push(nfFrame(pgn, prio, sa, f0));
    for (let fc = 1; idx < total; fc++) {
      const fr = [(seq << 5) | fc];
      for (let i = 0; i < 7; i++) fr.push(idx < total ? payload[idx++] : 0xFF);
      frames.push(nfFrame(pgn, prio, sa, fr));
    }
    return frames;
  }

  // ── Source addresses ────────────────────────────────────────────────────────
  // THE ONE PLACE AN ADDRESS IS DECLARED (dronecan.js's / isobus.js's rule). NMEA 2000 has no
  // preferred-address table the way J1939 does (isobus.net's SourceAddress table) - a real
  // network claims arbitrary addresses via Address Claim - so these are this file's own choice,
  // one per logical instrument, grouped by NMEA_DEVICE_CLASS (j1939.js): the engine block is
  // Propulsion (50), the helm/autopilot is Steering and Control (40), the nav computer is
  // Navigation (60), the tank sender is Instrumentation/General (80).
  const SA_ENGINE = 0;
  const SA_HELM   = 1;
  const SA_NAV    = 2;
  const SA_TANK   = 3;

  // Full rudder throw, in degrees, for converting the contract's `rudder`/`rudder_actual`
  // PERCENTAGE onto PGN 127245's Position/Angle Order fields, which are real angles. 35 degrees
  // is the conventional hard-over figure most small-craft wheel/tiller steering systems use
  // (the isobus.js precedent for a percentage-to-real-unit choice with no contract constant to
  // read it from - draft_force's Rear Nominal Lower Link Force offset is the same kind of
  // declared-once conversion). Stated here rather than encoded silently.
  const RUDDER_MAX_DEG = 35;

  const has = (t, k) => t && t[k] !== undefined && t[k] !== null;

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
  };

  // A bearing wraps into N2K's own 0..2*pi range rather than carrying a sign - Wind Angle,
  // COG, Set and Heading-To-Steer are all declared UNSIGNED in NMEA2K_DB (unlike Deviation/
  // Variation, which really can be negative), so `awa`'s port-side negative degrees must land
  // in the TOP half of the range, not clamp to zero.
  const wrap360 = (deg) => ((deg % 360) + 360) % 360;

  // ── Builders ────────────────────────────────────────────────────────────────
  function nfRudder(t) {
    const d = nfBlank(8);
    // Instance, Direction Order (byte 1) and the Angle Order (bytes 2-3, the COMMANDED angle a
    // real autopilot orders) all stay "not available": this file has only the applied position,
    // never a distinct order for it.
    if (has(t, 'rudder_actual')) {
      nfPut(d, 4, 2, Number(t.rudder_actual) / 100 * RUDDER_MAX_DEG, NF_ANG, 0, true);
    }
    return nfFrame(NF_MSGS.RUDDER.pgn, NF_MSGS.RUDDER.prio, NF_MSGS.RUDDER.sa, d);
  }

  function nfEngineRapid(t) {
    const d = nfBlank(8);
    // Engine Speed (bytes 1-2) and Boost Pressure (bytes 3-4) stay "not available": `rpm` is not
    // a boat contract signal and the boat has no boost pressure reading.
    if (has(t, 'trim')) nfPut(d, 5, 1, t.trim, 1, 0, true);
    return nfFrame(NF_MSGS.ENGRAPID.pgn, NF_MSGS.ENGRAPID.prio, NF_MSGS.ENGRAPID.sa, d);
  }

  // Shared by the apparent and true Wind Data frames - a real anemometer sends both as two
  // separate frames from the same address, one per Reference value, which is exactly this.
  function nfWindFrame(sa, angleDeg, speedMs, refCode) {
    const d = nfBlank(8);
    nfPut(d, 1, 2, speedMs, 0.01, 0, false);
    const a = Number(angleDeg);
    if (Number.isFinite(a)) nfPut(d, 3, 2, wrap360(a), NF_ANG, 0, false);
    nfBits(d, 5, 0, 3, refCode);
    return nfFrame(NF_MSGS.WIND.pgn, NF_MSGS.WIND.prio, sa, d);
  }

  function nfSpeedWater(t) {
    const d = nfBlank(8);
    // Speed (Ground) (bytes 3-4) and Sensor Type (byte 5) stay "not available": `sog` already
    // has its own dedicated PGN (129026) and repeating it here would be the 'odo' problem.
    nfPut(d, 1, 2, t.stw, 0.01, 0, false);
    return nfFrame(NF_MSGS.SPDWTR.pgn, NF_MSGS.SPDWTR.prio, NF_MSGS.SPDWTR.sa, d);
  }

  function nfCogSog(t) {
    const d = nfBlank(8);
    // COG Ref only gets written alongside a real COG - a course over ground from this sim is a
    // GPS-derived ground track, which is always true-referenced (0), never magnetic.
    const c = Number(t.cog);
    if (Number.isFinite(c)) {
      nfBits(d, 1, 0, 2, 0);
      nfPut(d, 2, 2, wrap360(c), NF_ANG, 0, false);
    }
    nfPut(d, 4, 2, t.sog, 0.01, 0, false);
    return nfFrame(NF_MSGS.COGSOG.pgn, NF_MSGS.COGSOG.prio, NF_MSGS.COGSOG.sa, d);
  }

  function nfWaterDepth(t) {
    const d = nfBlank(8);
    const depth = Number(t.depth);
    // depth === -1 is the contract's OWN sentinel for "no reading" (outside every terrain's
    // extent, or the hull out of the water). N2K's Depth field has no negative range at all, so
    // the honest wire statement for that case is "not available", not a clamped zero - the same
    // trap isobus.js's WBSD/GBSD direction bit avoids by gating on `status` being present at all.
    if (Number.isFinite(depth) && depth >= 0) nfPut(d, 1, 4, depth, 0.01, 0, false);
    return nfFrame(NF_MSGS.DEPTH.pgn, NF_MSGS.DEPTH.prio, NF_MSGS.DEPTH.sa, d);
  }

  // The Fast Packet payload alone (no FP header), so the self-test can round-trip it through
  // j1939DecodePGN directly rather than through the chunked frames.
  function nfEngineDynamicPayload(t) {
    const d = nfBlank(26);
    // Oil Temp, Coolant Temp, Alternator, Engine Hours, Coolant/Fuel Pressure, discrete status
    // and Engine Load/Torque all stay "not available": `coolant`/`engine_hours` are UNFLAVORED
    // (the base CAN map's job, see header) and this game has no other source for the rest.
    if (has(t, 'oil_press')) nfPut(d, 1, 2, t.oil_press, 0.1, 0, false);
    if (has(t, 'fuel_rate')) nfPut(d, 9, 2, t.fuel_rate, 0.1, 0, true);
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
    const d = nfBlank(8);
    nfBits(d, 0, 0, 4, inst);
    nfBits(d, 0, 4, 4, NF_TANK_TYPE[inst]);
    nfPut(d, 1, 2, levelPct, 0.004, 0, true);
    // Capacity (bytes 3-6) stays "not available": no tank in this game has a modeled litre size.
    return nfFrame(NF_MSGS.FLUID.pgn, NF_MSGS.FLUID.prio, SA_TANK, d);
  }

  function nfDirectionDataPayload(t) {
    const d = nfBlank(14);
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
    const d = nfBlank(21);
    // The four limit-exceeded/override flags, Turn Mode, Heading Reference, Commanded Rudder
    // Direction/Angle, Track, both limits, both turn orders, Off-Track Limit and Vessel Heading
    // all stay "not available" - see the header note on this PGN. `nav_mode_actual` HEADING HOLD
    // maps to Heading Control Standalone (3) rather than Heading Control (4): this pilot has no
    // network of its own to be "Heading Control" over, and the contract says so outright ("no
    // routes and no cross-track error").
    if (has(t, 'nav_mode_actual')) nfBits(d, 1, 0, 3, Number(t.nav_mode_actual) ? 3 : 0);
    const hts = Number(t.heading_target);
    if (Number.isFinite(hts)) nfPut(d, 5, 2, wrap360(hts), NF_ANG, 0, false);
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

    if (slow) {                                                          // ~100 ms
      if (has(t, 'rudder_actual')) out.push(nfRudder(t));
      if (has(t, 'trim')) out.push(nfEngineRapid(t));
      if (has(t, 'awa') || has(t, 'aws')) out.push(nfWindFrame(SA_NAV, t.awa, t.aws, 2));
      if (has(t, 'twd') || has(t, 'tws')) out.push(nfWindFrame(SA_NAV, t.twd, t.tws, 0));
    }

    if (now - nfLast250 >= 250) {
      if (has(t, 'cog') || has(t, 'sog')) { nfLast250 = now; out.push(nfCogSog(t)); }
    }

    if (now - nfLast500 >= 500) {
      if (has(t, 'oil_press') || has(t, 'fuel_rate')) { nfLast500 = now; out.push(...nfEngineDynamic(t)); }
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

  function nfDecodeCommand(frame) {
    if (!frame.isExt || frame.isRtr || !frame.data || !frame.data.length) return;
    const id = frame.id >>> 0;
    const pgn = (((id >>> 24) & 1) << 16) | (((id >>> 16) & 0xFF) << 8) | ((id >>> 8) & 0xFF);
    const sa = id & 0xFF;
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
  });
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
  function nmea2000SelfTest() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (d) => d.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

    // 1. Id build is a PDU2 broadcast and parses back to the PGN/SA that went in.
    if (typeof j1939ParseId === 'function') {
      eq('Rudder id parses back', j1939ParseId(nfId(127245, 2, SA_HELM)),
        { priority: 2, dp: (127245 >>> 16) & 1, pf: (127245 >>> 8) & 0xFF, pgn: 127245, da: 0xFF, sa: SA_HELM });
    }

    // 2. Sentinels: depth's own -1 must leave the Depth field "not available", never a clamped
    //    zero - N2K's Depth field cannot represent a negative reading at all.
    eq('no depth signal leaves the field not-available', hex(nfWaterDepth({}).data),
      'FF FF FF FF FF FF FF FF');
    eq('the -1 sentinel leaves the field not-available too, not a clamped zero',
      hex(nfWaterDepth({ depth: -1 }).data), 'FF FF FF FF FF FF FF FF');
    eq('a real depth is written', nfWaterDepth({ depth: 2.5 }).data.slice(1, 5), [250, 0, 0, 0]);

    // 3. Trim is a plain signed byte; a negative value round-trips through two's complement
    //    (-40 -> 216 = 0xD8).
    eq('trim -40 %', hex(nfEngineRapid({ trim: -40 }).data), 'FF FF FF FF FF D8 FF FF');

    // 4. A signal the game did not publish leaves the byte at 0xFF, not a written zero.
    eq('no rudder_actual leaves Position not-available', hex(nfRudder({}).data),
      'FF FF FF FF FF FF FF FF');

    // 5. Round-trip every frame through j1939.js's own decoder, in NMEA 2000 mode. This is the
    //    real check on every scale/offset above.
    if (typeof j1939DecodePGN === 'function' && typeof j1939ProtoMode !== 'undefined') {
      const savedMode = j1939ProtoMode;
      j1939ProtoMode = 'nmea2000';
      const rt = (label, pgn, data, want) => {
        const got = j1939DecodePGN(pgn, data);
        if (!got.length) { failures.push(label + ': no decoder entry for PGN ' + pgn); return; }
        for (const name of Object.keys(want)) {
          const f = got.find(x => x.name === name);
          if (!f) { failures.push(label + ': decoder returned no field "' + name + '"'); continue; }
          eq(label + ' ' + name, String(f.display), want[name]);
        }
      };
      rt('Rudder', 127245, nfRudder({ rudder_actual: 100 }).data,
        { 'Position': RUDDER_MAX_DEG.toFixed(1) + ' °' });
      rt('Engine Rapid', 127488, nfEngineRapid({ trim: 25 }).data, { 'Tilt/Trim': '25 %' });
      rt('Wind (apparent, wraps port-side negative)', 130306, nfWindFrame(SA_NAV, -60, 5, 2).data,
        { 'Wind Speed': '5.00 m/s', 'Wind Angle': '300.0 °', 'Reference': 'Apparent' });
      rt('Wind (true)', 130306, nfWindFrame(SA_NAV, 45, 6, 0).data,
        { 'Wind Angle': '45.0 °', 'Reference': 'True (North)' });
      rt('Speed Water Ref', 128259, nfSpeedWater({ stw: 3.5 }).data, { 'Speed (Water)': '3.50 m/s' });
      rt('COG & SOG', 129026, nfCogSog({ cog: 45, sog: 2 }).data,
        { 'COG': '45.0 °', 'SOG': '2.00 m/s', 'COG Ref': 'True' });
      rt('Water Depth', 128267, nfWaterDepth({ depth: 4.2 }).data, { 'Depth': '4.20 m' });
      rt('Engine Dynamic', 127489, nfEngineDynamicPayload({ oil_press: 350, fuel_rate: -12 }),
        { 'Oil Pressure': '350.0 kPa', 'Fuel Rate': '-12.0 L/h' });
      rt('Fluid Level (fresh water)', 127505, nfFluidLevel(0, 62).data,
        { 'Level': '62.0 %', 'Type': 'Water' });
      rt('Fluid Level (waste)', 127505, nfFluidLevel(1, 80).data,
        { 'Level': '80.0 %', 'Type': 'Black Water' });
      rt('Direction Data', 130577, nfDirectionDataPayload({ current_set: 200, current_drift: 0.4 }),
        { 'Set': '200.0 °', 'Drift': '0.40 m/s' });
      rt('Heading/Track Control', 127237,
        nfHeadingTrackControlPayload({ nav_mode_actual: 1, heading_target: 90 }),
        { 'Steering Mode': 'Heading Control Standalone', 'Heading-To-Steer (Course)': '90.0 °' });
      j1939ProtoMode = savedMode;
    } else {
      failures.push('j1939.js is not loaded on this page (or exposes no mutable protocol mode), ' +
        'so the round-trip decode was not checked - expected on carlito-bridge.html, a failure ' +
        'anywhere else');
    }

    // 6. The autopilot command: a 127237 from a control head drives the pilot state, one from this
    //    file's own helm address is its own echo and is skipped, an unavailable Heading-To-Steer
    //    leaves the heading alone, and a transfer with a missing frame is dropped whole. Built with
    //    this file's own Fast Packet encoder, so the reassembler is checked against it.
    const savedPilot = Object.assign({}, nfPilot);
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
    Object.assign(nfPilot, savedPilot);

    if (failures.length) console.error('NMEA 2000 flavor self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('NMEA 2000 flavor self-test: all checks passed.');
    return failures;
  }
  window.nmea2000SelfTest = nmea2000SelfTest;
})();
