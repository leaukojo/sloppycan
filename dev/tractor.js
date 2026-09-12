// ── Tractor dashboard ─────────────────────────────────────────────────────────
// One floating window, following the Carlito link through vehicle-panel.js. Takes 'dash':
// a tractor is driven with the RAMN controls, so it replaces the cluster and the Control Panel
// keeps driving. Claims no uplink signal and owns none: its Commands section is a view over
// isobus.js, which owns the tractor's seven commands and also reads them off the bus.
//
// A STARTING POINT: currently the RAMN cluster verbatim, off window.ramnGetState(). The
// signals that belong here are hitch_pos_actual / pto_rpm / implement_connected /
// diff_lock_state / draft_force, and they arrive in the payload this file is already handed.
//
// Integration: index.html (script after vehicle-panel.js; #tractorBtn ships style="display:none",
// vehicle-panel.js shows it) · sloppycan.js (_buttonsWrap id list). Live-only.

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
.tractor-window {
  position:fixed; z-index:900; top:72px; left:90px; width:300px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.tractor-window.open { display:flex; }
.tractor-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.tractor-header .tractor-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; }
.tractor-header .tractor-title { flex:1; }
.tractor-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.tractor-close:hover { background:var(--bg); color:var(--text); }
.tractor-scaleouter { overflow:hidden; }
.tractor-body { width:300px; transform-origin:top left; padding:14px 14px 16px; box-sizing:border-box; }

/* Top row: steering wheel + gear */
.tractor-top { display:flex; align-items:center; gap:14px; margin-bottom:14px; }
.tractor-wheel { width:80px; height:80px; color:var(--text2); flex-shrink:0; transition:transform .08s linear; }
.tractor-gearbox { flex:1; text-align:center; }
.tractor-gearcap { font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:4px; }
.tractor-gearbadge {
  display:inline-flex; align-items:center; justify-content:center; min-width:56px;
  padding:5px 14px; border:1px solid var(--border2); border-radius:9px; background:var(--bg);
}
.tractor-gear { font-family:var(--mono); font-size:38px; font-weight:500; line-height:1; color:var(--text); }
.tractor-gear.rev { color:var(--amber); }
.tractor-joy { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); margin-top:6px; min-height:12px; }
.tractor-joy.active { color:var(--blue); }

/* Pedal + steer bars */
.tractor-bar-row { margin-bottom:9px; }
.tractor-bar-head { display:flex; justify-content:space-between; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:3px; }
.tractor-bar-head .v { font-family:var(--mono); color:var(--text); letter-spacing:0; }
.tractor-bar { height:9px; background:var(--bg); border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.tractor-bar > i { display:block; height:100%; width:0%; border-radius:4px; transition:width .08s linear; }
.tractor-bar.brake > i { background:var(--red); }
.tractor-bar.accel > i { background:var(--green); }
/* Steering: centre-origin bar */
.tractor-steer { position:relative; height:9px; background:var(--bg); border:1px solid var(--border); border-radius:5px; }
.tractor-steer::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--border2); }
.tractor-steer > i { position:absolute; top:0; bottom:0; left:50%; width:0%; background:var(--blue); border-radius:3px; transition:all .08s linear; }

/* Tell-tale grid */
.tractor-tells {
  display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:14px;
  border-top:1px solid var(--border); padding-top:12px;
}
.tractor-tell {
  display:flex; flex-direction:column; align-items:center; gap:3px;
  padding:6px 2px; border-radius:8px; background:var(--bg); color:var(--text3);
  transition:color .1s, background .1s;
}
.tractor-tell svg { width:22px; height:22px; }
.tractor-tell .lbl { font-size:8px; text-transform:uppercase; letter-spacing:.05em; text-align:center; line-height:1.2; }
.tractor-tell.on.green { color:var(--green); background:var(--green-dim); }
.tractor-tell.on.blue  { color:var(--blue);  background:var(--blue-dim); }
.tractor-tell.on.amber { color:var(--amber); background:var(--amber-dim); }
.tractor-tell.on.red   { color:var(--red);   background:var(--red-dim); }

