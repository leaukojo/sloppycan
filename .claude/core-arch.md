# Core Architecture Reference

## Files & load order

`index.html` loads scripts in this order: the bolt-on modules (`j1939.js` … `carlito.js`, all
`defer`), then **`can-link.js`** (non-defer), **`diag-parse.js`** (non-defer), then
**`sloppycan.js`** (non-defer). Non-defer scripts run during parse, before the deferred modules,
and share one global lexical scope. So `can-link.js` + `diag-parse.js` evaluate immediately
before `sloppycan.js`, which is required (see coupling notes below).

## `can-link.js` - shared CAN transport (gs_usb + SLCAN)

The device/protocol layer, carved out of `sloppycan.js` so the standalone
`carlito-bridge.html` can reuse it without booting the whole app. Declares the connection
**state + consts** (`connMode`, `port`/`reader`, `usbSerDev`/`usbSerIn`/`usbSerOut`, `busIsOpen`,
`frameBuffer`/`termBuffer`, `gsFclk`/`gsIface`/`gsEchoId`/`gsBtConst`, `serialWriteChain`,
`recentTx`, `GSUSB_FILTERS`/`GS_BREQ`/`GS_MODE`/CAN flag+mask consts, `SLCAN_BITRATE_HZ`,
`SERIAL_USB_FILTERS`, `_onAndroid`, `HEX_STR_RE`, `USB_MAX_STALLS`) and the **functions**
`getBitrateHz`, `openGsUsb`/`openWebUSBCDC`, `gsBitTimingPass`/`gsCalcBitTiming`/`gsSetBitTiming`/
`gsSetMode`, `usbRecoverStall`, `gsUsbPump`/`usbSerialPump`/`readLoop`, `dispatchSerialText`/
`processBuffer`/`parseSLCAN`/`escRawLine`/`isHexStr`/`hexToBytes`, `gsUsbPackFrame`, `encodeCmd`,
`sendCommand`/`sendCommandRaw`/`recentTxPush`.

Because all three core scripts share global scope, these are the SAME bindings the rest of
`sloppycan.js` reads - the carve-out needed **no** call-site edits in `sloppycan.js`. The host
side (UI orchestration) stays in `sloppycan.js`: `connectSerial`, `disconnectSerial`, `busOpen`/
`getOpenCmd`/`getBaudCmd`, `hwConnectWarning`, `requireBusForCarlito`, `resetConnectionState`,
`updateBusPauseBtn`, plus the TX-scheduler glue `txTransmitRaw`/`txBuildSlcan`/`gsUsbBuildFrame`/
`txDataBytes` (which call the now-moved `gsUsbPackFrame`/`sendCommand`). The functions in
`can-link.js` reference, **at call time only**, host globals each page provides: `log`,
`ingestFrame`, `paused`, `demoMode`, `terminalMode`/`termLog`, `escHtml`, `parseErrors`/
`totalFrames`/`frameRateBuffer`/`bytesReceived`, `disconnectSerial`, and DOM ids
`#statBytes`/`#deviceInfo`/`#baudRate`.

**Standalone bridge:** `carlito-bridge.html` + `carlito-bridge.js` load `can-link.js` + `ramn.js`
+ `carlito.js` and supply those host globals as minimal shims (no SloppyCAN UI). See the project
`CLAUDE.md`.

## `sloppycan.js` section map (line numbers - use `offset`/`limit` Read, don't load whole file)

The file is ~5000 lines of top-level globals (no module wrapper). Navigate by these `// ── … ──`
section headers. Line numbers drift as the file is edited - re-grep `^// ── ` if an offset misses.

