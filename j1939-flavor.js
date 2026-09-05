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
//   j1939.js             J1939_DB += 0xF000 ERC1 / 0xFEAE AIR1 / 0xFEEA VW, and the VW entry on
//                        J1939_REQ_SERVERS that answers a request for axle_load
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
  // exact inverses. Non-finite input writes nothing and the 0xFF..FF default stands. The top two
  // raw codes are reserved (0xFF..FE error, 0xFF..FF not available), so a real value clamps below
  // them rather than colliding with one.
  function jfPut(d, b, n, val, f, o) {
    const v = Number(val);
    if (!Number.isFinite(v)) return;
    const max = Math.pow(2, 8 * n) - 1;
    let raw = Math.max(0, Math.min(max - 2, Math.round((v - (o || 0)) / f)));
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
    //    ...and a value past the top of the scale clamps BELOW the two reserved codes.
    eq('over-range clamps under the reserved codes', jfAir1({ air_primary: 9999 }).data[2], 0xFD);

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

    if (failures.length) console.error('J1939 flavor self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('J1939 flavor self-test: all checks passed.');
    return failures;
  }
  window.j1939FlavorSelfTest = j1939FlavorSelfTest;
})();
