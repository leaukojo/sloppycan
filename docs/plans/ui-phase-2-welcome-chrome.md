# Phase 2: welcome screen and app chrome

**Run with:** Opus, effort **high**, plan mode **no**. The decisions are made and the plan
below is concrete. Effort stays high because section 2 reworks the connect / Demo / Clear state
flow, which every session goes through, and its edge cases (auto-open off, a quiet bus, Clear
while connected) are easy to break.

Needs phase 1 (tokens and primitives). Each numbered section is one commit.

## 1. Welcome: three tiles (decided 2026-11-13)

Today (`index.html` `#emptyState`): a centred 780px column (at 1600px wide) with a big empty
area under it. It
holds a title, a tagline, an explainers line, two CTAs that duplicate the header's
Connect/Demo, a "No adapter? The Demo streams…" note that repeats the Demo button, a Carlito
card with a three-line description ("…Open it with the Carlito button up top"), and an "Also
worth exploring - point at one to find it on screen" grid of hover chips.

New:

```
sloppyCAN                                         (--fs-xxl)
Read and explore any CAN bus in your browser.     (--fs-m, --text2)

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  → Connect   │ │  ▷ Demo      │ │ [screenshot] │   tiles share the width (max ~1200px),
│    adapter   │ │              │ │ Drive Carlito│   height ~40vh, centred in the free space
└──────────────┘ └──────────────┘ └──────────────┘
Explainers ↗
```

- **Connect adapter**: same action as today's CTA (`toggleConnectPopover(true)` +
  `flashEls('connectConfirmBtn')` + `onboardArrowTo(...)`). The popover is anchored top-right,
  far from the tile, so the arrow still earns its place.
- **Demo**: `startDemo()`.
- **Drive Carlito**: `startDemo()` then `carlitoToggle()`, one click. Today `carlitoToggle()`
  with no bus only records a pending open (`pendingOpen`), nudges the user, and waits for
  `carlitoBusReady()`. Carlito is an in-page iframe window (`carlito.js`), not a popup, so
  opening it after `startDemo()` can't hit a popup blocker.
- No other copy. The tiles are the explanation.

Remove: the `.onboard-chip` grid, the chip half of `onboardSpotlight()` in `sloppycan.js` (keep
`onboardArrowTo` and its arrow), the `.onboard-*` CSS this orphans, and `vehicle-panel.js`'s
`_chipEl` lookup and toggling (it already tolerates `null`; delete it, since it becomes dead code).

## 2. One "link" state for the welcome screen and the chrome (decided, then corrected)

Today the welcome shows whenever `frames.size === 0` (`rerenderTable` and `clearFrames` in
`sloppycan.js`). Two consequences:

- Connected to a quiet bus, the user sees the welcome's Connect/Demo tiles while already
  connected.
- After **Clear**, the welcome comes back until the next frame arrives.

Introduce one state, **link up**: an adapter is connected or the Demo is running. Set it in one
place as a body class (`body.no-link`), cleared on connect or `startDemo()` and set again on
disconnect. Don't scatter `style.display` toggles.

| | No link | Link up, no frames | Link up, frames |
|---|---|---|---|
| Welcome tiles | shown | hidden | hidden |
| ID List / Dump body | – | `.empty` "No frames yet." | table |
| `#sharedToolbar`, `#txPanel` + `#resizeHandle`, `#logPanel` | hidden | shown | shown |
| Header `#busPauseBtn`, `#clearMainBtn`, stats | hidden | shown | shown |
| Serial Terminal tab (today a disabled tab at opacity .35) | hidden | shown when it would be enabled today | same |

Key it on the **link, not on the bus being open**. With "Auto-open bus on connect" unchecked,
the adapter connects with the bus closed, and **Open Bus** (`#busPauseBtn`) is the only way to
open it, so it must be visible then.

One exception: if an error is logged with no link (a failed connect), show the console bar so
the error can be found. Hook this into `log()` in `sloppycan.js`, next to its `autoExpandErr`
check.

## 3. Header

| Today | Change |
|---|---|
| `FPS [10]` select in the header | Turn `⋯` into the app menu: its Workspace actions, then a "Settings" group holding **Render rate** (the FPS select) and **Buffer size** (moved out of the Connect popover). Both are *global* prefs, not per-workspace (`collectPrefs` / `applyPrefs`), and neither is about connecting. Keep the ids `fpsLimit` and `bufferSizeSelect` so persistence keeps working. Rename `#wsMenuBtn`'s label from "Workspace actions" to "Menu". Update the Memory stat's tooltip, which says "capacity set under Connect ▸ Buffer size". |
| Stats: a `‹` chevron + "0% MEMORY" when collapsed (the default); IDs/Frames/fps/Errors/Bytes when expanded | Show **IDs · fps** always (with a link), **Errors** only when > 0 (red), **Memory** only at ≥ 75% (amber). Frames and Bytes go into the block's tooltip. Delete the collapse: `toggleStatsCollapse`, `_statsCollapsed`, the `slcanStatsCollapsed` localStorage key and the `.stats-collapsed` CSS. |
| Demo becomes a grey **Reload** once started (`makeReloadBtn`) | Label it **Stop demo**. Keep the reload behaviour: it's what stopping means here. |
| Connect → popover titled "ADAPTER SETTINGS" → another **Connect** | Drop the popover title. Lay the fields out with `.field` (caption left, control right). Checkboxes go left-aligned with their label, not split to opposite edges as now. |
| `#noSerialBanner`: "⚠ Web Serial API not available. Please use Chrome or Edge (version 89+). This interface requires a Chromium-based browser." | "Needs Chrome or Edge." |

Keep the header's responsive wrap (`header{flex-wrap:wrap}` + the 1200px media block).

## 4. Bottom panels

- **TX Scheduler rows** repeat their labels (ID, RTR, DLC, DATA (HEX), PERIOD, MS, ENABLE) at
  10px on every row. Make the rows a CSS grid with one shared column template, and print the
  labels once in a header row. The row's note field ("Broadcasts UDS Tester Present") is free text
  set in 12px Azeret Mono, which reads much larger than the 10px condensed labels around it. Make
  it `--fs-m` sans with placeholder "Note"; the ID and data fields stay mono.
- **Automatic messages** header: cut the "sent by modules · read-only" subnote (it's already the
  tooltip).
- **Console**: show "auto-expand on error" and Clear only while the console is expanded.

## Done when

- Fresh load (no link): the header, the tabs and the three tiles. Nothing disabled is on screen,
  including the Serial Terminal tab.
- Demo: the chrome appears, the welcome is gone, and Clear shows "No frames yet." until frames
  arrive, never the tiles.
- Connected with auto-open off: Open Bus is visible and opens the bus.
- Carlito tile with no link: the Demo starts and Carlito opens, in one click.
- The 1366×768 and 1600×900 screenshots in both themes look right; the user verifies.
