# Phase 1: foundation

**Run with:** Opus, effort **high**, plan mode **yes**. This phase defines the tokens and the
primitive class API that phases 2–4 build on, and it touches about 20 files. Approve the
primitive names and the size mapping before the sweep starts, because changing them afterwards
means a second sweep. The work is broad rather than deep, so xhigh isn't needed.

Goal: one set of tokens and primitives that every later phase uses, plus the objective defects
(cropped text, unreadable contrast) fixed. Each numbered section below is one commit.

## Audit numbers (measured 2026-11-13)

- **Sizes:** at least 12 font sizes are in use: 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16
  and 22px. In a sweep of every tab with Demo traffic, over 99% of rendered text elements
  (mostly table cells) were 10–12px, in a *condensed* face. Tabs are 16px, so the tab bar is the
  loudest thing on screen while the data is the quietest.
- **Contrast** (WCAG ratio against `--bg` / `--bg2` / `--bg3`):

  | Token | Value | Ratio | |
  |---|---|---|---|
  | dark `--text2` | `#5d6b78` | 3.80 / 3.65 / 3.50 | fails 4.5 for small text |
  | dark `--text3` | `#37424c` | 2.02 / 1.94 / 1.86 | used for most labels and empty-state text |
  | light `--text2` | `#6a4296` | 6.48 / 7.02 / 5.70 | fine |
  | light `--text3` | `#9d77c6` | 3.12 / 3.38 / 2.74 | |

- **Radii:** `sloppycan.css` alone has 0, 2, 3, 4, 5, 6, 7, 8, 9, 12, 20, 999px and 50%, despite
  the "sharp" design language. Rounded: Fuzzing cards (8px), CHAdeMO stat cards (10px) and pills,
  onboarding cards, the XCP buttons and inputs (5–6px), the RAMN floating windows (12px).
- **Injected styles:** 17 modules call `document.createElement('style')`. Every tab has its own
  label style. XCP: mixed-case "CRO (HEX)" with mono selects. ISO-TP: spaced caps with sans
  selects. The DroneCAN and J1939 bars: their own `.dc-config` button and select styles.
  Fuzzing: native **blue** radios in an amber theme.
- **Cropping, root cause.** Saira Condensed's natural line height is ~1.58× its size: 17.5px at
  11px, 19px at 12px, 20.5px at 13px. Azeret Mono's is ~1.15× (15px at 13px). A 22px control
  with 1px borders has 20px inside, so 12px Saira fits only with zero vertical padding. At the
  new 13px in 24px, the same holds.
  - **Selects clip**: Graph's `- no IDs seen yet -` loses the descender of the "y" (verified;
    `padding:0 6px` fixes it).
  - **Buttons and inputs** centre their text and overflow without clipping, so most look fine,
    but they're the same bug.
  - Measured with the appendix snippet:
    - Graph's 4 selects (`.graph-sel`, `padding:3px 6px`): needs 19px, has 14px.
    - `.btn-sm` (Help, Pause scroll, TX Suspend/Add): 18 / 14.
    - `.btn-xs` (ISO-TP Clear Window): 18 / 12.
    - `.input-send-btn`: 18 / 14.
    - The TX row's send-once button (`padding:2px`): 18 / 16.
    - `#inspectNoteArea` (`padding:8px`): 21 / 4.
    - J1939's lamp and preset selects and DroneCAN's selects (`padding:1px`): 19 / 18.

## 1. Tokens (`assets/sloppycan.css` `:root` + `body.light`)

Add:

```css
--fs-s: 11px;  --fs-m: 13px;  --fs-l: 15px;  --fs-xl: 20px;  --fs-xxl: 28px;
--ctl-h: 24px;            /* buttons, selects, inputs (was 22px). 13px Saira needs 20.5px inside,
                             so a 24px control fits it only with zero vertical padding */
--r-pill: 999px;          /* the only radius besides 0 and 50% */
```

Colour changes. The ratios are against `--bg` / `--bg2` / `--bg3`; recheck after any tweak.

| Token | Now | New | New ratios |
|---|---|---|---|
| dark `--text2` | `#5d6b78` | `#74818e` | 5.22 / 5.01 / 4.80 |
| dark `--text3` | `#37424c` | `#56636f` | 3.37 / 3.24 / 3.11 |
| light `--text3` | `#9d77c6` | `#8a63b5` | 4.05 / 4.39 / 3.56 |

