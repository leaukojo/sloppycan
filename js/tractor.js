// ── Tractor dashboard ─────────────────────────────────────────────────────────
// One floating window, following the Carlito link through vehicle-panel.js. Takes 'dash':
// a tractor is driven with the RAMN controls, so it replaces the cluster and the Control panel
// keeps driving. Claims no uplink signal and owns none: its commands are a section of the
// Control panel (vehiclePanelSection), a view over isobus.js, which owns the tractor's eight
// commands and also reads them off the bus.
//
// TELEMETRY ONLY, like boat.js: every instrument is the game's own publish, never
// window.ramnGetState() (what sloppyCAN COMMANDS - and blank under ISO 11783 traffic, which is
// exactly when a tractor is on the link). It shows traction as a PAIR whose gap is the reading -
// wheel_speed against ground_speed, the excess shaded as slip beside the game's own wheel_slip -
// then the hitch, draft and PTO, the implement off its address-claim device class, the diff lock
// and MFWD states, and the engine block. Ranges, warn levels and enum labels all come off the
// contract through vehiclePanelUtil.
//
// Integration: index.html (script after vehicle-panel.js; #tractorBtn ships style="display:none",
// vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list). Live-only.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
/* Traction: wheel against ground on one scale, the wheel's excess shaded as slip */
.tractor-pair { display:grid; grid-template-columns:44px 1fr 60px; gap:5px 6px; align-items:center;
  font-size:var(--fs-s); text-transform:uppercase; letter-spacing:.06em; color:var(--text2); }
.tractor-pair .v { font-family:var(--mono); font-size:var(--fs-s); color:var(--text); letter-spacing:0; text-align:right; text-transform:none; }
.tractor-slip { position:relative; }
.tractor-slip > i { position:absolute; top:0; bottom:0; left:0; }
.tractor-slip > i.gap { background:var(--amber); border-radius:0; transition:left .12s linear, width .12s linear; }
.tractor-slip.over > i.gap { background:var(--red); }
.tractor-gap { margin-top:7px; }

