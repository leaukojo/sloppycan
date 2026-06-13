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