Then re-point every caption that uses `--text3` to `--text2` (`.hdr-tag`, `.toolbar-label`,
`.tx-lbl`, `.empty-sub`, `.oc-desc`, `.help-note`, `.note-sans`, `.device-info`, `.graph-lbl`,
`.j1939-badge`, `.dc-note` and the module equivalents; all verified to use `--text3` today).
`--text3` stays only on disabled text, placeholders, separators and the zero-bits in the bit
views.

Beta tab labels render at `--text3` with `opacity:.82` (`.view-tab-beta ~ .view-tab`), nearly as
dim as the *disabled* Serial Terminal tab (`--text2` at `.35`), so they read as unavailable. Give
them normal tab colour; the `BETA` tag already marks them.

The 14 `explainers/*.html` pages carry their own copy of the token block. Apply the same three
colour changes there in the same commit so the explainers don't drift (a mechanical edit). The
rest of this phase is app-only. `carlito-bridge.html` has its own standalone `<style>`; leave it.

## 2. Type scale

Map the old sizes to the new ones:

| Old | New | Used for |
|---|---|---|
| 9, 10, 10.5, 11 | `--fs-s` 11 | caps labels, column headers, badges, meta |
| 11.5, 12, 12.5, 13 | `--fs-m` 13 | body, controls, table cells, log lines, hex bytes |
| 14, 15, 16 | `--fs-l` 15 | tabs, window and section titles |
| 22, big digits | `--fs-xl` / `--fs-xxl` | welcome title, stat readouts |

Apply in `sloppycan.css`, in every module's injected CSS, and in inline `font-size:` in JS
templates. `font-size:` occurrences per JS file (injected CSS and inline styles together):
sloppycan.js 44, xcp 23, canopen 18, j1939 15, drone 15, chademo 14, ramn 13, carlito 12,
vehicle-panel 11, dronecan 10.

Exempt: instrument faces in the vehicle panels and the RAMN cluster (dial ticks, gauge digits).
Mark each exemption `/* fs-exempt: gauge */` so the lint can skip it.

Also: `.view-tab` 16 → 15. Controls 22 → `--ctl-h`, keeping `padding:0 X`. Hex bytes in the
CANopen log render in **sans** 10.5px; make them mono like everywhere else. Expect table rows to
grow by ~2px; that's the accepted cost of the bigger scale.

## 3. Shape

- `border-radius` is `0`, except `--r-pill` (status pills, the beta tag) and `50%` (dots, slider
  knobs). Fix the Fuzzing sections, CHAdeMO stat cards, onboarding cards (replaced in phase 2
  anyway), the XCP buttons and inputs, the `makeFloating` windows, `.graph-sel` and
  `.graph-swatch`.
