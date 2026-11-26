# Module Documentation

**What lives here:** only what spans files - each module's integration points into the core,
cross-module flows, and features with no file of their own. **A module's own behaviour is
documented in the module** (header first, then its comments); read that before editing it.

Common pattern: a deferred script tag, hooks in `sloppycan.js` / `index.html` (tagged `… remove to
revert`, which are navigation aids, not a removability promise), persistence via
`collectSettings` / `applySettings` + a `window._<mod>Pending` + `window.<mod>ScheduleSave =
scheduleSave` at startup. Reuse the core's `window.*` helpers rather than copying them:
`withTxLock`, `canRelTs` / `canHexBytes` / `canParseIntAuto`, `txReady()` (open bus and not
listen-only), `fuzzTxFrame(id, isExt, dlc, bytes)` (the TX seam: gs_usb branch + `dumpLog` /
`frames` bookkeeping via `recordTxFrame`), `ingestFrame`, `canForward` (the gateway model).
Explainer pages live in `explainers/`.

---

## Tabs: integration points

| Module | Core hooks (`sloppycan.js` unless noted) |
|---|---|
| `graph.js` | `ingestFrame` → `graphIngestFrame`; `switchViewTab` + `graphOnShow`; `#frameBody` contextmenu → `graphContextMenu`; `graphSignals` persistence. `index.html`: `#vtab-graph`, `#graphWrap`, `#graphCtxMenu` |
| `fuzz.js` | `fuzzTxFrame` / `fuzzBusReady` / `fuzzObservedIds` (near `frameKey`); `switchViewTab` + `fuzzOnShow`; `disconnectSerial` → `fuzzStop`; `fuzz` key. `index.html`: `#vtab-fuzz`, `#fuzzWrap`, `#fuzzActiveBadge` (TX Scheduler header). CSS `.fuzz-*` in `assets/sloppycan.css` |
| `chademo.js` | `ingestFrame` → `chademoIngestFrame`; `clearFrames` → `chademoClear`; `switchViewTab` + `demoMaybeSwitch('chademo')`; demo engine → `chademoDemoLoopStart/Stop`. No persistence. Explainer `ev-charging-explainer.html` |
| `xcp.js` | `ingestFrame` / `clearFrames` / `disconnectSerial` → `xcpIngestFrame` / `xcpClear` / `xcpStop`; `switchViewTab` + `xcpOnShow`; `xcp` key; `window.xcpDemoActive`. Explainer `xcp-explainer.html` |
| `canopen.js` | Same four hooks as XCP (`canopen*`); `canopen` key; `window.canopenDemoActive`; demo engine → `canopenDemoStart/Stop` (a base traffic, not started on tab show). Explainer `canopen-explainer.html` |
| `dronecan-core.js` + `dronecan.js` | `ingestFrame` / `clearFrames` / `disconnectSerial` → `dronecanIngestFrame` / `dronecanClear` / `dronecanStop`; `switchViewTab` + `dronecanOnShow` + `demoMaybeSwitch` + `vehiclePanelRequestForProto('dronecan')`; demo engine → `dronecanDemoStart/Stop`, `demoInitialBaseTraffic`; `dronecan` key (`txEnabled` / `fcNode` / `led`; per-node params and the allocation table are bus state, not saved). `index.html`: `#vtab-dronecan`, `#dronecanWrap`, core then tab script after `carlito-registry.js`. `carlito-bridge.html` loads only the core, which is why the core never touches `makeStackedLogTab` / `canRelTs` / `escHtml` and carries `dcNullTab` for `dronecan.js` to replace. Explainer `dronecan-explainer.html` |
| `j1939.js` | `ingestFrame` → `j1939IngestFrame`; `clearFrames` → `j1939Clear`; `switchViewTab(name, proto)` → `j1939ProtoClick(proto)` → `demoMaybeSwitch` / `vehiclePanelRequestForProto(mode)` (only when the mode changed and took); `j1939Proto` key. Modes, request path below |

