# Core Architecture Reference

## Files & load order

`index.html` lists the deferred bolt-on modules first, then the non-defer core: **`can-link.js`**,
**`diag-parse.js`**, **`sloppycan.js`**. Non-defer scripts run during parse, before every deferred
module, and all classic scripts share one global lexical scope.

## `can-link.js` vs `sloppycan.js`

`can-link.js` (its header lists the host contract) owns the connection state and the transport
primitives: `openGsUsb` / `openWebUSBCDC`, gs_usb bit timing + mode, `gsUsbPump` / `usbSerialPump` /
`readLoop`, `processBuffer` / `parseSLCAN`, the two frame encoders every TX path uses
(`gsUsbPackFrame` / `slcanEncode`, both taking an explicit DLC), `sendCommand`. `sloppycan.js` keeps
the host side: `connectSerial` / `disconnectSerial`, `busOpen`, `hwConnectWarning`,
`requireBusForCarlito`, `resetConnectionState`, `updateBusPauseBtn`, and the TX-scheduler glue
(`txTransmitRaw`, which takes a byte frame, / `txDataBytes`). `carlito-bridge.js` supplies the same
host globals as shims.

## `sloppycan.js` sections

Navigate by `grep -n '^// ── ' js/sloppycan.js`. In order: header · Ring buffer · TX Scheduler ·
Fuzzer hooks · Utilities (`escHtml`, `log`) · Connection / bus state reset · "All frames filtered
out" notice · gs_usb transport · Responsive header · View tabs · Frame Inspector · Notch · Resize
handle · Demo Mode · Demo base-traffic engine · Demo traffic follows the Carlito vehicle · ISO-TP /
UDS · Functional addressing · RX state machine · Functional-addressing RX · DOM helpers · Send ·
OBD-II sub-mode · Supported-PIDs probe · Quick Watch · Theme toggle · CSV Export · Workspaces &
persistence · Startup · Onboarding spotlight arrow.

Landmarks: `ingestFrame` / `ingestFrameBody`; `rerenderTable`, `renderDump`, the rAF loop;
`renderTxRows`, `txSendOne`, `txSendOnce`; `inspectFrame` (CRC-15, bit stuffing); `startDemo`,
`demoTick` (CRC-32/ISO-HDLC).

`diag-parse.js` is three sections: OBD-II / J1979 (`OBD_MODE`, `OBD_PID01/09`, `obdDecode`),
UDS / ISO 14229-1 (`UDS_*`, `udsDecode*`), KWP2000 / ISO 14230 (`KWP_*`, `kwpDecode`, the
`decodePayload` dispatcher).

## Coupling rules

- **`diag-parse.js` must load before `sloppycan.js`:** the DIAG-MODE palettes (`KWP_PALETTE` /
  `UDS_PALETTE`) read its tables at eval time. Its own reads of core (`escHtml`, `obdProtoMode`)
  happen at call time.
- **The OBD/UDS/KWP sub-mode controller stays in `sloppycan.js`:** it and the ISO-TP transport
  call each other, so splitting either out only relocates the coupling.

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
- `demoOnTelemetry` (a `vehiclePanelSubscribe` subscriber) makes the traffic follow the Carlito
  vehicle with no prompt, on a change only: truck → j1939, tractor → iso11783, boat → nmea2000,
  drone → dronecan, anything else → ramn (no reload; the table is vehicle-panel.js's
  `vehiclePanelProtoTable`). Without Carlito, returning to RAMN still needs a reload. Outside demo,
  the J1939 tab, shown with a truck / tractor / boat on the link, selects that vehicle's mode once
  per vehicle per link (`j1939TabFollowKind`), so a mode picked afterwards stands.
- `window.demoIsActive = () => demoMode` lets modules gate the switch (used by `j1939ProtoClick`).
- Plain-J1939 demo frames come from `j1939BaseDemoFrames()` in `j1939.js`.

## Key data structures

```js
frames: Map<frameKey, { id, isExt, isRtr, dlc, data: number[],
  byteChangedAt: number[], count, firstSeen, lastSeen,
  timestamps: number[], hasRx, hasTx }>   // timestamps: a 1 s rate window (rateWindowPush/Count, can-link.js), pruned by age on push

dumpLog: RingBuffer(100000) of { ts, isTx, id, isExt, isRtr, dlc, data, seq }   // seq stamped on push; the Dump's filtered view is extended by seq, re-filtered only when the filter changes

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
parse (`raw(unparsed): …`) or on the BEL error.

## Shared UI helpers & conventions (read before adding inputs/rows)

- **CAN-ID inputs** must hard-clamp via `clampIdInput(el, ext)` (`sloppycan.js`, near the
  `CAN_SFF_MASK`/`CAN_EFF_MASK` consts; exposed as `window.clampIdInput`): strips non-hex, caps width
  to 3/8 hex, clamps to `0x7FF`/`0x1FFFFFFF`, toggles `.invalid` when empty. Already wired into the TX
  row (`txSyncField`), ISO-TP IDs (`isotpIdInput`), fuzz (`fuzzCfgChange`), XCP (`xcpCfgChange`).
  CANopen COB-IDs use `coClampCob` (allows empty = "auto"). `slcanEncode` zero-pads to fixed width.
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

## Byte colour semantics (ID List, RX frames only)

| Colour | Condition |
|--------|-----------|
| Green  | `byteChangedAt[i]` within `hotMs` of now |
| Amber  | byte index in `notchedBytes[key]` |
| Grey   | byte in `stableBytes[key]` AND current value matches snapshot |
| White  | none of the above |
| Blue   | TX-only frame (`hasRx=false`) - `.byte.tx-byte`, subtle, opacity 0.75 |

TX frames with mixed RX/TX history use normal RX colouring.