| Line | Section |
|------|---------|
| 1    | Architecture Overview (header comment) |
| 82   | gs_usb (candleLight / CANable-native) constants |
| 195  | Ring buffer (O(1) push, oldest-first) |
| 270  | TX Scheduler |
| 690  | Fuzzer hooks (for `fuzz.js`) |
| 732  | Utilities (`escHtml`, `log`, …) |
| 737  | Connection / bus state reset |
| 878  | "All frames filtered out" notice |
| 1177 | gs_usb transport |
| 2016 | View tabs (ID List / Traffic Dump) |
| 2249 | Frame Inspector |
| 2656 | Notch · 2805 Resize handle |
| 2842 | Demo Mode · 2913 Demo base-traffic engine |
| 3162 | ISO-TP / UDS · 3293 Functional addressing · 3346 RX state machine · 3424 Functional-addr RX |
| 3552 | (seam) OBD/UDS/KWP parsers → **`diag-parse.js`** |
| 3559 | DOM helpers · 3793 Send |
| 3851 | OBD-II / SAE J1979 sub-mode · 4233 Supported-PIDs probe · 4265 Quick Watch |
| 4396 | Theme toggle · 4411 CSV Export |
| 4447 | Workspaces & persistence (4614 UI prefs · 4632 Save · 4655 Workspace ops) |
| 4852 | Startup · 4934 Onboarding spotlight arrow |

## `diag-parse.js` - OBD-II / UDS / KWP2000 decoders + tables

Pure payload decoders (no DOM ownership, no bus state) extracted from `sloppycan.js`. All globals.

| Line | Section |
|------|---------|
| 15   | OBD-II / ISO 15031 / SAE J1979 - `OBD_MODE`, `OBD_PID01/09`, `obdM01Value`, `obdDecode` |
| 163  | UDS / ISO 14229-1 - `UDS_*` tables, `udsH`/`udsBytesHex`/`udsDTC*`/`dtcLink`/`udsMemAddr`, `udsDecode*`, `udsSection`/`udsToggle` |
| 319  | KWP2000 / ISO 14230 - `KWP_*` tables, `kwpAscii`, `kwpDecode`, `decodePayload` dispatcher |

## Module coupling (why only diag-parse split out)

- **`sloppycan.js` = CORE-IO hub.** Owns DOM, bus state, ingestion, rendering, the ISO-TP transport,
  and the OBD sub-mode controller. The bolt-on modules hook *into* it; it's the centre of the graph.
- **`diag-parse.js` = leaf.** Reaches back into core only for `escHtml` (DOM helper, `sloppycan.js`
  line ~732) and `obdProtoMode` (the UDS/OBD/KWP mode flag) - **both read at call time**, so they
  resolve fine even though core loads *after* diag-parse. This one-way, near-zero coupling is what
  made it the only clean split boundary.
- **Eval-time dependency (the load-order rule):** `sloppycan.js`'s DIAG-MODE palettes `KWP_PALETTE`
  / `UDS_PALETTE` (~line 4060) reference `KWP_DIAG_MODE` / `UDS_SESSION` / `UDS_RESET` / … as array
  literal values **at eval time**. Those tables live in `diag-parse.js`, so it **must** load first.
- **ISOTP ↔ OBD-sub-mode cycle (NOT split):** the OBD/UDS/KWP sub-mode controller (the "Send"/sub-mode
  sections, ~3793–4395) is in a true dependency cycle with the ISO-TP transport (~3162–3551) - each
  calls the other. Splitting it would only relocate coupling and add load-order risk, so it stays in
  core. diag-parse is the *only* acyclic carve-out.

## Other `sloppycan.js` landmarks

- Serial layer - orchestration `connectSerial`/`disconnectSerial` in `sloppycan.js`; the
  transport primitives (`readLoop`, `parseSLCAN`, Android `openWebUSBCDC`/`usbSerialPump`,
  gs_usb `openGsUsb`/`gsUsbPump`/`gsCalcBitTiming`/`gsSetBitTiming`/`gsSetMode`/`gsUsbPackFrame`)
  now live in **`can-link.js`** (shared). `gsUsbBuildFrame` (TX-scheduler glue) stays in `sloppycan.js`.
- Frame ingestion - `ingestFrame`; rendering - `rerenderTable`, `renderDump`, RAF loop.
- TX Scheduler - `renderTxRows`, `txBuildSlcan`, `txSendOne`, `txSendOnce`.
- Frame Inspector - `inspectFrame`, CRC-15, bit stuffing. Demo - `startDemo`, `demoTick`,
  CRC-32/ISO-HDLC, base-traffic engine.

## Demo base-traffic engine

