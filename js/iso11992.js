// ── ISO 11992-2 (the trailer bus) — the carlito `iso11992` flavor packer ──────
// The contract's trailer signals, as the towed vehicle's messages back to the truck. No tab:
// ISO 11992-2 frames are J1939-format 29-bit ids, so the J1939 tab shows them beside everything
// else, named by J1939_DB's EBS21 / EBS22 entries (j1939-tables.js). A MODELLING CHOICE, stated:
// the trailer bus is a CAN of its own on pins 6 and 7 of the
// ISO 7638 connector, behind the truck's gateway; here it is shown on the same CAN as the chassis.
//
// ── WHERE THE NUMBERS CAME FROM - READ THIS BEFORE TRUSTING ONE ──────────────
// The standard itself (ISO 11992-2) is paywalled and NOT on this machine, so this file is built
// from the best sources that could be reached, and every number below is tagged with its tier.
// Replace the SECONDARY ones from the standard the day a copy is available.
//   [ISO]  ISO's own free sample pages (2003 edition clauses 6.1-6.3; 2023 edition 6.1): the 29-bit
//          J1939-style identifier and its PDU1/PDU2 rules; priority 3 for control and 6 for
//          informational messages, ignored by receivers (6.1.2); "All eight bytes shall be used"
//          (6.1.8); the address table (6.2 Table 3); PDU2 GE even toward the predecessor (6.2);
//          discrete parameters are 2-bit and suspect values follow SAE J1939-71 (2023 REQ 8.1).
//   [REG]  Regulations quoting the standard's byte positions: EU 2015/68 Annex XII Appendix 1
//          (ISO 11992-2:2003 + Amd.1:2007) for EBS22 byte 1 bits 1-2 "Vehicle ABS active/passive",
//          EBS22 bytes 5-6 "Axle load sum" and EBS11 bytes 3-4 "Service/secondary brake demand
//          value"; UN R13 Annexes 16/21 (cited in the carlito repo's docs/sources.md) for EBS21
//          byte 2 bits 1-2 "VDC active/passive".
//   [SEC]  Secondary only - a training deck and a J1939 PGN table, seen through search summaries:
//          the PGNs, EBS21 = 768 (PDU1) and EBS22 = 65220 (0xFEC4, PDU2). 0xFEC4's even GE agrees
//          with [ISO]'s direction rule, which is all the corroboration there is.
// Three signals have NO source for their scaling at all, and are declared unpackable rather than
// guessed (see the registration below).
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
  // [ISO] 6.1.2: the receiver masks priority off, so this choice changes no decode. The messages'
  // own priorities are not in any source here, so both take the informational default.
  const PRIO_INFO = 6;
  const MSGS = {
    // [SEC] PGN, [REG] byte 2 bits 1-2 VDC active/passive. PDU1, addressed to the predecessor.
    EBS21: { pgn: 768,   prio: PRIO_INFO, sa: SA_TOWED1, da: SA_COMMERCIAL },
    // [SEC] PGN, [REG] byte 1 bits 1-2 Vehicle ABS active/passive. PDU2.
    EBS22: { pgn: 65220, prio: PRIO_INFO, sa: SA_TOWED1 },
  };
  // [ISO] REQ 8.1 adopts J1939-71's two-bit vocabulary: 00 passive / off, 01 active / on.
  const PASSIVE = 0, ACTIVE = 1;

  // A TRAILER THAT IS NOT TALKING SENDS NOTHING. trailer_connected is "a trailer has claimed on the
  // ISO 11992 bus", and false covers both bobtail and a coupled trailer behind a unit with no data
  // pair - in both cases the towed node is silent. So the signal rides the frames' PRESENCE, the
  // way dronecan.js's node_online does. Sent on carlito.js's slow tick (100 ms); the standard's
  // repetition rates are not in any source here, so the rate is this side's.
  function isoPack(t, slow) {
    if (!t || !slow || !jp.has(t, 'trailer_connected') || !t.trailer_connected) return [];
    const ebs21 = jp.blank(), ebs22 = jp.blank();
    if (jp.has(t, 'trailer_vdc')) jp.bits(ebs21, 1, 0, 2, t.trailer_vdc ? ACTIVE : PASSIVE);
    if (jp.has(t, 'trailer_abs')) jp.bits(ebs22, 0, 0, 2, t.trailer_abs ? ACTIVE : PASSIVE);
    // Every other byte stays all-ones, J1939-71's "not available" ([ISO] REQ 8.1): wheel-based
    // speed, lateral acceleration and the axle load sum have no scale from any source here.
    return [jp.msgFrame(MSGS.EBS21, ebs21), jp.msgFrame(MSGS.EBS22, ebs22)];
  }

  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'iso11992',
    signals: ['trailer_connected', 'trailer_abs', 'trailer_vdc'],
    unpackable: {
      trailer_axle_load: 'its carrier is EBS22 bytes 5-6 "Axle load sum" (EU 2015/68 Annex XII), but ' +
        'no source reachable here gives that field\'s resolution or offset, and the ISO 11992-2 ' +
        'standard itself is not on this machine - provide it to implement this',
      trailer_brake_demand: 'its carrier is EBS11 bytes 3-4 "Service/secondary brake demand value" ' +
        '(EU 2015/68 Annex XII), a PRESSURE demand whose resolution no source reachable here gives, ' +
        'and the contract\'s % has no pressure scale to convert through - provide ISO 11992-2 to implement this',
      trailer_brake_applied: 'its carrier is EBS25 bytes 1-6 "Brake cylinder pressure" per wheel (UN R13 ' +
        'Annex 16 2.4.2), PRESSURES whose resolution no source reachable here gives, and the contract\'s ' +
        'one % has neither a pressure scale nor a per-wheel split - provide ISO 11992-2 to implement this',
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
    const hex = (fr) => fr.map(f => (f.id >>> 0).toString(16).toUpperCase() + '#' +
      f.data.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''));

    // EBS21: priority 6, PF 3 (PDU1) to 0x20 from 0xC8. EBS22: PF 0xFE, GE 0xC4, from 0xC8.
    eq('ABS and VDC active', hex(isoPack({ trailer_connected: true, trailer_abs: true, trailer_vdc: true }, true)),
      ['180320C8#FFFDFFFFFFFFFFFF', '18FEC4C8#FDFFFFFFFFFFFFFF']);
    eq('both passive', hex(isoPack({ trailer_connected: true, trailer_abs: false, trailer_vdc: false }, true)),
      ['180320C8#FFFCFFFFFFFFFFFF', '18FEC4C8#FCFFFFFFFFFFFFFF']);
    eq('absent states stay not available', hex(isoPack({ trailer_connected: true }, true)),
      ['180320C8#FFFFFFFFFFFFFFFF', '18FEC4C8#FFFFFFFFFFFFFFFF']);
    eq('no trailer on the bus: silence', isoPack({ trailer_connected: false, trailer_abs: true }, true), []);
    eq('no trailer_connected statement: silence', isoPack({ trailer_abs: true }, true), []);
    eq('only on the slow tick', isoPack({ trailer_connected: true, trailer_abs: true }, false), []);
    eq('EBS22 parses back as PGN 65220 from 0xC8', jp.parseId(0x18FEC4C8), { priority: 6, dp: 0, pf: 0xFE, pgn: 65220, da: 0xFF, sa: 0xC8 });
    // Round trip through j1939.js's decoder (J1939_DB's EBS21 / EBS22 entries), where it is loaded -
    // carlito-bridge.html has no decoder, and there is nothing to round-trip against there.
    if (typeof j1939DecodePGN === 'function' && typeof J1939_DB !== 'undefined') {
      const [e21, e22] = isoPack({ trailer_connected: true, trailer_abs: true, trailer_vdc: false }, true);
      const dec = (pgn, d, name) => (j1939DecodePGN(pgn, d, J1939_DB).find(x => x.name === name) || {}).display;
      eq('EBS21 round trip', dec(768, e21.data, 'VDC active/passive'), 'Passive');
      eq('EBS22 round trip', dec(65220, e22.data, 'Vehicle ABS active/passive'), 'Active');
    }

    if (failures.length) console.error('ISO 11992 self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('ISO 11992 self-test: all checks passed.');
    return failures;
  }
  window.iso11992SelfTest = iso11992SelfTest;
})();
