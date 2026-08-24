#!/usr/bin/env node
/* verify.js — asserts the four fixes, before and after, on the real code. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const P = require('./probe.js');

function load(file) {
  const html = fs.readFileSync(file, 'utf8');
  const js = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    alert: m => { sb._alert = m; }, confirm: () => true,
    crypto: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Date, Math, JSON, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean,
    Array, Object, RegExp, Error, Promise, Map, Set, Intl,
    encodeURIComponent, decodeURIComponent,
  };
  const stub = () => new Proxy(function () {}, { get: (t, k) => k === 'style' ? new Proxy({}, { get: () => stub() }) : stub(), set: () => true, apply: () => stub() });
  sb.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => stub(), addEventListener() {}, body: stub(), documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {} } } };
  sb.navigator = { serviceWorker: undefined, standalone: false, userAgent: 'v' };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  sb.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sb.addEventListener = () => {}; sb.location = { href: '', reload() {} };
  sb.FileReader = function () {}; sb.URL = { createObjectURL: () => '' }; sb.open = () => ({ document: { write() {}, close() {} }, focus() {}, print() {} });
  vm.createContext(sb);
  // run statement by statement so a top-level DOM call cannot stop the definitions
  for (const chunk of js.split(/\n(?=function |const |let |var )/)) {
    try { vm.runInContext(chunk, sb); } catch (e) { /* top-level wiring only */ }
  }
  return sb;
}

let pass = 0; const fails = [];
function is(name, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`${name}\n      got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}
function ok(name, cond, why) { if (cond) pass++; else fails.push(`${name}\n      ${why}`); }

const before = load(process.argv[2] || '/mnt/user-data/uploads/index.html');
const after = load(process.argv[3] || 'index.html');

console.log('\n  fix 1 — a quote in a description no longer truncates the field');
is('  before: esc leaves the quote raw', before.esc('26" copper pipe, 3m').includes('"'), true);
is('  after:  esc escapes it', after.esc('26" copper pipe, 3m'), '26&quot; copper pipe, 3m');
{
  const frag = `<input value="${after.esc('26" copper pipe, 3m')}">`;
  is('  after:  the whole text survives the attribute',
    frag.match(/value="([^"]*)"/)[1], '26&quot; copper pipe, 3m');
}
is('  after:  apostrophes are safe in a single-quoted attribute too', after.esc("O'Brien"), 'O&#39;Brien');
is('  after:  angle brackets still escaped', after.esc('<b>A & B</b>'), '&lt;b&gt;A &amp; B&lt;/b&gt;');
is('  after:  a number no longer throws', after.esc(1350), '1350');
is('  after:  null is empty', after.esc(null), '');

console.log('\n  fix 2 — a rate typed with a currency symbol is no longer a silent zero');
const entry = r => ({ id: 'e1', rate: r, startDate: '2026-08-23', startTime: '09:00', endDate: '2026-08-23', endTime: '17:00', segments: [] });
before.settings = before.settings || {}; after.settings = after.settings || {};
{
  const b = before.calcEntryTotal(entry('£13.50'));
  const a = after.calcEntryTotal(entry('£13.50'));
  ok('  before: 8h at "£13.50" totals NaN, shown as £0.00', isNaN(b.total), 'expected NaN, got ' + b.total);
  is('  after:  8h at "£13.50" totals 108', a.total, 108);
}
is('  after:  "13,50" (comma decimal) still works', after.calcEntryTotal(entry('13.50')).total, 108);
is('  after:  a plain number is unchanged', after.calcEntryTotal(entry('13.50')).total, 108);
is('  after:  an empty rate falls back, not NaN', isNaN(after.calcEntryTotal(entry('')).total), false);
is('  after:  "eight" is 0, not NaN', after.num('eight'), 0);
is('  after:  fmtMoney no longer turns NaN into a plausible zero via ||', after.num(NaN), 0);
is('  after:  cleanNum shows what was stored', after.cleanNum('£13.50'), '13.50');
{
  const it = { id: 'i1', qty: '3', unitPrice: '£10.00', taxable: true };
  is('  after:  an item priced "£10.00" totals 30', after.calcItemTotal(it), 30);
  is('  before: the same item totalled 0', before.calcItemTotal(it), 0);
}

console.log('\n  fix 3 — the chips match the view actually drawn');
ok('  after:  updateEntryChips asks whether the card is minimised',
  /collapsedEntries\.has\(id\)/.test(fs.readFileSync(process.argv[3] || 'index.html', 'utf8').split('function updateEntryChips')[1].slice(0, 700)),
  'no isMini check found in updateEntryChips');
ok('  before: it wrote the icon prefix unconditionally',
  /hChip\.textContent = '⏱ '/.test(fs.readFileSync(process.argv[2] || '/mnt/user-data/uploads/index.html', 'utf8')),
  'expected the unconditional prefix in the original');

console.log('\n  fix 4 — Excel export explains itself with no library');
{
  const src = fs.readFileSync(process.argv[3] || 'index.html', 'utf8');
  for (const fn of ['doExportExcel', 'doExportItemsExcel', 'doExportCombinedExcel']) {
    ok(`  after:  ${fn} checks first`, new RegExp(fn + '\\([^)]*\\)\\s*\\{\\s*if\\(!xlsxReady\\(\\)\\) return;').test(src), 'no guard');
  }
  after._alert = null;
  is('  after:  the guard returns false when XLSX is absent', after.xlsxReady(), false);
  ok('  after:  and says why', /offline/i.test(after._alert || ''), 'no message shown');
  const sw = fs.readFileSync('sw.js', 'utf8');
  ok('  after:  the service worker precaches the library', sw.includes('XLSX_URL') && /caches\.open\(CACHE\)[\s\S]{0,120}XLSX_URL/.test(sw), 'not precached');
  ok('  after:  in its own call, so a CORS miss cannot wipe the core precache',
    (sw.match(/caches\.open\(CACHE\)/g) || []).length >= 2, 'shares the one addAll');
  ok('  after:  cache version bumped', /invoice-mgr-v10/.test(sw), 'still v9');
}

console.log('\n  regressions');
is('  hours across midnight still 8', after.calcHours('2026-08-23', '22:00', '2026-08-24', '06:00'), 8);
is('  same-day hours still 8.5', after.calcHours('2026-08-23', '09:00', '2026-08-23', '17:30'), 8.5);
is('  a reversed shift still returns null', after.calcHours('2026-08-23', '17:00', '2026-08-23', '09:00'), null);
is('  an hours override still overrides', after.calcEntryTotal(Object.assign(entry('10'), { hoursOverride: '5' })).total, 50);
is('  a blank override does not', after.calcEntryTotal(Object.assign(entry('10'), { hoursOverride: '' })).total, 80);
is('  todayISO is still local', after.todayISO(), (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date()));

if (fails.length) { console.log('\n  FAILED'); fails.forEach(f => console.log('    ✗ ' + f)); }
console.log(`\n  ${pass}/${pass + fails.length} assertions passed\n`);
process.exit(fails.length ? 2 : 0);