Demo splits traffic into **base** (continuous) vs **diagnostic** (request/answer). Exactly
one base traffic runs at a time, tracked by `demoBaseTraffic` (`'ramn'` default | `'j1939'` |
`'nmea2000'` | `'iso11783'` | `'chademo'` | `'canopen'`).

- `demoStartBaseTimers()` / `demoStopBaseTimers()` start/clear the active generator's timers
  (RAMN = `DEMO_CONFIG` ticks; j1939 family = `demoInjectN2k` 100 ms timer pulling
  `window.j1939DemoFrames()`; chademo = `window.chademoDemoLoopStart/Stop`; canopen =
  `window.canopenDemoStart/Stop` continuous node). `startDemo` + both `busPauseClick`
  open/pause/resume branches go through these.
- `startDemo` picks the initial base via `demoInitialBaseTraffic()` (reads the active view tab
  - pressing Demo on the J1939/CHAdeMO/CANopen tab starts that traffic with **no** prompt).
- `demoSetBaseTraffic(kind)` swaps generators (and calls `window.j1939SetProto` for a j1939 mode).
- `window.demoMaybeSwitch(kind, label)` is the prompt: no-op outside demo / if already active;
  else two `confirm()`s (switch? then clear buffer?) → `clearFrames()` + `demoSetBaseTraffic`.
  Called from `switchViewTab` (j1939 + chademo + canopen branches) and `j1939ProtoClick` (toggle).
  Returning to RAMN requires a page reload.
- `window.demoIsActive = () => demoMode` lets modules gate the switch (used by `j1939ProtoClick`).
- Plain-J1939 demo frames come from `j1939BaseDemoFrames()` in `j1939.js`.

## Key data structures

```js
frames: Map<frameKey, { id, isExt, isRtr, dlc, data: number[],
  byteChangedAt: number[], count, firstSeen, lastSeen,
  timestamps: number[], hasRx, hasTx }>

dumpLog: RingBuffer(100000) of { ts, isTx, id, isExt, isRtr, dlc, data }

notchedBytes:  Map<frameKey, Set<byteIndex>>
stableBytes:   Map<frameKey, Map<byteIndex, value>>
notchSnapshot: Map<frameKey, { ts: number[], data: number[] }>
frameNotes:    Map<frameKey, string>   // survives clear
```

`frameKey` is `"E:<id>"` (29-bit) or `"S:<id>"` (11-bit).

## gs_usb transport

The `connMode` global (`'serial'` | `'gsusb'`) selects the active transport; `'serial'` covers
both Web Serial and the Android CDC path, `'gsusb'` is the binary WebUSB protocol. gs_usb reuses
`usbSerDev`/`usbSerIn`/`usbSerOut` for the device + bulk endpoints, so `disconnectSerial` and the
`updateBusPauseBtn` connection check work unchanged. RX/TX/open/close branch on
`connMode === 'gsusb'`; `sendCommand` (SLCAN text) is a no-op in gs_usb mode, so any new
frame-TX path must branch like `txSendOne` and `isotpTxCan` do (pack a frame with
`gsUsbPackFrame` → `transferOut`). Bitrate is mapped from the Speed dropdown (`getBitrateHz`) to a
bit-timing struct (`gsCalcBitTiming`, ~87.5% sample point, clamped to the device's BT_CONST
limits) and sent before MODE start. The Serial Terminal tab is hidden in gs_usb mode.

**Wire-format quirk (classic CAN):** a gs_usb host frame is *variable length* - a 12-byte header
(`echo_id`, `can_id`, `dlc`, `channel`, `flags`, `reserved`) + exactly `dlc` data bytes (no
padding). So a frame on the wire is `12 + dlc` bytes, one frame per bulk-IN transfer. `gsUsbPump`
must parse by actual length - assuming a fixed 20 bytes silently drops every frame with `dlc < 8`.
RX frames carry `echo_id = 0xFFFFFFFF`; TX echoes carry the host's rotating echo id and are
dropped. The reference adapter is a **RAMN** board (`RAMNV1/Middlewares/.../gs_usb/usbd_gs_usb.c`).

## SLCAN protocol (text, CR-terminated)

