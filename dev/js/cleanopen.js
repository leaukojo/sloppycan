// ── CleANopen (CiA 422) — the garbage truck's body command ───────────────────
// The contract's `cleanopen` flavor is the one on a SECOND NETWORK: CiA 422 is a CANopen
// body-control network (EN 16815:2019), reaching the J1939 chassis across a CiA 413-6 truck
// gateway. This file owns the one dir="in" signal on it, `body_cmd` (Idle / Lift / Dump / Lower):
// one state, fed by truck.js's selector (window.cleanopenSetCtl) AND by a frame on the bus, and
// leaving through carlito.js's uplink registry. It is also the flavor's PACKER: the body
// controller's state goes out as its TPDO1, with its CiA 301 boot-up and heartbeat (see THE BODY'S
// STATE below). The body network is a second bus behind a gateway on a real truck; here it is
// shown on the same CAN as the chassis.
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
// transmits TPDO1 (0x190) and never the RPDO1 (0x210) it decodes, so its echo is not a command.
// Nor does it ever transmit NMT (0x000), which it also obeys (see NMT below).
//
// INTEGRATION POINTS:
//   index.html / carlito-bridge.html  <script src="cleanopen.js" defer> after carlito-registry.js
//   truck.js                          its body selector is a view over cleanopenCtl / SetCtl