/* Commands: views over isobus.js, which owns them */
.tractor-ctl { margin-top:12px; border-top:1px solid var(--border); padding-top:10px; }
.tractor-ctl-cap { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:8px; }
.tractor-ctl-cap .bus-key { color:var(--amber); letter-spacing:.06em; }
.tractor-ctl-row { display:flex; align-items:center; gap:6px; margin-bottom:7px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); }
.tractor-ctl-row .lbl { width:52px; flex-shrink:0; }
.tractor-ctl-row input[type=range] { flex:1; min-width:0; }
.tractor-ctl-row .v { font-family:var(--mono); color:var(--text); letter-spacing:0; width:44px; text-align:right; flex-shrink:0; }
.tractor-ctl-row button {
  padding:4px 7px; font-size:10px; font-family:var(--sans); text-transform:uppercase; letter-spacing:.06em;
  color:var(--text2); background:var(--bg); border:1px solid var(--border); border-radius:6px; cursor:pointer;
}
.tractor-ctl-row button.on { color:var(--green); border-color:var(--green); background:var(--green-dim); }
.tractor-ctl .bus { outline:1px solid var(--amber); outline-offset:1px; }

.tractor-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}
`;
  document.head.appendChild(style);

  const BASE_W = 300;
  const PANEL_ID = 'tractor';
  const FAMILY = 'tractor';
  const VARIANT = 'tractor-kenney';  // VehicleCatalog.VARIANTS id, not the family
  const LABEL = 'tractor';

  // ── Window DOM ──────────────────────────────────────────────────────────────
  const win = document.createElement('div');
  win.className = 'tractor-window';
  win.id = 'tractorWindow';
  win.innerHTML = `
  <div class="tractor-header" id="tractorHeader" title="The tractor's cluster. Opens by itself when a tractor appears on the Carlito link and takes the RAMN dashboard's place while it is up; the RAMN Control Panel stays, because a tractor is driven with the same pedals and gearbox. Drag to move, grip the bottom-right corner to resize.">
    <span class="tractor-dot"></span>
    <span class="tractor-title">Tractor dashboard</span>
    <button class="tractor-close" id="tractorCloseBtn" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="tractor-scaleouter" id="tractorScaleOuter">
   <div class="tractor-body" id="tractorBody">
    <div class="tractor-top">
      <svg class="tractor-wheel" id="tractorWheel" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round">
        <circle cx="50" cy="50" r="44"/>
        <circle cx="50" cy="50" r="10" fill="currentColor" stroke="none"/>
        <path d="M50 50 H94 M50 50 H6 M50 50 V94"/>
      </svg>
      <div class="tractor-gearbox">
        <div class="tractor-gearcap">Gear</div>
        <div class="tractor-gearbadge"><span class="tractor-gear" id="tractorGear">&ndash;</span></div>
        <div class="tractor-joy" id="tractorJoy"></div>
      </div>
    </div>

    <div class="tractor-bar-row">
      <div class="tractor-bar-head"><span>Brake</span><span class="v" id="tractorBrakeV">0%</span></div>
      <div class="tractor-bar brake"><i id="tractorBrakeBar"></i></div>
    </div>
    <div class="tractor-bar-row">
      <div class="tractor-bar-head"><span>Accel</span><span class="v" id="tractorAccelV">0%</span></div>
      <div class="tractor-bar accel"><i id="tractorAccelBar"></i></div>
    </div>
    <div class="tractor-bar-row">
      <div class="tractor-bar-head"><span>Steer</span><span class="v" id="tractorSteerV">C 0%</span></div>
      <div class="tractor-steer"><i id="tractorSteerBar"></i></div>
    </div>

    <div class="tractor-tells">
      <div class="tractor-tell" id="tractorTellTurnL" data-color="green">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="15,4 5,12 15,20"/></svg>
        <span class="lbl">Left</span>
      </div>
      <div class="tractor-tell" id="tractorTellTurnR" data-color="green">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="9,4 19,12 9,20"/></svg>
        <span class="lbl">Right</span>
      </div>
      <div class="tractor-tell" id="tractorTellClear" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="10.5" y="7" width="3" height="10" rx="1.5" fill="currentColor" stroke="none"/>
          <path d="M8 8 L4 6.5M8 12 H4M8 16 L4 17.5"/>
          <path d="M16 8 L20 6.5M16 12 H20M16 16 L20 17.5"/>
        </svg>
        <span class="lbl">Clearance</span>
      </div>
      <div class="tractor-tell" id="tractorTellLow" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6c5.5 0 5.5 12 0 12 a6 6 0 0 0 0-12z" fill="currentColor" stroke="none"/>
          <path d="M14 8 l6 1M14 12 l6 1M14 16 l6 1"/>
        </svg>
        <span class="lbl">Low beam</span>
      </div>
      <div class="tractor-tell" id="tractorTellHigh" data-color="blue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6c5.5 0 5.5 12 0 12 a6 6 0 0 0 0-12z" fill="currentColor" stroke="none"/>
          <path d="M14 8 h6M14 12 h6M14 16 h6"/>
        </svg>
        <span class="lbl">High</span>
      </div>
      <div class="tractor-tell" id="tractorTellKey" data-color="green">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="8" cy="8" r="4"/><path d="M11 11 l8 8M16 16 l2-2M18 18 l2-2"/>
        </svg>
        <span class="lbl" id="tractorKeyLbl">Off</span>
      </div>
      <div class="tractor-tell" id="tractorTellHand" data-color="red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="9"/><path d="M7 12 h10" stroke-linecap="round"/>
          <text x="12" y="10" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">P</text>
        </svg>
        <span class="lbl">Brake</span>
      </div>
      <div class="tractor-tell" id="tractorTellHorn" data-color="amber">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 9 h4 l6-4 v14 l-6-4 H3 z"/>
          <path d="M17 8 a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2"/>
        </svg>
        <span class="lbl">Horn</span>
      </div>
      <div class="tractor-tell" id="tractorTellBatt" data-color="red">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="3" y="8" width="18" height="10" rx="1.5"/>
          <path d="M7 6 v2M7 5 h3M16 6 v2M14.5 7 h3"/>
        </svg>
        <span class="lbl">Batt</span>
      </div>
      <div class="tractor-tell" id="tractorTellChk" data-color="amber">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
          <path d="M4 11 V9 h2 V7 h3 l2-2 h3 v2 h2 l2 2 v2 h-1 v5 h-2 v-2 h-8 v2 H6 v-5 z"/>
        </svg>
        <span class="lbl">Check</span>
      </div>
    </div>

    <div class="tractor-ctl" title="The tractor's commands, sent to Carlito over the uplink. isobus.js owns them and ALSO reads the real ISO 11783-7 command frames off the bus (65090 hitch/PTO, 44288 guidance, 65072 aux valve 0): while a frame is holding one it is ringed amber, and touching the control takes it back.">
      <div class="tractor-ctl-cap"><span>Commands</span><span class="bus-key">amber = held by the bus</span></div>
      <div class="tractor-ctl-row" title="contract hitch_pos - requested rear hitch position, 0 lowered (working) to 100 raised (transport). Bus: PGN 65090 SPN 1875.">
        <span class="lbl">Hitch</span><input type="range" id="tractorCtlHitch" min="0" max="100" value="100"><span class="v" id="tractorCtlHitchV">100%</span>
      </div>
      <div class="tractor-ctl-row">
        <span class="lbl">PTO</span>
        <button id="tractorCtlPto" title="contract pto - rear PTO engage request. Bus: PGN 65090 SPN 1894.">Engage</button>
        <button id="tractorCtl540" title="contract pto_mode 0 - the 540 r/min gearing. Bus: PGN 65090 SPN 1896.">540</button>
        <button id="tractorCtl1000" title="contract pto_mode 1 - the 1000 r/min gearing. Bus: PGN 65090 SPN 1896.">1000</button>
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
   </div>
  </div>
  <div class="tractor-resize" id="tractorResize"></div>