## Shared "stacked log tab" factory (`window.makeStackedLogTab`, in `sloppycan.js`)

CHAdeMO, XCP, CANopen and DroneCAN are a **top panel stacked over a scrolling frame-log table**.
The shared machinery - rAF render loop (dirty / visibility gating, ~15 fps, 1 s relative-time
tick), the log ring (append, `logMax` cap, optional same-id `coalesce`), the table builder
(empty state, near-bottom scroll-follow) and `ready()` / `showTxHint()` / `readout()` - lives once
here. A module keeps its decode, its top panel (`cfg.renderTop`), its row builder (`cfg.row`) and
its TX logic, and calls `tab.markDirty()` / `pushLog(e)` / `clearLog()` / `render()`.

`cfg = { wrapId, logElId, tableClass, theadHtml, emptyHtml, row(e), renderTop(), onTick?,
coalesce?(prev, e), renderMs=67, logMax=600, readoutElId?, txHintElId? }`. `row(e)` returns a
`renderKeyedRows` row spec (`{ cls?, cells: [html | { html, lead?, cls?, style?, title?, span? }] }`),
not HTML, so rows update in place. The pending / timer transaction machinery (`xcpPending`,
`coPending`) is deliberately **not** shared. J1939 keeps its own loop.

---

## OBD-II / J1979 (ISO-TP tab sub-mode; UI in `sloppycan.js`, decoders in `diag-parse.js`)

Toggle `#isotpModeUds` / `#isotpModeObd` / `#isotpModeKwp` via `isotpSetProtoMode`. Each mode
remembers its own Tx/Rx (`isotpModeIds`, kept fresh by `isotpIdInput`), so an emptied field is
discarded and a mode's last valid IDs return with it.

- **Request palette** (`OBD_PALETTE`, `obdInit`, `obdSend`): sends go through `isotpSend()` so
  they are logged. `Clear DTCs (04)` is `confirm()`-gated.
- **Supported-PIDs probe** (`obdProbeStart` / `obdProbeDone`): walks `01 00/20/40/60`, lights
  `#obdProbeGrid`.
- **Quick Watch** (`obdWatch*`, `#obdWatchGrid`): round-robin poller via `obdRequest({log:false})`.
- **Single in-flight rule:** gated on `isotpPendingEl || isotpRxState || isotpTxQueue.length ||
  isotpFuncMode || isotpRxMap.size`. Responses via `obdCaptureCb`, tapped in `isotpMarkDone` /
  `isotpMarkTimeout` / `isotpMarkError`.
- **Functional addressing (0x7DF):** auto-enables `isotpFuncMode`, routes to
  `isotpIngestFunctional`, accepts any responder (7E8–7EF / 0x18DAF1xx), keyed per ECU in
  `isotpRxMap` (`.isotp-ecu-tag` pills). Multi-frame FC goes to the physical ID via
  `isotpSendFCTo` + `txIdOverride` on `isotpTxCan`.
- **Persistence:** `isotp.proto` + `obdWatch` keys. Explainer `obd2-explainer.html`.

## KWP2000 / ISO 14230 (same tab, third mode)

- Own tables `KWP_SVC` / `KWP_NRC` / `KWP_DIAG_MODE`; `kwpDecode` mirrors `udsDecode`'s shape.
  `decodePayload(bytes)` dispatches on `obdProtoMode` at all three ISO-TP log decode sites.
- `buildSvcPalette(containerId, palette, sendFn)` builds both `#kwpPalette` (`KWP_PALETTE`,
  `kwpSend`) and `#udsPalette` (`UDS_PALETTE`, `udsSend`, UDS mode only). Split buttons open a
  `.svc-panel`; a param's `visibleWhen(els)` hides its row and its bytes.
- Reuses the `isotp.proto` key. Explainers `kwp2000-explainer.html`, `uds-explainer.html`.

---

## J1939 / NMEA 2000 / ISOBUS tabs (`j1939.js`)

