# Core Architecture Reference

## Script sections (in order within `sloppycan.js`)

1. `RingBuffer` class — O(1) push/pop, used for `dumpLog`
2. State variables — `frames`, `dumpLog`, `notchedBytes`, `stableBytes`, etc.
3. Utility — `log`, `escHtml`, `frameKey`, `getFilter`, `applyFilter`
4. Serial layer — `connectSerial`, `disconnectSerial`, `readLoop`, `parseSLCAN`; Android WebUSB CDC path: `openWebUSBCDC`, `usbSerialPump`; gs_usb (WebUSB) path: `openGsUsb`, `gsUsbPump`, `gsCalcBitTiming`, `gsSetBitTiming`, `gsSetMode`, `gsUsbPackFrame`/`gsUsbBuildFrame`
5. Frame ingestion — `ingestFrame`
6. Rendering — `rerenderTable`, `renderDump`, RAF loop
7. Sorting, view tabs, notch, bus/pause controls
8. TX Scheduler — `renderTxRows`, `txBuildSlcan`, `txSendOne`, `txSendOnce`
9. Frame Inspector — `inspectFrame`, CRC-15, bit stuffing
10. Demo mode — `startDemo`, `demoTick`, CRC-32/ISO-HDLC
11. Startup

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

**Wire-format quirk (classic CAN):** a gs_usb host frame is *variable length* — a 12-byte header
(`echo_id`, `can_id`, `dlc`, `channel`, `flags`, `reserved`) + exactly `dlc` data bytes (no
padding). So a frame on the wire is `12 + dlc` bytes, one frame per bulk-IN transfer. `gsUsbPump`
must parse by actual length — assuming a fixed 20 bytes silently drops every frame with `dlc < 8`.
RX frames carry `echo_id = 0xFFFFFFFF`; TX echoes carry the host's rotating echo id and are
dropped. The reference adapter is a **RAMN** board (`RAMNV1/Middlewares/.../gs_usb/usbd_gs_usb.c`).

## SLCAN protocol (text, CR-terminated)

Frames: `tIIILDD…` std data (3-hex ID), `TIIIIIIIILDD…` ext data (8-hex ID), `rIIIL` std RTR,
`RIIIIIIIIL` ext RTR. Commands: `V`→version `Vxxyy`, `N`→serial; `S0..S8` bitrate, `O` open /
`L` open listen-only / `C` close. Adapter error reply = BEL (`0x07`). Parsing lives in
`parseSLCAN` / `processBuffer` / `readLoop`. Raw bytes are logged **only** for lines that fail to
parse (`raw(unparsed): …`) or on the BEL error — there is no longer a blanket first-512-byte dump.

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
  carries the opaque bg + `position:sticky;top:0`; their scroll container needs `padding-top:0`).
- **UDS/KWP/OBD palettes** (`buildSvcPalette`): a param may carry `visibleWhen(els)` to show/hide its
  row and exclude its bytes from `assemble()` (used for SecurityAccess even-level Key and LinkControl
  sub-service `0x03` hiding the Baudrate record). `#isotpInput` placeholder is set per mode in
  `isotpSetProtoMode` (UDS `22 F1 84`, OBD `01 0C`, KWP `21 F0`).
- **Graph idle-freeze:** `graphBusLive()` gates the live edge — when the bus is disconnected/paused the
  window holds at `graphLiveEnd` instead of sliding. Resume keeps zoom; Live (`graphGoLive`) also
  resets zoom.

## Byte colour semantics (ID List, RX frames only)

| Colour | Condition |
|--------|-----------|
| Green  | `byteChangedAt[i]` within `hotMs` of now |
| Amber  | byte index in `notchedBytes[key]` |
| Grey   | byte in `stableBytes[key]` AND current value matches snapshot |
| White  | none of the above |
| Blue   | TX-only frame (`hasRx=false`) — `.byte.tx-byte`, subtle, opacity 0.75 |

TX frames with mixed RX/TX history use normal RX colouring.

## Known issues / pending cleanups (do not fix unless asked)

No known outstanding cleanups.
