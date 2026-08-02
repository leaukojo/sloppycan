# Module Documentation

All modules follow the same bolt-on pattern: a deferred script tag, integration hooks in
`sloppycan.js` and `index.html`, persistence via `_pending` + `scheduleSave`. Modules may reuse
shared core helpers exposed on `window.*` (`withTxLock`, `canRelTs`/`canHexBytes`/`canParseIntAuto`,
`txReady`, `fuzzTxFrame`) rather than re-implementing them. The per-module **Integration points**
lists below double as a map of exactly where each module plugs into the core.

> The explainer/reference pages named below live in the `explainers/` folder; in-app links
> reference them as `explainers/<page>.html`.

---

## Graph tab (`graph.js`)

Plots signal values over time on a hand-rolled `<canvas>` - no charting library, opens from `file://`.

- **Signal** = `{ frameKey, byteIndex, width:1|2, endian:'le'|'be', signed, name }`. `graphExtract` returns `null` for RTR/empty data, `byteIndex ≥ dlc`, or a word crossing the dlc boundary.
- **Own history.** Each signal owns a ring buffer of `{t, v}` (`Float64Array`, `GRAPH_CAP = 4096`) fed from the `graphIngestFrame` hook. No `dumpLog` backfill.
- **Rendering.** Separate RAF loop + `graphDirty` gate; live redraw capped at ~30 fps (33 ms) with a 750 ms id-picker refresh tick. Per-trace normalized Y (`vmin`/`vmax`, sticky - only ever grow); `↕` button (`graphRescaleSignal`) resets to current buffer.
- **Persistence.** Signal list persists as `graphSignals`; deferred load via `window._graphPending`.

**Integration points:** `ingestFrame` → `if (window.graphIngestFrame) graphIngestFrame(frame)`; `switchViewTab` graph branch + `graphOnShow`; `#frameBody` contextmenu → `window.graphContextMenu`; three persistence functions; `window.graphScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-graph`, `#graphWrap`/`#graphCtxMenu`, `<script src="graph.js" defer>`.

---

## Fuzzing tab (`fuzz.js`)

Transmits crafted frames. All wire I/O goes through `window.fuzzTxFrame` - no transport code in `fuzz.js`.

- **`fuzzCfg`** - persisted config: `idMode`/`isExt`/range/single/obs; `dlcMode`/`dlcFixed`; `payMode`/`randomBytes`/`byteMasks`/`bitGrid`/`bitPat`; `gap`/`burst`. Runtime cursors reset on Start.
- **Sending seam:** `window.fuzzTxFrame(id,isExt,dlc,bytes)` (in `sloppycan.js`) handles `connMode==='gsusb'` branch + `dumpLog`/`frames` bookkeeping (via the shared `recordTxFrame` helper, also used by `txSendOne`/`isotpTxCan`).
- **TX gate:** `window.txReady()` (core) = open bus AND not listen-only. Modules (fuzz/xcp/canopen) call it instead of reaching into the `#listenOnly` DOM id directly; each keeps a local fallback for when the core fn is absent.
- **Safety:** Start requires `confirm()`; `fuzzStop()` called from `disconnectSerial`; `fuzzApply` always stops first.
- **Indicator:** `#fuzzActiveBadge` + Stop in TX Scheduler header (always visible).

**Integration points:** `window.fuzzTxFrame`/`fuzzBusReady`/`fuzzObservedIds` (near `frameKey`); `switchViewTab` fuzz branch + `fuzzOnShow`; `disconnectSerial` → `window.fuzzStop()`; three persistence functions (`fuzz` key via `window.fuzzCollect`/`fuzzApply`/`window._fuzzPending`); `window.fuzzScheduleSave = scheduleSave` at startup. `index.html`: `#vtab-fuzz`, `#fuzzWrap`, `#fuzzActiveBadge`, `<script src="fuzz.js" defer>`. CSS: `.fuzz-*` rules in `sloppycan.css`.

---

## OBD-II / J1979 (ISO-TP tab sub-mode; UI in `sloppycan.js`, decoders in `diag-parse.js`)

Sub-mode of the ISO-TP/UDS tab. Toggle `#isotpModeUds`/`#isotpModeObd` via `isotpSetProtoMode`. Each proto has its own remembered Tx/Rx (`isotpModeIds`, seeded with defaults and kept fresh by `isotpIdInput`); switching modes loads the entering mode's pair, so an emptied/invalid field is discarded and a mode's last valid IDs are restored on return.

