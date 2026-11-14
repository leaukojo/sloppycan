// ── Carlito registries: created once, before anything registers ───────────────
// Every registry the Carlito link reads, created empty here so that WHO loads first stops
// mattering: a module registering and carlito.js reading both hold the same object, whatever the
// script order. (carlito.js used to snapshot `window.x || {}` as it evaluated, and a fallback made
// then was detached from window - every later registration was silently lost.) carlito.js runs its
// coverage and clash checks on DOMContentLoaded, after every deferred script.
//
// Load (defer) before every module that registers, on both pages. Reads nothing at eval time.
// Modules keep their own `window.x = window.x || ...` lines; with this loaded they are no-ops.
// carlitoUplinkClaim has no such fallback: a module that claims needs this file loaded first.

// { signal: () => value } - a protocol module's own control for a contract "in" signal. One
// signal, one source: a name here AND in carlito.js's RAMN IN_SOURCES warns.
window.carlitoUplinkSources = window.carlitoUplinkSources || {};
// { signal: [ { prio, fn: (st) => value | undefined } ] } - temporary CLAIMS on a shared axis,
// asked before any source, highest prio first; `undefined` declines to the next. Register through
// carlitoUplinkClaim, never by assigning. THE PRECEDENCE, stated once (higher wins):
//   20  drone.js        the Drone Control panel's sticks, while it is flying
//   10  j1939-flavor.js bus driver demand (EEC2 / EBC1 / VDC2 / TC1 / CCVS), while fresh
window.carlitoUplinkOverrides = window.carlitoUplinkOverrides || {};
window.carlitoUplinkClaim = window.carlitoUplinkClaim || function (name, prio, fn) {
  const list = window.carlitoUplinkOverrides[name] = window.carlitoUplinkOverrides[name] || [];
  list.push({ prio, fn });
  list.sort((a, b) => b.prio - a.prio);
};
// [ frame => void ] - a module reading its own command off the bus into its own state.
window.carlitoUplinkDecoders = window.carlitoUplinkDecoders || [];
// [ { flavor, signals, pack(t, slow), unpackable?, onRequest?, mirrors?, reset? } ] - a flavor's frame
// layout; reset() forgets what it has announced (carlito.js calls it on bus open and link end/resume).
window.carlitoFlavorPackers = window.carlitoFlavorPackers || [];
// [ { pgn, abbr, sa, prio, signals, build(t), nack? } ] - a J1939 parameter group answered on request;
// nack: false makes a null build() silence rather than a NACK (a control function that is not there).
window.j1939RequestServers = window.j1939RequestServers || [];

// ── A contract signal by (name, dir) ────────────────────────────────────────
// The one lookup every module uses rather than walking CARLITO_CONTRACT.signals itself. Indexed on
// the first call that finds the contract loaded, never at eval time (both pages load this file
// before carlito_contract.js); null for a signal the contract lacks.
window.carlitoSig = window.carlitoSig || (function () {
  let index = null;
  return (name, dir) => {
    if (!index) {
      const sigs = window.CARLITO_CONTRACT && window.CARLITO_CONTRACT.signals;
      if (!sigs) return null;   // not indexed: the contract may simply not have loaded yet
      index = new Map(sigs.map(s => [s.name + '|' + s.dir, s]));
    }
    return index.get(name + '|' + dir) || null;
  };
})();
// A bitfield bit's MASK by contract name: carlitoBit('status', 'brake_light') === 1 << 8. The
// layout is the signal's `bits` table (index -> name), so no module hand-types a bit number. A bit
// the contract does not declare warns once and is 0: a mask that never matches, not a wrong bit.
window.carlitoBit = window.carlitoBit || (function () {
  const warned = new Set();
  return (name, bit) => {
    const sig = [window.carlitoSig(name, 'out'), window.carlitoSig(name, 'in')].find(s => s && s.bits);
    const key = sig && Object.keys(sig.bits).find(k => sig.bits[k] === bit);
    if (key !== undefined) return 1 << +key;
    if (!warned.has(name + '.' + bit)) {
      warned.add(name + '.' + bit);
      console.warn(`Carlito: contract '${name}' declares no bit '${bit}' - it reads as never set.`);
    }
    return 0;
  };
})();
// The tallest drive byte: the top of the contract `gear` enum's '1-N' key, so a panel and a decoder
// follow the bus rather than a literal. 6, RAMN's own MAX_GEAR_VALUE, with no contract loaded.
window.carlitoGearTop = window.carlitoGearTop || (() => {
  const sig = window.carlitoSig('gear', 'in');
  const key = sig && sig.enum && Object.keys(sig.enum).find(k => /^1-\d+$/.test(k));
  return key ? +key.split('-')[1] : 6;
});

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
// The families with a J1939 network: the truck and the tractor. The one copy of that list, read by
// j1939-flavor.js's mirrors and j1939.js's request server (a car or a boat has no J1939 ECU to answer).
window.carlitoJ1939Network = window.carlitoJ1939Network ||
  ((t) => window.carlitoIsFamily('truck', t) || window.carlitoIsFamily('tractor', t));
