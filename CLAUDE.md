# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based CAN bus monitor for **SLCAN** and **gs_usb** (candleLight / CANable / RAMN) USB-to-CAN adapters. No build step, no dependencies, no backend required. Open `index.html` directly in Chrome or Edge (Web Serial API required on desktop; Android Chrome uses a WebUSB fallback). The adapter protocol is chosen with the **Adapter** dropdown (`SLCAN` / `gs_usb`); gs_usb is WebUSB-only.

## Running Locally

Open `index.html` directly in Chrome/Edge. Web Serial API requires `file://` or HTTPS:

```
python -m http.server 8000
# open http://localhost:8000/index.html
```

Web Serial works from `file://` or `localhost`; HTTPS is only needed to reach the page from another device on the network.

Demo mode (no hardware): click the **Demo** button.

## Architecture

Core files:

- **`index.html`** - layout skeleton and inline styles; links CSS and JS
- **`sloppycan.css`** - dark theme, CSS variables, component styles (~1840 lines)
- **`sloppycan.js`** - all application logic (~4700 lines), structured with `// ── Section ──` comments
- **`can-link.js`** - shared CAN transport layer (gs_usb + SLCAN device open / RX pumps / frame parse / serialized write), split out of `sloppycan.js`. Loaded (non-`defer`) **before** `sloppycan.js`; all three core scripts share one global lexical scope, so the connection state (`connMode`/`port`/`usbSerDev`/`busIsOpen`/…) and primitives it declares are the same bindings `sloppycan.js` references. Reused as-is by the standalone bridge (see below)
- **`diag-parse.js`** - pure OBD-II / UDS / KWP2000 payload decoders + reference tables (~420 lines), split out of `sloppycan.js`. Loaded (non-`defer`) immediately **before** `sloppycan.js` because the core's DIAG-MODE palettes read these tables at eval time

Standalone page (not part of the SloppyCAN app, no link to/from it):

- **`carlito-bridge.html`** + **`carlito-bridge.js`** - a minimal RAMN↔Carlito bridge for users who bring their own CAN tooling. Loads `can-link.js` (transport) + `ramn.js` (decode → `ramnGetState`) + `carlito.js` (the game link), with `carlito-bridge.js` supplying small host shims (`log`/`ingestFrame`/`connectSerial`/`disconnectSerial`/`canForward` + the connect bar). It just decodes RAMN control frames into the embedded game and forwards the game's telemetry (`0x520`–`0x528`) back onto the wire - no dashboards, tabs, demo, or workspaces. Connect bar offers gs_usb + SLCAN; Carlito opens automatically on connect

Optional bolt-on modules (deferred scripts; integration hooks live in the core files, and modules may share core helpers exposed on `window.*`):

