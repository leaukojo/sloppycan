// ── CANaerospace — the carlito `canaerospace` flavor packer ───────────────────
// The plane's one out signal of this flavor, `flaps_actual`, as a CANaerospace Normal Operation
// Data message. Packer only: the flavor's in signals (elevator / flaps) are plane.js's controls,
// and the beacon / strobe are carlito.js's lamp clocks.
//
// ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
// CANaerospace V1.7 (Stock Flight Systems, 2006), an openly published specification:
//   3.1  Every message is a 4-byte header + up to 4 data bytes, big-endian: byte 0 node-ID (for
//        NOD, "the node-ID identifies the transmitting station"), byte 1 data type, byte 2 service
//        code ("should be set to zero if unused" for NOD), byte 3 message code ("incremented by
//        one for each message ... rolls over to zero after passing 255").
//   2.2  Data type FLOAT = 2: IEEE-754 single precision.
//   5    THE DEFAULT IDENTIFIER DISTRIBUTION HAS NO FLAP SURFACE POSITION. Its only flap entry is
//        430 "Flaps lever position" (Norm, -1/+1) - the pilot's REQUEST, the contract's `flaps`,
//        not `flaps_actual`. Publishing the surface under 430 would misstate what it is. 5 also
//        says "The identifiers from 1500-1799 are unassigned and may be used for other data at
//        the user's discretion", and 2.1 that identifier distribution is at the user's discretion
//        generally, so this side takes 1500: a DECLARED choice, like cleanopen.js's node id.
// The value is carried in 430's own unit, Norm (0..1 here, flaps only extend), so a listener can
// compare lever and surface without a second scale.
//
// INTEGRATION POINTS:
//   index.html / carlito-bridge.html  <script src="canaerospace.js" defer> after carlito-registry.js
// Telemetry TX rides carlito.js's canForward gateway, like every packer.

(function () {
  'use strict';

  const CAS_ID_FLAPS_ACTUAL = 1500;   // 0x5DC, 11-bit: the first identifier 5 leaves to the user
  const CAS_NODE = 1;                 // node-ID of the transmitting station (1-255); chosen, not looked up
  const CAS_FLOAT = 2;                // 2.2 data type FLOAT
  const CAS_SERVICE_UNUSED = 0;       // 3.1: NOD service code, zero if unused
  let casMsgCode = 0;                 // 3.1: per identifier, +1 per message, wraps after 255

  function float32be(v) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, false);
    return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)];
  }

  // Slow tick (100 ms): flaps slew over seconds. Absent or non-numeric -> no message at all, the
  // only honest NOD for a value nobody published.
  function casPack(t, slow) {
    if (!t || !slow || t.flaps_actual === undefined || t.flaps_actual === null) return [];
    const v = Number(t.flaps_actual);
    if (!Number.isFinite(v)) return [];
    const data = [CAS_NODE, CAS_FLOAT, CAS_SERVICE_UNUSED, casMsgCode, ...float32be(v / 100)];
    casMsgCode = (casMsgCode + 1) & 0xFF;
    return [{ id: CAS_ID_FLAPS_ACTUAL, isExt: false, data }];
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({ flavor: 'canaerospace', signals: ['flaps_actual'], pack: casPack });

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.canaerospaceSelfTest(). The message code is snapshotted and put
  // back in a `finally`, so a run leaves the live sequence where it was.
  function canaerospaceSelfTest() {
    const saved = casMsgCode;
    try { return casSelfTestChecks(); }
    finally { casMsgCode = saved; }
  }
  function casSelfTestChecks() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (fr) => fr.map(f => f.id.toString(16).toUpperCase() + '#' +
      f.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''));
    casMsgCode = 0;
    // 40 % -> 0.4 -> IEEE-754 0x3ECCCCCD, big-endian.
    eq('flaps 40 %', hex(casPack({ flaps_actual: 40 }, true)), ['5DC#010200003ECCCCCD']);
    eq('the message code counts', casPack({ flaps_actual: 0 }, true)[0].data[3], 1);
    casMsgCode = 255;
    eq('code 255 goes out', casPack({ flaps_actual: 100 }, true)[0].data.slice(3), [0xFF, 0x3F, 0x80, 0x00, 0x00]);
    eq('then rolls over to zero', casPack({ flaps_actual: 100 }, true)[0].data[3], 0);
    eq('absent: no message', casPack({}, true), []);
    eq('non-numeric: no message', casPack({ flaps_actual: 'x' }, true), []);
    eq('only on the slow tick', casPack({ flaps_actual: 40 }, false), []);

    if (failures.length) console.error('CANaerospace self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('CANaerospace self-test: all checks passed.');
    return failures;
  }
  window.canaerospaceSelfTest = canaerospaceSelfTest;
})();