/* Commands (the Control panel section): views over isobus.js, which owns them */
.tractor-ctl-cap { display:flex; justify-content:space-between; font-size:var(--fs-s); text-transform:uppercase; letter-spacing:.14em; color:var(--text2); margin-bottom:8px; }
.tractor-ctl-row { display:flex; align-items:center; gap:6px; margin-bottom:7px; font-size:var(--fs-s); text-transform:uppercase; letter-spacing:.06em; color:var(--text2); }
.tractor-ctl-row .lbl { width:52px; flex-shrink:0; }
.tractor-ctl-row input[type=range] { flex:1; min-width:0; }
.tractor-ctl-row .v { font-family:var(--mono); color:var(--text); letter-spacing:0; width:44px; text-align:right; flex-shrink:0; }
.tractor-ctl-row button {
  padding:4px 7px; font-size:var(--fs-s); font-family:var(--sans); text-transform:uppercase; letter-spacing:.06em;
  color:var(--text2); background:var(--bg); border:1px solid var(--border); border-radius:0; cursor:pointer;
}
.tractor-ctl-row button.on { color:var(--green); border-color:var(--green); background:var(--green-dim); }
.tractor-ctl .bus { outline:1px solid var(--amber); outline-offset:1px; }
`;
  document.head.appendChild(style);

  const { rangeOf, isWarn, enumLabel, num, fmt, whole, setTell, setBar } = window.vehiclePanelUtil;

  // contract `status` masks, from its `bits` table: the bits a tractor sets.
  const stBit = (b) => window.carlitoBit('status', b);
  const ST = { ign: stBit('ignition'), park: stBit('handbrake'), lights: stBit('headlights'), stab: stBit('esc') };

  // ── Panel body ──────────────────────────────────────────────────────────────
  const BODY = `
    <div class="vp-chips">
      <div class="vp-chip" id="tractorChipGear" title="contract gear - the gear actually ENGAGED, off the contract's enum (N, P, R, D1-D24). On the CVT a D byte is the mechanical range; the live ratio is the Ratio readout below."><span class="cap">Gear</span><span class="val" id="tractorGear">&ndash;</span></div>
      <div class="vp-chip" id="tractorChipImpl" title="contract implement_connected / implement_type - what is on the hitch, by the ISO 11783-1 device class its address claim (PGN 60928) reports, labelled off the contract's enum. A class the enum does not name reads as its number."><span class="cap">Implement</span><span class="val" id="tractorImpl">&ndash;</span></div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="contract wheel_speed against contract ground_speed on ONE scale. The shaded run past the ground bar is the wheels turning faster than the tractor is travelling - the gap IS the slip. The figure on the right is the game's own wheel_slip (unpackable on CAN: no SPN carries it), red past its digging-in warn."><span>Traction</span><span class="v" id="tractorSlip">&ndash;</span></div>
    <div class="tractor-pair">
      <span title="contract wheel_speed - speed off the driven wheels (J1939 WBSD, PGN 65096).">Wheel</span>
      <div class="vp-bar tractor-slip" id="tractorWheelBar"><i class="b"></i><i class="gap"></i></div>
      <span class="v" id="tractorWheelV">&ndash;</span>
      <span title="contract ground_speed - true speed over the ground (J1939 GBSD, PGN 65097).">Ground</span>
      <div class="vp-bar" id="tractorGroundBar"><i></i></div>
      <span class="v" id="tractorGroundV">&ndash;</span>
    </div>
    <div class="vp-tells tractor-gap">
      <div class="vp-tell" id="tractorTellDiff" data-color="green" title="contract diff_lock_state - the rear differential lock as actually engaged.">Diff lock</div>
      <div class="vp-tell" id="tractorTellFwd" data-color="green" title="contract fwd_drive_state - MFWD (front-axle drive) as actually engaged.">MFWD</div>
      <div class="vp-tell" id="tractorTellPto" data-color="green" title="contract pto_state - the rear PTO as actually engaged.">PTO</div>
      <div class="vp-tell" id="tractorTellSlip" data-color="red" title="contract wheel_slip against its own warn - digging in.">Slip</div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="The three-point hitch and the PTO, all read back off the sim (ISO 11783-7 RHS and RPTO)."><span>Hitch &amp; PTO</span></div>
    <div class="vp-bars n2">
      <div class="vp-bar-row" title="contract hitch_pos_actual - where the rear hitch IS, 0 lowered (working) to 100 raised (transport). The Hitch slider below is the request.">
        <div class="vp-bar-head"><span>Hitch</span><span class="v" id="tractorHitchV">&ndash;</span></div>
        <div class="vp-bar" id="tractorHitchBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract draft_force - the implement's rearward pull in the soil, a percentage of rated draft. A real force at the hitch point: engine load, rpm sag and slip move because of it. 0 out of the soil.">
        <div class="vp-bar-head"><span>Draft</span><span class="v" id="tractorDraftV">&ndash;</span></div>
        <div class="vp-bar" id="tractorDraftBar"><i></i></div>
      </div>
    </div>
    <div class="vp-bar-row tractor-gap" title="contract pto_rpm - rear PTO shaft speed, across the contract's range.">
      <div class="vp-bar-head"><span>PTO shaft</span><span class="v" id="tractorPtoV">&ndash;</span></div>
      <div class="vp-bar" id="tractorPtoBar"><i></i></div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-sec-lbl" title="The engine block. Every bar carries the contract's own range and warn threshold."><span>Engine</span></div>
    <div class="vp-bars n2">
      <div class="vp-bar-row" title="contract rpm - engine speed, red past the contract's warn.">
        <div class="vp-bar-head"><span>RPM</span><span class="v" id="tractorRpmV">&ndash;</span></div>
        <div class="vp-bar" id="tractorRpmBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract engine_load - actual engine torque as a percent of the peak (J1939 SPN 513-like, EEC1). Draft drives it.">
        <div class="vp-bar-head"><span>Load</span><span class="v" id="tractorLoadV">&ndash;</span></div>
        <div class="vp-bar" id="tractorLoadBar"><i></i></div>
      </div>
    </div>
    <div class="vp-bars n3 tractor-gap">
      <div class="vp-bar-row" title="contract fuel - tank level, red at the contract's low-fuel warn.">
        <div class="vp-bar-head"><span>Fuel</span><span class="v" id="tractorFuelV">&ndash;</span></div>
        <div class="vp-bar" id="tractorFuelBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract coolant - coolant temperature, red past the contract's overheat warn.">
        <div class="vp-bar-head"><span>Coolant</span><span class="v" id="tractorCoolV">&ndash;</span></div>
        <div class="vp-bar" id="tractorCoolBar"><i></i></div>
      </div>
      <div class="vp-bar-row" title="contract battery - terminal voltage, red below the contract's low warn.">
        <div class="vp-bar-head"><span>Battery</span><span class="v" id="tractorBattV">&ndash;</span></div>
        <div class="vp-bar" id="tractorBattBar"><i></i></div>
      </div>
    </div>
    <div class="vp-reads tractor-gap">
      <div class="vp-read" title="contract fuel_rate in L/h (J1939 LFE1 SPN 183). Range-less by contract, so it gets a number and not a bar."><span class="cap">Burn L/h</span><span class="val" id="tractorBurn">&ndash;</span></div>
      <div class="vp-read" title="contract gear_ratio - the gearbox's input speed over its output (J1939 SPN 526). On the CVT it moves continuously; 0 in N or P, which reads as no ratio here."><span class="cap">Ratio</span><span class="val" id="tractorRatio">&ndash;</span></div>
      <div class="vp-read" title="contract engine_hours - the hour meter (J1939 SPN 247, on request)."><span class="cap">Hours</span><span class="val" id="tractorHours">&ndash;</span></div>
    </div>
    <div class="vp-bar-row tractor-gap" title="contract axle_load - drive-axle load (J1939 SPN 582, PGN 65258 on request), red past the contract's warn.">
      <div class="vp-bar-head"><span>Drive axle</span><span class="v" id="tractorAxleV">&ndash;</span></div>
      <div class="vp-bar" id="tractorAxleBar"><i></i></div>
    </div>

    <div class="vp-rule"></div>
    <div class="vp-tells">
      <div class="vp-tell" id="tractorTellIgn" data-color="green" title="contract status bit 'ignition'.">Ign</div>
      <div class="vp-tell" id="tractorTellPark" data-color="red" title="contract status bit 'handbrake'.">Park</div>
      <div class="vp-tell" id="tractorTellLights" data-color="blue" title="contract status bit 'headlights' - at LOW or brighter.">Lights</div>
      <div class="vp-tell" id="tractorTellStab" data-color="amber" title="contract status bit 'esc' - stability control acting.">Stab</div>
    </div>

