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

  window.J1939Pack = { buildId, parseId, blank, put, bits, has, hasNum, frame, msgFrame };
})();
