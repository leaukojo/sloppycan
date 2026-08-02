# Contributing

Thanks for taking a look at SloppyCAN.

## Before you start

- Read [`README.md`](README.md) for what the app does and how to run it.
- For architecture, wire formats, and data structures, see
  [`.claude/core-arch.md`](.claude/core-arch.md) and [`.claude/modules.md`](.claude/modules.md).
- There's no build step and no dependencies: `index.html` + `sloppycan.css` + `sloppycan.js`
  is the core; everything else is an optional bolt-on module (see "For contributors" in the
  README for the module pattern).

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/leaukojo/sloppycan/issues). Useful things to include:

- Browser + OS (Web Serial/WebUSB behavior varies by browser).
- Adapter type (SLCAN / gs_usb) and device, or "Demo mode" if no hardware is involved.
- Steps to reproduce, and what you expected vs. what happened.

## Submitting changes

1. Fork the repo and make your change. Test it in a real browser (`file://` is enough for most
   tabs; see the README for what needs serving over `localhost`).
2. Keep new tabs/features as self-contained bolt-on modules where possible, following the
   existing pattern (a single script, wired into the core through a few clearly tagged hooks).
3. Open a pull request describing what changed and how you tested it (which browser/adapter,
   or Demo mode).

## A note on scope

This project is for **learning CAN bus protocols**, not for interfacing with real, in-service
vehicles; see the [License](README.md#license). Please keep contributions aligned with that
scope (bench setups, simulators, RAMN/Carlito, demo/test traffic).
