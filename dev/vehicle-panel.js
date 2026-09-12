// ── Vehicle panels: the shared mechanism ────────────────────────────────────
// The parts of drone.js that are not about drones, so truck.js / tractor.js / boat.js are each
// only their own instrument panel. A panel keeps its own CSS prefix, DOM and render.
//
// Integration: index.html (script after carlito_contract.js, before every panel; every panel
// button ships style="display:none") · ramn.js (ramnSetDashOpen) · j1939.js + sloppycan.js
// (vehiclePanelRequestForProto, reflowHeader) · carlito.js (carlitoOnTelemetry, owned here).
// Live-only: no persistence.

(function () {
  'use strict';

  const CONTRACT = window.CARLITO_CONTRACT || { signals: [] };
  const SIGS = CONTRACT.signals || [];

  // ── Which machine is on the link ────────────────────────────────────────────
  // A "out" signal the contract gives to exactly ONE family being present IS the vehicle; there is
  // no vehicle_type on the wire. A name shared with the car says nothing about who published it.
  const _famCache = {};
  function signalsFor(family) {
    if (!_famCache[family]) {
      _famCache[family] = SIGS
        .filter(s => s.dir === 'out' && Array.isArray(s.vehicles) &&
                     s.vehicles.length === 1 && s.vehicles[0] === family)
        .map(s => s.name);
      if (!_famCache[family].length) {
        console.warn('Vehicle panels: the contract declares no ' + family + '-only "out" signal, so a ' +
          family + ' can never be detected - load carlito_contract.js before the panels.');
      }
    }
    return _famCache[family];
  }
  const isFamily = (family, t) => !!t && signalsFor(family).some(n => n in t);

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
  const PROTO_PANEL = {
    dronecan: ['drone', 'The DroneCAN tab decodes the drone’s bus, and a car publishes none of it.'],
    j1939:    ['truck', 'The J1939 tab decodes a heavy truck’s bus - engine, retarder, air ' +
                        'reservoirs and the trailer’s ISO 11992 link.'],
    iso11783: ['tractor', 'ISO 11783 is the tractor-implement bus: hitch, PTO, wheel and ground ' +
                          'speed, and the implement’s own address claim.'],
    nmea2000: ['boat', 'NMEA 2000 is a marine bus - heading, rudder and trim.'],
  };
  function requestForProto(mode) {
    const m = PROTO_PANEL[mode];
    return m ? requestVehicle(m[0], m[1]) : false;
  }

  window.vehiclePanelSubscribe = (fn) => { if (typeof fn === 'function') subs.push(fn); };
  window.vehiclePanelIsFamily = isFamily;
  window.vehiclePanelRegister = register;
  window.vehiclePanelClaim = claim;
  window.vehiclePanelRequestVehicle = requestVehicle;
  window.vehiclePanelRequestForProto = requestForProto;
})();
