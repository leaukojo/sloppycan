// ── CANaerospace — the carlito `canaerospace` flavor packer, and the plane's whole telemetry ──
// The plane's one out signal of this flavor, `flaps_actual`, AND every CAN_MAP signal a plane
// publishes, as CANaerospace Normal Operation Data (NOD) messages. On a plane this packer `carries`
// all of them, so carlito.js's 0x52x block sends nothing: 0x520-0x52E is 1312-1326, inside the
// NOD range V1.7 5.10 reserves for future use. Packer only: the flavor's in signals (elevator /
// flaps) are plane.js's controls, and the beacon / strobe are carlito.js's lamp clocks.
//
// ── WHERE THE LAYOUT CAME FROM ───────────────────────────────────────────────
// CANaerospace V1.7 (Stock Flight Systems, 12.1.2006), an openly published specification:
//   2.1  NOD is CAN-IDs 300-1799, 11-bit; "the identifier distribution within the specified ranges
//        is at the user's discretion", with section 5's default distribution "highly encouraged".
//   2.2  Data types: FLOAT = 2 (IEEE-754 single), BSHORT = 8 (16 discrete bits), UCHAR = 10.
//   3.1  Every message is a 4-byte header + 1 to 4 data bytes, big-endian: byte 0 node-ID (for
//        NOD, "the node-ID identifies the transmitting station"), byte 1 data type, byte 2 service
//        code ("should be set to zero if unused" for NOD), byte 3 message code ("incremented by
//        one for each message ... rolls over to zero after passing 255"; counted per identifier
//        here, since it exists to "determine the age of a signal").
//   5    The default distribution reserves 300-1499; "The identifiers from 1500-1799 are
//        unassigned and may be used for other data at the user's discretion". Units are SI with
//        the exceptions hPa and deg/s; signs follow ISO 1151 (the Notes column below).
//   5.10 1300-1499: "Reserved for future use".
//   6    The example "baseline system": its node-IDs (1 AHRS, 2 ADC, 9 GPS receiver, 11 engine
//        monitoring system, 13 electric system) and its schedule, which sends the accelerations,
//        rates, attitude and heading every 12.5 ms and altitude, rpm, fuel, DC volts and GPS every
//        100 ms, all as FLOAT (latitude / longitude included). An EXAMPLE, not a rule: using its
//        node-IDs is a DECLARED choice, like cleanopen.js's node id.
// Rates: what the example puts in its fast group rides every telemetry call, its 100 ms group the
// slow tick; a signal it does not list keeps CAN_MAP's own fast / slow flag.
//
// ── THE STANDARD IDS USED, AND THE ONES NOT ──────────────────────────────────
// 300-302 body accelerations (g; forward / right / up +): accLong / accLat / acc_vert over g0.
//   These are the game's KINEMATIC accelerations with no gravity term (acc_vert's desc), so level
//   flight reads 0 g on 302 where a real accelerometer reads +1 - the same statement
//   dronecan-core.js makes for ahrs.Solution.
// 303-305 body rates (deg/s; nose up / roll right / yaw right +): the game's rad/s in deg/s. 305
//   NEGATES yaw: the game reads it off its UP axis, where + is nose LEFT (dronecan-core.js gives
//   the same reason for its ahrs.Solution z).
// 311 / 312 body pitch / roll angle (deg; nose up / roll right +): the contract's signs as is.
// 321 heading angle, "deg +/- 180": the contract's 0-360 compass heading folded to +/-180.
// 337 body longitudinal velocity (m/s): `speed`, the signed longitudinal speed.
// 414 engine #1 throttle lever position, ECS channel A (Norm -1/+1): `throttle` / 100.
// 314 altitude rate (m/s): `vspeed`. 320 baro corrected altitude (m): `altitude`, which is above
//   sea level - not 1038, GPS height above the ELLIPSOID, which differs from it by the geoid.
// 500 engine #1 N1, ECS A (1/min; "crankshaft RPM for piston engines"): `rpm`.
// 548 engine #1 coolant temperature, ECS A (K): `coolant` + 273.15.
// 920 DC system #1 voltage (V): `battery`. 1036 / 1037 GPS aircraft latitude / longitude (deg).
// NOT USED: 668 fuel tank quantity is in kg and `fuel` is a %, with no tank capacity to convert
// by; 413 nose wheel steering / 401 roll control are each half of `steer`, which the game applies
// as roll + yaw; 1176 WOW solenoid is a BLONG whose bits the spec does not define (`ground`);
// 1039 GPS ground speed is horizontal, `kmh` is |speed|; 315-317 airspeeds: the game publishes none.
// Those, and what has no aircraft meaning at all, ride the user range 1501-1510 below, in the
// contract's own unit.
//
// ── flaps_actual ON 1500 ──────────────────────────────────────────────────────
// The default distribution's only flap entry is 430 "Flaps lever position" (Norm, -1/+1) - the
// pilot's REQUEST, the contract's `flaps`, not `flaps_actual`. Publishing the surface under 430
// would misstate what it is, so it takes 1500, the first user identifier. It is carried in 430's
// own unit, Norm (0..1 here, flaps only extend), so a listener can compare lever and surface
// without a second scale.
//
// ── BUS COST ──────────────────────────────────────────────────────────────────
// About 15 messages on every call and 14 more on the slow tick: at the ~20 / ~10 Hz the telemetry
// has, ~440 frames/s, near the drone's DroneCAN ~390, against 6 fast + 6 slow 0x52x frames before.
//
// INTEGRATION POINTS:
//   index.html / carlito-bridge.html  <script src="canaerospace.js" defer> after carlito-registry.js
// Telemetry TX rides carlito.js's canForward gateway, like every packer.