Three view tabs (`#vtab-j1939` / `#vtab-nmea2000` / `#vtab-iso11783`) on one panel (`#j1939Wrap`):
`switchViewTab('j1939', mode)` → `j1939ProtoClick(mode)` → `j1939SetProto` (only on a change),
which swaps the dictionary (`j1939ActiveDb()`: `J1939_DB` / `NMEA2K_DB` / `ISOBUS_DB`, all in
`j1939-tables.js`), clears live state, persists and marks the mode's tab. In demo the click routes
through `demoMaybeSwitch` (switches the base traffic, prompted; declined leaves the old mode's tab
marked).

**NMEA 2000:** bit-offset field model (`{name, bo, bl, signed, scale, offset, unit, …}`, fields
straddle bytes), `n2kDecodeField` returns `j1939DecodeSPN`'s shape. **Fast Packet**
(`n2kFastPacket`, key `${pgn}:${sa}:${seq}`, first frame `data[0]&0x1F==0`, 7-byte continuations,
stale after ~1 s) reassembles through `j1939DispatchPGN(..., fromTP=true)` (FP badge). Faults
sub-tab hidden. Explainer `nmea2000-explainer.html`.

**ISO 11783:** standard TP stays on; **ETP** (`isoEtpSessions`, CM 0xC800 / DT 0xC700) for large
transfers - **DPO trap:** `byteOffset = (dpoOffset + seq − 1) × 7`, buffer capped at 256 KB. Task
Controller (57344) and VT (0xE600 / 0xE700) decode via a per-entry `decode(data)`. Explainer
`iso11783-explainer.html`.

**Demo:** `window.j1939DemoFrames()` per mode (`j1939BaseDemoFrames` / N2K / `isoDemoFrames`, which
includes a 1792-byte ETP transfer), injected by `demoInjectN2k` on the demo engine's 100 ms timer.
The base J1939 groups are built by `j1939-flavor.js`'s builders (`window.j1939FlavorFrames`, the
game's own encoders) and paced by `JF_MSGS`' J1939-71 rates (`window.j1939FlavorMsgs`).
While game telemetry is forwarded, `j1939DemoDropGameOwned` drops every group
`window.carlitoProducing()` reports plus its twins (`J1939_GAME_TWINS`), so each (PGN, SA) has one
producer.

## The J1939 request path (`j1939.js`, served for other modules)

PGN 59904 (RQST, a 3-byte little-endian PGN, to one address or 0xFF) asks for a group whose
J1939-71 rate is "On request".