(function () {
  'use strict';

  const CO_BODY_NODE = 0x10;                   // node id; any of 1-127, chosen, not looked up
  const CO_RPDO1 = 0x200 + CO_BODY_NODE;       // CiA 301 predefined RPDO1 COB-ID -> 0x210
  const CO_RPDO1_DEADLINE_MS = 500;            // the declared RPDO1 event timer

  const bodyEnum = () => {
    const s = window.carlitoSig && window.carlitoSig('body_cmd', 'in');
    return (s && s.enum) || {};
  };

  // { panel, bus, at }: the bus value while its deadline holds, otherwise the panel's. A panel
  // edit clears the bus value. Panel 0 = Idle, the game's own absent-default.
  const coCmd = { body_cmd: { panel: 0, bus: undefined, at: 0 } };
  const coFresh = (r) => r.bus !== undefined && Date.now() - r.at <= CO_RPDO1_DEADLINE_MS;
  const coLive = (r) => coFresh(r) ? r.bus : r.panel;

  function coDecode(frame) {
    if (frame.isExt || frame.isRtr || (frame.id >>> 0) !== CO_RPDO1) return;
    if (coNmt !== CO_NMT_OPERATIONAL) return;   // CiA 301: PDOs are processed in Operational only
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

  // ── THE BODY'S STATE (the flavor's out signals) ─────────────────────────────
  // The same body controller's TPDO1: CiA 301's predefined COB-ID 0x180 + node id. Its MAPPING and
  // its event timer are DECLARED DEVICE CONFIGURATION, exactly as RPDO1's are above - CiA 422's
  // objects are members-only, so no CiA 422 number is used. Four bytes, one per contract value
  // (a PDO is as long as its mapping):
  //   byte 0 body_state  (the contract's own enum)   byte 2 body_inhibit (0 / 1)
  //   byte 1 body_pos    (%, 1 per bit)               byte 3 hopper_load  (%, 1 per bit)
  // An absent value carries 0xFF, carlito.js's "not available" byte for an unsigned field.
  //
  // A DOWN BODY NETWORK CARRIES NOTHING. The contract's body_bus is "body network powered and the
  // gateway answering", so while it is false (a firetruck, or the PTO off) no TPDO goes out at all
  // - body_bus rides the frame's PRESENCE, the way dronecan-core.js's node_online does. Sent on
  // carlito.js's slow tick: a 100 ms event timer.
  const CO_TPDO1 = 0x180 + CO_BODY_NODE;       // CiA 301 predefined TPDO1 COB-ID -> 0x190
  // THE NODE'S OWN LIFE SIGNS, so a CANopen listener sees the body network come and go the way
  // CANopen shows it: CiA 301's error-control channel, COB-ID 0x700 + node id, one byte of NMT state
  // (canopen.js decodes the same codes). A boot-up (0x00) when the network comes up, then a heartbeat
  // reading the node's current NMT state every producer heartbeat time, DECLARED here as 1000 ms.
  // When body_bus drops, the heartbeat stops: a consumer's heartbeat timeout is how CANopen itself
  // reports a node gone.
  //
  // NMT (CiA 301, COB-ID 0x000, data [command, node]) is obeyed for node 0x10 and for 0, all
  // nodes - canopen.js's CO_NMT_TO_STATE codes: 0x01 start -> Operational, 0x02 stop -> Stopped,
  // 0x80 -> Pre-operational, 0x81 reset node / 0x82 reset communication -> a fresh boot-up on the
  // next tick. TPDO1 goes out, and RPDO1 is obeyed, in Operational only; the heartbeat runs in every
  // state. AFTER A BOOT-UP THE NODE IS OPERATIONAL AT ONCE, a DECLARED model: a gateway-run body
  // network restarts it, so the NMT master's Start is taken as given rather than waited for -
  // which is also what the body_bus edge and the packer's `reset` do.
  const CO_HEARTBEAT = 0x700 + CO_BODY_NODE;   // -> 0x710
  const CO_NMT_BOOTUP = 0x00, CO_NMT_STOPPED = 0x04, CO_NMT_OPERATIONAL = 0x05, CO_NMT_PREOP = 0x7F;
  const CO_NMT_ID = 0x000;
  const CO_HEARTBEAT_MS = 1000;                // the declared producer heartbeat time
  let coBusUp = false, coHbAt = 0;             // body_bus on the last tick; last heartbeat sent
  let coNmt = CO_NMT_OPERATIONAL;              // the node's NMT state
  function coNmtDecode(frame) {
    if (frame.isExt || frame.isRtr || (frame.id >>> 0) !== CO_NMT_ID) return;
    const d = frame.data;
    if (!d || d.length < 2) return;
    const node = d[1] & 0xFF;
    if (node !== CO_BODY_NODE && node !== 0) return;
    const cmd = d[0] & 0xFF;
    if (cmd === 0x01) coNmt = CO_NMT_OPERATIONAL;
    else if (cmd === 0x02) coNmt = CO_NMT_STOPPED;
    else if (cmd === 0x80) coNmt = CO_NMT_PREOP;
    else if (cmd === 0x81 || cmd === 0x82) coBusUp = false;   // the next tick boots it again
  }
  window.carlitoUplinkDecoders.push(coNmtDecode);
  const coU8 = (t, name) => {
    const v = t[name];
    if (v === undefined || v === null) return 0xFF;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(0xFE, n)) : 0xFF;
  };
  function coPack(t, slow) {
    if (!t || !slow) return [];
    if (!t.body_bus) { coBusUp = false; return []; }
    const out = [];
    const now = Date.now();
    if (!coBusUp) {
      coBusUp = true; coHbAt = now; coNmt = CO_NMT_OPERATIONAL;   // booted, and started (declared above)
      out.push({ id: CO_HEARTBEAT, isExt: false, data: [CO_NMT_BOOTUP] });
    } else if (now - coHbAt >= CO_HEARTBEAT_MS) { coHbAt = now; out.push({ id: CO_HEARTBEAT, isExt: false, data: [coNmt] }); }
    if (coNmt === CO_NMT_OPERATIONAL) out.push({ id: CO_TPDO1, isExt: false,
      data: [coU8(t, 'body_state'), coU8(t, 'body_pos'), coU8(t, 'body_inhibit'), coU8(t, 'hopper_load')] });
    return out;
  }
  window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
  window.carlitoFlavorPackers.push({
    flavor: 'cleanopen',
    signals: ['body_state', 'body_pos', 'body_inhibit', 'body_bus', 'hopper_load'],
    pack: coPack,
    // A bus that just opened (or a link that came back) has not heard the boot-up.
    reset: () => { coBusUp = false; },
  });

  // ── Self-test ───────────────────────────────────────────────────────────────
  // Run from the console: window.cleanopenSelfTest(). DOM-free, so it also runs under node.
  // The command record is snapshotted and put back in a `finally`, so a check that throws cannot
  // leave a test value driving the game.
  function cleanopenSelfTest() {
    const saved = Object.assign({}, coCmd.body_cmd), busUp = coBusUp, hbAt = coHbAt, nmt = coNmt;
    coNmt = CO_NMT_OPERATIONAL;   // the checks start from the default state
    try { return coSelfTestChecks(); }
    finally { Object.assign(coCmd.body_cmd, saved); coBusUp = busUp; coHbAt = hbAt; coNmt = nmt; }
  }
  function coSelfTestChecks() {
    const failures = [];
    const eq = (what, got, want) => {
      const g = JSON.stringify(got), w = JSON.stringify(want);
      if (g !== w) failures.push(what + ': got ' + g + ', want ' + w);
    };
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

    // TPDO1: the four mapped bytes, the body_bus gate, the slow tick, and "not available". The
    // first tick with the network up carries the boot-up first; the heartbeat clock is then pinned
    // so the checks after it see the TPDO alone.
    const tp = (t, slow) => coPack(t, slow === undefined ? true : slow).map(f => [f.id, f.data.join(',')]);
    eq('TPDO1 COB-ID', CO_TPDO1.toString(16).toUpperCase(), '190');
    coBusUp = false;
    eq('the network coming up boots the node, then TPDO1',
      tp({ body_bus: true, body_state: 2, body_pos: 40, body_inhibit: false, hopper_load: 35 }),
      [[0x710, '0'], [0x190, '2,40,0,35']]);
    eq('TPDO1 bytes', tp({ body_bus: true, body_state: 2, body_pos: 40, body_inhibit: false, hopper_load: 35 }),
      [[0x190, '2,40,0,35']]);
    coHbAt = Date.now() - CO_HEARTBEAT_MS;
    eq('a heartbeat, Operational, once a heartbeat time', tp({ body_bus: true })[0], [0x710, '5']);
    coHbAt = Date.now();
    eq('a down body network sends nothing', tp({ body_bus: false, body_state: 0, body_pos: 0 }), []);
    eq('no body_bus statement sends nothing', tp({ body_state: 0 }), []);
    eq('only on the slow tick', tp({ body_bus: true, body_state: 1 }, false), []);
    coBusUp = true; coHbAt = Date.now();   // the network up, with a fresh heartbeat
    eq('absent fields are not available', tp({ body_bus: true, body_inhibit: true }), [[0x190, '255,255,1,255']]);

    // NMT: stop silences TPDO1 and the RPDO, the heartbeat reports Stopped; start brings both back;
    // a reset boots the node again. A command for another node changes nothing.
    const nmt = (cmd, node) => coNmtDecode({ id: 0x000, isExt: false, isRtr: false, data: [cmd, node] });
    const up = { body_bus: true, body_state: 1, body_pos: 10, body_inhibit: false, hopper_load: 0 };
    nmt(0x02, 0x11);
    eq('NMT for another node is not ours', tp(up), [[0x190, '1,10,0,0']]);
    nmt(0x02, CO_BODY_NODE);
    eq('stopped: no TPDO1', tp(up), []);
    coHbAt = Date.now() - CO_HEARTBEAT_MS;
    eq('stopped: the heartbeat reads 0x04', tp(up), [[0x710, '4']]);
    window.cleanopenSetCtl({ body_cmd: 0 });
    coDecode({ id: 0x210, isExt: false, isRtr: false, data: [1] });
    eq('stopped: RPDO1 is not obeyed', src(), 0);
    nmt(0x01, 0);
    eq('start (all nodes): TPDO1 again', tp(up), [[0x190, '1,10,0,0']]);
    coDecode({ id: 0x210, isExt: false, isRtr: false, data: [1] });
    eq('operational: RPDO1 obeyed', src(), 1);
    nmt(0x80, CO_BODY_NODE);
    coHbAt = Date.now() - CO_HEARTBEAT_MS;
    eq('pre-operational: heartbeat 0x7F, no TPDO1', tp(up), [[0x710, '127']]);
    nmt(0x81, CO_BODY_NODE);
    eq('reset node: boot-up again, then Operational', tp(up), [[0x710, '0'], [0x190, '1,10,0,0']]);

    if (failures.length) console.error('CleANopen self-test: ' + failures.length + ' failure(s)\n' + failures.join('\n'));
    else console.log('CleANopen self-test: all checks passed.');
    return failures;
  }
  window.cleanopenSelfTest = cleanopenSelfTest;
})();
