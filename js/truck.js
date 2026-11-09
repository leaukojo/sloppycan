// ── Truck dashboard ─────────────────────────────────────────────────────────
// One floating window, following the Carlito link through vehicle-panel.js. Takes 'dash':
// a truck is driven with the RAMN controls, so it replaces the cluster and the Control Panel
// keeps driving. Claims no uplink signal and owns none: its Commands section is a view over the
// modules that do - isobus.js (pto), cleanopen.js (body_cmd), j1939-flavor.js (retarder).
//
// TELEMETRY ONLY, like boat.js: every instrument is the game's own publish, never
// window.ramnGetState() (what sloppyCAN COMMANDS - and blank under J1939 traffic, which is exactly
// when a truck is on the link). It shows the engine block, the air reservoirs against their
// low-pressure warn, the retarder and brake temperature, the drive-axle load, the trailer (ISO
// 11992) and the refuse body (CiA 422), and the status bits a truck sets. Ranges, warn levels and
// enum labels all come off the contract through vehiclePanelUtil.
//
// Integration: index.html (script after vehicle-panel.js; #truckBtn ships style="display:none",
// vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list). Live-only.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
/* Commands: views over the modules that own them (isobus.js, j1939-flavor.js, cleanopen.js) */
.truck-ctl-cap { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:8px; }
.truck-ctl-cap .bus-key { color:var(--amber); letter-spacing:.06em; }
.truck-ctl-row { display:flex; align-items:center; gap:6px; margin-bottom:7px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); }
.truck-ctl-row .lbl { width:52px; flex-shrink:0; }
.truck-ctl-row input[type=range] { flex:1; min-width:0; }
.truck-ctl-row .v { font-family:var(--mono); color:var(--text); letter-spacing:0; width:44px; text-align:right; flex-shrink:0; }
.truck-ctl-row button {
  padding:4px 7px; font-size:10px; font-family:var(--sans); text-transform:uppercase; letter-spacing:.06em;
  color:var(--text2); background:var(--bg); border:1px solid var(--border); border-radius:6px; cursor:pointer;
}
.truck-ctl-row button.on { color:var(--green); border-color:var(--green); background:var(--green-dim); }
.truck-ctl .bus { outline:1px solid var(--amber); outline-offset:1px; }
.truck-gap { margin-top:7px; }
.truck-inhib { display:flex; align-items:center; justify-content:center; }
`;
  document.head.appendChild(style);

  const { enumLabel, num, fmt, whole, setTell, setBar } = window.vehiclePanelUtil;

  // contract `status`, whose bit layout is FROZEN (its desc): the bits a truck sets.
  const ST = { ign: 0, moving: 2, park: 5, lights: 6, brkLamp: 8, escOff: 9, yaw: 10, roll: 11 };

  // ── Panel body ──────────────────────────────────────────────────────────────
  const BODY = `
    <div class="vp-chips">
      <div class="vp-chip" id="truckChipGear" title="contract gear - the gear actually ENGAGED, off the contract's enum (N, P, R, D1-D24). Its gear_ratio is the Ratio readout below."><span class="cap">Gear</span><span class="val" id="truckGear">&ndash;</span></div>
      <div class="vp-chip" title="contract kmh - road speed."><span class="cap">Road speed</span><span class="val" id="truckKmh">&ndash;</span></div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="The engine block. Every bar carries the contract's own range and warn threshold - the same numbers the game's own cluster colours on."><span>Engine</span></div>
    <div class="vp-bars n2">
      <div class="vp-bar-row" title="contract rpm - engine speed, red past the contract's warn.">
        <div class="vp-bar-head"><span>RPM</span><span class="v" id="truckRpmV">&ndash;</span></div>
        <div class="vp-bar" id="truckRpmBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract engine_load - actual engine torque as a percent of the peak (J1939 SPN 513-like, EEC1).">
        <div class="vp-bar-head"><span>Load</span><span class="v" id="truckLoadV">&ndash;</span></div>
        <div class="vp-bar" id="truckLoadBar"><i></i></div>
      </div>
    </div>
    <div class="vp-bars n3 truck-gap">
      <div class="vp-bar-row" title="contract fuel - tank level, red at the contract's low-fuel warn.">
        <div class="vp-bar-head"><span>Fuel</span><span class="v" id="truckFuelV">&ndash;</span></div>
        <div class="vp-bar" id="truckFuelBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract coolant - coolant temperature, red past the contract's overheat warn.">
        <div class="vp-bar-head"><span>Coolant</span><span class="v" id="truckCoolV">&ndash;</span></div>
        <div class="vp-bar" id="truckCoolBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract battery - terminal voltage, red below the contract's low warn.">
        <div class="vp-bar-head"><span>Battery</span><span class="v" id="truckBattV">&ndash;</span></div>
        <div class="vp-bar" id="truckBattBar"><i></i></div>
      </div>
    </div>
    <div class="vp-reads truck-gap">
      <div class="vp-read" title="contract fuel_rate in L/h. Range-less by contract, so it gets a number and not a bar."><span class="cap">Burn L/h</span><span class="val" id="truckBurn">&ndash;</span></div>
      <div class="vp-read" title="contract gear_ratio - the gearbox's input speed over its output (J1939 SPN 526), read out of the sim. 0 in N or P, which reads as no ratio here."><span class="cap">Ratio</span><span class="val" id="truckRatio">&ndash;</span></div>
      <div class="vp-read" title="contract engine_hours - the hour meter (J1939 SPN 247, on request)."><span class="cap">Hours</span><span class="val" id="truckHours">&ndash;</span></div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="The air brakes and the endurance brake. The two air circuits turn red AT their contract warn, a LOW-side threshold: the low-pressure warning, which sits above the point where the spring brakes apply."><span>Brakes</span></div>
    <div class="vp-bars n2">
      <div class="vp-bar-row" title="contract air_primary - service brake air pressure, circuit 1 (J1939 SPN 1087).">
        <div class="vp-bar-head"><span>Air 1</span><span class="v" id="truckAir1V">&ndash;</span></div>
        <div class="vp-bar" id="truckAir1Bar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract air_secondary - service brake air pressure, circuit 2 (J1939 SPN 1088).">
        <div class="vp-bar-head"><span>Air 2</span><span class="v" id="truckAir2V">&ndash;</span></div>
        <div class="vp-bar" id="truckAir2Bar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract retarder_state - retarder torque as actually APPLIED, a magnitude (J1939 SPN 520 is the same number negated).">
        <div class="vp-bar-head"><span>Retarder</span><span class="v" id="truckRetV">&ndash;</span></div>
        <div class="vp-bar" id="truckRetBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract brake_temp - service brake temperature, red past the contract's fade warn.">
        <div class="vp-bar-head"><span>Brake temp</span><span class="v" id="truckBtV">&ndash;</span></div>
        <div class="vp-bar" id="truckBtBar"><i></i></div>
      </div>
    </div>
    <div class="vp-bar-row truck-gap" title="contract axle_load - drive-axle load (J1939 SPN 582, PGN 65258 on request), red past the contract's warn.">
      <div class="vp-bar-head"><span>Drive axle</span><span class="v" id="truckAxleV">&ndash;</span></div>
      <div class="vp-bar" id="truckAxleBar"><i></i></div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="contract trailer_connected - a trailer on the ISO 11992 data pair. Bobtail, every trailer signal reads a real 0 / false, so the group is greyed rather than blanked."><span>Trailer</span><span class="v" id="truckTrlr">&ndash;</span></div>
    <div id="truckTrlrGrp">
      <div class="vp-bars n2">
        <div class="vp-bar-row" title="contract trailer_axle_load - the towed unit's axle load, read out of the sim the same way as the tractor's. Red past the contract's warn.">
          <div class="vp-bar-head"><span>Axle</span><span class="v" id="truckTAxleV">&ndash;</span></div>
          <div class="vp-bar" id="truckTAxleBar"><i></i></div>
        </div>
        <div class="vp-bar-row" title="contract trailer_brake_demand - the braking demand SENT to the trailer (ISO 11992-2 EBS11). Not the retarder, which a trailer's service brakes may not compensate.">
          <div class="vp-bar-head"><span>Brake demand</span><span class="v" id="truckTBrkV">&ndash;</span></div>
          <div class="vp-bar" id="truckTBrkBar"><i></i></div>
        </div>
      </div>
      <div class="vp-tells truck-gap">
        <div class="vp-tell" id="truckTellTAbs" data-color="amber" title="contract trailer_abs - the trailer's own anti-lock holding a wheel back (ISO 11992-2 EBS22).">ABS</div>
        <div class="vp-tell" id="truckTellTVdc" data-color="red" title="contract trailer_vdc - the trailer's own roll-over control braking (ISO 11992-2 EBS21). The one stability signal still able to light with the tractor's ESC off.">VDC</div>
      </div>
    </div>

    <div id="truckBodySec">
      <div class="vp-rule"></div>
      <div class="vp-sec-lbl" title="contract body_bus - the refuse body's CiA 422 network powered and the gateway answering. It runs off the PTO, so it is down with the PTO out - and a truck with no body reads the same, since the game publishes the body's signals on every truck. While it is down cleanopen.js sends nothing, and the group is greyed."><span>Refuse body</span><span class="v" id="truckBodyBus">&ndash;</span></div>
      <div id="truckBodyGrp">
        <div class="vp-chips">
          <div class="vp-chip" id="truckChipBody" title="contract body_state - the arm's state, off the contract's enum. Amber while it is not stowed."><span class="cap">State</span><span class="val" id="truckBodyState">&ndash;</span></div>
          <div class="vp-tell truck-inhib" id="truckTellInhib" data-color="amber" title="contract body_inhibit - the chassis-side interlock (road speed, PTO, parking brake) refusing every body command. Suppressed while the body network is down, the game's own rule: a body with no network cannot be refused a command.">Inhibit</div>
        </div>
        <div class="vp-bars n2 truck-gap">
          <div class="vp-bar-row" title="contract body_pos - the arm's position, read back off the rig.">
            <div class="vp-bar-head"><span>Arm</span><span class="v" id="truckArmV">&ndash;</span></div>
            <div class="vp-bar" id="truckArmBar"><i></i></div>
          </div>
          <div class="vp-bar-row" title="contract hopper_load - how full the hopper is.">
            <div class="vp-bar-head"><span>Hopper</span><span class="v" id="truckHopV">&ndash;</span></div>
            <div class="vp-bar" id="truckHopBar"><i></i></div>
          </div>
        </div>
      </div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-tells">
      <div class="vp-tell" id="truckTellIgn" data-color="green" title="contract status bit 0 - ignition.">Ign</div>
      <div class="vp-tell" id="truckTellPark" data-color="red" title="contract status bit 5 - handbrake.">Park</div>
      <div class="vp-tell" id="truckTellLights" data-color="blue" title="contract status bit 6 - headlights at LOW or brighter.">Lights</div>
      <div class="vp-tell" id="truckTellBrk" data-color="red" title="contract status bit 8 - brake-light request from roll stability's own braking (J1939 VDC1 SPN 1815 on a truck).">Brk lamp</div>
      <div class="vp-tell" id="truckTellYaw" data-color="amber" title="contract status bit 10 - the yaw controller braking (J1939 VDC1 YC, SPNs 1817/1819).">Yaw ctl</div>
      <div class="vp-tell" id="truckTellRoll" data-color="amber" title="contract status bit 11 - roll stability braking (J1939 VDC1 ROP, SPNs 1816/1818).">Roll ctl</div>
      <div class="vp-tell" id="truckTellEsc" data-color="amber" title="contract status bit 9 - a fitted stability control switched off (esc_off; VDC1 SPN 1814).">ESC off</div>
      <div class="vp-tell" id="truckTellMove" data-color="green" title="contract status bit 2 - moving.">Moving</div>
    </div>

    <div class="vp-rule"></div>
    <div class="truck-ctl" title="The truck's commands, sent to Carlito over the uplink. Each is owned by the module for its bus, and the PTO and body command are also read off the bus: while a frame is holding one it is ringed amber, and touching the control takes it back. The trailer lamps are injected from the J1939 tab, beside the DM1 lamps.">
      <div class="truck-ctl-cap"><span>Commands</span><span class="bus-key">amber = held by the bus</span></div>
      <div class="truck-ctl-row">
        <span class="lbl">PTO</span>
        <button id="truckCtlPto" title="contract pto - the chassis PTO that drives the body. Shared with the tractor and owned with it by isobus.js. Bus: PGN 65090 SPN 1894.">Engage</button>
      </div>
      <div class="truck-ctl-row" title="contract body_cmd - the refuse body command on the CiA 422 body network (cleanopen.js). Bus: CANopen RPDO1 of body node 0x10 (COB-ID 0x210), byte 0, held only while it keeps arriving.">
        <span class="lbl">Body</span><span id="truckCtlBody"></span>
      </div>
      <div class="truck-ctl-row" title="contract retarder - driveline retarder request, 0 released (j1939-flavor.js). Panel only: its J1939 carrier (TSC1 to the retarder) has no decoder here yet.">
        <span class="lbl">Retarder</span><input type="range" id="truckCtlRet" min="0" max="100" value="0"><span class="v" id="truckCtlRetV">0%</span>
      </div>
    </div>
