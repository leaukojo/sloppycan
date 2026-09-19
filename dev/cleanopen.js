// ── CleANopen (CiA 422) — the garbage truck's body command ───────────────────
// The contract's `cleanopen` flavor is the one on a SECOND NETWORK: CiA 422 is a CANopen
// body-control network (EN 16815:2019), reaching the J1939 chassis across a CiA 413-6 truck
// gateway. This file owns the one dir="in" signal on it, `body_cmd` (Idle / Lift / Dump / Lower):
// one state, fed by truck.js's selector (window.cleanopenSetCtl) AND by a frame on the bus, and
// leaving through carlito.js's uplink registry. It packs nothing - the body network's out signals
// (`body_bus`, `body_inhibit`, …) have no packer yet, which the coverage check reports as a
// silent flavor rather than a fault.
//
// ── WHERE THE LAYOUT CAME FROM, AND WHERE IT DID NOT ──────────────────────────
// CiA 422's object dictionary - which object a refuse body's command lives in - is members-only,
// so no CiA 422 number appears anywhere in this file. What IS used is CiA 301, the CANopen
// application layer every CANopen device speaks (the same layer canopen.js decodes):
//   - The predefined connection set: RPDO1's COB-ID is 0x200 + node id.
//   - PDO MAPPING IS DEVICE CONFIGURATION. Which object rides which byte of an RPDO is written
//     into the receiving device by whoever commissions the network, so a mapping is a statement
//     about THIS body controller, not a claim about the standard.
//   - An RPDO's event timer is its DEADLINE MONITOR: a receiver expects the PDO again within it.
// So the body controller this side stands in for is DECLARED below, once (CO_BODY_NODE and the
// two after it): node 0x10, RPDO1 byte 0 = the body command in the contract's own enum values, a
// 500 ms deadline. A frame whose byte 0 is not in that enum is not a command this controller
// knows, and is dropped.
//
// A LAPSED DEADLINE DROPS THE COMMAND, which is the contract's own safety rule: Idle and Lower
// both stow the forks because "a body that stayed up when the command dropped would be the unsafe
// design". So a lift is HELD by sending RPDO1 periodically (the TX scheduler's period does it),
// and a single frame lifts for half a second.
//
// THE OWN-ADDRESS RULE (carlito.js's decoder registry) has nothing to filter here: this side
// transmits nothing on the body network, so there is no echo of its own to read back.
//
// INTEGRATION POINTS:
//   index.html / carlito-bridge.html  <script src="cleanopen.js" defer> BEFORE carlito.js
//   truck.js                          its body selector is a view over cleanopenCtl / SetCtl

(function () {
  'use strict';

  const CO_BODY_NODE = 0x10;                   // node id; any of 1-127, chosen, not looked up
  const CO_RPDO1 = 0x200 + CO_BODY_NODE;       // CiA 301 predefined RPDO1 COB-ID -> 0x210
  const CO_RPDO1_DEADLINE_MS = 500;            // the declared RPDO1 event timer

  const bodyEnum = () => {
    const c = window.CARLITO_CONTRACT;
    const s = c && c.signals && c.signals.find(x => x.name === 'body_cmd' && x.dir === 'in');
    return (s && s.enum) || {};
  };

  // { panel, bus, at }: the bus value while its deadline holds, otherwise the panel's. A panel
  // edit clears the bus value. Panel 0 = Idle, the game's own absent-default.
  const coCmd = { body_cmd: { panel: 0, bus: undefined, at: 0 } };
  const coFresh = (r) => r.bus !== undefined && Date.now() - r.at <= CO_RPDO1_DEADLINE_MS;
  const coLive = (r) => coFresh(r) ? r.bus : r.panel;

  function coDecode(frame) {
    if (frame.isExt || frame.isRtr || (frame.id >>> 0) !== CO_RPDO1) return;
    const d = frame.data;
    if (!d || !d.length) return;
    const v = d[0] & 0xFF;
    if (bodyEnum()[v] == null) return;
    coCmd.body_cmd.bus = v;
    coCmd.body_cmd.at = Date.now();
  }

  window.carlitoUplinkDecoders = window.carlitoUplinkDecoders || [];
  window.carlitoUplinkDecoders.push(coDecode);
  window.carlitoUplinkSources = window.carlitoUplinkSources || {};
  Object.assign(window.carlitoUplinkSources, { body_cmd: () => coLive(coCmd.body_cmd) });

  // The panel's view: the live value, and whether a frame is holding it right now.
  window.cleanopenCtl = () => ({ body_cmd: coLive(coCmd.body_cmd), bus: { body_cmd: coFresh(coCmd.body_cmd) } });
  window.cleanopenSetCtl = (p) => {
    if (!p || !('body_cmd' in p)) return;
    const v = Math.round(Number(p.body_cmd));
    if (bodyEnum()[v] == null) return;
    coCmd.body_cmd.panel = v;
    coCmd.body_cmd.bus = undefined;
  };

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.cleanopenSelfTest(). DOM-free, so it also runs under node.
  function cleanopenSelfTest() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
    const saved = Object.assign({}, coCmd.body_cmd);
    const src = () => window.carlitoUplinkSources.body_cmd();
    coCmd.body_cmd.panel = 0; coCmd.body_cmd.bus = undefined;

    eq('RPDO1 COB-ID', CO_RPDO1.toString(16).toUpperCase(), '210');
    eq('the enum comes off the contract', Object.keys(bodyEnum()).length, 4);
    eq('nothing received: the panel', src(), 0);
    coDecode({ id: CO_RPDO1, isExt: false, data: [1] });
    eq('RPDO1 Lift', src(), 1);
    coDecode({ id: CO_RPDO1, isExt: false, data: [9] });
    eq('an unknown command is dropped, the last one stands', src(), 1);
    coDecode({ id: CO_RPDO1 + 1, isExt: false, data: [2] });
    eq('another node\'s RPDO1 is not ours', src(), 1);
    coDecode({ id: CO_RPDO1, isExt: true, data: [2] });
    eq('a 29-bit frame with the same number is not a CANopen PDO', src(), 1);
    coCmd.body_cmd.at = Date.now() - CO_RPDO1_DEADLINE_MS - 1;
    eq('a lapsed deadline drops the command to the panel', src(), 0);
    coDecode({ id: CO_RPDO1, isExt: false, data: [2] });
    window.cleanopenSetCtl({ body_cmd: 3 });
    eq('a panel edit clears the bus value', src(), 3);

    Object.assign(coCmd.body_cmd, saved);
    if (failures.length) console.error('CleANopen self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('CleANopen self-test: all checks passed.');
    return failures;
  }
  window.cleanopenSelfTest = cleanopenSelfTest;
})();
