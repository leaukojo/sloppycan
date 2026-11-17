// ── ISO 11992-2 (the trailer bus) — the carlito `iso11992` flavor packer ──────
// The contract's trailer signals: the towed vehicle's messages back to the truck, and the truck's
// brake demand to it. No tab: ISO 11992-2 frames are J1939-format 29-bit ids, so the J1939 tab
// shows them beside everything else, named by J1939_DB's EBS11 / EBS21 / EBS22 entries
// (j1939-tables.js). A MODELLING CHOICE, stated:
// the trailer bus is a CAN of its own on pins 6 and 7 of the
// ISO 7638 connector, behind the truck's gateway; here it is shown on the same CAN as the chassis.
//
// ── WHERE THE NUMBERS CAME FROM - READ THIS BEFORE TRUSTING ONE ──────────────
// The standard itself (ISO 11992-2) is paywalled and NOT on this machine, so this file is built
// from the best sources that could be reached, and every number below is tagged with its tier.
// Check them, and the choices marked below, against the standard the day a copy is available.
//   [ISO]  ISO's own free sample pages (2003 edition clauses 6.1-6.3; 2023 edition 6.1): the 29-bit
//          J1939-style identifier and its PDU1/PDU2 rules; priority 3 for control and 6 for
//          informational messages, ignored by receivers (6.1.2); "All eight bytes shall be used"
//          (6.1.8); the address table (6.2 Table 3); PDU2 GE even toward the predecessor (6.2);
//          discrete parameters are 2-bit and suspect values follow SAE J1939-71 (2023 REQ 8.1).
//   [REG]  Regulations quoting the standard's byte positions: EU 2015/68 Annex XII Appendix 1
//          (ISO 11992-2:2003 + Amd.1:2007) for EBS22 byte 1 bits 1-2 "Vehicle ABS active/passive",
//          EBS22 bytes 5-6 "Axle load sum" and EBS11 bytes 3-4 "Service/secondary brake demand
//          value"; UN R13 Annexes 16/21 (cited in the carlito repo's docs/sources.md) for EBS21
//          byte 2 bits 1-2 "VDC active/passive". UN R13 Annex 17 for that demand value's scale:
//          released = 0, "service brake pedal fully applied" = 33280d to 43520d (650 to 850 kPa)
//          (3.2.2.2.1), and 33280d = 650 kPa again as the trailer test's full demand (4.2.2.1.1):
//          51.2 counts a kPa from zero, i.e. 5/256 kPa a bit, offset 0.
//   [DD]   The ISO 11783 data dictionary (isobus.net, which lists ISO 11992-2's groups by
//          acronym, "See document ISO 11992-2 for PG details"): the PGNs, EBS11 = 512 (PDU1),
//          EBS21 = 768 (PDU1), EBS22 = 65220 (0xFEC4, PDU2), EBS25 = 61472 (0xF020, PDU2).
//          No priorities, rates or field layouts there.
// Two signals have NO source for their scaling, and are declared unpackable rather than guessed
// (see the registration below). An LLM's from-memory layout of these messages was checked against
// R13 Annex 16 / isobus.net and found wrong in places (EBS25's PGN, EBS22's warning bits), so
// none of its unconfirmed figures are used.
//
// INTEGRATION POINTS:
//   index.html / carlito-bridge.html  <script src="iso11992.js" defer> after j1939-pack.js
// Telemetry TX rides carlito.js's canForward gateway, like every packer.