- **Request palette** (`OBD_PALETTE`, `obdInit`, `obdSend`) - palette sends go through `isotpSend()` so they're logged. `Clear DTCs (04)` is `confirm()`-gated.
- **Supported-PIDs probe** (`obdProbeStart`/`obdProbeDone`) - walks `01 00/20/40/60`, lights `#obdProbeGrid`.
- **Quick Watch** (`obdWatch*`, `#obdWatchGrid`) - round-robin poller via `obdRequest({log:false})`, not logged.
- **Single in-flight rule:** gated on `isotpPendingEl || isotpRxState || isotpTxQueue.length || isotpFuncMode || isotpRxMap.size`. Responses via `obdCaptureCb` tapped in `isotpMarkDone`/`isotpMarkTimeout`/`isotpMarkError`.
- **Functional addressing (0x7DF):** auto-enables `isotpFuncMode`, routes to `isotpIngestFunctional`, accepts any responder (7E8–7EF / 0x18DAF1xx), keyed per ECU in `isotpRxMap`, rendered as `.isotp-ecu-tag` pills. Multi-frame FC sent to physical ID via `isotpSendFCTo` + `txIdOverride` on `isotpTxCan`.
- **Persistence:** `isotp.proto` + `obdWatch` keys; `window.obdScheduleSave` at startup.
- **Explainer:** `obd2-explainer.html`.

**Revert:** remove toggle markup + `#obdWrap` + `#isotpInputLabel`, the OBD JS section + hooks, `.obd-*` CSS, `obd2-explainer.html`, `demoObdResponse`/`DEMO_OBD_PIDS`.

---

## KWP2000 / ISO 14230 (ISO-TP tab sub-mode; tables/decoder in `diag-parse.js`, UI in `sloppycan.js`)

Third option in the ISO-TP protocol toggle (`UDS | OBD-II | KWP2000`). No transport changes.

- **Separate tables:** `KWP_SVC`/`KWP_NRC`/`KWP_DIAG_MODE`. `kwpDecode(bytes)` mirrors `udsDecode` shape.
- **Dispatcher:** `decodePayload(bytes)` → `obdProtoMode === 'kwp' ? kwpDecode : udsDecode`. Used at all three ISO-TP log decode sites.
- **Palette:** `KWP_PALETTE` + `kwpInit()` build `#kwpPalette` (StartComms, StartSession, TesterPresent, ReadECUIdent, ReadByLocalId, ECUReset, StopComms). `kwpSend(bytes)` mirrors `obdSend`.
- **Shared param buttons:** `buildSvcPalette(containerId, palette, sendFn)` builds both `#kwpPalette` and `#udsPalette`. Split buttons (`{label, sid, params}`) open a `.svc-panel` for per-param selects/hex inputs.
- **UDS palette:** `UDS_PALETTE` / `udsInit` / `udsSend` in `#udsWrap`, shown only in UDS mode. Explainer: `uds-explainer.html`.
- **Persistence:** reuses `isotp.proto` key (shared with OBD).
- **Explainer:** `kwp2000-explainer.html`.

**Revert:** remove `KWP_SVC`/`KWP_NRC`/`KWP_DIAG_MODE`/`kwpAscii`/`kwpDecode`/`KWP_PALETTE`/`kwpInit`/`kwpSend`, restore direct `udsDecode` calls at the three log sites, remove `#isotpModeKwp` + `#kwpWrap`, `'kwp'` branches in `isotpSetProtoMode`/`applySettings`/`demoIsoTpRespond`, `kwp2000-explainer.html`.

---

## NMEA 2000 (J1939 tab mode, `j1939.js`)

