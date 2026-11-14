// Static checks that need no browser and no dependencies:
//   1. every inline on*="..." handler in the two app pages calls functions that are defined;
//   2. every <script src> in the app pages and explainers/*.html points at a file that exists;
//   3. .claude/CLAUDE.md stays within its size budget (it is loaded into every Claude Code session).
//   4. the app's CSS keeps to the UI tokens: the type scale, the radii, no vertical padding on controls.
//
//   node .github/scripts/static-checks.mjs [repo-root]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.argv[2] || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const PAGES = ['index.html', 'carlito-bridge.html'];
const failures = [];

// ── 1. Inline handlers ───────────────────────────────────────────────────────
// Definitions: every js/*.js file plus the pages' own inline <script> blocks.
const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
let defs = readdirSync(join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => read('js/' + f)).join('\n');
for (const p of PAGES)
  for (const m of read(p).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) defs += '\n' + m[1];
// Every declared name, collected in one pass: `function NAME`, `NAME =` and `window.NAME =`. This
// only proves a name is declared SOMEWHERE (an IIFE-private function counts); smoke.mjs checks
// the stronger "is a function on window" against the live page.
const DECLARED = new Set();
for (const re of [/function\s*\*?\s+([A-Za-z_$][\w$]*)/g, /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])/gm, /window\.([A-Za-z_$][\w$]*)\s*=(?![=>])/g])
  for (const m of defs.matchAll(re)) DECLARED.add(m[1]);
const defined = (n) => DECLARED.has(n);

