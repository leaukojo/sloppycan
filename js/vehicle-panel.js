// ── Vehicle panels: the shared mechanism ────────────────────────────────────
// The parts of drone.js that are not about drones, so truck.js / tractor.js / boat.js are each
// only their own instrument panel. A panel keeps its own CSS prefix, body DOM and render; the
// window chrome, makeFloating, Esc, open / close, registration and the claim are built here
// (makeVehiclePanel; vehiclePanelWindow alone for drone.js's two-window pair), and the contract
// readers + instrument widgets every dashboard draws with are vehiclePanelUtil.
//
// Integration: index.html (script after carlito_contract.js, before every panel; every panel
// button ships style="display:none") · ramn.js (ramnSetDashOpen) · j1939.js + sloppycan.js
// (vehiclePanelRequestForProto, reflowHeader) · carlito.js (carlitoOnTelemetry, owned here).
// Live-only: no persistence.

(function () {
  'use strict';

  // ── Which machine is on the link ────────────────────────────────────────────
  // The rule is carlito-registry.js's carlitoIsFamily (a family-only "out" signal present IS the
  // vehicle), shared with the demo traffic, j1939-flavor.js's mirrors and dronecan.js.
  const isFamily = (family, t) => window.carlitoIsFamily(family, t);

  // ── The telemetry fan-out ───────────────────────────────────────────────────
  // carlito.js calls exactly one carlitoOnTelemetry, so panels subscribe rather than assign.
  // `null` = the link is gone, and every subscriber has to see it.
  let lastTel = null;
  const subs = [];
  const warned = new Set();
  window.carlitoOnTelemetry = function (t) {
    lastTel = t;
    syncButtons();
    for (const fn of subs) {
      try { fn(t); }
      catch (e) {
        if (!warned.has(fn)) { warned.add(fn); console.warn('Vehicle panels: a telemetry subscriber threw, ignoring it:', e); }
      }
    }
  };

  // ── The panel registry ──────────────────────────────────────────────────────
  // `variant` is the game's VehicleCatalog variant id, not the family. `verb`: a drone is flown.
  const panels = new Map();          // id → { id, family, variant, label, verb, btn, close, isOpen }
  function register(p) {
    if (!p || !p.id) return;
    panels.set(p.id, p);
    syncButtons();
  }

  // ── Toolbar buttons ─────────────────────────────────────────────────────────
  // A panel's button + onboarding chip are up only while its machine is on the link, or while the
  // window they close is open. Runs on every telemetry push (~20 Hz), so it decides before it
  // writes: reflowHeader measures the whole header, which a shown/hidden button changes.
  let btnsShown = null;
  function syncButtons() {
    const want = [];
    let sig = '';
    for (const p of panels.values()) {
      if (!p.btn) continue;
      const show = isFamily(p.family, lastTel) || !!(p.isOpen && p.isOpen());
      want.push([p, show]);
      sig += p.id + (show ? '1' : '0');
    }
    if (sig === btnsShown) return;
    btnsShown = sig;
    for (const [p, show] of want) {
      if (p._btnEl === undefined) {
        p._btnEl = document.getElementById(p.btn) || null;
        p._chipEl = document.querySelector('.onboard-chip[data-target="#' + p.btn + '"]') || null;
      }
      if (p._btnEl) p._btnEl.style.display = show ? '' : 'none';
      if (p._chipEl) p._chipEl.style.display = show ? '' : 'none';
    }
    if (window.reflowHeader) window.reflowHeader();
  }

  // ── The RAMN handoff + one panel at a time ──────────────────────────────────
  // `takes` is what the panel REPLACES: 'pair' (dashboard + Control, for a machine the RAMN
  // controls do not fit) or 'dash' (the cluster alone, for one they do).
  let heldBy = '';          // id of the panel that currently has the screen
  let ramnDashWasOpen = false, ramnPairTaken = false;
  function claim(id, open, takes) {
    if (open) {
      if (heldBy === id) return;
      // A vehicle change does NOT pass through "no link" - carlito.js reloads the iframe without
      // nulling its last payload - so the next panel claims while the previous still holds.
      const handover = heldBy !== '';
      if (handover) {
        const other = panels.get(heldBy);
        heldBy = '';                       // cleared first: the close below claims(false) into a no-op
        if (other && other.close) other.close();
      }
      heldBy = id;
      // The RAMN record belongs to the CHAIN. Re-reading ramnIsOpen() on a handover records "the
      // cluster was down" - it is, the panel before us put it down - and the last panel out never
      // restores it. ramnPairTaken is the chain's MAXIMUM for the same reason: once a 'pair' panel
      // has closed the Control Panel, a 'dash' panel taking over still owes both windows back.
      if (!handover) {
        ramnDashWasOpen = !!(window.ramnIsOpen && window.ramnIsOpen());
        ramnPairTaken = false;
      }
      ramnPairTaken = ramnPairTaken || (takes === 'pair');
      // The CLOSING is this claim's own `takes`: a road vehicle must not shut the Control Panel it
      // is driven with.
      if (takes === 'pair') { if (window.ramnSetPairOpen) window.ramnSetPairOpen(false); }
      else if (window.ramnSetDashOpen) window.ramnSetDashOpen(false);
      syncButtons();
    } else {
      if (heldBy !== id) return;
      heldBy = '';
      syncButtons();
      if (!ramnDashWasOpen) return;   // a window the user had closed stays closed
      if (ramnPairTaken) { if (window.ramnSetPairOpen) window.ramnSetPairOpen(true); }
      else if (window.ramnSetDashOpen) window.ramnSetDashOpen(true);
    }
  }

  // ── The other direction: a tab asks the game for its machine ────────────────
  // The vehicle is a BOOT PARAM (?vehicle=), so this costs a RELOAD and asks first. Quiet when
  // there is nothing to change. There is deliberately no "change vehicle" contract signal.
  function requestVehicle(id, why) {
    const p = panels.get(id);
    if (!p || !p.variant) return false;
    if (isFamily(p.family, lastTel)) return false;                        // already driving one
    if (!window.carlitoIsOpen || !window.carlitoIsOpen()) return false;   // no game to ask
    if (!window.carlitoSelectVehicle) return false;
    const label = p.label || p.family;
    if (!confirm((p.verb || 'Drive') + ' the ' + label + ' in Carlito?\n\n' + (why ? why + '\n\n' : '') +
                 'Switching vehicles is a boot parameter, so the game RELOADS and the current ' +
                 'drive is lost.')) return false;
    const asked = window.carlitoSelectVehicle(p.variant);
    if (asked && window.log) window.log('Carlito: reloading into the ' + label + '.');
    return asked;
  }

  // One table, one rule: a protocol view asks for its machine when the user SELECTS that protocol.
  // The DroneCAN tab holds one protocol, so showing it is the selection; the J1939 tab holds three,
  // so its MODE BUTTON is - a tab opened to read frames must not offer to restart a drive.
  // The J1939 traffics carry the RAMN Control Panel as J1939 driver-demand groups
  // (j1939-flavor.js); NMEA 2000 carries only its steer, as a rudder order, so the game's keyboard
  // drives the throttle; DroneCAN carries none, and the drone flies from Drone Control or falls
  // back to the keyboard.
  const J1939_DRIVES = ' Under this traffic the RAMN Control Panel drives it through J1939 frames' +
                       ' (EEC2 / EBC1 / VDC2 / TC1 / CCVS).';
  const PROTO_PANEL = {
    dronecan: ['drone', 'The DroneCAN tab decodes the drone’s bus, and a car publishes none of it.' +
                        ' Fly it from Drone Control, or from the game’s own keyboard while that is' +
                        ' closed - the RAMN controls need RAMN traffic.'],
    j1939:    ['truck', 'The J1939 tab decodes a heavy truck’s bus - engine, retarder and air ' +
                        'reservoirs, plus the trailer’s ABS / VDC states (ISO 11992 EBS22 / ' +
                        'EBS21, carried on this bus).' + J1939_DRIVES],
    iso11783: ['tractor', 'ISO 11783 is the tractor-implement bus: hitch, PTO, wheel and ground ' +
                          'speed, and the implement’s own address claim.' + J1939_DRIVES],
    nmea2000: ['boat', 'NMEA 2000 is a marine bus - heading, rudder and trim. Under this traffic ' +
                       'the RAMN Control Panel’s steer orders the rudder (PGN 127245) and the ' +
                       'game’s own keyboard drives the throttle.'],
  };
  function requestForProto(mode) {
    const m = PROTO_PANEL[mode];
    return m ? requestVehicle(m[0], m[1]) : false;
  }

  // ── Contract readers + formatting (vehiclePanelUtil) ────────────────────────
  // Ranges, warn thresholds and enum labels are the CONTRACT's and are never retyped in a panel: a
  // bar that turns red at its own signal's `warn` is the same number the game's cluster uses, and
  // a label read off the table cannot drift from the value the game resolved.
  // Indexed once: setBar asks for a signal's range and warn on every render.
  const SIG_BY = new Map(((window.CARLITO_CONTRACT || {}).signals || []).map(s => [s.name + '|' + s.dir, s]));
  const sigDef = (name, dir) => SIG_BY.get(name + '|' + (dir || 'out'));
  function rangeOf(name) {
    const s = sigDef(name, 'out');
    return (s && Array.isArray(s.range) && s.range.length === 2) ? s.range : [0, 1];
  }
  // The caller passes the value the threshold is ABOUT: a signal that warns either way (roll,
  // pitch) is handed a magnitude.
  function isWarn(name, v) {
    const s = sigDef(name, 'out');
    if (!s || !Number.isFinite(Number(s.warn)) || !Number.isFinite(v)) return false;
    return s.warn_side === 'low' ? v <= s.warn : v >= s.warn;
  }
  // A RANGE key ("1-24": "D1-D24", the gear enum) is expanded rather than skipped, and a value
  // the table does not name reads as itself rather than as nothing.
  function enumLabel(name, v, dir) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '–';
    const tbl = (sigDef(name, dir) || {}).enum;
    if (!tbl) return String(n);
    if (tbl[n] !== undefined) return String(tbl[n]);
    for (const [k, lbl] of Object.entries(tbl)) {
      const r = /^(\d+)-(\d+)$/.exec(k);
      if (!r || n < +r[1] || n > +r[2]) continue;
      const l = /^(\D*)(\d+)-\1(\d+)$/.exec(String(lbl));
      return l ? l[1] + (n - +r[1] + +l[2]) : String(lbl);
    }
    return String(n);
  }
  // An INSTANCED contract signal (count > 1) arrives as an ARRAY, so `+t.sig || 0` - which
  // Number()s an array into NaN and falls through to a plausible 0 - is exactly the wrong shape.
  const inst = (v, i) => { const n = Number(Array.isArray(v) ? v[i] : undefined); return Number.isFinite(n) ? n : NaN; };
  // An absent field is NaN, never 0, and every formatter draws it as '–'.
  const num = (v) => { const n = (v === undefined || v === null || v === '') ? NaN : Number(v); return Number.isFinite(n) ? n : NaN; };
  const fmt = (v, d, unit) => Number.isFinite(v) ? (v.toFixed(d) + (unit || '')) : '–';
  const whole = (v, unit) => Number.isFinite(v) ? (Math.round(v) + (unit || '')) : '–';

  // Idempotent: re-toggling every tick fights the transition and flickers on the ON→OFF edge.
  function setTell(node, on) {
    on = !!on;
    if (node.classList.contains('on') === on) return;
    node.classList.toggle('on', on);
    node.classList.toggle(node.dataset.color, on);
  }
  // `.vp-bar` filled across the signal's contract range, red at its contract warn.
  function setBar(barEl, vEl, name, v, digits, unit) {
    const [lo, hi] = rangeOf(name);
    const span = (hi - lo) || 1;
    const warn = isWarn(name, v);
    barEl.classList.toggle('warn', warn);
    barEl.firstElementChild.style.width =
      Number.isFinite(v) ? (Math.max(0, Math.min(100, (v - lo) / span * 100)) + '%') : '0%';
    vEl.textContent = fmt(v, digits, unit);
    vEl.classList.toggle('warn', warn);
  }
  // `.vp-ctr`'s inner <i>: a percentage swinging either side of neutral. `label` formats the value.
  function setCtrBar(barEl, vEl, v, label) {
    const c = Number.isFinite(v) ? Math.max(-100, Math.min(100, v)) : 0;
    barEl.style.width = Math.abs(c) / 2 + '%';
    barEl.style.left = c >= 0 ? '50%' : (50 - Math.abs(c) / 2) + '%';
    vEl.textContent = label(v);
  }

  // ── Window chrome + instrument CSS, injected once ───────────────────────────
  // .vp-* is the chrome every panel shares and the instrument vocabulary boat.js established
  // (rules, section labels, chips, readouts, bars, tell-tales). A panel adds its own prefixed
  // classes for anything only it draws.
  const VP_CSS = `
.vp-window {
  position:fixed; z-index:900; top:72px; left:90px;
  background:var(--bg2); border:1px solid var(--border2); border-radius:12px;
  box-shadow:0 8px 24px #0006; font-family:var(--sans); color:var(--text);
  display:none; flex-direction:column; overflow:hidden;
}
.vp-window.open { display:flex; }
.vp-header {
  display:flex; align-items:center; gap:8px; cursor:move; user-select:none;
  padding:8px 10px; background:var(--bg3); border-bottom:1px solid var(--border);
  font-size:12px; font-weight:600; letter-spacing:.02em;
}
.vp-dot { width:8px; height:8px; border-radius:50%; background:var(--green); flex-shrink:0; }
.vp-title { flex:1; }
.vp-close {
  background:none; border:none; color:var(--text2); cursor:pointer; font-size:16px;
  line-height:1; padding:2px 6px; border-radius:5px;
}
.vp-close:hover { background:var(--bg); color:var(--text); }
.vp-scaleouter { overflow:hidden; }
.vp-body { transform-origin:top left; padding:12px 14px 16px; box-sizing:border-box; }
.vp-resize {
  position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--border2) 50%,var(--border2) 60%,transparent 60%,transparent 75%,var(--border2) 75%,var(--border2) 85%,transparent 85%);
}

.vp-hidden { display:none !important; }
.vp-dim { opacity:.4; }
.vp-rule { height:1px; background:var(--border); margin:9px 0 8px; }
.vp-sec-lbl {
  display:flex; justify-content:space-between; align-items:baseline;
  font-size:9px; text-transform:uppercase; letter-spacing:.14em; color:var(--text3); margin-bottom:6px;
}
.vp-sec-lbl .v { font-family:var(--mono); font-size:9px; letter-spacing:0; color:var(--text2); text-transform:none; }
.vp-sec-lbl .v.on { color:var(--amber); }
.vp-sec-lbl .v.warn { color:var(--red); }

.vp-chips { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.vp-chip {
  display:flex; flex-direction:column; gap:2px; padding:5px 8px;
  background:var(--bg); border:1px solid var(--border); border-radius:8px;
}
.vp-chip .cap { font-size:8px; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); }
.vp-chip .val { font-family:var(--mono); font-size:13px; color:var(--text); }
.vp-chip.on { border-color:var(--amber); background:var(--amber-dim); }
.vp-chip.on .val { color:var(--amber); }

.vp-reads { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.vp-read {
  display:flex; flex-direction:column; gap:1px; padding:4px 6px;
  background:var(--bg); border:1px solid var(--border); border-radius:7px;
}
.vp-read .cap { font-size:8px; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); }
.vp-read .val { font-family:var(--mono); font-size:12px; color:var(--text); }
.vp-read .val.port { color:var(--red); }
.vp-read .val.stbd { color:var(--green); }
.vp-read .val.warn { color:var(--amber); }

.vp-bar-row { margin-bottom:7px; }
.vp-bars { display:grid; gap:7px; }
.vp-bars.n2 { grid-template-columns:1fr 1fr; }
.vp-bars.n3 { grid-template-columns:repeat(3,1fr); }
.vp-bars .vp-bar-row { margin-bottom:0; }
.vp-bar-head { display:flex; justify-content:space-between; font-size:9px; text-transform:uppercase; letter-spacing:.06em; color:var(--text3); margin-bottom:3px; }
.vp-bar-head .v { font-family:var(--mono); font-size:10px; color:var(--text); letter-spacing:0; text-transform:none; }
.vp-bar-head .v.warn { color:var(--red); }
.vp-bar { height:8px; background:var(--bg); border:1px solid var(--border); border-radius:5px; overflow:hidden; }
.vp-bar > i { display:block; height:100%; width:0%; border-radius:4px; background:var(--cyan); transition:width .12s linear; }
.vp-bar.warn > i { background:var(--red); }
.vp-ctr { position:relative; height:8px; background:var(--bg); border:1px solid var(--border); border-radius:5px; }
.vp-ctr::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--border2); }
.vp-ctr > i { position:absolute; top:0; bottom:0; left:50%; width:0%; background:var(--blue); border-radius:3px; transition:all .12s linear; }

.vp-tells { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
.vp-tell {
  text-align:center; padding:5px 2px; border-radius:7px; background:var(--bg);
  border:1px solid var(--border); color:var(--text3);
  font-size:9px; text-transform:uppercase; letter-spacing:.06em;
  transition:color .1s, background .1s, border-color .1s;
}
.vp-tell.on.green { color:var(--green); background:var(--green-dim); border-color:var(--green); }
.vp-tell.on.blue  { color:var(--blue);  background:var(--blue-dim);  border-color:var(--blue); }
.vp-tell.on.amber { color:var(--amber); background:var(--amber-dim); border-color:var(--amber); }
.vp-tell.on.red   { color:var(--red);   background:var(--red-dim);   border-color:var(--red); }
`;
  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    const s = document.createElement('style');
    s.textContent = VP_CSS;
    document.head.appendChild(s);
  }

  // ── One floating window ─────────────────────────────────────────────────────
  // { winId, cssPrefix, title, headerTip, dot, baseW, left, pad, bodyHtml } → the window, built,
  // appended and made draggable / resizable. `rescale()` re-applies makeFloating's scale at the
  // current width. makeFloating fixes the scale wrapper's height in pixels, so a body whose HEIGHT
  // changes (a section shown or hidden) needs it again: `refit()` re-applies it only when the
  // body's height has moved since the last fit, cheap enough to run after every render.
  let floatWarned = false;
  function vehiclePanelWindow(o) {
    injectCss();
    const P = o.cssPrefix;
    const baseW = o.baseW || 300;
    const win = document.createElement('div');
    win.className = `vp-window ${P}-window`;
    win.id = o.winId;
    if (o.left != null) win.style.left = o.left + 'px';
    win.innerHTML = `
  <div class="vp-header ${P}-header" title="${escHtml(o.headerTip || '')}">
    <span class="vp-dot ${P}-dot"${o.dot ? ` style="background:${o.dot}"` : ''}></span>
    <span class="vp-title ${P}-title">${escHtml(o.title || '')}</span>
    <button class="vp-close ${P}-close" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="vp-scaleouter ${P}-scaleouter">
   <div class="vp-body ${P}-body" style="width:${baseW}px${o.pad ? ';padding:' + o.pad : ''}">${o.bodyHtml || ''}</div>
  </div>
  <div class="vp-resize ${P}-resize"></div>`;
    document.body.appendChild(win);
    const body = win.querySelector('.vp-body');
    let scale = () => {};
    if (window.makeFloating) {
      scale = window.makeFloating({
        win, header: win.querySelector('.vp-header'), grip: win.querySelector('.vp-resize'),
        outer: win.querySelector('.vp-scaleouter'), body, baseW, closeSel: '.vp-close',
      });
    } else if (!floatWarned) {
      floatWarned = true;
      console.warn('Vehicle panels: makeFloating is missing - load ramn.js before the panels. ' +
        'The windows still open, but cannot be dragged or resized.');
    }
    let fitH = -1;
    const rescale = () => { scale(win.offsetWidth || baseW); fitH = body.offsetHeight; };
    return {
      win,
      closeBtn: win.querySelector('.vp-close'),
      q: (id) => win.querySelector('#' + id),
      isOpen: () => win.classList.contains('open'),
      rescale,
      refit: () => { if (body.offsetHeight !== fitH) rescale(); },
    };
  }

  // ── One panel: a window that follows the link ───────────────────────────────
  // { id, family, variant, label, verb, btn, takes, follow, ...window options, render, onTelemetry }
  //   → { q, toggle, markDirty, tel }
  //   takes   'pair' | 'dash' | omitted (no claim: a panel driven beside the RAMN controls)
  //   follow  open when the family appears, close when it goes - only an AUTOMATIC open is undone
  //           by the automatic close, and a panel touched by hand is never closed out from under
  //           its user
  //   render(t, raw)  on the telemetry push, rAF-batched, only while open. `t` is the payload while
  //           this panel's machine is on the link and null otherwise (the resting panel, not the
  //           last machine's readings frozen); `raw` is the payload regardless.
  //   onTelemetry(t, live)  every push, open or not.
  function makeVehiclePanel(o) {
    const w = vehiclePanelWindow({ winId: o.id + 'Window', ...o });
    const isOpen = w.isOpen;
    let tel = null, live = false, autoOpened = false, rafPending = false;

    function markDirty() {
      if (rafPending || !isOpen()) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (!isOpen()) return;
        if (o.render) o.render(live ? tel : null, tel);
        w.refit();
      });
    }
    function setOpen(open) {
      if (isOpen() === open) return;
      w.win.classList.toggle('open', open);
      if (open) { w.rescale(); markDirty(); }
      const b = o.btn && document.getElementById(o.btn);
      if (b) b.classList.toggle('active', open);
      if (o.takes) claim(o.id, open, o.takes);
    }
    const close = () => { autoOpened = false; setOpen(false); };
    const toggle = () => { autoOpened = false; setOpen(!isOpen()); };   // by hand: never auto-closed

    w.closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e._scEscHandled || !isOpen()) return;   // shared flag across windows
      e._scEscHandled = true; close();
    });

    subs.push(function (t) {
      tel = t;
      const now = !!isFamily(o.family, t);
      if (now !== live) {
        live = now;
        if (o.follow) {
          if (live && !isOpen()) { autoOpened = true; setOpen(true); }
          else if (!live && autoOpened) { autoOpened = false; setOpen(false); }
        }
      }
      if (o.onTelemetry) o.onTelemetry(t, live);
      markDirty();
    });

    register({ id: o.id, family: o.family, variant: o.variant, label: o.label, verb: o.verb,
               btn: o.btn, isOpen, close });

    return { q: w.q, toggle, markDirty, tel: () => tel };
  }

  window.vehiclePanelSubscribe = (fn) => { if (typeof fn === 'function') subs.push(fn); };
  window.vehiclePanelIsFamily = isFamily;
  window.vehiclePanelRegister = register;
  window.vehiclePanelClaim = claim;
  window.vehiclePanelRequestVehicle = requestVehicle;
  window.vehiclePanelRequestForProto = requestForProto;
  window.vehiclePanelWindow = vehiclePanelWindow;
  window.makeVehiclePanel = makeVehiclePanel;
  window.vehiclePanelUtil = { sigDef, rangeOf, isWarn, enumLabel, inst, num, fmt, whole,
                              setTell, setBar, setCtrBar };
  // The same table as [[proto, family], ...], for sloppycan.js's demo traffic to follow the machine.
  window.vehiclePanelProtoTable = () => Object.entries(PROTO_PANEL).map(([proto, m]) => [proto, m[0]]);
})();