Frames: `tIIILDD…` std data (3-hex ID), `TIIIIIIIILDD…` ext data (8-hex ID), `rIIIL` std RTR,
`RIIIIIIIIL` ext RTR. Commands: `V`→version `Vxxyy`, `N`→serial; `S0..S8` bitrate, `O` open /
`L` open listen-only / `C` close. Adapter error reply = BEL (`0x07`). Parsing lives in
`parseSLCAN` / `processBuffer` / `readLoop`. Raw bytes are logged **only** for lines that fail to
parse (`raw(unparsed): …`) or on the BEL error - there is no longer a blanket first-512-byte dump.

## Shared UI helpers & conventions (read before adding inputs/rows)

- **CAN-ID inputs** must hard-clamp via `clampIdInput(el, ext)` (`sloppycan.js`, near the
  `CAN_SFF_MASK`/`CAN_EFF_MASK` consts; exposed as `window.clampIdInput`): strips non-hex, caps width
  to 3/8 hex, clamps to `0x7FF`/`0x1FFFFFFF`, toggles `.invalid` when empty. Already wired into the TX
  row (`txSyncField`), ISO-TP IDs (`isotpIdInput`), fuzz (`fuzzCfgChange`), XCP (`xcpCfgChange`).
  CANopen COB-IDs use `coClampCob` (allows empty = "auto"). `txBuildSlcan` zero-pads to fixed width.
- **Connection-failure UX:** inline `#connectError` under the Connect button via
  `showConnectError`/`clearConnectError` (cleared at connect start + on disconnect), **plus** the
  bottom-right toast. The message also hints the adapter may be open in another app/tab.
- **TX Scheduler layout:** `#txPanel` → header → `#txContent` (toggled by `toggleTxPanel`, persisted
  as `txPanelOpen`) wrapping `#txModuleSection` (read-only module-driven rows, above) + `#txBody`
  (editable rows). `renderTxModuleRows` (called from `renderTxRows`, `obdWatchUpdateIndicator`,
  `obdWatchToggle`, and fuzz's `fuzzUpdateIndicator`) mirrors Quick Watch + Fuzzer sends, tinted with
  `--red`. `toggleTxModule` collapses just the module section. `txAutoExpand` (`window.txAutoExpand`)
  expands the panel when transmission starts (TX enable, `obdWatchStart`, fuzz start).
- **Module message logs** (XCP/CANopen/CHAdeMO/J1939 tables) render **chronological** (oldest→newest,
  no `.reverse()`), auto-scroll to bottom only when already near it, and have sticky `<thead>` (`th`
  carries the opaque bg + `position:sticky;top:0`; their scroll container needs `padding-top:0`). The
  XCP/CANopen/CHAdeMO "session-panel-over-frame-log" tabs share one render-loop + log-ring + table
  builder: `window.makeStackedLogTab(cfg)` (defined in `sloppycan.js` by the other `window.*` exports;
  per-module wiring in `.claude/modules.md`). J1939 predates it and keeps its own loop.
- **UDS/KWP/OBD palettes** (`buildSvcPalette`): a param may carry `visibleWhen(els)` to show/hide its
  row and exclude its bytes from `assemble()` (used for SecurityAccess even-level Key and LinkControl
  sub-service `0x03` hiding the Baudrate record). `#isotpInput` placeholder is set per mode in
  `isotpSetProtoMode` (UDS `22 F1 84`, OBD `01 0C`, KWP `21 F0`).
- **Graph idle-freeze:** `graphBusLive()` gates the live edge - when the bus is disconnected/paused the
  window holds at `graphLiveEnd` instead of sliding. Resume keeps zoom; Live (`graphGoLive`) also
  resets zoom.

## Byte colour semantics (ID List, RX frames only)

| Colour | Condition |
|--------|-----------|
| Green  | `byteChangedAt[i]` within `hotMs` of now |
| Amber  | byte index in `notchedBytes[key]` |
| Grey   | byte in `stableBytes[key]` AND current value matches snapshot |
| White  | none of the above |
| Blue   | TX-only frame (`hasRx=false`) - `.byte.tx-byte`, subtle, opacity 0.75 |

TX frames with mixed RX/TX history use normal RX colouring.

## Known issues / pending cleanups (do not fix unless asked)

No known outstanding cleanups.