// A bare call (not a member call like el.click()) or a window.NAME call; skip language keywords
// and browser globals, which the page does not define.
const NOT_OURS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'function', 'typeof', 'new', 'catch',
  'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'isNaN', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'open', 'encodeURIComponent',
]);
let handlerCount = 0;
for (const p of PAGES) {
  const html = read(p);
  for (const m of html.matchAll(/\s(on[a-z]+)=(["'])([\s\S]*?)\2/g)) {
    handlerCount++;
    const code = decodeEntities(m[3]);
    const line = html.slice(0, m.index + 1).split('\n').length;
    for (const c of code.matchAll(/(^|[^\w$.]|window\.)([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = c[2];
      if (NOT_OURS.has(name)) continue;
      if (!defined(name)) failures.push(`${p}:${line} ${m[1]}="${code}" calls ${name}(), which nothing defines`);
    }
  }
}

// ── 2. Script files exist ────────────────────────────────────────────────────
const htmlFiles = [...PAGES, ...readdirSync(join(ROOT, 'explainers')).filter(f => f.endsWith('.html')).map(f => 'explainers/' + f)];
let scriptCount = 0;
for (const f of htmlFiles) {
  for (const m of read(f).matchAll(/<script[^>]*\bsrc=(["'])([^"']+)\1/g)) {
    const src = m[2];
    if (/^(https?:)?\/\//.test(src)) continue;   // external: not ours to check
    scriptCount++;
    if (!existsSync(resolve(ROOT, dirname(f), src.split(/[?#]/)[0]))) failures.push(`${f}: <script src="${src}"> does not exist`);
  }
}

// ── 3. CLAUDE.md size budget ─────────────────────────────────────────────────
// Per-module detail belongs in the module itself or .claude/modules.md, not here.
const CLAUDE_MD_BUDGET = 9000;   // bytes
const claudeMdBytes = Buffer.byteLength(read('.claude/CLAUDE.md').replace(/\r\n/g, '\n'), 'utf8');
if (claudeMdBytes > CLAUDE_MD_BUDGET) failures.push(`CLAUDE.md is ${claudeMdBytes} bytes, over its ${CLAUDE_MD_BUDGET}-byte budget`);

// ── 4. Design tokens: type scale, radii, control padding ─────────────────────
// The app's CSS lives in sloppycan.css, index.html and each module's injected <style> and inline
// style="" (the explainers and carlito-bridge.html are standalone, out of scope).
//   a. font-size is a --fs-* token, inherit, or 11/13/15/20/28px, unless the line says fs-exempt
//      (instrument faces);
//   b. border-radius is 0, 50% or var(--r-pill) (the sharp shape language);
//   c. a select / input / .btn has no vertical padding: controls are a fixed --ctl-h tall with
//      border-box sizing, so vertical padding crops Saira Condensed's tall line box.
const STYLE_FILES = ['assets/sloppycan.css', 'index.html',
  ...readdirSync(join(ROOT, 'js')).filter(f => f.endsWith('.js')).sort().map(f => 'js/' + f)];
const FS_OK = /^(var\(--fs-(s|m|l|xl|xxl)\)|inherit|(11|13|15|20|28)px)$/;
const RADIUS_OK = /^(0(px)?|50%|var\(--r-pill\))$/;
const lineOf = (text, i) => text.slice(0, i).split('\n').length;
const bareVal = (v) => v.replace(/\s*!important\s*$/, '').trim();   // `0 8px !important` is `0 8px`
const vertPad = (decls) => {   // the first non-zero vertical padding in a declaration block, or null
  for (const m of decls.matchAll(/(?:^|[;{\s"'])padding(-top|-bottom|-block)?\s*:\s*([^;"'}]+)/g)) {
    const v = bareVal(m[2]).split(/\s+/);
    const vert = m[1] ? v : [v[0], v[2] ?? v[0]];
    if (vert.some(x => !/^0(px)?$/.test(x))) return m[0].replace(/^[;{\s"']/, '').trim();
  }
  return null;
};
// The rule's subject (last compound selector) is a select, an input or a .btn.
const CONTROL_SEL = /(^|[\s>+~])(select|input)(?![\w-])|\.btn(?![\w])/;
// Not checkbox / radio / range / color: those are not text boxes and carry no line of text.
const NOT_TEXT = /\[type=["']?(checkbox|radio|range|color)/;
const targetsControl = (sel) => sel.split(',').some(s => {
  const subject = s.trim().split(/\s*[\s>+~]\s*/).pop();
  return CONTROL_SEL.test(subject) && !NOT_TEXT.test(subject);
});
let styleChecks = 0;
for (const f of STYLE_FILES) {
  const text = read(f);
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?<![\w-])font-size\s*:\s*([^;"'}`]+)/g)) {
      styleChecks++;
      if (!FS_OK.test(bareVal(m[1])) && !line.includes('fs-exempt'))
        failures.push(`${f}:${i + 1} font-size:${m[1].trim()} is off the type scale (use a --fs-* token, or mark an instrument face fs-exempt)`);
    }
    for (const m of line.matchAll(/(?<![\w-])border-radius\s*:\s*([^;"'}`]+)/g)) {
      styleChecks++;
      if (!RADIUS_OK.test(bareVal(m[1]))) failures.push(`${f}:${i + 1} border-radius:${m[1].trim()} (only 0, 50% or var(--r-pill))`);
    }
  });
  // Stylesheet text: the whole .css file, an HTML page's <style> blocks, a module's injected CSS
  // (`x.textContent = `…`` or a `FOO_CSS = `…`` const, as vehicle-panel.js has).
  const sheets = f.endsWith('.css') ? [[text, 0]]
    : [...text.matchAll(f.endsWith('.html') ? /<style[^>]*>([\s\S]*?)<\/style>/g : /(?:\.textContent|_CSS)\s*=\s*`([\s\S]*?)`/g)]
        .map(m => [m[1], m.index + m[0].indexOf(m[1])]);
  for (const [css, off] of sheets) {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));   // keep offsets
    for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!targetsControl(m[1].trim())) continue;
      styleChecks++;
      const p = vertPad(m[2]);
      if (p) failures.push(`${f}:${lineOf(text, off + m.index + m[0].length - m[2].length - 1)} ${m[1].trim()} { ${p} } - controls take padding:0 X`);
    }
  }
  // Inline style="" on a <select>, an <input> or a <button class="btn …">.
  for (const m of text.matchAll(/<(select|input|button)\b([^>]*)>/g)) {
    if (m[1] === 'button' && !/class=["'][^"']*\bbtn\b(?!-)/.test(m[2])) continue;
    if (m[1] === 'input' && /type=["']?(checkbox|radio|range|color)\b/.test(m[2])) continue;
    const st = m[2].match(/style=(["'])([\s\S]*?)\1/);
    if (!st) continue;
    styleChecks++;
    const p = vertPad(';' + st[2]);
    if (p) failures.push(`${f}:${lineOf(text, m.index)} <${m[1]} style="${p}"> - controls take padding:0 X`);
  }
}

console.log(`${handlerCount} inline handlers, ${scriptCount} local <script src> checked, ${styleChecks} style declarations, CLAUDE.md ${claudeMdBytes}/${CLAUDE_MD_BUDGET} bytes`);
if (failures.length) {
  console.error(`\nSTATIC CHECKS FAILED - ${failures.length} problem(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('static checks passed');