(function () {
  'use strict';

  const jp = window.J1939Pack;

  // [ISO] Table 3: the commercial vehicle's address is fixed; towed vehicle position #1 is 0xC8,
  // which is also the address a powered-up towed node uses until address assignment completes.
  const SA_COMMERCIAL = 0x20;
  const SA_TOWED1 = 0xC8;
  // [ISO] 6.1.2: the receiver masks priority off, so this choice changes no decode. No source here
  // gives a message's own priority: EBS11, the brake demand, takes the control 3; the trailer's
  // two status messages the informational 6.
  const PRIO_CTRL = 3, PRIO_INFO = 6;
  const MSGS = {
    // [DD] PGN, [REG] bytes 3-4 the service/secondary brake demand. PDU1, the towing vehicle to
    // the towed one.
    EBS11: { pgn: 512,   prio: PRIO_CTRL, sa: SA_COMMERCIAL, da: SA_TOWED1 },
    // [DD] PGN, [REG] byte 2 bits 1-2 VDC active/passive. PDU1, addressed to the predecessor.
    EBS21: { pgn: 768,   prio: PRIO_INFO, sa: SA_TOWED1, da: SA_COMMERCIAL },
    // [DD] PGN, [REG] byte 1 bits 1-2 Vehicle ABS active/passive. PDU2.
    EBS22: { pgn: 65220, prio: PRIO_INFO, sa: SA_TOWED1 },
  };
  // [REG] R13 Annex 17: 5/256 kPa a bit. The contract's 100 % is taken as 650 kPa (33280d), the
  // floor of R13's "fully applied" band and its test's full demand - a choice inside the band.
  // Little-endian, as J1939Pack.put writes every J1939-format field: no source here states it.
  const DEMAND_KPA_PER_BIT = 5 / 256;
  const DEMAND_FULL_KPA = 650;
  // [ISO] REQ 8.1 adopts J1939-71's two-bit vocabulary: 00 passive / off, 01 active / on.
  const PASSIVE = 0, ACTIVE = 1;

  // A TRAILER THAT IS NOT TALKING SENDS NOTHING. trailer_connected is "a trailer has claimed on the
  // ISO 11992 bus", and false covers both bobtail and a coupled trailer behind a unit with no data
  // pair - in both cases the towed node is silent (and, with no node to hear it, so is EBS11). So
  // the signal rides the frames' PRESENCE, the way dronecan.js's node_online does. Sent on
  // carlito.js's slow tick (100 ms); the standard's repetition rates are not in any source here,
  // so the rate is this side's.
  function isoPack(t, slow) {
    if (!t || !slow || !jp.has(t, 'trailer_connected') || !t.trailer_connected) return [];
    const ebs11 = jp.blank(), ebs21 = jp.blank(), ebs22 = jp.blank();
    if (jp.has(t, 'trailer_brake_demand')) {
      const pct = Math.max(0, Math.min(100, Number(t.trailer_brake_demand)));
      jp.put(ebs11, 2, 2, pct / 100 * DEMAND_FULL_KPA, DEMAND_KPA_PER_BIT, 0);
    }
    if (jp.has(t, 'trailer_vdc')) jp.bits(ebs21, 1, 0, 2, t.trailer_vdc ? ACTIVE : PASSIVE);
    if (jp.has(t, 'trailer_abs')) jp.bits(ebs22, 0, 0, 2, t.trailer_abs ? ACTIVE : PASSIVE);
    // Every other byte stays all-ones, J1939-71's "not available" ([ISO] REQ 8.1): wheel-based
    // speed, lateral acceleration and the axle load sum have no scale from any source here.
    return [jp.msgFrame(MSGS.EBS21, ebs21), jp.msgFrame(MSGS.EBS22, ebs22), jp.msgFrame(MSGS.EBS11, ebs11)];
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'iso11992',
    signals: ['trailer_connected', 'trailer_abs', 'trailer_vdc', 'trailer_brake_demand'],
    unpackable: {
      trailer_axle_load: 'its carrier is EBS22 bytes 5-6 "Axle load sum" (EU 2015/68 Annex XII), but ' +
        'no source reachable here gives that field\'s resolution or offset, and the ISO 11992-2 ' +
        'standard itself is not on this machine - provide it to implement this',
      trailer_brake_applied: 'its carrier is EBS25 (PGN 61472) bytes 1-6 "Brake cylinder pressure" ' +
        'per wheel (UN R13 Annex 16 2.4.2), PRESSURES whose resolution no source reachable here ' +
        'gives, and the contract\'s one % has neither a pressure scale nor a per-wheel split - ' +
        'provide ISO 11992-2 to implement this',
    },
    pack: isoPack,
  });

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.iso11992SelfTest(). Stateless, so nothing to snapshot.
  function iso11992SelfTest() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const hex = (fr) => fr.map(f => (f.id >>> 0).toString(16).toUpperCase().padStart(8, '0') + '#' +
      f.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''));

    // EBS21: priority 6, PF 3 (PDU1) to 0x20 from 0xC8. EBS22: PF 0xFE, GE 0xC4, from 0xC8.
    // EBS11: priority 3, PF 2 (PDU1) to 0xC8 from 0x20.
    eq('ABS and VDC active', hex(isoPack({ trailer_connected: true, trailer_abs: true, trailer_vdc: true }, true)),
      ['180320C8#FFFDFFFFFFFFFFFF', '18FEC4C8#FDFFFFFFFFFFFFFF', '0C02C820#FFFFFFFFFFFFFFFF']);
    eq('both passive', hex(isoPack({ trailer_connected: true, trailer_abs: false, trailer_vdc: false }, true)),
      ['180320C8#FFFCFFFFFFFFFFFF', '18FEC4C8#FCFFFFFFFFFFFFFF', '0C02C820#FFFFFFFFFFFFFFFF']);
    eq('absent states stay not available', hex(isoPack({ trailer_connected: true }, true)),
      ['180320C8#FFFFFFFFFFFFFFFF', '18FEC4C8#FFFFFFFFFFFFFFFF', '0C02C820#FFFFFFFFFFFFFFFF']);
    // R13 Annex 17's anchors: released 0, full (650 kPa) 33280d = 0x8200; 10 % is 65 kPa, 3328d.
    const demand = (pct) => hex(isoPack({ trailer_connected: true, trailer_brake_demand: pct }, true))[2];
    eq('demand released', demand(0), '0C02C820#FFFF0000FFFFFFFF');
    eq('demand 10 %', demand(10), '0C02C820#FFFF000DFFFFFFFF');
    eq('demand full is 650 kPa', demand(100), '0C02C820#FFFF0082FFFFFFFF');
    eq('demand past 100 % clamps', demand(150), '0C02C820#FFFF0082FFFFFFFF');
    eq('no trailer on the bus: silence', isoPack({ trailer_connected: false, trailer_abs: true }, true), []);
    eq('no trailer_connected statement: silence', isoPack({ trailer_abs: true }, true), []);
    eq('only on the slow tick', isoPack({ trailer_connected: true, trailer_abs: true }, false), []);
    eq('EBS22 parses back as PGN 65220 from 0xC8', jp.parseId(0x18FEC4C8), { priority: 6, dp: 0, pf: 0xFE, pgn: 65220, da: 0xFF, sa: 0xC8 });
    // Round trip through j1939.js's decoder (J1939_DB's EBS11 / EBS21 / EBS22 entries), where it is loaded -
    // carlito-bridge.html has no decoder, and there is nothing to round-trip against there.
    if (typeof j1939DecodePGN === 'function' && typeof J1939_DB !== 'undefined') {
      const [e21, e22, e11] = isoPack({ trailer_connected: true, trailer_abs: true, trailer_vdc: false, trailer_brake_demand: 100 }, true);
      const dec = (pgn, d, name) => (j1939DecodePGN(pgn, d, J1939_DB).find(x => x.name === name) || {}).display;
      eq('EBS21 round trip', dec(768, e21.data, 'VDC active/passive'), 'Passive');
      eq('EBS22 round trip', dec(65220, e22.data, 'Vehicle ABS active/passive'), 'Active');
      eq('EBS11 round trip', dec(512, e11.data, 'Service/secondary brake demand value'), '650 kPa');
    }

    if (failures.length) console.error('ISO 11992 self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('ISO 11992 self-test: all checks passed.');
    return failures;
  }
  window.iso11992SelfTest = iso11992SelfTest;
})();