(function () {
  'use strict';

  const CAS_FLOAT = 2, CAS_BSHORT = 8, CAS_UCHAR = 10;   // 2.2 data types
  const CAS_SERVICE_UNUSED = 0;       // 3.1: NOD service code, zero if unused
  // Node-IDs: 6's example list, plus 14 (the first id past it) for what no example node sends.
  const NODE = { AHRS: 1, ADC: 2, GPS: 9, EMS: 11, ELEC: 13, CARLITO: 14 };
  const G0 = 9.80665, DEG = 180 / Math.PI;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // One row per message: contract signal, identifier, sending node, data type, every call (fast)
  // or the slow tick only, and the conversion from the contract's unit. In identifier order.
  const CAS_TX = [
    { sig: 'accLong',    id: 300,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v / G0 },
    { sig: 'accLat',     id: 301,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v / G0 },
    { sig: 'acc_vert',   id: 302,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v / G0 },
    { sig: 'pitch_rate', id: 303,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v * DEG },
    { sig: 'roll_rate',  id: 304,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v * DEG },
    { sig: 'yaw',        id: 305,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => -v * DEG },
    { sig: 'pitch',      id: 311,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v },
    { sig: 'roll',       id: 312,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v },
    { sig: 'vspeed',     id: 314,  node: NODE.ADC,  type: CAS_FLOAT, fast: false, conv: (v) => v },
    { sig: 'altitude',   id: 320,  node: NODE.ADC,  type: CAS_FLOAT, fast: false, conv: (v) => v },
    { sig: 'heading',    id: 321,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,
      conv: (v) => { const h = ((v % 360) + 360) % 360; return h > 180 ? h - 360 : h; } },
    { sig: 'speed',      id: 337,  node: NODE.AHRS, type: CAS_FLOAT, fast: true,  conv: (v) => v },
    { sig: 'throttle',   id: 414,  node: NODE.EMS,  type: CAS_FLOAT, fast: true,  conv: (v) => clamp(v / 100, -1, 1) },
    { sig: 'rpm',        id: 500,  node: NODE.EMS,  type: CAS_FLOAT, fast: false, conv: (v) => v },
    { sig: 'coolant',    id: 548,  node: NODE.EMS,  type: CAS_FLOAT, fast: false, conv: (v) => v + 273.15 },
    { sig: 'battery',    id: 920,  node: NODE.ELEC, type: CAS_FLOAT, fast: false, conv: (v) => v },
    { sig: 'lat',        id: 1036, node: NODE.GPS,  type: CAS_FLOAT, fast: false, conv: (v) => v },
    { sig: 'lon',        id: 1037, node: NODE.GPS,  type: CAS_FLOAT, fast: false, conv: (v) => v },
    // The user range (5: 1500-1799 unassigned), in the contract's own units; flaps_actual in Norm.
    { sig: 'flaps_actual', id: 1500, node: NODE.CARLITO, type: CAS_FLOAT, fast: false, conv: (v) => v / 100 },
    { sig: 'kmh',        id: 1501, node: NODE.CARLITO, type: CAS_FLOAT,  fast: true,  conv: (v) => v },
    { sig: 'gear',       id: 1502, node: NODE.CARLITO, type: CAS_UCHAR,  fast: true,  conv: (v) => v },   // the contract's enum byte
    { sig: 'steer',      id: 1503, node: NODE.CARLITO, type: CAS_FLOAT,  fast: true,  conv: (v) => v },   // %
    { sig: 'ground',     id: 1504, node: NODE.CARLITO, type: CAS_UCHAR,  fast: true,  conv: (v) => v ? 1 : 0, flag: true },
    { sig: 'posX',       id: 1505, node: NODE.CARLITO, type: CAS_FLOAT,  fast: false, conv: (v) => v },   // m
    { sig: 'posZ',       id: 1506, node: NODE.CARLITO, type: CAS_FLOAT,  fast: false, conv: (v) => v },   // m
    { sig: 'odo',        id: 1507, node: NODE.CARLITO, type: CAS_FLOAT,  fast: false, conv: (v) => v },   // km
    { sig: 'status',     id: 1508, node: NODE.CARLITO, type: CAS_BSHORT, fast: false, conv: (v) => v },   // the bitfield verbatim
    { sig: 'impact',     id: 1509, node: NODE.CARLITO, type: CAS_FLOAT,  fast: false, conv: (v) => v },   // m/s^2
    { sig: 'fuel',       id: 1510, node: NODE.CARLITO, type: CAS_FLOAT,  fast: false, conv: (v) => v },   // %
  ];
  const casCodes = new Map();         // 3.1: per identifier, +1 per message, wraps after 255

  function float32be(v) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, false);
    return [dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)];
  }
  const DATA = {
    [CAS_FLOAT]: float32be,
    [CAS_UCHAR]: (v) => [clamp(Math.round(v), 0, 0xFF)],
    [CAS_BSHORT]: (v) => { const w = clamp(Math.round(v), 0, 0xFFFF); return [w >> 8, w & 0xFF]; },
  };

  const casIsPlane = (t) => !!(window.carlitoIsFamily && window.carlitoIsFamily('plane', t));

  // A plane's messages for this call. Absent or non-numeric -> no message at all, the only honest
  // NOD for a value nobody published (a flag reads its truthiness, as CAN_MAP's does).
  function casPack(t, slow) {
    if (!casIsPlane(t)) return [];
    const out = [];
    for (const r of CAS_TX) {
      if (!r.fast && !slow) continue;
      const raw = t[r.sig];
      if (raw === undefined || raw === null) continue;
      const v = r.flag ? raw : Number(raw);
      if (!r.flag && !Number.isFinite(v)) continue;
      const code = casCodes.get(r.id) || 0;
      casCodes.set(r.id, (code + 1) & 0xFF);
      out.push({ id: r.id, isExt: false,
        data: [r.node, r.type, CAS_SERVICE_UNUSED, code, ...DATA[r.type](r.conv(v))] });
    }
    return out;
  }

  // ── ONE CARRIER: CAN_MAP's signals in CANaerospace messages (plane) ────────────
  // On a plane every CAN_MAP signal above rides ONLY its message here, and carlito.js sends its
  // 0x52x field as absent - which leaves that block empty, so a plane sends no 0x52x at all.
  const CAS_CARRIES = {};
  for (const r of CAS_TX) {
    if (r.sig === 'flaps_actual') continue;   // this flavor's own signal, not CAN_MAP's
    CAS_CARRIES[r.sig] = r.id < 1500
      ? `CANaerospace NOD ${r.id} (V1.7 default distribution), node ${r.node}`
      : `CANaerospace NOD ${r.id}, user-defined (V1.7 5: 1500-1799 unassigned), node ${r.node}`;
  }
  const casCarriesFor = (t) => casIsPlane(t) ? Object.keys(CAS_CARRIES) : [];

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({ flavor: 'canaerospace', signals: ['flaps_actual'],
    carries: CAS_CARRIES, carriesFor: casCarriesFor, pack: casPack });

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.canaerospaceSelfTest(). The message codes are snapshotted and put
  // back in a `finally`, so a run leaves the live sequences where they were.
  function canaerospaceSelfTest() {
    const saved = new Map(casCodes);
    try { return casSelfTestChecks(); }
    finally { casCodes.clear(); for (const [k, v] of saved) casCodes.set(k, v); }
  }
  function casSelfTestChecks() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (fr) => fr.map(f => f.id.toString(16).toUpperCase() + '#' +
      f.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''));
    const f32 = (d) => new DataView(new Uint8Array(d.slice(4, 8)).buffer).getFloat32(0, false);
    const one = (t, id, slow = true) => casPack({ flaps_actual: 0, ...t }, slow).find(f => f.id === id);
    const near = (what, got, want) => { if (!(Math.abs(got - want) < 1e-4)) failures.push(`${what}: got ${got}, want ${want}`); };
    casCodes.clear();
    // 40 % -> 0.4 -> IEEE-754 0x3ECCCCCD, big-endian, from node 14.
    eq('flaps 40 %', hex(casPack({ flaps_actual: 40 }, true)), ['5DC#0E0200003ECCCCCD']);
    eq('the message code counts', casPack({ flaps_actual: 0 }, true)[0].data[3], 1);
    casCodes.set(1500, 255);
    eq('code 255 goes out', casPack({ flaps_actual: 100 }, true)[0].data.slice(3), [0xFF, 0x3F, 0x80, 0x00, 0x00]);
    eq('then rolls over to zero', casPack({ flaps_actual: 100 }, true)[0].data[3], 0);
    eq('codes count per identifier', one({ pitch: 1 }, 311).data[3], 0);
    eq('absent: no message', casPack({ flaps_actual: 'x' }, true), []);
    eq('flaps only on the slow tick', casPack({ flaps_actual: 40 }, false), []);
    eq('not a plane: nothing', casPack({ pitch: 1, roll: 2, heading: 90, depth: 4 }, true), []);
    eq('not a plane: carries nothing', casCarriesFor({ pitch: 1, depth: 4 }), []);
    eq('a plane: carries no flavor signal of its own', casCarriesFor({ flaps_actual: 0 }).includes('flaps_actual'), false);
    casCodes.clear();
    // 311 body pitch angle 3 deg -> 0x40400000, AHRS node 1.
    eq('pitch 3 deg', hex([one({ pitch: 3 }, 311)]), ['137#0102000040400000']);
    eq('gear as UCHAR', hex([one({ gear: 4 }, 1502)]), ['5DE#0E0A000004']);
    eq('ground as UCHAR', hex([one({ ground: true }, 1504)]), ['5E0#0E0A000001']);
    eq('status as BSHORT', hex([one({ status: 0x0181 }, 1508)]), ['5E4#0E0800000181']);
    near('yaw 0.1 rad/s left -> -5.73 deg/s', f32(one({ yaw: 0.1 }, 305).data), -0.1 * DEG);
    near('roll rate in deg/s', f32(one({ roll_rate: -0.2 }, 304).data), -0.2 * DEG);
    near('heading 270 -> -90', f32(one({ heading: 270 }, 321).data), -90);
    near('heading 90 stays', f32(one({ heading: 90 }, 321).data), 90);
    near('coolant in K', f32(one({ coolant: 90 }, 548).data), 363.15);
    near('accLong in g', f32(one({ accLong: G0 }, 300).data), 1);
    near('throttle in Norm, clamped', f32(one({ throttle: -250 }, 414).data), -1);
    eq('lat from the GPS node', one({ lat: 48.8566 }, 1036).data[0], NODE.GPS);
    eq('fast tick: attitude goes', !!one({ pitch: 1 }, 311, false), true);
    eq('fast tick: altitude waits', !!one({ altitude: 100 }, 320, false), false);

    if (failures.length) console.error('CANaerospace self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('CANaerospace self-test: all checks passed.');
    return failures;
  }
  window.canaerospaceSelfTest = canaerospaceSelfTest;
})();