| File | Tab / feature |
|------|---------------|
| `j1939.js` | J1939 / N2K / ISOBUS tab. Also owns **the J1939-21 request path** (PGN 59904 in, the parameter group or a 59392 NACK back out) - the handful of J1939-71 groups whose transmission repetition rate is "On request" have no periodic frame by design, so there is no way to see one without asking. Two are registered on `window.j1939RequestServers` and answered out of `window.carlitoTelemetry()`: **65261 CCSS** (SPN 74 -> `speed_limit`) and **65253 HOURS** (SPN 247 -> `engine_hours`), which is what retired both signals' coverage opt-outs. `j1939EncodeSPN` is the exact inverse of `j1939DecodeSPN` and reads the same `J1939_DB` descriptors, so there is no second scale table. Three outcomes, all deliberate: the group, a NACK when the vehicle has no such parameter, or **silence** when nothing is on the link. Also **sources the three J1939-73 DM1 lamp states** onto `carlito.js`'s uplink (`red_stop` / `amber_warn` / `protect_lamp`, four-state selectors in the tab): the contract carries them as plain bools and THIS SIDE OWNS THE FLASH RATE (`j1939LampBit`), because J1939-73's flash-1Hz / flash-2Hz lamp states are urgency and a rate is a property of the source. The game has no blink timer for any lamp. Must load **before** `carlito.js` |
| `graph.js` | Graph tab |
| `fuzz.js` | Fuzzing tab |
| `chademo.js` | CHAdeMO tab |
| `xcp.js` | XCP-on-CAN tab |
| `canopen.js` | CANopen tab |
| `dronecan.js` | DroneCAN tab: a real DroneCAN (UAVCAN v0) transfer encoder (29-bit ids, tail byte, multi-frame CRC) + transfer reassembly/decode, carrying **all three transfer kinds** - broadcast messages, addressed **services**, and **anonymous** messages (`dcParseAnyId` is the one place that decides which an id is, and it returns the reassembly key with it: a service keys on *both* node ids and a direction, an anonymous transfer is single-frame by construction because there is no source id to key on). The services are `uavcan.protocol.GetNodeInfo` (1), `RestartNode` (5) and `param.GetSet` (11), served **out of `DC_ROSTER` and the per-node NodeStatus this module already publishes** - a service is a bus concept, not a game-state concept, so **none of it touched the contract**. A node that is not publishing answers nothing (the same silence a failed node gives); a RestartNode acknowledges and then really leaves the bus for `DC_REBOOT_MS` before returning at `uptime_sec` 0; `uavcan.node.status_period_ms` is a real writable parameter, which is why the NodeStatus sweep is per node. The client is a maintenance tool at node **127** (DroneCAN reserves 126/127 for tools) and never retries - an unanswered request is information. **Dynamic node ID allocation** has both ends here and they talk **over the bus**: the allocatee emits real anonymous transfers, six unique-id bytes at a time, and the allocator's grant comes back through `ingestFrame`. Also the **flavor packer** for the contract's `dronecan`-flavored signals - `esc.Status` / `BatteryInfo` / `Fix2` / `range_sensor.Measurement` / `ahrs.Solution` / `ArmingStatus` / `hardpoint.Status` / `camera_gimbal.Status` / `air_data.StaticPressure` / `air_data.RawAirData`, plus one `NodeStatus` (341) per ONLINE node at 1 Hz from an 8-entry **node roster** (`DC_ROSTER`, the one place a node id is declared; its length is asserted against the contract's `node_health` count). An offline node - `node_online` bit clear - **stops publishing**, which is the whole reading. The tab also carries the bench controls for the drone's inbound signals (`node_fail` by clicking a roster row, `flight_mode`, `led`, `beep`, `hardpoint_cmd`, `gimbal_pitch`/`gimbal_yaw`), contributed to `carlito.js`'s uplink through `window.carlitoUplinkSources`; `led`/`beep`/`hardpoint_cmd`/the gimbal pair additionally emit `LightsCommand` (1081) / `BeepCommand` (1080) / `hardpoint.Command` (1070) / `camera_gimbal.AngularCommand` (**1040**, not 1042) **and** `actuator.ArrayCommand` (1010) from the FC node **on change only**. **Data type ids come off the DSDL file names and signatures off `pydronecan`, never off a plan document** - the method is validated by re-deriving the nine that were already in `DC_MSGS` and getting them back identical, which is the only reason a new one can be trusted (a wrong signature is invisible on a single-frame transfer and produces frames this decoder accepts on a multi-frame one). The hardpoint, gimbal and air-data peripherals publish from the FC node rather than roster entries of their own, because the roster IS the contract's `node_health` index space - so `node_fail` cannot take them off the bus, a stated limitation rather than an oversight. Loads after `carlito_contract.js`, **before** `carlito.js` |
| `isobus.js` | **Flavor packer only, no tab** - the contract's `isobus`-flavored signals as real ISO 11783-7 / SAE J1939 frames: `WBSD` (65096) / `GBSD` (65097) / `RPTO` (65091) / `RHS` (65093) from the Tractor ECU at SA 240, `EEC2` (61443, SPN 92) from the engine, `EAC1` (61446, SPN 569) and `FWD` (64991, SPN 2612) from the axles at 500 ms, and the implement's **Address Claim** (60928) whose NAME device class IS `implement_type` - sent ON CHANGE, because attaching *is* the claim and J1939 has no "unclaim". `wheel_slip` is declared `unpackable` (no SPN exists for it); `engine_hours` is declared `onRequest`, because PGN 65253 is request-only and it is j1939.js's request path that answers it. Gated **per signal, not per vehicle** - `engine_load` / `pto_state` / `engine_hours` are the truck's too. ISOBUS is J1939 on the wire, so `j1939.js` renders every frame (Mode ▸ ISO 11783) and there is no second view. Self-test: `window.isobusSelfTest()`. Loads after `carlito_contract.js`, **before** `carlito.js` |
| `j1939-flavor.js` | **Flavor packer only, no tab** - the contract's `j1939`-flavored signals as real SAE J1939 parameter groups: `ERC1` (61440) @100 ms from **Retarder - Driveline SA 0x10** (SPN 520 <- `retarder_state`) and `AIR1` (65198) @**1 s** from **Brakes - System Controller SA 0x0B** (SPN 1087/1088 <- `air_primary`/`air_secondary`). **The only flavor whose layout is entirely LOOKED UP** - every signal has a real SPN, so no proprietary id is invented for any of them, and every number came off SAE J1939-71 itself. **SPN 520 is negative and the contract's signal is a magnitude** (the dashboard bar would fill backwards otherwise), so the packer negates it - that is the one place the sign lives. SPN 900 Retarder Torque Mode is written **only** for mode `0000b`, the one value J1939-71 states in text; the rest are TABLE SPN899_A, a *figure*, so anything else leaves the field "not available" rather than claiming a mode this file never read. `axle_load` is declared `onRequest`: PGN **65258 VW** is request-only and `j1939.js` answers it from **Axle - Drive #1 (0x09)**, not the engine - the first request server that is not an engine function, which is why that path's "it is *X* that carries this one" note now reads the server's own `sa`. **NOT folded into `j1939.js`**, because `carlito-bridge.html` loads this and not that, and the truck would lose its frames there. Self-test: `window.j1939FlavorSelfTest()`. Loads after `carlito_contract.js`, **before** `carlito.js` |
| `ramn.js` | RAMN dashboard (floating instrument-cluster window) + RAMN Control Panel (demo-only driving window) |
| `carlito.js` | Carlito game link - floating window embedding the Godot game (loaded from one of two hardcoded channels, `…/carlito/stable/` or `…/carlito/dev/`, picked by the header selector / `?carlitoBuild=` / auto-pair on a `/dev/` path); sends all RAMN controls into it (drive + handbrake/ignition/headlights) and emits the car telemetry it sends back as CAN `0x520`–`0x528` (50/100 ms) via `window.canForward` - ingested once for the dashboards and, when a bus is open, transmitted on the wire and shown as a single `FW` (forward) dump entry (gateway model: counts as RX+TX; plain RX when no bus). Closing the window tears down the iframe (stops the game). Consumes `window.CARLITO_CONTRACT` (from `carlito_contract.js`, loaded first) for the message field names + CAN-map coverage check; sends gear `R` as `0xFF`; both sides `console.warn` once on contract-version mismatch. Game-side bridge lives in the `carlito` repo |

OBD-II, KWP2000, UDS, DTC decoder, NMEA 2000, and ISOBUS are sub-modes implemented inside the core files or `j1939.js` - no separate feature module (the OBD/UDS/KWP payload **decoders + tables** live in the core-split `diag-parse.js`; the sub-mode UI controllers stay in `sloppycan.js`).

Many module integration hooks in the core files carry `// … remove to revert` comments. Treat these as navigation aids that mark where a module plugs in - not a hard "every module must be independently removable" contract. Modules may depend on shared core helpers (e.g. `window.withTxLock`, `window.canRelTs`/`canHexBytes`/`canParseIntAuto`, `window.txReady`, `window.fuzzTxFrame`); prefer reusing those over re-implementing per module.

Standalone reference pages live in `explainers/`: `isotp-explainer.html` (+ `isotp-2016.html`, ISO 15765-2:2016 large-payload extensions), `obd2-explainer.html`, `kwp2000-explainer.html`, `uds-explainer.html`, `nmea2000-explainer.html`, `iso11783-explainer.html`, `ev-charging-explainer.html`, `xcp-explainer.html`, `canopen-explainer.html`, `dronecan-explainer.html`, `dtc.html` (DTC decoder), `can-signals-explainer.html` (ground-up CAN walkthrough: bus schematic → editable bitstream → two-way frame parse table → physical-layer oscilloscope → arbitration waveform; linked from the Frame Inspector's bitstream). Each is self-contained (only external dependency: Google Fonts).

## Conventions & gotchas

- **Shared global scope:** `can-link.js`, `diag-parse.js`, and `sloppycan.js` are classic (non-module) scripts sharing one global lexical scope — a `let`/`const`/`function` declared in one is the same binding everywhere. **Never redeclare a name across them** (a duplicate `let` is a SyntaxError that spans scripts). Bolt-on modules are `defer`red and talk to the core via `window.*`.
- **Untrusted bus data → escape before the DOM:** CAN ids, payload bytes, and decoded ASCII/DTC strings are device-controllable. Route them through `escHtml()` (escapes `& < > " '`) or `textContent` before any `innerHTML`/attribute interpolation. `log()` already escapes its whole message — don't double-escape into it.
- **Flavored contract signals are packed by their flavor module, not by `CAN_MAP`:** the contract's
  `flavor` field borrows a protocol's signal names/semantics "without implementing its CAN frames -
  frame layout stays on the sloppyCAN side". That layout lives in the protocol's own module, which
  pushes `{ flavor, signals, pack(t, slow) }` onto `window.carlitoFlavorPackers` (plus an optional
  `unpackable: { signal: reason }` - signals it declares it will never pack - and an optional
  `onRequest: { signal: reason }` - signals carried by a parameter group that only exists when
  something asks for it. The coverage check subtracts both from the gap list and reports each on
  its own line, because "nothing carries this, by decision" and "there is a frame for this the
  moment you ask" are different claims) and must therefore be
  loaded **before `carlito.js`**. The inbound mirror of this is `window.carlitoUplinkSources`: a
  module that owns a control for a contract "in" signal registers `{ name: () => value }` there and
  `carlito.js`'s contract-driven uplink picks it up (one signal, one source - a name in both that map
  and `IN_SOURCES` warns). `carlito.js`'s `checkCanCoverage()` holds `CAN_MAP` to exactly the
  *unflavored* "out" signals and each registered packer to its own flavor's; a flavor with no packer
  loaded is silent. `dronecan.js` is the first such module, `isobus.js` the second, `j1939-flavor.js` the third.
- **A packer's PGN/SPN numbers come off a primary source, never off a plan document** — the same
  rule `dronecan.js` follows for DSDL ids and signatures, and it earns its keep: writing
  `isobus.js` found four wrong tables in `j1939.js` (0xFE43/0xFE45 had the rear PTO and rear hitch
  **swapped**, EEC1 carried SPN 91/92 where J1939-71 has 512/513, `J1939_SA` had the axles at
  0x21–0x23 instead of 0x08–0x0A, and `j1939DecodeName` read the NAME's industry group and
  self-configurable bit three bits low) — plus the front PTO/hitch SPNs, which had been filled in
  by pattern from the rear ones and were wrong to a man. All were corrected in the same change,
  along with `isoDemoFrames()` and the explainer, which had been built to match them. The sources
  are the ISOBUS Data Dictionary (isobus.net — its PGN/SPN and SourceAddress tables), J1939-71 and
  J1939-81 — **not** web-search summaries or a DBC of unknown provenance, both of which
  contradicted the dictionary during that work. `j1939-flavor.js` is the same rule paying off
  again: all three of its groups (ERC1 61440, AIR1 65198, VW 65258) were read straight out of
  J1939-71 and added to `J1939_DB` with their neighbouring SPNs. It also shows where the rule
  **stops**: SPN 900's mode names are a *figure* in that document, not text, so the packer writes
  only the one mode the prose states and leaves the field "not available" otherwise.
- **`carlito_contract.js` is generated, not hand-edited:** it sets `window.CARLITO_CONTRACT` and is a committed synced copy of the `carlito` repo's canonical `contract/carlito_contract.json`. Regenerate from the carlito repo (`node tools/gen_js_contract.mjs`), not here. It must load before `carlito.js` (script tags already ordered in `index.html` + `carlito-bridge.html`). The runtime version-mismatch warning is the drift guard (no CI here).
- **A contract change is a paired change across two repos.** The game and sloppyCAN agree by version number, so a bump lands on the `dev` branch of **both** `carlito` and `sloppycan` together, and both get promoted to stable together. Promoting one alone puts a live stable pair on mismatched versions — the runtime warning fires and signals are misread.
- **Verifying changes:** there is no test suite. Syntax-check with `node --check <file>.js`; verify behaviour by opening `index.html` and using **Demo** mode (no hardware needed). Navigate `sloppycan.js` by its `// ── Section ──` headers (map in `core-arch.md`). CI runs the `node --check` sweep plus a sanity load of `carlito_contract.js`; everything else is verified by driving.

## Deploy — two channels

Both channels are served from the `gh-pages` branch, which CI rewrites as a single orphan
commit and force-pushes (nothing in that history is worth keeping):

| | URL | Updated by |
|---|---|---|
| stable | <https://leaukojo.github.io/sloppycan/> | *Promote dev → stable* (manual) |
| dev | <https://leaukojo.github.io/sloppycan/dev/> | every push to `dev` |

Stable sits at the **gh-pages root**, not in a `stable/` subdirectory — unlike carlito, which
needs sibling dirs under a redirect page because its PWA service-worker scopes would nest and
intercept each other. sloppyCAN ships no service worker, so there is no scope to nest and
stable keeps the root URL already published in the README.

Promotion **copies the published `/dev/` bytes**, never re-copies from the branch, so what you
approved on dev is what goes stable. Ritual: Actions → *Promote dev → stable* → Run workflow.
Paired with carlito's promote whenever the contract version moved (see above).

**The Carlito window auto-pairs channels:** sloppyCAN served from a path containing `/dev/`
defaults to the dev game, everything else to stable — so `/sloppycan/dev/` drives
`/carlito/dev/` without anyone selecting anything. The header selector and `?carlitoBuild=`
override that; a `?carlitoUrl=` local override replaces both and hides the selector.

## Detailed references

- **[.claude/core-arch.md](.claude/core-arch.md)** - script section list, key data structures, gs_usb wire-format, byte colour semantics.
- **[.claude/modules.md](.claude/modules.md)** - per-module docs for graph, fuzz, OBD-II, KWP2000, NMEA 2000, ISOBUS, DTC, CHAdeMO, XCP, CANopen (integration points).