- **Client:** the request controls at the right of the sub-tab bar (`#j1939ReqPgn` with its
  datalist of answerable groups, `#j1939ReqDa`) →
  `j1939SendRequest()`, from **0xF9** (J1939-81 Off-Board Diagnostic-Service Tool #1) through
  `window.canForward`, so the answer really comes back through `ingestFrame`.
- **Server:** `j1939ServeRequest`, called from `j1939IngestFrame` **before** the per-mode branches
  (the Mode dropdown decides display, not what is on the bus). The group from the server's own
  `sa`; a NACK (59392 ACKM, control byte 1) when the vehicle has no such parameter; silence with
  nothing on the link, or with a vehicle that has no J1939 network (`carlitoJ1939Network`: only
  truck and tractor are served). Answers go through `J1939Pack.claimFirst`.
- **Address Claim:** `J1939Pack.claimFirst` (`j1939-pack.js`) puts one 60928 before the first frame
  from each J1939 source (`j1939-flavor.js`, `isobus.js`, the server); the packers' `reset()` forget
  the shared ledger, so every source claims again when a bus opens. A request for 60928 is
  answered by every source in the ledger (`j1939AnswerClaims`), then the implement's server.
- **Registry** `window.j1939RequestServers`: `{ pgn, abbr, sa, prio, signals, build(t), nack? }`.
  65261 CCSS + 65253 HOURS (engine), 65258 VW (`j1939-flavor.js`, Axle - Drive #1 0x09), 60928
  Address Claim (`isobus.js`, `nack: false`). `build` gets `window.carlitoTelemetry()`, **null
  when stale** (600 ms).
- **Coverage:** `carlito.js` declares these signals `onRequest` (`CAN_MAP_ON_REQUEST` or a packer's
  `onRequest`) and cross-checks them against the registry only when `j1939.js` is loaded, so the
  bridge page reports the declaration rather than a gap.
- **Sources:** J1939-21 (request / ACK layouts, priority 6); J1939-71 (the groups). **Reading
  `j1939-71.pdf`** (text, not a scan): `pdftotext -layout` gives the PGN tables with the SPN column
  shifted a row (pair SPNs with bit positions in order); plain `pdftotext` gives the SPN
  definitions.

## DTC decoder (`explainers/dtc.html`)

Standalone lookup for OBD-II 2-byte, UDS 3-byte + status and J1939 4-byte SPN+FMI codes. Loads
`../js/diag-parse.js` and `../js/j1939-tables.js` (+ `../js/j1939-pack.js`) so its decoding cannot drift
from the app. `DTC_DB` (~500 SAE J2012 descriptions; manufacturer codes flagged, never invented);
`decodeToken` auto-detects (a bare 4-byte value shows UDS and J1939 cards); `?q=P0301` or
`?bytes=01+90+12+2F&fmt=uds` prefill it.

**In-app deep links:** `sloppycan.js` `dtcLink` / `dtcHexQ` + `.vHtml` rows at OBD Mode 03/07/0A,
UDS 0x19 and the single-DTC site; `j1939.js` `j1939RenderDM` links the SPN cell.

---

## Flavor packers: integration points

`isobus.js`, `j1939-flavor.js`, `nmea2000.js`, `cleanopen.js`, `iso11992.js`, `canaerospace.js`:
a `<script defer>` on **both** `index.html` and `carlito-bridge.html`, after `carlito-registry.js`
(and `j1939-pack.js`, which the J1939-family four use). **No hooks in `sloppycan.js`.** They
register on `window.carlitoFlavorPackers` (and the uplink registries where they own a command);
`carlito.js` calls them. The bridge page loads neither `sloppycan.js` nor `j1939.js`, so their
cross-module reads are `typeof`-guarded and their self-tests fall back to pinned vectors there.
The J1939-family frames (`isobus.js`, `j1939-flavor.js`, `nmea2000.js`, `iso11992.js`) are decoded
in the J1939 tab, so their PGNs / SPNs are entries in `j1939-tables.js`; `cleanopen.js`'s show in
the CANopen tab.

`j1939-flavor.js` is a separate file from `j1939.js` because the bridge page loads it and not
`j1939.js`. `isobus.js` / `j1939-flavor.js` share EEC1's encoder (`window.j1939Eec1Frame`):
`engine_load` (SPN 513) and the rpm (SPN 190) in one frame, sent by `isobus.js` whenever
`engine_load` is there. `j1939.js`'s demo merges its wheel and switches into VDC2 / CCVS through
`window.j1939DemoDrive`; its pedal rides the demo's own EEC2.

## Vehicle link and panels: integration points

- **`carlito.js`:** `index.html` `#carlitoBtn` + script (after the packers and panels). Uses
  `window.ramnGetState` (RAMN `key` defaults to Ignition so demo driving passes the engine gate),
  `window.canForward`, owns `carlitoOnTelemetry` (fanned out by `vehicle-panel.js`), flips
  `ramnChallengeEdge` on the game's `challenge` edges (silences demo ECUs B and C; D, which builds
  0x1BB from the 0x150 / 0x1A7 it hears, stays on; `j1939.js` stops the panel's drive while B or C
  is silent, via `ramnDriveSilenced`). `carlitoBusReady` is called on bus open (also
  by `carlito-bridge.js`). The unflavored telemetry block (`CAN_MAP`, 0x520-0x52C) goes out 11-bit,
  except on a truck or tractor (`carlitoJ1939Network`): there it is J1939 Proprietary B, PGN
  0xFF20-0xFF2C from SA 0x25, through `J1939Pack.claimFirst` (so `CLAIM_FUNCTION` needs 0x25); and
  on a boat, where it is NMEA 2000 proprietary single-frame (same PGNs and SA, no claim, data
  prefixed by the header `FF 9F`: manufacturer code 2047, industry 4 Marine).
  The fields a packer's `carriesFor(t)` names (`j1939-flavor.js`: rpm in EEC1, gear in ETC2, yaw /
  accelerations in VDC2, lat / lon in VP, odo in VDHR, …; `nmea2000.js`: heading 127250, lat / lon
  129025, yaw 127251, pitch / roll 127257, coolant 127489, fuel 127505, battery 127508, odo 128275;
  `dronecan-core.js`: pitch / roll / heading / rates / accelerations in ahrs.Solution, lat / lon /
  altitude in Fix2, battery in BatteryInfo; `canaerospace.js`: every plane signal, in CANaerospace
  NODs 300-1037 and user-range 1501-1510) go out absent (NA) there, so each signal has one carrier
  on the vehicle's bus. A drone's remaining block stays 11-bit: DroneCAN allows CAN 2.0A on its bus.
  A plane's is empty, so it sends no 0x52x (1312-1324 is CANaerospace's reserved NOD range). `carlito.js` also
  adds `J1939_DB` / `ISOBUS_DB` / `NMEA2K_DB` entries for PGN 0xFF20-0xFF2C, generated from
  `CAN_MAP`'s declarative rows (`field()`, big-endian custom `decode`), so the tabs name the block.
  Commands come in through `window.carlitoUplinkIngestFrame`, fed by
  `ingestFrameBody`, the TX mirror (`txSendOne` / `fuzzTxFrame`) and the bridge. The game side is `carlito/src/bridge/` (see `carlito/CLAUDE.md`); the
  game deploys from its own repo.