`;

  // ── Commands: a section of the Control panel ─────────────────────────────────
  const CTL = `
    <div class="tractor-ctl" title="The tractor's commands, sent to Carlito over the uplink. isobus.js owns them and ALSO reads the real ISO 11783-7 command frames off the bus (65090 hitch/PTO, 44288 guidance, 65072 aux valve 0): while a frame is holding one it is ringed amber, and touching the control takes it back.">
      <div class="tractor-ctl-cap"><span>Tractor commands</span></div>
      <div class="tractor-ctl-row" title="contract hitch_pos - requested rear hitch position, 0 lowered (working) to 100 raised (transport). Bus: PGN 65090 SPN 1875.">
        <span class="lbl">Hitch</span><input type="range" id="tractorCtlHitch" min="0" max="100" value="100"><span class="v" id="tractorCtlHitchV">100%</span>
      </div>
      <div class="tractor-ctl-row">
        <span class="lbl">PTO</span>
        <button id="tractorCtlPto" title="contract pto - rear PTO engage request. Bus: PGN 65090 SPN 1894.">Engage</button>
        <button id="tractorCtl540" title="contract pto_mode 0 - the 540 r/min gearing. Bus: PGN 65090 SPN 1896.">540</button>
        <button id="tractorCtl1000" title="contract pto_mode 1 - the 1000 r/min gearing. Bus: PGN 65090 SPN 1896.">1000</button>
      </div>
      <div class="tractor-ctl-row" title="contract hand_throttle - the all-speed governor's second lever: the higher of it and the accelerator sets the engine speed, idle (0) to high idle (100). It does not pull away alone. Panel only: no ISO 11783-7 command carries it.">
        <span class="lbl">Hand</span><input type="range" id="tractorCtlHand" min="0" max="100" value="0"><span class="v" id="tractorCtlHandV">0%</span>
      </div>
      <div class="tractor-ctl-row">
        <span class="lbl">Drive</span>
        <button id="tractorCtlDiff" title="contract diff_lock - rear differential lock request. Panel only: its J1939 carrier (TC1, SPN 687) has no decoder here yet.">Diff lock</button>
        <button id="tractorCtlFwd" title="contract fwd_drive - MFWD front-axle engage request. Panel only: no command message carries it.">MFWD</button>
      </div>
      <div class="tractor-ctl-row" title="contract guidance_curvature - 1/km, + = right, 127 is full lock (7.9 m radius). Its PRESENCE overrides steer, so it is sent only while engaged. Bus: PGN 44288, only while its status says 'intended to steer'.">
        <span class="lbl">Guide</span>
        <button id="tractorCtlGuide">Engage</button>
        <input type="range" id="tractorCtlCurv" min="-127" max="127" value="0"><span class="v" id="tractorCtlCurvV">0</span>
      </div>
      <div class="tractor-ctl-row" title="contract scv_flow - hydraulic remote (SCV) opening, which drives the fertilizer spreader's gate. Bus: PGN 65072 (aux valve 0), port flow while the state is EXTEND.">
        <span class="lbl">SCV</span><input type="range" id="tractorCtlScv" min="0" max="100" value="0"><span class="v" id="tractorCtlScvV">0%</span>
      </div>
    </div>
