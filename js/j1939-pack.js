// ── J1939 / NMEA 2000 frame packing: the one copy ─────────────────────────────
// The wire primitives every J1939-family packer shares - j1939-flavor.js, isobus.js, nmea2000.js
// and j1939.js's request path and demo. They used to be four near-identical local copies, each
// carrying its own copy of the encoding rules below; this file is the only place those rules live.
//
// SELF-CONTAINED ON PURPOSE: carlito-bridge.html loads the packers but neither j1939.js nor
// j1939-tables.js, so nothing here may read either. Exports exactly one name, window.J1939Pack,
// because a top-level `put` or `frame` in this shared global scope would collide with somebody's.
// Load it (defer) before j1939.js and every packer, on both pages.

(function () {
  'use strict';

  // J1939 / ISO 11783 / NMEA 2000 29-bit id:
  //   [28:26] priority  [25] EDP  [24] DP  [23:16] PDU format  [15:8] PDU specific  [7:0] SA
  // PDU2 (PF >= 0xF0) is a broadcast and PS is part of the PGN; PDU1 (PF < 0xF0) puts the
  // DESTINATION address in PS and the PGN does not include it. A PDU1 with no `da` goes to the
  // global address 0xFF.
  function buildId(pgn, prio, sa, da) {
    const dp = (pgn >>> 16) & 1;
    const pf = (pgn >>> 8) & 0xFF;
    const ps = pf < 0xF0 ? ((da == null ? 0xFF : da) & 0xFF) : (pgn & 0xFF);
    return ((((prio & 7) << 26) >>> 0) | (dp << 24) | (pf << 16) | (ps << 8) | (sa & 0xFF)) >>> 0;
  }
  // The exact inverse of buildId. A PDU2 has no destination, so it reads as the global address.
  function parseId(id) {
    id = id >>> 0;
    const priority = (id >>> 26) & 7, dp = (id >>> 24) & 1, pf = (id >>> 16) & 0xFF, ps = (id >>> 8) & 0xFF;
    return { priority, dp, pf, pgn: (dp << 16) | (pf << 8) | (pf < 0xF0 ? 0 : ps), da: pf < 0xF0 ? ps : 0xFF, sa: id & 0xFF };
  }

  // A frame's data starts as all-ones bytes and fields are written INTO it. In J1939 and NMEA 2000
  // alike an all-ones field IS "not available", so a byte a packer never touches states "no
  // source for this" rather than claiming a zero - the same statement carlito.js's uplink makes
  // by OMITTING an unwired signal.
  function blank(len = 8) { return new Array(len).fill(0xFF); }

  // A scaled field, little-endian, `b`/`n` its BYTE index and count, in j1939DecodeSPN's {b,n,f,o}
  // (and n2kDecodeField's {scale,offset}) vocabulary so encoder and decoder are exact inverses.
  // Non-finite input writes nothing and the all-ones default stands. The two protocols reserve
  // DIFFERENT raw values, so the rule is chosen explicitly:
  //   'j1939' (default) - J1939-71 Table 1 judges a value by its TOP byte: <= 0xFA valid, FB
  //     parameter-specific, FC-FD reserved, FE error, FF not available. A real value clamps to
  //     0xFA, 0xFAFF, 0xFAFFFFFF... Unsigned only: J1939 carries a sign in its offset.
  //   'n2k' - the top TWO codes are reserved (all-ones "not available", the next "out of range"),
  //     matching n2kDecodeField. Unsigned clamps below them; `signed` clamps below the top two
  //     POSITIVE codes and carries negatives as two's complement.
  function put(d, b, n, val, f, o, opts) {
    const rule = (opts && opts.rule) || 'j1939';
    const signed = !!(opts && opts.signed);
    if (rule === 'j1939' && signed) throw new Error('J1939Pack.put: J1939 fields are unsigned (the sign rides the offset)');
    const v = Number(val);
    if (!Number.isFinite(v)) return;
    let raw;
    if (rule === 'j1939') {
      const max = 0xFB * Math.pow(2, 8 * (n - 1)) - 1;
      raw = Math.max(0, Math.min(max, Math.round((v - (o || 0)) / f)));
    } else if (rule === 'n2k') {
      const bits = 8 * n;
      raw = Math.round((v - (o || 0)) / f);
      if (signed) {
        const maxPos = Math.pow(2, bits - 1) - 1;
        raw = Math.max(-Math.pow(2, bits - 1), Math.min(maxPos - 2, raw));
        if (raw < 0) raw += Math.pow(2, bits);
      } else {
        const max = Math.pow(2, bits) - 1;
        raw = Math.max(0, Math.min(max - 2, raw));
      }
    } else {
      throw new Error('J1939Pack.put: unknown rule ' + rule);
    }
    for (let i = 0; i < n; i++) { d[b + i] = raw % 256; raw = Math.floor(raw / 256); }
  }

  // A bit-level field inside one byte. `bit` is the 0-based LSB position within byte `b`, matching
  // j1939DecodeSPN - so the standard's "5.7" (byte 5, bit 7 counting from 1) is b=4, bit=6.
  function bits(d, b, bit, nbits, val) {
    const mask = (((1 << nbits) - 1) << bit) & 0xFF;
    d[b] = ((d[b] & ~mask) | ((val << bit) & mask)) & 0xFF;
  }

  // Telemetry presence. Two meanings, kept apart on purpose:
  //   has    - the key is there (not undefined/null). The packers' test: the game publishes
  //            signals_for_vehicle, so an absent key is a real absence and not a zero.
  //   hasNum - the key is there AND reads as a finite number. The request servers' test: a
  //            request answered from a non-number would put garbage in the group.
  const has = (t, k) => t && t[k] !== undefined && t[k] !== null;
  const hasNum = (t, k) => !!t && t[k] != null && Number.isFinite(Number(t[k]));

  function frame(id, data) { return { id, isExt: true, data }; }
  // A frame from a message-table entry { pgn, prio, sa, da? }.
  function msgFrame(m, data) { return frame(buildId(m.pgn, m.prio, m.sa, m.da), data); }

  // ── Address Claim before a control function's first frame ──────────────────
  // Address Claimed (PGN 60928) is "Sent at power on" (Open SAE J1939, p.15): a bus capture of a
  // real vehicle starts with one claim per control function. The ledger is shared, here, because
  // j1939-flavor.js and isobus.js both send from Engine #1 (0x00) and one ECU claims once. Both
  // packers' reset() forget it, so carlito.js's resetPackers() (a bus opening, the link resuming)
  // makes every source claim again. NMEA 2000 sources do not come through here.
  //
  // NAME Function per preferred address, off isobus.net's nameFunction and sourceAddress tables:
  // functions 0-127 are industry-group independent, 134 Tractor ECU is industry group 2's. The
  // implement (0x80) is absent on purpose: isobus.js claims it on attaching, with its device class.
  const CLAIM_FUNCTION = {
    0x00: 0,     // Engine #1                  - Engine
    0x03: 3,     // Transmission #1            - Transmission
    0x08: 7,     // Axle - Steering            - Axle - Steering
    0x09: 8,     // Axle - Drive #1            - Axle - Drive
    0x0B: 9,     // Brakes - System Controller - Brakes - System Controller
    0x10: 13,    // Retarder - Driveline       - Retarder - Driveline
    0x17: 19,    // Instrument Cluster #1      - Instrument Cluster
    0xF0: 134,   // Tractor ECU                - Tractor ECU (industry group 2)
  };
  const CLAIM_PGN = 60928, CLAIM_PRIO = 6;
  const claimed = new Map();   // sa -> the NAME it claimed with (a request for 60928 is answered with it)
  // J1939-81 NAME, little-endian (isobus.js's ibName layout): manufacturer code 0 (none is
  // registered to this project), identity 1, ECU / function instance 0, vehicle system 0
  // (non-specific), and NOT arbitrary-address capable - these hold their preferred addresses.
  function claimName(fn, ig) {
    const lo = 1;
    const hi = (((fn & 0xFF) << 8) | ((ig & 7) << 28)) >>> 0;
    return [lo & 0xFF, (lo >>> 8) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 24) & 0xFF,
            hi & 0xFF, (hi >>> 8) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 24) & 0xFF];
  }
  // `frames` with a claim inserted before the first frame from each unclaimed source in the table.
  // The industry group is the vehicle's, off `t`: 2 agricultural for the tractor, else 1
  // on-highway (the truck) - one rule for both packers, which share Engine #1. A different
  // industry group is a different vehicle on a link that never went stale: its claims are not the
  // last one's, so the ledger starts again (no truck NAME on a tractor's Engine #1, and no truck
  // brakes controller answering a tractor's request for 60928). A vehicle with no J1939 network
  // (a car, a boat) between two trucks counts as a change too, keyed 0: the second truck claims.
  let claimedIg = null;
  function claimFirst(frames, t) {
    const ig = window.carlitoIsFamily && window.carlitoIsFamily('tractor', t) ? 2 : 1;
    const key = window.carlitoJ1939Network && !window.carlitoJ1939Network(t) ? 0 : ig;
    if (key !== claimedIg) { claimed.clear(); claimedIg = key; }
    const out = [];
    for (const f of frames) {
      const sa = f.id & 0xFF;
      if (f.isExt && sa in CLAIM_FUNCTION && !claimed.has(sa)) {
        claimed.set(sa, claimName(CLAIM_FUNCTION[sa], ig));
        out.push(claimFrame(sa));
      }
      out.push(f);
    }
    return out;
  }
  function claimFrame(sa) { return frame(buildId(CLAIM_PGN, CLAIM_PRIO, sa, 0xFF), claimed.get(sa).slice()); }
  function forgetClaims() { claimed.clear(); }
  // The sources holding a claim, for j1939.js's answer to a request for 60928: every control
  // function answers it with its Address Claimed ("Sent ... after a 'Request' for 'Address
  // Claim'", Open SAE J1939 p.15). A source that has not claimed is not on the bus yet.
  const claimedSources = () => [...claimed.keys()];
  // For the hermetic self-tests: what has been claimed, and putting it back.
  const claimsSnapshot = () => ({ ig: claimedIg, claimed: new Map(claimed) });
  function claimsRestore(s) { claimed.clear(); for (const [sa, name] of s.claimed) claimed.set(sa, name); claimedIg = s.ig; }

  window.J1939Pack = { buildId, parseId, blank, put, bits, has, hasNum, frame, msgFrame,
                       claimFirst, claimFrame, claimedSources, forgetClaims, claimsSnapshot, claimsRestore };
})();