- **`ramn.js`:** `ingestFrame` → `ramnIngestFrame`; `clearFrames` → `ramnClear`;
  `disconnectSerial` → `ramnStop`; `demoTick` → `ramnCtrlPayload(id)`, returns early while
  `!ramnTrafficOn()` or `ramnIdSilenced(id)`; `demoIsoTpRespond` → `ramnUdsAnswer` (the RAMN ECUs'
  UDS routine 0x0200, also answered off the bus by `ramnIngestFrame`); `startDemo` → `ramnDemoStarted`; `demoSetBaseTraffic` → `ramnClear` on
  leaving RAMN, then `ramnSyncTrafficUI`. `txSendOne` / `fuzzTxFrame` mirror each sent frame into
  `ramnIngestFrame` and `carlitoUplinkIngestFrame`, so a frame sent by hand drives the game as a
  wire frame does. `index.html`: `#ramnBtn` (`ramnToggle()`, opens the dashboard + the Control panel;
  off demo the driving widgets hide, `ramn-live`). All DOM + CSS injected. Exposes
  `ramnVehicleSlots()` + `ramnSetTitles()` for `vehicle-panel.js`.
- **`vehicle-panel.js`:** script after `carlito_contract.js`, before every panel; every panel
  button ships `style="display:none"`. `ramn.js` `ramnSetDashOpen`; `sloppycan.js`
  `switchViewTab('dronecan')` → `vehiclePanelRequestForProto` and `reflowHeader`; `j1939.js` as
  above; the demo follows the vehicle through `vehiclePanelSubscribe` +
  `vehiclePanelProtoTable()` (`demoOnTelemetry`).
- **Controls vs status:** what the user operates lives in the Control panel, what shows state on
  a dashboard. The RAMN pair is titled after the machine on the link (`Dashboard (Truck)` /
  `Control panel (Truck)`, `RAMN` for a car); a machine's commands are a `vehiclePanelSection`
  (`where: 'ctrl'`) mounted into it, its read-backs with no dashboard of their own a `'dash'`
  section. Never a control widget on a dashboard window. The drone, which replaces the pair, has
  its own `Dashboard (Drone)` / `Control panel (Drone)`.
