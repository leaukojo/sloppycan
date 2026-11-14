# UI redesign: overview

Started 2026-11-13 from a full UI/UX audit (every tab in Demo mode, both themes, 1600×900 and
1366×768). The phase files hold the work; this file holds the why, the rules and the decisions.

| Phase | File | Scope | Opus effort | Plan mode | Status |
|---|---|---|---|---|---|
| 1 | [ui-phase-1-foundation.md](ui-phase-1-foundation.md) | Tokens, type scale, contrast, shape, crop bugs, shared primitives, lint | high | yes | todo |
| 2 | [ui-phase-2-welcome-chrome.md](ui-phase-2-welcome-chrome.md) | Welcome screen, header, bottom panels | high | no | todo |
| 3 | [ui-phase-3-beta-tabs.md](ui-phase-3-beta-tabs.md) | DroneCAN, J1939, CHAdeMO, CANopen; Carlito controls to vehicle panels | high | yes | todo |
| 4 | [ui-phase-4-core-tabs.md](ui-phase-4-core-tabs.md) | ID List, Dump, ISO-TP, XCP, Graph, Fuzzing, Terminal, Inspector | medium | no | todo |

Phase 1 comes first because phases 2–4 build on its primitives. After phase 1 the other three are
independent of each other. Run one session per phase. Each phase file opens with the reason for
its effort and plan-mode recommendation.

## How the "Linear / Apple Notes" prompt applies here

Most of it applies. One part does not.

- **Applies:** cut the taglines and helper text; when a screen needs explaining, fix the layout;
  keep one consistent look. Most of what's wrong with the UI today breaks one of these.
- **Does not apply literally:** "simple purpose". sloppyCAN is a multi-protocol workbench with
  12 tabs and 10 vehicle panels, not a notes app. The useful model is **Linear**: dense but calm,
  with a few primitives used everywhere, quiet chrome, detail in panes and tooltips, and nothing
  that explains itself on screen.
- **"UX, DX and AX at once" in practice:** today 17 modules each inject their own `<style>` with
  their own sizes, radii and label styles, so every tab looks different, and an agent copies
  whichever tab it opened first. A shared set of primitives, plus a lint in `static-checks.mjs`
  that rejects off-scale values, improves all three at once: users get consistency, developers
  get less CSS, and agents can't regress it.
- **Don't delete what this tool teaches; move it.** Much of the helper text is good teaching
  material in the wrong place (permanent labels). It goes to the explainers, the Help popover or
  a one-sentence tooltip.

## Rules (apply in every phase)

1. **Labels are nouns, never sentences.** A permanent label names a thing. If something needs
   explaining, the explanation goes in this order of preference: a better layout, a one-sentence
   tooltip in the user's voice, the Help popover, an explainer page. Developer reasoning (contract
   names, DSDL ids, "static markup because…") stays in code comments.
2. **One way to do each thing:** one bar, field, segmented control, button, table, section
   title, empty state, stat card and "learn" link (phase 1 defines them). Modules compose these
   and keep only bespoke CSS (gauges, canvases, bit grids).
3. **Three text sizes:** 11 (caps labels, meta, badges), 13 (body, controls, tables, logs) and
   15 (tabs, titles). Readouts use 20 or 28. Body text is `--text` or `--text2`; `--text3` is
   only for disabled text, placeholders and decoration.
4. **Hide controls that can't act yet; don't grey them out.** Before a link is up (adapter
   connected or Demo running) there's nothing to filter, transmit or clear.
5. **Empty states are one line**, with an action button if one helps. They don't teach the
   protocol.
6. **Enforced where possible:** each rule that can be checked goes into
   `.github/scripts/static-checks.mjs`.

Keep these from the previous redesign:

- **`padding:0 X` on fixed-height controls.** Saira Condensed's natural line height is about
  1.58× its size (19px at 12px; 20.5px at the new 13px), so vertical padding crops text in a
  22–24px select.
- The header's responsive wrap (`header{flex-wrap:wrap}` + the 1200px media block).
- The ID-cell colour, which is set inline by the ID List and Traffic Dump render code, not by
  CSS.
- The byte-highlight boxes and STD/RX/TX/FW badges, which carry meaning.
- Sticky header backgrounds on `th`, not `thead`.

When a phase changes one of these (phase 1 moves controls from 22px to 24px), update Claude's
project memory note `redesign-header-overflow` to match.

## Decisions log

- 2026-11-13: type scale is **11 / 13 / 15** (bigger, roughly 10% fewer table rows on screen).
- 2026-11-13: welcome is **3 big tiles** (Connect, Demo, Drive Carlito). Cut the hover-tour
  chips. Hide the filter bar, TX scheduler and console until a bus is open.
  *Refined in review:* "until a link is up" (adapter connected or Demo), not "until the bus is
  open". With auto-open off, a connected adapter's bus is closed and Open Bus must stay visible.
  See phase 2.
- 2026-11-13: Carlito bench controls move **out of the protocol tabs into the vehicle panels**:
  DroneCAN's rows go (Drone Control already has them), and J1939's DM1/trailer lamp row moves
  into the Truck panel's Commands.
  *Correction, same day:* in a DroneCAN Demo without the game, those rows also put command
  transfers on the bus, and Drone Control is unreachable there. The tab therefore gets a "Drone
  controls" button that opens the window on its own; see phase 3.
- 2026-11-13: Frame Inspector as a side panel: **yes, but later** (backlog).
- Shape: stay sharp (`border-radius:0`), the existing design language. Pills and dots are the
  only round shapes.

## Backlog (not scheduled)

- **Frame Inspector becomes a side panel** on ID List / Traffic Dump: click a row and the details
  slide in on the right, like Linear's issue peek. The tab and its dead-end empty state go away.
  `inspectFrame(f)` (`sloppycan.js`) already renders into a container, so it's mostly layout plus
  selection state.
- **Group the tabs.** 12 flat tabs, or 11 once the Inspector is a pane. Possible groups:
  Bus (ID List, Dump, Graph) · Diagnostics (ISO-TP, XCP) · Protocols (J1939/N2K, CHAdeMO, CANopen,
  DroneCAN) · Tools (Fuzzing, Terminal). Only worth doing if the tab bar wraps on laptops.
- **Tooltip pass.** Many `title=` attributes are developer notes (`contract trailer_abs_lamp - …
  SAE J2497 carries on the POWER LINE…`). Rewrite them as one user-facing sentence and move the
  rest into code comments.
- **Replace the native `confirm()` dialogs that fire on a tab switch** with an inline bar in the
  tab:
  - `demoMaybeSwitch` (`sloppycan.js`) shows two dialogs when you open a protocol tab during
    Demo;
  - `requestVehicle` (`vehicle-panel.js`) shows a paragraph-long one when you open
    DroneCAN/J1939 modes while Carlito runs (the `PROTO_PANEL` texts).

(`docs/` is excluded from the gh-pages deploy in `ci.yml`, so these plans are not published.)
