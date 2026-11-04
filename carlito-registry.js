// ── Carlito registries: created once, before anything registers ───────────────
// Every registry the Carlito link reads, created empty here so that WHO loads first stops
// mattering: a module registering and carlito.js reading both hold the same object, whatever the
// script order. (carlito.js used to snapshot `window.x || {}` as it evaluated, and a fallback made
// then was detached from window - every later registration was silently lost.) carlito.js runs its
// coverage and clash checks on DOMContentLoaded, after every deferred script.
//
// Load (defer) before every module that registers, on both pages. Reads nothing at eval time.
// Modules keep their own `window.x = window.x || ...` lines; with this loaded they are no-ops.

// { signal: () => value } - a protocol module's own control for a contract "in" signal. One
// signal, one source: a name here AND in carlito.js's RAMN IN_SOURCES warns.
window.carlitoUplinkSources = window.carlitoUplinkSources || {};
// { signal: (st) => value | undefined } - a temporary CLAIM on a shared axis, asked first;
// `undefined` declines. A second claimant wraps the first rather than assigning over it.
window.carlitoUplinkOverrides = window.carlitoUplinkOverrides || {};
// [ frame => void ] - a module reading its own command off the bus into its own state.
window.carlitoUplinkDecoders = window.carlitoUplinkDecoders || [];
// [ { flavor, signals, pack(t, slow), unpackable?, onRequest?, mirrors?, reset? } ] - a flavor's frame
// layout; reset() forgets what it has announced (carlito.js calls it on bus open and link end/resume).
window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
// [ { pgn, abbr, sa, prio, signals, build(t), nack? } ] - a J1939 parameter group answered on request;
// nack: false makes a null build() silence rather than a NACK (a control function that is not there).
window.j1939RequestServers = window.j1939RequestServers || [];

// ── Which machine is on the link ────────────────────────────────────────────
// An "out" signal the contract gives to exactly ONE family being present IS the vehicle; there is
// no vehicle_type on the wire. A name shared with the car says nothing about who published it.
// The one copy of that rule, here because both pages load this file (vehicle-panel.js does not
// load on carlito-bridge.html). The contract is read on first use, not at eval time: index.html
// loads this file before carlito_contract.js.
window.carlitoIsFamily = window.carlitoIsFamily || (function () {
  const cache = {};
  function signalsFor(family) {
    if (cache[family]) return cache[family];
    const sigs = (window.CARLITO_CONTRACT && window.CARLITO_CONTRACT.signals) || null;
    if (!sigs) return [];   // not cached: the contract may simply not have loaded yet
    cache[family] = sigs
      .filter(s => s.dir === 'out' && Array.isArray(s.vehicles) &&
                   s.vehicles.length === 1 && s.vehicles[0] === family)
      .map(s => s.name);
    if (!cache[family].length) {
      console.warn('Carlito: the contract declares no ' + family + '-only "out" signal, so a ' +
        family + ' can never be detected - load carlito_contract.js before the modules that ask.');
    }
    return cache[family];
  }
  return (family, t) => !!t && signalsFor(family).some(n => n in t);
})();