- **Panels** (`drone.js`, `truck.js`, `tractor.js`, `boat.js`): a script tag after
  `vehicle-panel.js` + `ramn.js` (`drone.js` also after `dronecan.js`), a toolbar button, the id in
  `sloppycan.js`'s `_buttonsWrap` list. **Sections only** (`boat-pilot.js`, `train.js`,
  `plane.js`, plus the truck / tractor commands): a script tag, no button. Everything else through `window.vehiclePanel*` and the uplink registries. Not loaded on
  `carlito-bridge.html` (`carlito-bridge.js` sets `window.droneIsOpen = () => true`).

## Script link (`script-link.js`)

`sloppycan.js` `ingestFrameBody` (at its top) and `recordTxFrame` → `scriptLinkFrame`; inbound
via `window.canForward`. `index.html` `#scriptBtn` + `#scriptLinkStatus`. Relay, client helper and
examples in `scripting/`. `carlito.js` `setChallenge` → `scriptLinkInfo`: the game envelope's
challenge edges as `#challenge` info lines (`challengeInfoLines`). A script's `#challenge open
<id>` → `onScriptInfo` → `carlitoOpenChallenge`: a live `carlitoCommand` (the `?challenge=` link if shut).

## CAN Signals explainer (`explainers/can-signals-explainer.html`)

Standalone (no app import). One link in: the `<a href="can-signals-explainer.html?bits=…">` in
`inspectFrame`'s "Bitstream with Bit Stuffing" title. Its deliberate design choices are in the
page's own comments.

## TODO

- **Worker RX pump.** The Carlito iframe is same-site, so it shares the app's main thread: a level
  load stalls `readLoop` / `usbSerialPump` (`can-link.js`), RAMN's USB buffer overflows and the
  board closes the channel. Move the read pump to a dedicated Worker (Web Serial and WebUSB both
  work there) and post parsed frames to the page; the bridge reuses the transport too. Stopgap
  now: the SLCAN re-open watchdog in `sloppycan.js` (re-sends `O`/`L` when no RX frame arrives for 2 s, only within 5 s of a main-thread stall).
  Budget (RAMN GitHub firmware, default traffic): ECU A receives ~370 frames/s × 22 B ≈ 8.1 kB/s
  into a 15 000 B USB TX stream buffer (full in ~1.8 s), then one `xStreamBufferSend` waits 2 s
  before `CLOSE_DEVICE_ON_USB_TX_OVERFLOW` closes SLCAN: **~3.8 s without host reads**, a bit more
  with host-side and 2 kB staging buffers. Desktop Web Serial now opens with a 1 MB `bufferSize`
  (`SERIAL_BUFFER_SIZE`, `can-link.js`), which the browser fills during a stall; Android WebUSB
  still needs the Worker. Queuing several `transferIn` does not help: each completes on RAMN's
  next short packet (~1 frame), so a queue is used up in milliseconds.
- **RAMN demo ↔ physical board parity.** Challenges (by hand or by solver) should feel the same in
  Demo as on a RAMN; not yet audited end to end. Trust the board's firmware (`RAMN_HF25_priv`) and
  the DBC over the GitHub tree, which byte-swaps every 16-bit signal (0x1A7 read reversed). Known gaps:
  - A challenge silences demo ECUs B and C itself; on the board only a script's `31 01 02 00` does,
    so a hand-driving player there fights B and C's frames.
  - Demo 0x1BB never sets the battery bit (firmware: ECU D's own key at On / Ignition) nor check
    engine on CAN errors.
  - The panel key defaults to Ignition; the board's is wherever the physical key is.
  - Demo frames ride a 100 ms `setInterval` (drifts); the board's flasher is a firm 1 Hz.