`;

  // ── The panel ───────────────────────────────────────────────────────────────
  let el = {};
  const panel = window.makeVehiclePanel({
    id: 'truck', family: 'truck', label: 'truck',
    variant: 'semi',                  // VehicleCatalog.VARIANTS id, not the family
    btn: 'truckBtn', takes: 'dash', follow: true,
    cssPrefix: 'truck', title: 'Truck dashboard', baseW: 320,
    headerTip: "The truck's instruments, read off the game's own publish at ~20 Hz. Opens by itself when a truck appears on the Carlito link and takes the RAMN dashboard's place while it is up; the RAMN Control Panel stays, because a truck is driven with the same pedals and gearbox. Drag to move, grip the bottom-right corner to resize.",
    bodyHtml: BODY,
    render: (t) => render(t || {}),
  });
  const markDirty = panel.markDirty;

  // ── Render ──────────────────────────────────────────────────────────────────
  // `t` is {} with no truck on the link: the resting panel, not the last one's readings frozen.
  function render(t) {
    const gear = num(t.gear);
    el.gear.textContent = enumLabel('gear', gear);
    el.chipGear.classList.toggle('on', gear === 255);          // R, the contract's 0xFF
    el.kmh.textContent = whole(num(t.kmh), ' km/h');

    // ── Engine ──
    setBar(el.rpmBar, el.rpmV, 'rpm', num(t.rpm), 0);
    setBar(el.loadBar, el.loadV, 'engine_load', num(t.engine_load), 0, '%');
    setBar(el.fuelBar, el.fuelV, 'fuel', num(t.fuel), 0, '%');
    setBar(el.coolBar, el.coolV, 'coolant', num(t.coolant), 0, '°C');
    setBar(el.battBar, el.battV, 'battery', num(t.battery), 1, ' V');
    el.burn.textContent = fmt(num(t.fuel_rate), 1);
    const ratio = num(t.gear_ratio);
    el.ratio.textContent = ratio > 0 ? ratio.toFixed(2) : (Number.isFinite(ratio) ? 'none' : '–');
    el.hours.textContent = fmt(num(t.engine_hours), 1);

    // ── Brakes ──
    setBar(el.air1Bar, el.air1V, 'air_primary', num(t.air_primary), 1, ' bar');
    setBar(el.air2Bar, el.air2V, 'air_secondary', num(t.air_secondary), 1, ' bar');
    setBar(el.rtdBar, el.rtdV, 'retarder_state', num(t.retarder_state), 0, '%');
    setBar(el.btBar, el.btV, 'brake_temp', num(t.brake_temp), 0, '°C');
    setBar(el.axleBar, el.axleV, 'axle_load', num(t.axle_load), 0, ' kg');

    // ── Trailer ──
    const trlr = t.trailer_connected;
    el.trlr.textContent = trlr === undefined ? '–' : (trlr ? 'connected' : 'bobtail');
    el.trlr.classList.toggle('on', !!trlr);
    el.trlrGrp.classList.toggle('vp-dim', trlr !== undefined && !trlr);
    setBar(el.tAxleBar, el.tAxleV, 'trailer_axle_load', num(t.trailer_axle_load), 0, ' kg');
    setBar(el.tBrkBar, el.tBrkV, 'trailer_brake_demand', num(t.trailer_brake_demand), 0, '%');
    setTell(el.tAbs, t.trailer_abs);
    setTell(el.tVdc, t.trailer_vdc);

    // ── Refuse body ── (hidden only for a payload that carries none of it, e.g. an older game)
    const hasBody = ['body_state', 'body_pos', 'body_inhibit', 'body_bus', 'hopper_load'].some(k => k in t);
    el.bodySec.classList.toggle('vp-hidden', !hasBody);
    if (hasBody) {
      const bus = t.body_bus;
      el.bodyBus.textContent = bus === undefined ? '–' : (bus ? 'bus up' : 'network down');
      el.bodyBus.classList.toggle('on', !!bus);
      el.bodyGrp.classList.toggle('vp-dim', bus !== undefined && !bus);
      const bs = num(t.body_state);
      el.bodyState.textContent = enumLabel('body_state', bs);
      el.chipBody.classList.toggle('on', Number.isFinite(bs) && bs !== 0);
      setTell(el.inhib, t.body_inhibit && bus !== false);
      setBar(el.armBar, el.armV, 'body_pos', num(t.body_pos), 0, '%');
      setBar(el.hopBar, el.hopV, 'hopper_load', num(t.hopper_load), 0, '%');
    }

    // ── Tell-tales ──
    const st = num(t.status) | 0;
    const bit = (b) => !!(st & (1 << b));
    setTell(el.tIgn, bit(ST.ign));
    setTell(el.tPark, bit(ST.park));
    setTell(el.tLights, bit(ST.lights));
    setTell(el.tBrk, bit(ST.brkLamp));
    setTell(el.tYaw, bit(ST.yaw));
    setTell(el.tRoll, bit(ST.roll));
    setTell(el.tEsc, bit(ST.escOff));
    setTell(el.tMove, bit(ST.moving));

    renderCtl();
  }

  // ── Commands ────────────────────────────────────────────────────────────────
  // A view over the modules that own the truck's commands: the PTO is isobus.js's (shared with
  // the tractor), the body command cleanopen.js's, the retarder j1939-flavor.js's. The first two
  // are also read off the bus - a control a frame is holding right now is ringed amber, and
  // touching it takes it back. Rendered with the instruments, on the telemetry push and after
  // every click.
  const ctl = () => ({
    ib: window.isobusCtl ? window.isobusCtl() : null,
    co: window.cleanopenCtl ? window.cleanopenCtl() : null,
    jf: window.j1939FlavorCtl ? window.j1939FlavorCtl() : null,
  });
  const setCtl = (fn, p) => { if (window[fn]) window[fn](p); markDirty(); };
  function renderCtl() {
    const c = ctl();
    if (c.ib) { el.pto.classList.toggle('on', !!c.ib.pto); el.pto.classList.toggle('bus', c.ib.bus.pto); }
    if (c.co) {
      for (const b of el.body.querySelectorAll('button')) {
        const on = Number(b.dataset.body) === c.co.body_cmd;
        b.classList.toggle('on', on);
        b.classList.toggle('bus', on && c.co.bus.body_cmd);
      }
    }
    if (c.jf) {
      if (document.activeElement !== el.ret) el.ret.value = c.jf.retarder;
      el.retV.textContent = c.jf.retarder + '%';
    }
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    const q = panel.q;
    el = {
      chipGear: q('truckChipGear'), gear: q('truckGear'), kmh: q('truckKmh'),
      rpmBar: q('truckRpmBar'), rpmV: q('truckRpmV'), loadBar: q('truckLoadBar'), loadV: q('truckLoadV'),
      fuelBar: q('truckFuelBar'), fuelV: q('truckFuelV'), coolBar: q('truckCoolBar'), coolV: q('truckCoolV'),
      battBar: q('truckBattBar'), battV: q('truckBattV'),
      burn: q('truckBurn'), ratio: q('truckRatio'), hours: q('truckHours'),
      air1Bar: q('truckAir1Bar'), air1V: q('truckAir1V'), air2Bar: q('truckAir2Bar'), air2V: q('truckAir2V'),
      rtdBar: q('truckRetBar'), rtdV: q('truckRetV'), btBar: q('truckBtBar'), btV: q('truckBtV'),
      axleBar: q('truckAxleBar'), axleV: q('truckAxleV'),
      trlr: q('truckTrlr'), trlrGrp: q('truckTrlrGrp'),
      tAxleBar: q('truckTAxleBar'), tAxleV: q('truckTAxleV'), tBrkBar: q('truckTBrkBar'), tBrkV: q('truckTBrkV'),
      tAbs: q('truckTellTAbs'), tVdc: q('truckTellTVdc'),
      bodySec: q('truckBodySec'), bodyBus: q('truckBodyBus'), bodyGrp: q('truckBodyGrp'),
      chipBody: q('truckChipBody'), bodyState: q('truckBodyState'), inhib: q('truckTellInhib'),
      armBar: q('truckArmBar'), armV: q('truckArmV'), hopBar: q('truckHopBar'), hopV: q('truckHopV'),
      tIgn: q('truckTellIgn'), tPark: q('truckTellPark'), tLights: q('truckTellLights'), tBrk: q('truckTellBrk'),
      tYaw: q('truckTellYaw'), tRoll: q('truckTellRoll'), tEsc: q('truckTellEsc'), tMove: q('truckTellMove'),
      pto: q('truckCtlPto'), body: q('truckCtlBody'), ret: q('truckCtlRet'), retV: q('truckCtlRetV'),
    };

    // The body command's positions come off the CONTRACT's enum rather than being typed here.
    const bodySig = window.vehiclePanelUtil.sigDef('body_cmd', 'in');
    for (const [v, name] of Object.entries((bodySig && bodySig.enum) || {})) {
      const b = document.createElement('button');
      b.dataset.body = v;
      b.textContent = name;
      b.addEventListener('click', () => setCtl('cleanopenSetCtl', { body_cmd: Number(v) }));
      el.body.appendChild(b);
    }
    el.pto.addEventListener('click', () => { const c = ctl().ib; setCtl('isobusSetCtl', { pto: c && c.pto ? 0 : 1 }); });
    el.ret.addEventListener('input', () => setCtl('j1939FlavorSetCtl', { retarder: +el.ret.value }));
  })();

  window.truckToggle = panel.toggle;
})();