`;

  // ── The panel ───────────────────────────────────────────────────────────────
  let el = {};
  const panel = window.makeVehiclePanel({
    id: 'tractor', family: 'tractor', label: 'tractor',
    variant: 'tractor-kenney',        // VehicleCatalog.VARIANTS id, not the family
    btn: 'tractorBtn', takes: 'dash', follow: true,
    cssPrefix: 'tractor', title: 'Dashboard (Tractor)', baseW: 320,
    headerTip: "The tractor's instruments, read off the game's own publish at ~20 Hz. Opens by itself when a tractor appears on the Carlito link and takes the RAMN dashboard's place while it is up; the Control panel stays, because a tractor is driven with the same pedals and gearbox, and the tractor's own commands are a section of it. Drag to move, grip the bottom-right corner to resize.",
    bodyHtml: BODY,
    render: (t) => render(t || {}),
  });
  const section = window.vehiclePanelSection({ family: 'tractor', where: 'ctrl', html: CTL, render: () => renderCtl() });
  const markDirty = section.markDirty;

  // ── Render ──────────────────────────────────────────────────────────────────
  // `t` is {} with no tractor on the link: the resting panel, not the last one's readings frozen.
  function render(t) {
    const gear = num(t.gear);
    el.gear.textContent = enumLabel('gear', gear);
    el.chipGear.classList.toggle('on', gear === 255);          // R, the contract's 0xFF
    const conn = t.implement_connected;
    el.impl.textContent = conn === undefined ? '–'
      : (conn ? enumLabel('implement_type', num(t.implement_type)) : 'none');
    el.chipImpl.classList.toggle('on', !!conn);

    // ── Traction: one scale for both, so the gap between them is drawn, not computed twice ──
    const wheel = num(t.wheel_speed), ground = num(t.ground_speed), slip = num(t.wheel_slip);
    const [lo, hi] = rangeOf('wheel_speed');
    const pct = (v) => Number.isFinite(v) ? Math.max(0, Math.min(100, (v - lo) / ((hi - lo) || 1) * 100)) : 0;
    const wP = pct(wheel), gP = pct(ground);
    const base = Number.isFinite(ground) ? Math.min(wP, gP) : wP;
    el.wheelBase.style.width = base + '%';
    el.wheelGap.style.left = base + '%';
    el.wheelGap.style.width = Math.max(0, wP - base) + '%';
    el.groundBar.firstElementChild.style.width = gP + '%';
    el.wheelV.textContent = fmt(wheel, 1, ' km/h');
    el.groundV.textContent = fmt(ground, 1, ' km/h');
    const digging = isWarn('wheel_slip', slip);
    el.wheelBar.classList.toggle('over', digging);
    el.slip.textContent = Number.isFinite(slip) ? 'slip ' + whole(slip, '%') : '–';
    el.slip.classList.toggle('warn', digging);
    setTell(el.tDiff, t.diff_lock_state);
    setTell(el.tFwd, t.fwd_drive_state);
    setTell(el.tPto, t.pto_state);
    setTell(el.tSlip, digging);

    // ── Hitch & PTO ──
    setBar(el.hitchBar, el.hitchV, 'hitch_pos_actual', num(t.hitch_pos_actual), 0, '%');
    setBar(el.draftBar, el.draftV, 'draft_force', num(t.draft_force), 0, '%');
    setBar(el.ptoBar, el.ptoV, 'pto_rpm', num(t.pto_rpm), 0, ' r/min');

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
    setBar(el.axleBar, el.axleV, 'axle_load', num(t.axle_load), 0, ' kg');

    // ── Tell-tales ──
    const st = num(t.status) | 0;
    const bit = (mask) => !!(st & mask);
    setTell(el.tIgn, bit(ST.ign));
    setTell(el.tPark, bit(ST.park));
    setTell(el.tLights, bit(ST.lights));
    setTell(el.tStab, bit(ST.stab));
  }

  // ── Commands ────────────────────────────────────────────────────────────────
  // A view over isobus.js, which owns all eight tractor commands and also takes them off the bus
  // (window.isobusCtl / isobusSetCtl). A control a frame is holding right now is ringed amber and
  // its slider follows the frame; touching the control takes it back. Rendered by the section, on
  // the telemetry push and after every click.
  const ibc = () => (window.isobusCtl ? window.isobusCtl() : null);
  const ibSet = (p) => { if (window.isobusSetCtl) window.isobusSetCtl(p); markDirty(); };
  function renderCtl() {
    const c = ibc();
    if (!c) return;
    const b = c.bus;
    const slider = (inp, out, v, text, held) => {
      if (held || document.activeElement !== inp) inp.value = v;
      out.textContent = text;
      inp.classList.toggle('bus', held);
    };
    const btn = (node, on, held) => { node.classList.toggle('on', on); node.classList.toggle('bus', held); };
    slider(el.hitch, el.hitchCtlV, c.hitch_pos, Math.round(c.hitch_pos) + '%', b.hitch_pos);
    btn(el.pto, !!c.pto, b.pto);
    btn(el.m540, c.pto_mode === 0, b.pto_mode);
    btn(el.m1000, c.pto_mode === 1, b.pto_mode);
    slider(el.hand, el.handV, c.hand_throttle, Math.round(c.hand_throttle) + '%', false);
    btn(el.diff, !!c.diff_lock, false);
    btn(el.fwd, !!c.fwd_drive, false);
    // Disengaged, the slider keeps the operator's preset and nothing is sent.
    const engaged = c.guidance_curvature !== undefined;
    btn(el.guide, engaged, b.guidance_curvature);
    if (engaged) slider(el.curv, el.curvV, c.guidance_curvature, String(Math.round(c.guidance_curvature)), b.guidance_curvature);
    else { el.curv.classList.remove('bus'); el.curvV.textContent = 'off'; }
    slider(el.scv, el.scvV, c.scv_flow, Math.round(c.scv_flow) + '%', b.scv_flow);
  }

  // ── Wire ────────────────────────────────────────────────────────────────────
  (function wire() {
    const q = panel.q;
    const wheelBar = q('tractorWheelBar');
    el = {
      chipGear: q('tractorChipGear'), gear: q('tractorGear'),
      chipImpl: q('tractorChipImpl'), impl: q('tractorImpl'),
      slip: q('tractorSlip'), wheelBar,
      wheelBase: wheelBar.querySelector('i.b'), wheelGap: wheelBar.querySelector('i.gap'),
      groundBar: q('tractorGroundBar'), wheelV: q('tractorWheelV'), groundV: q('tractorGroundV'),
      tDiff: q('tractorTellDiff'), tFwd: q('tractorTellFwd'), tPto: q('tractorTellPto'), tSlip: q('tractorTellSlip'),
      hitchBar: q('tractorHitchBar'), hitchV: q('tractorHitchV'),
      draftBar: q('tractorDraftBar'), draftV: q('tractorDraftV'),
      ptoBar: q('tractorPtoBar'), ptoV: q('tractorPtoV'),
      rpmBar: q('tractorRpmBar'), rpmV: q('tractorRpmV'), loadBar: q('tractorLoadBar'), loadV: q('tractorLoadV'),
      fuelBar: q('tractorFuelBar'), fuelV: q('tractorFuelV'), coolBar: q('tractorCoolBar'), coolV: q('tractorCoolV'),
      battBar: q('tractorBattBar'), battV: q('tractorBattV'),
      burn: q('tractorBurn'), ratio: q('tractorRatio'), hours: q('tractorHours'),
      axleBar: q('tractorAxleBar'), axleV: q('tractorAxleV'),
      tIgn: q('tractorTellIgn'), tPark: q('tractorTellPark'), tLights: q('tractorTellLights'), tStab: q('tractorTellStab'),
    };
    const c = section.q;
    Object.assign(el, {
      hitch: c('tractorCtlHitch'), hitchCtlV: c('tractorCtlHitchV'), pto: c('tractorCtlPto'),
      m540: c('tractorCtl540'), m1000: c('tractorCtl1000'),
      hand: c('tractorCtlHand'), handV: c('tractorCtlHandV'),
      diff: c('tractorCtlDiff'), fwd: c('tractorCtlFwd'),
      guide: c('tractorCtlGuide'), curv: c('tractorCtlCurv'), curvV: c('tractorCtlCurvV'),
      scv: c('tractorCtlScv'), scvV: c('tractorCtlScvV'),
    });

    el.hitch.addEventListener('input', () => ibSet({ hitch_pos: +el.hitch.value }));
    el.pto.addEventListener('click', () => { const c = ibc(); ibSet({ pto: c && c.pto ? 0 : 1 }); });
    el.m540.addEventListener('click', () => ibSet({ pto_mode: 0 }));
    el.m1000.addEventListener('click', () => ibSet({ pto_mode: 1 }));
    el.hand.addEventListener('input', () => ibSet({ hand_throttle: +el.hand.value }));
    el.diff.addEventListener('click', () => { const c = ibc(); ibSet({ diff_lock: c && c.diff_lock ? 0 : 1 }); });
    el.fwd.addEventListener('click', () => { const c = ibc(); ibSet({ fwd_drive: c && c.fwd_drive ? 0 : 1 }); });
    el.guide.addEventListener('click', () => {
      const c = ibc();
      ibSet({ guidance_curvature: (c && c.guidance_curvature !== undefined) ? undefined : +el.curv.value });
    });
    el.curv.addEventListener('input', () => {
      const c = ibc();
      if (c && c.guidance_curvature !== undefined) ibSet({ guidance_curvature: +el.curv.value });
    });
    el.scv.addEventListener('input', () => ibSet({ scv_flow: +el.scv.value }));
  })();

  window.tractorToggle = panel.toggle;
})();
