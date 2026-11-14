# Plan: one file for UI strings (`js/strings.js`)

Status: proposed, not started. Goal: every user-facing label, hint, tooltip and status message in
one file, so wording is managed in one place and a translation is a second table, not a code hunt.

## Size (2026-11-14)

- ~370 `title="…"` tooltips: `index.html` 105, `drone.js` 45, `truck.js` / `boat.js` 39,
  `tractor.js` 37, then a long tail across ~15 files. Many are paragraphs, not labels.
- Visible markup text: all of `index.html` (1000 lines) plus each panel's template literal.
- ~60 `textContent = '…'` literals (35 in `sloppycan.js`), ~75 `log('…')` messages
  (`sloppycan.js`, `can-link.js`, `carlito-bridge.js`).
- 15 standalone pages in `explainers/`.

So: big. Touches nearly every file, and is only worth finishing if translation becomes real.

## Scope

**In:** UI chrome: buttons, section labels, hints, tooltips, status lines, `log()` messages.

**Out (stay where they are):**
- Protocol dictionaries (`j1939-tables.js`, `diag-parse.js` DTC / PID / SPN names): standard names
  from primary sources, not UI wording; translating them would break searchability against the spec.
- Contract enum labels: come from the generated `carlito_contract.js`.
- Bus-derived text (always via `escHtml()`, unchanged).
- `explainers/`: standalone pages, one language each if ever translated. Last, if at all.
- `carlito-bridge.html`: standalone, no link to the app; gets its own small table if wanted.

## Mechanism

1. `js/strings.js`, a classic script loaded **first** (before `can-link.js`). It declares only
   `window.UI_STR` (nested by area: `ramn.*`, `truck.*`, `hdr.*`, …) and `window.t(key, vars)`:
   lookup + `{name}` interpolation, returning the key itself when missing (visible, never blank).
   No other globals: the core scripts share one lexical scope.
2. Static markup in `index.html`: `data-i18n="key"` (text) / `data-i18n-title="key"` (tooltip),
   filled by one pass at load. Keep the English text in the markup too, so the page still reads
   right with the pass disabled and diffs stay legible.
3. Panel template literals (`ramn.js`, `drone.js`, …): `${t('ramn.keys')}` inline. Values that
   contain markup (`<b>W</b>`) stay HTML in the table; table strings are trusted, never bus data.
4. Language: `UI_STR` is English; a later `UI_STR_<lang>` overlays it, picked by `?lang=` /
   `navigator.language`. Not built until a translation exists.

## Guard (static-checks.mjs)

- Every `t('…')` / `data-i18n*` key exists in `UI_STR`; every `UI_STR` key is used somewhere
  (no dead strings).
- Not attempted: detecting raw new text in markup. Too noisy; review catches it.

## Phases (one commit each, smoke test green between)

0. `strings.js` + `t()` + the load pass + the static check, with no strings moved yet.
1. Floating panels: `ramn.js`, `truck.js`, `tractor.js`, `drone.js`, `boat.js`, `boat-pilot.js`,
   `plane.js`, `train.js`, `vehicle-panel.js`. Most of the wording churn happens here.
2. `index.html` header, toolbars and tabs.
3. Runtime text in `sloppycan.js` / tab modules: `textContent` literals, status lines.
4. `log()` messages (`can-link.js` too; it's reused by the bridge, so the bridge must load
   `strings.js` or `t()` must fall back to the key).
5. Optional: `explainers/`, the bridge.

## Costs / risks

- **Loses co-location.** Today a tooltip that explains code behaviour sits next to that code (the
  repo's "a file's behaviour lives in that file" rule). After: two files per wording edit. If the
  goal is only "easier to manage" with no translation planned, this is a net loss: stop after
  phase 1, or don't start.
- Long technical tooltips (drone/truck/boat) are documentation as much as UI; translating them is
  most of the translation cost.
- Self-tests or smoke checks that match on English text break when keys move; grep
  `.github/scripts/smoke.mjs` and the `*SelfTest`s for text matches before phase 1.
- Docs to update when done: `.claude/core-arch.md` (UI helpers), the file map in `CLAUDE.md`.
