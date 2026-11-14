# Phase 4: core tabs

**Run with:** Opus, effort **medium**, plan mode **no**. It's mostly copy cuts and moving tabs
onto the phase 1 primitives, all spelled out below. The exception is the Traffic Dump step, a
virtual-scroll table with a separate header table: raise the effort to **high** for that commit.

Needs phase 1. One commit per tab. Same rules as phase 3: `.bar`, `.field`, `.sec`, one-line
`.empty`, one `.learn` at the right end of the bar, no sentences.

## Shared filter bar (ID List + Traffic Dump, `#sharedToolbar`)

- Drop the captions FILTER IDS / FRAME / DATA / DISPLAY and let the controls name themselves:
  - IDs input placeholder `IDs: 024, 100-1FF`;
  - data input placeholder `Data bytes` (today the caption says "DATA" and the placeholder says
    "FILTER DATA");
  - the two frame selects both read **ALL**, which is ambiguous side by side. Make their first
    options `STD + EXT` and `DATA + RTR`;
  - the display select already reads "Hex + ASCII".
- Dump only: replace the "EXPORT" caption + Save filtered + Save all with one **Export ▾** menu
  (Filtered / All).

## ID List (`#frameTable`)

- Column widths, measured at 1600px: ID 194, Type 140, DLC 84, Data 629, Count 109, Rate 96,
  Last seen 142, Notes 173. A 29-bit ID ("0x14040A0B") needs ~100px and DLC holds one digit.
  Size ID, Type, DLC, Count, Rate and Last seen to their content, and give the remaining width
  to Notes.
- Last seen is sans 11px green (`.td-age`) next to mono Count/Rate. Make it mono `--fs-m` like
  its neighbours and keep the age colouring.
- The pin icon at the start of each row is barely visible (`.pin-btn`: `--text3` at opacity
  .5). Show it on row hover and when pinned.
- Remember: the ID cell colour is set inline by the render code, not by CSS.

## Traffic Dump (`#dumpHeaderTable` + `#dumpTable`): a real misalignment bug

The header and body are separate tables, and their columns don't line up. Measured at 1600px:

| | Data | Notes |
|---|---|---|
| Header | x 340–1440 | x 1440–1600 |
| Body | x 343–702 | x 702–862 |

The **Notes header sits ~740px to the right of the Notes cells**, and the body's cells add up to
859px inside a 1590px table, which is why the row lines stop short.

Give both tables one shared column definition (a `<colgroup>` written once, or the same CSS
widths) with the same flexible column. Then verify alignment by measuring header and body
`getBoundingClientRect()`, with the scrollbar both present and absent.

## ISO-TP (`#isotpWrap`)

- Bar keeps the protocol `.seg` (UDS / OBD-II / KWP2000), Tx ID, Rx ID and CAN. Addressing (+
  addr byte), Block size, STmin (+ its ms readout) and Padding go into a ⚙ **Transport**
  popover. Those are set-once values that take half the bar today.
- Two learn links ("Learn how ISO-TP works ↗", "Learn how UDS works ↗") → one `.learn` that
  follows the protocol. "Clear Window" → "Clear".
- Empty log: `.empty` "No requests yet." Input placeholder `hex bytes - e.g. 22 F1 84 or 3E 00`
  → `22 F1 84`.

## XCP (`#xcpWrap`, `xcp.js`)

- Move it onto the primitives. Its labels, mono selects and rounded green Connect button are the
  most off-style controls in the app.
- "Not connected. Set the CRO/DTO IDs above, then click Connect. With Demo mode on, a simulated
  XCP slave answers - no hardware needed." → "Not connected."
- "No XCP frames yet. Commands ride the CRO ID, responses + DAQ ride the DTO ID." → "No XCP
  frames yet."
- Move `.learn` up from the log bar. "Clear Window" → "Clear".

## Graph (`#graphWrap`, `graph.js`)

- Move it onto the primitives; the crop fix is in phase 1.
- Cut "drag = pan · wheel = zoom" from the bar and put it in the canvas `title` and the Help
  popover. "Live ⟲" → "Live". Shorten the Pause/Live tooltips to one sentence each.
- No signals graphed: `.empty` "No signals." over the canvas. Today it's an empty grid.

## Fuzzing (`#fuzzWrap`)

- Four full-width cards hold a few controls each, and Start sits at the bottom of the last
  card. Replace them with a top `.bar` holding **Start / Stop** (`.btn.primary`), the frame
  counter and a one-line warning, above a compact two-column form: Target + Payload on the left,
  DLC + Timing on the right. The whole tab should fit on one 768px-high screen.
- Warning: "⚠ Sends crafted frames. Use only on a bench bus." It stays because it's
  safety-relevant, but on one line.
- Radio groups → `.seg`.

## Serial Terminal (`#termWrap`)

- "⚠ Live traffic is streaming on the bus - it will clutter this raw console. Pause the bus (and
  close Carlito if it's running) to use the serial terminal cleanly." → "Live traffic will
  clutter this console." + an inline **Pause bus** button.

## Frame Inspector (light touch; the side panel is in the backlog)

- Drop the NOTES heading (the placeholder already says it) and the "ID Color" caption (the
  swatches get a tooltip).
- Bit-field layout: the 1-bit fields (SOF, RTR, IDE, R0) are as wide as the 11-bit ID, which
  crams the ID's bits. Make field width proportional to bit count.

## Done when

- On none of these tabs does the sentence sweep (phase 1 appendix) return anything. The Fuzzing
  warning is the one allowed exception.
- The core workflows still work in Demo: filters, notch, export, ISO-TP VIN request, XCP
  connect and read, graph add/pan/zoom, a fuzz run.
- The CI checks pass and the user verifies.