- `input[type=radio] { accent-color: var(--amber); }`: one line fixes the blue Fuzzing radios.
  Leave ranges alone; several are styled per module (`.range-green`, the drone's purple gimbal).
  Checkboxes are already custom.

## 4. Crop fixes

Remove the vertical padding from every control in the measured list above (`padding:0 X`).
Then re-run the appendix snippet on every tab, in the popovers (Connect, Help, Notch, `⋯`) and in
the RAMN windows, until it returns an empty list.

Graph picker with no traffic: replace `'- no IDs seen yet -'` (`graph.js`, in the ID-picker
fill) with a disabled picker showing `No IDs`, and disable Add while it's empty.

## 5. Primitives (`sloppycan.css`, new section `// ── Primitives`)

Define each once. Phases 2–4 migrate the modules to them.

| Class | Replaces | Shape |
|---|---|---|
| `.bar` | `.cfg-strip`, `.xcp-config`, `.co-config`, `.dc-config`, `.graph-toolbar`, `.subtab-bar`, `.chademo-note`, `.shared-toolbar` | 40px row, `gap:8px`, `padding:0 12px`, bottom border, wraps |
| `.field` | `label`+`.toolbar-label`, `.cfg-field`, `.fuzz-inline`, the XCP/CANopen labels | caption (`--fs-s`, caps, `--text2`) + control, `gap:6px` |
| `.seg` | `.obd-proto-toggle` (ISO-TP and J1939 protocol switches), fuzz radio groups | joined buttons, active = amber |
| `.btn` / `.btn.primary` / `.btn.danger` | `.xcp-btn`, `.co-btn`, `.obd-btn`, `.dc-config button` (DroneCAN and J1939 bars) | one height, one padding |
| `.sec` | `.fuzz-sec-title`, `.dc-grp-title`, `.log-section-bar`, `.xcp-log-bar`, `.co-logbar`, `.dc-logbar` | caps title, optional right-side actions |
| `.empty` | `.inspect-empty`, `.co-empty`, `.dc-empty`, the XCP/J1939/CHAdeMO empty texts | one line, `--text2`, centred, optional button |
| `.stat` | CHAdeMO cards, `.obd-tile` | caption + `--fs-xl` mono value + optional sub |
| `.pill` | CANopen state, CHAdeMO flags, DroneCAN health | `--r-pill`, `--fs-s` |
| `.learn` | the eight "Learn how X works ↗" links, spread over six tabs | an icon-link at the right end of the tab's `.bar` |

Migrating a module means deleting its version from the injected CSS, not keeping both.

**Marker classes are behaviour, not style.** JS selects on some of these classes:

- `#canopenWrap .co-tx-btn` and `#xcpWrap .xcp-tx-btn` (disable the buttons while a request is
  pending);
- `obd-btn` and `obd-btn-active` (built and queried in the OBD section of `sloppycan.js`);
- `xcp-hide-until-connected` (hidden by `xcp.js`'s CSS until `.xcp-connected` is set).

Grep each class in `js/` before replacing it. Keep the marker next to the new primitive
(`class="btn co-tx-btn"`), or update the selector in the same commit.

## 6. Lint (`.github/scripts/static-checks.mjs`)

Scan `assets/sloppycan.css`, each `js/*.js` (injected CSS and inline `style=`) and `index.html`.
The explainers and `carlito-bridge.html` are out of scope. Fail on:

1. any `font-size` that isn't a `--fs-*` token, `inherit`, or 11/13/15/20/28px, unless the line
   has `fs-exempt`;
2. any `border-radius` other than `0`, `50%` or `var(--r-pill)`;
3. a rule whose selector targets `select`, `input` or `.btn` and whose `padding` has a non-zero
   vertical value.

Add one line about the new checks to `CLAUDE.md` § Verifying. It's at 7780 of its 9000-byte
budget.

## Done when

- The lint passes, along with `node --check` on touched files and the three CI checks.
- The appendix snippet returns `[]` on every tab and popover.
- Screenshots of every tab in both themes look like one app: same label style, same control
  height, same section titles.
- The `redesign-header-overflow` memory note says 24px controls.
- The user verifies in Demo (per CLAUDE.md, ask rather than self-certify).

## Appendix: crop-audit snippet (DevTools / `evaluate_script`)

It measures each font's real `line-height: normal` instead of assuming 1.2×, which misses
Saira Condensed.

```js
(() => {
  const p = Object.assign(document.createElement('span'), { textContent: 'Ag' });
  p.style.cssText = 'position:absolute;visibility:hidden;line-height:normal';
  document.body.appendChild(p);
  const need = c => { p.style.font = c.font; p.style.lineHeight = 'normal'; return p.getBoundingClientRect().height; };
  const out = [...document.querySelectorAll('select,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),button')]
    .filter(e => e.offsetParent && (e.textContent.trim() || e.value || e.placeholder))
    .map(e => [e, getComputedStyle(e)]).filter(([, c]) => c.boxSizing === 'border-box')
    .map(([e, c]) => [e, c, parseFloat(c.height) - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom)
      - parseFloat(c.borderTopWidth) - parseFloat(c.borderBottomWidth),
      c.lineHeight === 'normal' ? need(c) : parseFloat(c.lineHeight)])
    .filter(([, , has, n]) => has + 0.5 < n)
    .map(([e, c, has, n]) => `${e.id ? '#' + e.id : e.className} needs ${n.toFixed(0)} has ${has.toFixed(0)} (pad ${c.paddingTop})`);
  p.remove();
  return out;
})()
```

## Appendix: sentence sweep (used by the "Done when" lists of phases 3 and 4)

Run it on each tab. It lists permanent text of 8+ words outside tables, logs and the TX rows.
Table content is excluded on purpose.

```js
[...new Set([...document.querySelectorAll('body *')]
  .filter(e => e.offsetParent && !e.querySelector('select')
    && !e.closest('tbody, .log-pane, #pane-console, #txBody, select')
    && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
  .map(e => e.innerText.trim().replace(/\s+/g, ' '))
  .filter(t => t.split(' ').length >= 8 && t.length < 300))]
```

Note that the demo-switch `confirm()` fires on the protocol tabs; stub `window.confirm` first.
