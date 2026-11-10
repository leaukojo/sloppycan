// Static checks that need no browser and no dependencies:
//   1. every inline on*="..." handler in the two app pages calls functions that are defined;
//   2. every <script src> in the app pages and explainers/*.html points at a file that exists;
//   3. .claude/CLAUDE.md stays within its size budget (it is loaded into every Claude Code session).
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

console.log(`${handlerCount} inline handlers, ${scriptCount} local <script src> checked, CLAUDE.md ${claudeMdBytes}/${CLAUDE_MD_BUDGET} bytes`);
if (failures.length) {
  console.error(`\nSTATIC CHECKS FAILED - ${failures.length} problem(s):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('static checks passed');