`;

  // ── State ───────────────────────────────────────────────────────────────────
  let tel = null;               // last telemetry pushed (null = link gone)
  let live = false;             // a tractor is on the link
  let autoOpened = false;       // opened BY the telemetry, not by hand
  let scale = () => {};
  let rafPending = false;
  let el = {};

  const isOpen = () => win.classList.contains('open');

  const JOY = { 1: '', 2: 'Up', 3: 'Down', 4: 'Right', 5: 'Left', 6: 'Press' };
  const KEYPOS = { 1: 'Off', 2: 'Acc', 3: 'Ign' };
  const BLANK = { brake: 0, accel: 0, steer: 0, gear: null, joy: 1, horn: false, key: 1,
                  turnL: false, turnR: false, handbrake: false, battery: false, checkEngine: false,
                  clearance: false, lowbeam: false, highbeam: false, brakeRaw: 0 };
  const state = () => (window.ramnGetState ? window.ramnGetState() : BLANK);

  // ── Follow the link ─────────────────────────────────────────────────────────
  // Only an AUTOMATIC open is undone by the automatic close.
  window.vehiclePanelSubscribe(function (t) {
    tel = t;
    const now = !!(window.vehiclePanelIsFamily && window.vehiclePanelIsFamily(FAMILY, t));
    if (now !== live) {
      live = now;
      if (live && !isOpen()) { autoOpened = true; setOpen(true); }
      else if (!live && autoOpened) { autoOpened = false; setOpen(false); }
    }
    markDirty();
  });

  // ── Window open / close ─────────────────────────────────────────────────────
  function setOpen(open) {
    if (isOpen() === open) return;
    win.classList.toggle('open', open);
    if (open) { scale(win.offsetWidth || BASE_W); markDirty(); }
    const b = document.getElementById('tractorBtn');
    if (b) b.classList.toggle('active', open);
    if (window.vehiclePanelClaim) window.vehiclePanelClaim(PANEL_ID, open, 'dash');
  }
  function tractorToggle() {
    autoOpened = false;             // touched by hand: the telemetry hook stops closing it
    setOpen(!isOpen());
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  // On the telemetry push (~20 Hz), not per ingested frame: this window follows the link.
  function markDirty() {
    if (rafPending || !isOpen()) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function setTell(node, on) {
    // Idempotent: re-toggling every tick fights the transition and flickers on the ON→OFF edge.
    if (node.classList.contains('on') === on) return;
    node.classList.toggle('on', on);
    node.classList.toggle(node.dataset.color, on);
  }

  function render() {
    if (!isOpen()) return;
    // No tractor on the link → the resting cluster, not the last one's readings frozen.
    const st = (live && tel) ? state() : BLANK;

    el.wheel.style.transform = `rotate(${(st.steer / 100 * 150).toFixed(1)}deg)`;

    el.brakeBar.style.width = Math.max(0, Math.min(100, st.brake)) + '%';
    el.brakeV.textContent = Math.round(st.brake) + '%';
    el.accelBar.style.width = Math.max(0, Math.min(100, st.accel)) + '%';
    el.accelV.textContent = Math.round(st.accel) + '%';

    const sclamp = Math.max(-100, Math.min(100, st.steer));
    el.steerBar.style.width = Math.abs(sclamp) / 2 + '%';
    el.steerBar.style.left = sclamp >= 0 ? '50%' : (50 - Math.abs(sclamp) / 2) + '%';
    const dir = Math.abs(sclamp) < 2 ? 'C' : (sclamp < 0 ? 'L' : 'R');
    el.steerV.textContent = dir + ' ' + Math.round(Math.abs(sclamp)) + '%';

    el.gear.textContent = st.gear == null ? '–' : st.gear;
    el.gear.classList.toggle('rev', st.gear === 'R');
    el.joy.textContent = JOY[st.joy] || '';
    el.joy.classList.toggle('active', !!JOY[st.joy]);

    setTell(el.turnL, st.turnL);
    setTell(el.turnR, st.turnR);
    setTell(el.clear, st.clearance);
    setTell(el.low, st.lowbeam);
    setTell(el.high, st.highbeam);
    setTell(el.key, st.key >= 2);
    el.keyLbl.textContent = KEYPOS[st.key] || 'Off';
    setTell(el.hand, st.handbrake || st.brakeRaw > 10);
    setTell(el.horn, st.horn);
    setTell(el.batt, st.battery);
    setTell(el.chk, st.checkEngine);
    renderCtl();
  }

  // ── Commands ────────────────────────────────────────────────────────────────
  // A view over isobus.js, which owns all seven tractor commands and also takes them off the bus
  // (window.isobusCtl / isobusSetCtl). A control a frame is holding right now is ringed amber and
  // its slider follows the frame; touching the control takes it back. Rendered with the cluster,
  // on the telemetry push and after every click.
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
    slider(el.hitch, el.hitchV, c.hitch_pos, Math.round(c.hitch_pos) + '%', b.hitch_pos);
    btn(el.pto, !!c.pto, b.pto);
    btn(el.m540, c.pto_mode === 0, b.pto_mode);
    btn(el.m1000, c.pto_mode === 1, b.pto_mode);
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
    document.body.appendChild(win);
    const q = (id) => win.querySelector('#' + id);
    el = {
      wheel: q('tractorWheel'), gear: q('tractorGear'), joy: q('tractorJoy'),
      brakeBar: q('tractorBrakeBar'), brakeV: q('tractorBrakeV'),
      accelBar: q('tractorAccelBar'), accelV: q('tractorAccelV'),
      steerBar: q('tractorSteerBar'), steerV: q('tractorSteerV'),
      turnL: q('tractorTellTurnL'), turnR: q('tractorTellTurnR'), clear: q('tractorTellClear'),
      low: q('tractorTellLow'), high: q('tractorTellHigh'), key: q('tractorTellKey'),
      keyLbl: q('tractorKeyLbl'), hand: q('tractorTellHand'), horn: q('tractorTellHorn'),
      batt: q('tractorTellBatt'), chk: q('tractorTellChk'),
      hitch: q('tractorCtlHitch'), hitchV: q('tractorCtlHitchV'), pto: q('tractorCtlPto'),
      m540: q('tractorCtl540'), m1000: q('tractorCtl1000'),
      diff: q('tractorCtlDiff'), fwd: q('tractorCtlFwd'),
      guide: q('tractorCtlGuide'), curv: q('tractorCtlCurv'), curvV: q('tractorCtlCurvV'),
      scv: q('tractorCtlScv'), scvV: q('tractorCtlScvV'),
    };

    el.hitch.addEventListener('input', () => ibSet({ hitch_pos: +el.hitch.value }));
    el.pto.addEventListener('click', () => { const c = ibc(); ibSet({ pto: c && c.pto ? 0 : 1 }); });
    el.m540.addEventListener('click', () => ibSet({ pto_mode: 0 }));
    el.m1000.addEventListener('click', () => ibSet({ pto_mode: 1 }));
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

    q('tractorCloseBtn').addEventListener('click', () => { autoOpened = false; setOpen(false); });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; autoOpened = false; setOpen(false);
    });

    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: q('tractorHeader'), grip: q('tractorResize'),
        outer: q('tractorScaleOuter'), body: q('tractorBody'),
        baseW: BASE_W, closeSel: '.tractor-close',
      });
    } else {
      console.warn('Tractor panel: makeFloating is missing - load ramn.js before tractor.js.');
    }

    if (window.vehiclePanelRegister) {
      window.vehiclePanelRegister({
        id: PANEL_ID, family: FAMILY, variant: VARIANT, label: LABEL,
        btn: 'tractorBtn', isOpen,
        close: () => { autoOpened = false; setOpen(false); },
      });
    }
  })();

  window.tractorToggle = tractorToggle;
})();