Protocol-mode of the J1939 tab. An `.obd-proto-toggle` button group (`#j1939ProtoJ1939` / `#j1939ProtoNmea2000` / `#j1939ProtoIso11783`, on the **left** of the sub-tab bar, like ISO-TP) flips `j1939ProtoMode` via `j1939ProtoClick(mode)` → `j1939SetProto` (which drives the buttons' `.active` state). In Demo mode the toggle routes through `window.demoMaybeSwitch` (switches demo base traffic, prompted); otherwise it swaps the dictionary + persists. Tab button reads **"J1939 / N2K"**.

- **Active dictionary:** `j1939ActiveDb()` returns `NMEA2K_DB` in NMEA mode. `j1939SetProto` clears live state on switch; hides **Faults (DM1/DM2)** sub-tab in NMEA mode.
- **`NMEA2K_DB`** (~30 PGNs): bit-offset model `{name, bo, bl, signed, scale, offset, unit, dp, map, str, date, time}` - N2K fields straddle byte boundaries.
- **`n2kDecodeField`:** ≤32-bit via bit extraction; >32-bit byte-aligned float accumulation. Returns same `{name,display,valid}` shape as `j1939DecodeSPN`.
- **Fast Packet** (`n2kFastPacket` Map, key `${pgn}:${sa}:${seq}`): first frame `data[0]&0x1F==0`; continuations carry 7 bytes. Reassembled via `j1939DispatchPGN(..., fromTP=true)` - shown as **FP** badge. Stale slots dropped ~1 s.
- **Persistence:** `j1939Proto` key; `window.j1939GetProto`/`window.j1939Apply`/`window._j1939ProtoPending`; `window.j1939ScheduleSave = scheduleSave` at startup.
- **Demo:** `window.j1939DemoFrames()` returns the frame set for the active mode - `j1939BaseDemoFrames()` (plain J1939: EEC1/ET1/CCVS1/VEP1/Fuel + periodic address claim), N2K frames (NMEA), or `isoDemoFrames()` (ISOBUS). Ingested by `demoInjectN2k()` on a 100 ms timer, started by the demo base-traffic engine (`demoStartBaseTimers`) when a j1939-family base traffic is active. See core-arch.md "Demo base-traffic engine".
- **Explainer:** `nmea2000-explainer.html` (`#nmea2000LearnLink`, shown only in NMEA mode).

**Revert:** remove the `.obd-proto-toggle` button group + `#nmea2000LearnLink`, `NMEA2K_DB`/`n2kDecodeField`/`n2kFastPacket*`/`j1939SetProto`/`j1939ProtoClick`/`j1939DemoFrames`/`j1939BaseDemoFrames`, `j1939ActiveDb` indirection, NMEA branch in `j1939IngestFrame`, `j1939Proto` persistence key + `j1939ScheduleSave`, `demoInjectN2k` (driven by the demo base-traffic engine), `nmea2000-explainer.html`.

---

## ISO 11783 / ISOBUS (J1939 tab mode, `j1939.js`)

Third option in the J1939 protocol-mode dropdown. `j1939ProtoMode` gains `'iso11783'`; `j1939ActiveDb()` returns `ISOBUS_DB`. Standard J1939 TP stays active - only large transfers use ETP. Faults sub-tab stays visible.

- **`ISOBUS_DB`** spreads `J1939_DB` + ag PGNs (WBSD/GBSD 65096/65097, PTO 65093/65094, Hitch 65091/65092, VDS 65256). Task Controller (57344) + VT (0xE600/0xE700) use a per-entry `decode(data)` callback (`isoTcDecode`/`isoVtDecode`).
- **ETP transport** (`isoEtpSessions`, `isoEtpIngestCM`/`isoEtpIngestDT`): ETP.CM on 0xC800, ETP.DT on 0xC700. **DPO trap:** `byteOffset = (dpoOffset + seq − 1) × 7`. Buffer capped at 256 KB. ETP badge in render.
- **Ingest routing:** `iso11783` branch returns early only for ETP frames (0xC8/0xC7), falls through to shared TP + dispatch.
- **Demo (ISOBUS mode):** `isoDemoFrames()` (branch in `j1939DemoFrames`) emits TECU + ag address claims + a 1792-byte ETP transfer (exercises DPO path). Injected by `demoInjectN2k` when ISOBUS is the active demo base traffic.
- **Explainer:** `iso11783-explainer.html` (`#iso11783LearnLink`, shown only in ISOBUS mode).

**Revert:** remove `ISO 11783` `<option>` + `#iso11783LearnLink`, `ISOBUS_*` tables + `isoTcDecode`/`isoVtDecode`, `entry.decode` line in `j1939DecodePGN`, ETP block (`isoEtp*`), `iso11783` branches in `j1939IngestFrame`/`j1939SetProto`/`j1939ActiveDb`/`j1939RenderAddr`, `isoDemoFrames`/`isoEtpDemoFrames`, `iso11783-explainer.html`.

---

## DTC decoder (`dtc.html` standalone page)

Standalone reference page (no app runtime, `file://`-compatible) for looking up DTCs in OBD-II 2-byte, UDS 3-byte+status, or J1939 4-byte SPN+FMI encodings. Inlines faithful copies of the app's decoders. Theme from shared `'sloppycan-explainer-theme'` localStorage key.

- **`DTC_DB`** - ~500-entry SAE J2012 descriptions (P0xxx + curated U/C/B). Manufacturer-specific codes flagged, never fabricated.
- **Auto-detect:** `decodeToken` sniffs format; bare 4-byte renders both UDS+status and J1939 cards. Batch input splits on comma/newline.
- **URL prefill:** `?q=P0301` or `?bytes=01+90+12+2F&fmt=uds` for in-app deep-links.

**Integration points (in-app deep-links only):**
- `sloppycan.js`: `vHtml` escape-hatch in `udsSection`; `dtcLink`/`dtcHexQ` helpers; `.vHtml` rows at OBD Mode 03/07/0A + UDS 0x19 + single-DTC site.
- `j1939.js`: `j1939RenderDM` wraps the SPN cell in an `<a>` reconstructing the 4 record bytes.

**Revert:** delete `dtc.html`; restore `udsSection` `val` line, remove `dtcLink`/`dtcHexQ` + three `.vHtml` rows; unwrap SPN cell in `j1939.js`.

---

## Shared "stacked log tab" factory (`window.makeStackedLogTab`, in `sloppycan.js`)

CHAdeMO, XCP, and CANopen are all a **top panel stacked over a scrolling frame-log table**. The
identical machinery — the rAF render loop (dirty/visibility gating + ~15 fps throttle + 1 s
relative-timestamp tick), the log ring (append + `logMax` cap + optional same-id `coalesce`), the
table builder (empty-state + near-bottom scroll-follow), and the `ready()`/`showTxHint()`/
`readout()` helpers — lives **once** in `window.makeStackedLogTab(cfg)`. Each module calls it once and
keeps only its decode + session/nodes panel (`cfg.renderTop`) + row builder (`cfg.rowHtml`) + (xcp/co)
TX command logic. Module code marks the log dirty via `tab.markDirty()`, appends via `tab.pushLog(e)`,
empties via `tab.clearLog()`, and force-renders on tab-show via `tab.render()`. cfg shape:
`{ wrapId, logElId, tableClass, theadHtml, emptyHtml, rowHtml(e), renderTop(), onTick?, coalesce?(prev,e),
   renderMs=67, logMax=600, readoutElId?, txHintElId? }`. The per-module **pending/timer** transaction
machinery (`xcpPending`, `coPending`) is intentionally **not** shared — see each entry below.

---

## CHAdeMO (`chademo.js`)

Decodes CHAdeMO DC-fast-charging CAN (11-bit IDs, 500 kbit/s). J1772 and ISO 15118 are not on CAN - a note banner says so and links `ev-charging-explainer.html`.

- **`CHADEMO_MSGS`** - decode table keyed by 11-bit ID. Covers 0x100/0x101/0x102 (vehicle→charger) and 0x108/0x109 (charger→vehicle); v2.0 discharge IDs are `{raw:true}`. `chademoIngestFrame` early-exits on `frame.isExt`.
- **Layout:** Session (dashboard tiles + flag chips) and Frame Log are **stacked in one view** (Session on top with `max-height:55%`, Frame Log below), driven by the shared `makeStackedLogTab` factory (`chademoRenderSession` is its `renderTop`; passive, so no `coalesce`/`readout`/`txHint`) - no sub-tabs. `chademoSessionState()` derives coarse state from `lastIds` recency + enable/stop bits.
- **Demo (base traffic):** CHAdeMO is a demo **base traffic** - `window.chademoDemoLoopStart()` / `chademoDemoLoopStop()` run a capability-exchange + charging ramp that **loops** (5 s idle wait between cycles via `chademoDemoRestartAt`), injected via `window.ingestFrame`. Started/stopped by the core demo base-traffic engine (`demoStartBaseTimers`) when CHAdeMO is the active base traffic; opening the tab in Demo prompts via `window.demoMaybeSwitch('chademo', …)`. A **Pause demo** button (`window.chademoDemoPauseToggle`, gated on `chademoDemoTimer` so it only shows while the loop runs) sits next to the session state pill. No standalone Demo button.
- **No persistence** (live-only tab).

**Integration points:** `ingestFrame` → `if (window.chademoIngestFrame) chademoIngestFrame(frame)`; `clearFrames` → `if (window.chademoClear) chademoClear()`; `switchViewTab` chademo branch (show/hide + `demoMaybeSwitch`); `window.ingestFrame = ingestFrame` at startup; `chademoDemoLoopStart/Stop` called by the demo engine. `index.html`: `#vtab-chademo`, `#chademoWrap` (`#chademo-session` + `#chademo-log`), `<script src="chademo.js" defer>`. Explainer: `ev-charging-explainer.html`.

**Revert:** delete `chademo.js` + `ev-charging-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear hooks, `window.ingestFrame` line, `#chademoWrap`, `<script>` tag.

---

## XCP-on-CAN (`xcp.js`)

Passively decodes XCP-on-CAN (ASAM MCD-1 XCP) and acts as an active XCP master. Two configurable CAN IDs: CRO (master→slave, default `0x552`) and DTO (slave→master, default `0x553`).

- **Decode tables:** `XCP_CMD`, `XCP_ERR`/`XCP_EV`, `XCP_RESOURCE` - per ASAM XCP spec (`GET_DAQ_PROCESSOR_INFO=0xDA`, `START_STOP_SYNCH=0xDD`, `ERR_CMD_UNKNOWN=0x20`).
- **DTO classification:** `0xFF` RES, `0xFE` ERR, `0xFD` EV, `0xFC` SERV, `0x00–0xFB` DAQ.
- **Command↔response pairing:** RES/ERR decoded in context of last CRO. `xcpDecodeRes` parses CONNECT (byte order from `COMM_MODE_BASIC` bit0), GET_STATUS, GET_ID, UPLOAD/SHORT_UPLOAD, GET_DAQ_PROCESSOR_INFO.
- **Active master:** single in-flight `xcpPending` (its timeout is an inline `setTimeout` in `xcpSend`, not a separate arm helper - unlike CANopen's `coArmTimer`). `xcpSend` gates on `xcpReady()` (open bus + not listen-only) and sends via `window.fuzzTxFrame`. `xcpReadIdViaUpload` chains sequential UPLOADs. **Note:** unlike CANopen, XCP active writes (`SET_MTA`/`DOWNLOAD`) are **not** `confirm()`-gated - they rely on `xcpReady()`/listen-only only. (Intentional asymmetry; revisit if XCP write is exposed more prominently.)
- **DAQ flood guard:** DAQ DTOs coalesced via the factory's `cfg.coalesce` (same id within `XCP_DAQ_COALESCE_MS`) into one `×N` row.
- **Render/log:** session panel + frame-log table go through the shared `makeStackedLogTab` factory (`xcpRenderSession` = `renderTop`, `xcpUpdateButtons` = `onTick`). `xcpReady`/`xcpShowTxHint`/`xcpReadout` delegate to the returned handles.
- **Persistence:** `xcp` key: `cro`/`dto`/`isExt`/`byteOrder`.

**Integration points:** `ingestFrame` → `xcpIngestFrame`; `clearFrames` → `xcpClear`; `disconnectSerial` → `xcpStop`; `switchViewTab` + `xcpOnShow`; three persistence functions (`xcp` key via `xcpCollect`/`xcpApply`/`_xcpPending`); `window.xcpScheduleSave = scheduleSave` + `window.xcpDemoActive = () => demoMode` at startup. `index.html`: `#vtab-xcp`, `#xcpWrap`, `<script src="xcp.js" defer>`. Explainer: `xcp-explainer.html`.

**Revert:** delete `xcp.js` + `xcp-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear/disconnect hooks, `xcp` persistence key + startup lines, `#xcpWrap`, `<script>` tag.

---

## CANopen (`canopen.js`)

Passively decodes CANopen (CiA 301) and acts as an active client. COB-ID = `(functionCode << 7) | nodeId`. **11-bit only** - exits early on `frame.isExt`.

- **Classification:** `coClassify(id)` → `{node, fc, type, kind}`. Covers NMT 0x000, SYNC/EMCY 0x080, TIME 0x100, TPDO/RPDO 0x180–0x500, SDO tx/rx 0x580/0x600, heartbeat 0x700, LSS 0x7E4/0x7E5. Any 11-bit frame is classified - non-CANopen traffic showing up is correct passive behaviour.
- **SDO:** `coDecodeSdo(d, dir)` - expedited read/write, segmented (reassembled to text+hex), abort (4-byte LE code).
- **Node map:** `coNodes: Map<nodeId,{state,lastSeen,types:Set}>` from heartbeat/NMT/any traffic.
- **Layout:** Nodes & Control (`#co-nodes`: node map + SDO/NMT/SYNC forms, `max-height:55%`) and Message Log (`#co-log`) are **stacked in one view** via the shared `makeStackedLogTab` factory (`coRenderNodes` = `renderTop`, `coUpdateButtons` = `onTick`, PDO `cfg.coalesce` within `CO_PDO_COALESCE_MS`; `coReady`/`coShowTxHint`/`coReadout` delegate to the handles) - no sub-tabs.
- **Demo (base traffic):** the demo node (`coStartDemo`/`coStopDemo`, continuous heartbeats + TPDO + EMCY on a 1 s timer) is a demo **base traffic** - started/stopped by sloppycan.js's demo base-traffic engine (`window.canopenDemoStart/Stop`) when CANopen is the active base traffic, **not** on tab show. Opening the tab in Demo prompts via `window.demoMaybeSwitch('canopen', 'CANopen')`. The SDO/NMT **answering** (`coDemoServer`/`coDemoApplyNmt`) stays gated on `window.canopenDemoActive` (demo on), independent of which base traffic is active.
- **Active client:** single in-flight `coPending` + `coArmTimer`. `coSdoRead`/`coSdoWrite` (write adds own confirm), `coNmt`, `coSync`. All TX via `coTx` → `window.fuzzTxFrame`.
- **Persistence:** `canopen` key: `node`/`sdoTimeout`/`sdoReqId`/`sdoRspId`.

**Integration points:** `ingestFrame` → `canopenIngestFrame`; `clearFrames` → `canopenClear`; `disconnectSerial` → `canopenStop`; `switchViewTab` + `canopenOnShow`; three persistence functions (`canopen` key via `canopenCollect`/`canopenApply`/`_canopenPending`); `window.canopenScheduleSave = scheduleSave` + `window.canopenDemoActive = () => demoMode` at startup. `index.html`: `#vtab-canopen`, `#canopenWrap`, `<script src="canopen.js" defer>`. Explainer: `canopen-explainer.html`.

**Revert:** delete `canopen.js` + `canopen-explainer.html`; remove tab button, `switchViewTab` lines, ingest/clear/disconnect hooks, `canopen` persistence key + startup lines, `#canopenWrap`, `<script>` tag. **Future work:** user-supplied PDO mapping; SDO block transfer.

---

## RAMN dashboard + Control Panel (`ramn.js`)

Two floating, draggable, resizable windows (not tabs). 11-bit only - `ramnIngestFrame` exits early on `frame.isExt`. A shared helper `makeFloating({win,header,grip,outer,body,baseW})` wires drag (header, viewport-clamped) + resize (grip → uniform `applyScale` of the body) for both windows.

**Dashboard** - **instrument-cluster window** that decodes a RAMN board's live CAN stream into vehicle signals. Opened by the **RAMN dashboard** toolbar button (`#ramnBtn`, next to Demo). Gear shows as a labelled "GEAR" box (caption + bordered badge; amber for R) so it reads clearly as gear status.

- **Decode** (16-bit analog values are **big-endian, first 2 bytes**, `be16`): `0x024` brake `(be16&0xFFF)/0xFFF*100`%; `0x039` accel (same); `0x062` steer `(raw-0x7FF)/0x7FF*100` → −100 (L) … +100 (R) **per user spec, `0x000`=L100% - opposite the firmware default**; `0x077` byte0 gear (`0xFF`→R, 1–6), byte1 joystick (1 released…6 press); `0x098` byte0 horn; `0x150` byte0 lights (1 Off/2 Clearance/3 Low/4 High); `0x1B8` byte0 key (1 Off/2 Acc/3 Ign); `0x1A7` turn **control** (byte0 left, byte1 right); `0x1BB` LED **status** bitfield (0x01 batt, 0x02 check-engine, 0x40 left-turn, 0x80 right-turn); `0x1D3` byte0 handbrake. Turn arrows light from the `0x1BB` LED status bitfield (0x40 left / 0x80 right), **not** `0x1A7`, and **blink** (CSS `ramnBlink`).
- **Render:** rAF-throttled via a `dirty` flag - never touches DOM per frame (CAN ≥100 Hz). Steering wheel SVG rotates ±150°; pedal/steer bars; gear badge + joystick label; tell-tale grid with semantic colours from theme vars (`--green` turn, `--blue` lights, `--red` brake/batt, `--amber` horn/check).
- **Window mechanics:** `applyScale` is recomputed on open (offsetHeight is 0 while `display:none`), `BASE_W=300`, 220–640px. `Esc` closes the topmost open window (control panel first, then dashboard).
- **No persistence** (live-only). No tab, no explainer page.

**Control Panel (demo mode only)** - a second window (`#ramnCtrlWindow`, amber header dot). There is **no separate toolbar button**: the single `#ramnBtn` is a **paired toggle** (`ramnToggle()`) that opens *both* the dashboard and (when demo is active) the Control Panel, and closes both. Demo state is recorded by `startDemo` → `window.ramnDemoStarted()` (sets `demoEnabled` in `ramn.js`); on a live hardware bus only the dashboard opens. Each window's own close button + Esc still close it individually (`setDashOpen`/`setCtrlOpen`). Lets the user *drive* the simulated car; the dashboard reflects it via the normal `demoTick → ingestFrame → ramnIngestFrame` path (closed loop - no direct coupling). `window.ramnIsOpen()` is exported for carlito.js to auto-open the dashboard.
- **How it drives demo traffic:** `demoTick` (sloppycan.js) calls `window.ramnCtrlPayload(id)` to get the 2 payload bytes for each of the 10 demo RAMN IDs (`DEMO_CONFIG`), replacing the old fixed `[0x00,0x00]`. Encoding (BE 12-bit where analog): 0x024 brake `pct*0xFFF`; 0x039 accel; 0x062 steer `0x7FF + steer/100*0x7FF` (L100→0x000, C→0x7FF, R100→0xFFF, per user spec); 0x077 `[gear(0xFF=R), joyByte]`; 0x098 horn; 0x150 lights(1-4); 0x1A7 `[left,right]`; 0x1BB LED **status** byte0 `(turnL?0x40:0)|(turnR?0x80:0)` - mirrors the lit turn LEDs so the dashboard's 0x1BB-driven tell-tales match; 0x1B8 key(1-3); 0x1D3 handbrake. Defaults give a resting car (centred wheel, lights/key off, gear 1) so even un-touched demo looks sane.
- **Controls:** sticky brake/accel/steer sliders (steer has a **Centre** snap); a **shift joystick** pad that is the central control (like real RAMN); Off/Clr/Low/High lights; Off/Acc/Ign key; handbrake toggle. The joystick is momentary (sets 0x077 byte1, reverts to 1=released on mouse-up) with side effects on press: **↑/↓ shift gear** up/down through `['R',1..6]` (clamped; `gearShift`), **←/→ toggle** left/right turn signal (the ←/→ buttons latch green while their signal is on), **● (centre) = horn** while held. A "Gear N" readout sits in the joystick section header. **Keyboard** (panel open, not in a form field): `W`/`S`=accel/brake, `A`/`D`=steer - full while held, auto-return to rest on key-up; `syncCtrlUI()` keeps the widgets in sync.

**Integration points:** `ingestFrame` → `if (window.ramnIngestFrame) ramnIngestFrame(frame)`; `clearFrames` → `if (window.ramnClear) ramnClear()`; `disconnectSerial` → `if (window.ramnStop) window.ramnStop()`; `demoTick` → `payload = window.ramnCtrlPayload ? ramnCtrlPayload(id) : [0,0]`; `startDemo` → `if (window.ramnDemoStarted) ramnDemoStarted()`. `index.html`: `#ramnBtn` (`onclick="ramnToggle()"`, the paired toggle) + `<script src="ramn.js" defer>` (the old `#ramnCtrlBtn` was removed). All window DOM + CSS are injected by `ramn.js` (no markup/CSS in core files).

**Revert:** delete `ramn.js`; remove `#ramnBtn` + `#ramnCtrlBtn`, the `<script>` tag, and the five one-line hooks in `ingestFrame`/`clearFrames`/`disconnectSerial`/`demoTick`/`startDemo`.

**Keyboard `Space`** = momentary handbrake (engaged while held).

---

## Carlito game link (`carlito.js`)

A floating, draggable, **real-resize** window (own CSS, not the RAMN `makeFloating` transform-scale - the iframe needs real pixels so Godot's `canvasResizePolicy:2` fills it) that embeds the **Carlito** Godot HTML5 game in an `<iframe>` and pushes the RAMN-interpreted controls into it, so a real RAMN board *or* Demo+Control actually drives the car. Opened by the **Carlito** toolbar button (`#carlitoBtn`, next to the RAMN buttons; always visible).

- **OUT (sloppyCAN → game):** `window.ramnGetState()` (added in `ramn.js`: `() => ({ ...ramnState })`) → rAF push loop → `postMessage({type:'carlitoInput', values:{…}})` with **all** RAMN controls: `accel,brake,steer,handbrake,key,lights,gear,turnL,turnR,horn` (booleans→0/1, gear `'R'`→−1). Push gated on: window open + Link on + iframe loaded. (Game applies handbrake/ignition-key/headlights; relays the rest.)
- **IN (game → sloppyCAN):** a `message` listener accepts `{type:'carlitoOutput', values:{…full telemetry…}}` **only from our iframe** (`e.source === iframe.contentWindow`) ~every 50 ms, renders it, and **injects CAN frames `0x520`–`0x528`** (sloppyCAN-local "Carlito telemetry" IDs, not real RAMN) via the exposed `window.ingestFrame`, big-endian. **Rate split:** fast IDs `0x520`–`0x523` every message (~50 ms), slow IDs `0x524`–`0x528` every 2nd (~100 ms). Map: `0x520` speed+km/h · `0x521` rpm/gear/throttle · `0x522` IMU (yaw/longAcc/latAcc) · `0x523` steering/slip/onGround · `0x524` posX/posZ/heading · `0x525` GPS lat/lon (int32 deg×1e7) · `0x526` odometer · `0x527` status bitfield+impact · `0x528` fuel/coolant/battery. (Trace table only re-renders while connected or in Demo - true whenever actually driving.)
- **Game side (`carlito` repo):** the `Bridge` autoload reads `__carlitoInput` (`JavaScriptBridge`, freshness-gated), feeds it into `InputRouter` as one normalized `VehicleInput`, and publishes telemetry by walking the contract (`src/bridge/bridge.gd` + `src/bridge/web/head_include.html`). See `carlito/CLAUDE.md`.
- **Window UI:** header carries a **stable | dev** channel selector (plain text, `localStorage.carlitoBuild`); control bar (**Reload**, keyboard-help ⌨, **Link ●/○**, debug toggles - the game URL is one of the two hardcoded `GAME_URLS` constants `https://leaukojo.github.io/carlito/stable/` or `…/carlito/dev/`, no free-text input field), then a two-column **OUT | IN** panel - left green `sloppyCAN →` lists all controls with a green dot on the **applied** ones (accel/brake/steer/handbrake/key/lights) vs label-only (gear/turn/horn); right amber `← Carlito` shows speed km/h + bar, rpm, gear, heading, pos (stale `-` after 600 ms). iframe lazy; `allow="autoplay; fullscreen; gamepad"`. Resize "shield" overlay stops the iframe swallowing mouse events.
- **Deploy:** the game deploys from its own repo — CI publishes `dev` on every push, and *Promote dev → stable* copies that artifact to `stable`. Nothing to deploy here. **If the deployed game is stale, the window loads & plays but controls/feedback do nothing** (browsers also cache the `.pck` hard - hard-reload).

**Integration points:** `index.html`: `#carlitoBtn` (`onclick="carlitoToggle()"`) + `<script src="carlito.js" defer>`. `ramn.js`: `window.ramnGetState` + `ramnCtrl.key` defaults to 3 (Ignition) so demo driving passes the engine gate. Reuses `window.ingestFrame` (in sloppycan.js) for the `0x520`–`0x528` frames. All window DOM + CSS injected by `carlito.js`.

**Revert:** delete `carlito.js`; remove `#carlitoBtn`, the `<script>` tag, and the `window.ramnGetState` line in `ramn.js`. (Game-side revert: see `carlito/CLAUDE.md`.)

---

## CAN Signals explainer (`can-signals-explainer.html`)

Standalone physical-layer page (no app integration, no `sloppycan.js` import). Takes a stuffed CAN bitstream via `?bits=<0/1 string>` (default: the example 119-bit standard frame) and draws an oscilloscope view on a `<canvas>`: CAN_H, CAN_L, differential, RX, Sender TX, Receiver TX. Self-contains a `parseFrame()` that reverses bit-stuffing to colour-code fields and locate the ACK slot (falls back to "12th-from-last bit" + uncoloured traces on malformed input). Also has an interactive arbitration demo. Teaches dominant/recessive, wired-AND, ACK, and arbitration.

**Integration point:** one `<a href="can-signals-explainer.html?bits=${stuffed.map(s => s.bit).join('')}">` in `inspectFrame`'s "Bitstream with Bit Stuffing" title (`sloppycan.js`).

**Revert:** delete `can-signals-explainer.html`; remove that one `<a>` in `inspectFrame`.
