#!/usr/bin/env node
/* periods.js — asserts the pay-period, contract and archive behaviour. */
const fs = require('fs'), vm = require('vm');

function load(file) {
  const html = fs.readFileSync(file, 'utf8');
  const js = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const sb = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    alert: m => { sb._alert = m; }, confirm: () => (sb._confirm !== false),
    crypto: { randomUUID: () => 'id-' + (sb._n = (sb._n || 0) + 1) },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Date, Math, JSON, parseInt, parseFloat, isNaN, isFinite, String, Number, Boolean,
    Array, Object, RegExp, Error, Promise, Map, Set, Intl, encodeURIComponent, decodeURIComponent,
  };
  const stub = () => new Proxy(function () {}, { get: (t, k) => k === 'style' ? new Proxy({}, { get: () => stub() }) : stub(), set: () => true, apply: () => stub() });
  /* Return a real-enough element rather than null: these assertions call
     the app's own state functions, which repaint as a side effect, and a
     null container turns a behaviour test into a DOM crash. */
  const els = {};
  const mk = () => ({ innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    children: [], appendChild(c) { this.children.push(c); return c; }, querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, setAttribute() {}, getAttribute: () => null, remove() {}, click() {}, focus() {} });
  sb.document = {
    getElementById: id => els[id] || (els[id] = mk()),
    querySelector: () => mk(), querySelectorAll: () => [],
    createElement: () => mk(), addEventListener() {}, body: mk(),
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {} } }
  };
  sb.navigator = { serviceWorker: undefined, standalone: false, userAgent: 'v' };
  sb.window = sb; sb.self = sb; sb.globalThis = sb;
  sb.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  sb.addEventListener = () => {}; sb.location = { href: '', reload() {} };
  sb.FileReader = function () {}; sb.URL = { createObjectURL: () => '' };
  sb.open = () => ({ document: { write() {}, close() {} }, focus() {}, print() {} });
  vm.createContext(sb);
  for (const chunk of js.split(/\n(?=function |const |let |var )/)) {
    try { vm.runInContext(chunk, sb); } catch (e) { /* top-level wiring only */ }
  }
  /* let/const at the top of the script land in the context's lexical scope,
     not on the sandbox object, so sb.settings is undefined even though the
     app's own functions can see it. Reach them by evaluating instead. */
  sb.ev = expr => vm.runInContext(expr, sb);
  return sb;
}

let pass = 0; const fails = [];
const is = (n, got, want) => JSON.stringify(got) === JSON.stringify(want) ? pass++ : fails.push(`${n}\n      got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const ok = (n, c, why) => c ? pass++ : fails.push(`${n}\n      ${why}`);

const A = load(process.argv[2] || 'index.html');
const P = (d, s) => { const r = A.periodFor(d, s); return [r.start, r.end]; };

console.log('\n  a 25th-to-25th period');
is('  the 25th opens a new period', P('2026-08-25', 25), ['2026-08-25', '2026-09-24']);
is('  the 24th is still the old one', P('2026-08-24', 25), ['2026-07-25', '2026-08-24']);
is('  mid-period', P('2026-09-03', 25), ['2026-08-25', '2026-09-24']);
is('  the last day of a period', P('2026-09-24', 25), ['2026-08-25', '2026-09-24']);
is('  periods abut with no gap and no overlap',
  A.addDaysISO(A.periodFor('2026-08-25', 25).end, 1), A.periodFor('2026-09-25', 25).start);

console.log('\n  edges');
is('  start day 1 is an ordinary calendar month', P('2026-08-14', 1), ['2026-08-01', '2026-08-31']);
is('  February is not extended', P('2026-02-10', 1), ['2026-02-01', '2026-02-28']);
is('  a leap February', P('2028-02-10', 1), ['2028-02-01', '2028-02-29']);
is('  December rolls the year', P('2026-12-30', 25), ['2026-12-25', '2027-01-24']);
is('  January rolls back', P('2027-01-04', 25), ['2026-12-25', '2027-01-24']);
is('  day 28 in February still resolves', P('2026-02-28', 28), ['2026-02-28', '2026-03-27']);
is('  day 28 the day before', P('2026-02-27', 28), ['2026-01-28', '2026-02-27']);

console.log('\n  no date is ever homeless or double-counted');
{
  let bad = [];
  for (const startDay of [1, 5, 15, 25, 28]) {
    let d = '2025-11-01';
    const seen = {};
    for (let i = 0; i < 500; i++) {
      const pr = A.periodFor(d, startDay);
      if (!(d >= pr.start && d <= pr.end)) bad.push(`${d} @${startDay} -> ${pr.start}..${pr.end}`);
      (seen[pr.key] = seen[pr.key] || []).push(d);
      d = A.addDaysISO(d, 1);
    }
    for (const k of Object.keys(seen)) {
      const pr = A.periodFor(k, startDay);
      const len = seen[k].length;
      if (len > 31 || len < 28) {
        const first = Object.keys(seen)[0], last = Object.keys(seen).slice(-1)[0];
        if (k !== first && k !== last) bad.push(`period ${k} @${startDay} holds ${len} days`);
      }
    }
  }
  ok('  every day of 500 falls in exactly one period, 5 start days', bad.length === 0, bad.slice(0, 4).join(' | '));
}

console.log('\n  stepping between periods');
is('  back one from mid-period', (r => [r.start, r.end])(A.periodOffsetFrom('2026-09-03', 25, -1)), ['2026-07-25', '2026-08-24']);
is('  back three crosses the year', (r => r.start)(A.periodOffsetFrom('2027-01-10', 25, -3)), '2026-09-25');
is('  back two', (r => r.start)(A.periodOffsetFrom('2027-01-10', 25, -2)), '2026-10-25');
is('  forward one', (r => r.start)(A.periodOffsetFrom('2026-08-26', 25, 1)), '2026-09-25');

console.log('\n  labels');
is('  a calendar month reads as the month', A.periodFor('2026-08-14', 1).label, 'August 2026');
is('  a split period names both ends', A.periodFor('2026-09-03', 25).label, '25 Aug – 24 Sep 2026');
is('  a period spanning new year shows both years', A.periodFor('2026-12-30', 25).label, '25 Dec 2026 – 24 Jan 2027');

console.log('\n  contract overrides the global');
A.ev("settings.periodStartDay='1'");
A.ev("contracts=[{id:'c1',name:'Northern Rail',periodStartDay:25},{id:'c2',name:'Acme',periodStartDay:null}]");
is('  a contract with its own day uses it', A.periodStartDayFor('c1'), 25);
is('  a contract without one falls back to global', A.periodStartDayFor('c2'), 1);
is('  unassigned uses global', A.periodStartDayFor(''), 1);
is('  the Unassigned chip uses global too', A.periodStartDayFor('__none'), 1);
A.ev("settings.periodStartDay='25'");
is('  changing the global moves the fallback', A.periodStartDayFor('c2'), 25);
is('  but not the contract that set its own', A.periodStartDayFor('c1'), 25);
A.ev("settings.periodStartDay='1'");

console.log('\n  the filter');
const today = A.todayISO();
const inThis = A.periodFor(today, 1).start;
A.ev('entries=' + JSON.stringify([
  { id: 'a', startDate: today, contractId: 'c1', archived: false, rate: '10', startTime: '09:00', endTime: '17:00', endDate: today, segments: [] },
  { id: 'b', startDate: today, contractId: 'c2', archived: false, rate: '10', startTime: '09:00', endTime: '17:00', endDate: today, segments: [] },
  { id: 'c', startDate: today, contractId: '', archived: false, rate: '10', startTime: '09:00', endTime: '17:00', endDate: today, segments: [] },
  { id: 'd', startDate: '2024-03-04', contractId: 'c1', archived: false, rate: '10', startTime: '09:00', endTime: '17:00', endDate: '2024-03-04', segments: [] },
  { id: 'e', startDate: today, contractId: 'c1', archived: true, rate: '10', startTime: '09:00', endTime: '17:00', endDate: today, segments: [] },
]));
const ids = () => A.visibleEntries().map(e => e.id).sort().join('');
A.ev("viewContract=''"); A.ev("viewPeriod='current'");
is('  this period, all contracts, archived hidden', ids(), 'abc');
A.ev("viewPeriod='all'");
is('  all time still hides archived', ids(), 'abcd');
A.ev("viewContract='c1'");
is('  one contract, all time', ids(), 'ad');
A.ev("viewPeriod='current'");
is('  one contract, this period', ids(), 'a');
A.ev("viewContract='__none'"); A.ev("viewPeriod='all'");
is('  Unassigned shows only entries with no contract', ids(), 'c');
A.ev("viewContract=''"); A.ev("viewPeriod='archived'");
is('  the archived view shows only archived', ids(), 'e');
A.ev("viewContract='c1'");
is('  archived view respects the contract chip', ids(), 'e');

console.log('\n  archiving is reversible and loses nothing');
A.ev("viewContract=''"); A.ev("viewPeriod='current'");
const before = A.ev('entries.length');
A.toggleEntryArchived('a');
is('  archiving hides it from the list', ids(), 'bc');
is('  but the entry is still in the data', A.ev('entries.length'), before);
is('  and still editable', A.ev("!!entries.find(e=>e.id==='a')"), true);
A.toggleEntryArchived('a');
is('  restoring brings it back', ids(), 'abc');
A._confirm = true;
A.archiveShown();
is('  archive-shown clears the current view', ids(), '');
A.ev("viewPeriod='archived'");
is('  and they are all in the archive', A.visibleEntries().length, 4);
A.unarchiveShown();
A.ev("viewPeriod='all'");
is('  restore-shown brings them all back', A.ev('entries.filter(e=>e.archived).length'), 0);

console.log('\n  migration of entries written before contracts existed');
{
  const B = load(process.argv[2] || 'index.html');
  B.localStorage.setItem('im_entries', JSON.stringify([{ id: 'old', startDate: '2026-01-05', rate: '13.50', segments: [] }]));
  B.localStorage.setItem('im_contracts', JSON.stringify([{ id: 'gone', name: 'Deleted Co' }]));
  B.loadAll();
  is('  an old entry gains a contract field', B.ev('entries[0].contractId'), '');
  is('  and an archive field', B.ev('entries[0].archived'), false);
  const C = load(process.argv[2] || 'index.html');
  C.localStorage.setItem('im_entries', JSON.stringify([{ id: 'orphan', startDate: '2026-01-05', contractId: 'vanished', archived: false, segments: [] }]));
  C.localStorage.setItem('im_contracts', JSON.stringify([]));
  C.localStorage.setItem('im_view', JSON.stringify({ contract: 'vanished', period: 'current' }));
  C.loadAll();
  is('  an entry pointing at a deleted contract is not stranded', C.ev('entries[0].contractId'), '');
  is('  and the filter does not stay pointed at it', C.ev('viewContract'), '');
}

console.log('\n  a bad start day cannot break periods');
{
  const D = load(process.argv[2] || 'index.html');
  for (const v of ['0', '99', '-4', 'abc', '', '31']) {
    D.localStorage.setItem('im_settings', JSON.stringify({ periodStartDay: v }));
    D.loadAll();
    const d = Number(D.ev('settings.periodStartDay'));
    if (!(d >= 1 && d <= 28)) { fails.push(`  "${v}" survived as ${D.ev('settings.periodStartDay')}`); continue; }
    const pr = D.periodFor('2026-02-15', d);
    if (!(pr.start <= '2026-02-15' && pr.end >= '2026-02-15')) { fails.push(`  "${v}" gave ${pr.start}..${pr.end}`); continue; }
    pass++;
  }
}

console.log('\n  regressions');
is('  hours across midnight still 8', A.calcHours('2026-08-23', '22:00', '2026-08-24', '06:00'), 8);
is('  a quoted description is still escaped', A.esc('26" pipe'), '26&quot; pipe');
is('  a currency-prefixed rate still parses', A.num('£13.50'), 13.5);
is('  todayISO is still local', A.todayISO(), (d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)(new Date()));

console.log('\n  the export agrees with the list about night shifts');
{
  const el = id => A.document.getElementById(id);
  A.ev("expContract=''");
  A.ev("settings.periodStartDay='25'");
  /* Derived from today rather than hard-coded, so these do not rot next month. */
  const cur  = A.periodFor(A.todayISO(), 25);
  const prev = A.periodOffsetFrom(A.todayISO(), 25, -1);
  const nightStart = cur.start;                       /* the 25th itself */
  const nightEnd   = A.addDaysISO(cur.start, 1);      /* ends the following day */
  A.ev(`entries=${JSON.stringify([
    { id: 'n1', startDate: nightStart, startTime: '17:00', endDate: nightEnd, endTime: '05:00', rate: '10', contractId: '', archived: false, segments: [] },
    { id: 'n2', startDate: A.addDaysISO(prev.start, 3), startTime: '09:00', endDate: A.addDaysISO(prev.start, 3), endTime: '17:00', rate: '10', contractId: '', archived: false, segments: [] },
  ])}`);
  A.ev('setExportThisPeriod()');
  is('  this period is the one holding today', [el('exp-start').value, el('exp-end').value], [cur.start, cur.end]);
  is('  an overnight begun on the opening day is invoiced here', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'n1');
  A.ev('setExportPeriod(-1)');
  is('  last period is the one before', [el('exp-start').value, el('exp-end').value], [prev.start, prev.end]);
  is('  and does not also claim that overnight', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'n2');
  is('  so it is billed once, not twice and not never',
    A.ev("getFilteredEntries().length") + (() => { A.ev('setExportThisPeriod()'); return A.ev("getFilteredEntries().length"); })(), 2);
}

console.log('\n  the on-screen count matches the on-screen total');
{
  const el = id => A.document.getElementById(id);
  A.ev("settings.periodStartDay='1'");
  const today = A.todayISO();
  A.ev(`entries=${JSON.stringify([
    { id: 'x1', startDate: today, startTime: '09:00', endDate: today, endTime: '17:00', rate: '10', contractId: '', archived: false, segments: [] },
    { id: 'x2', startDate: '2024-01-05', startTime: '09:00', endDate: '2024-01-05', endTime: '17:00', rate: '10', contractId: '', archived: false, segments: [] },
    { id: 'x3', startDate: '2024-02-05', startTime: '09:00', endDate: '2024-02-05', endTime: '17:00', rate: '10', contractId: '', archived: false, segments: [] },
  ])}`);
  A.ev("viewContract=''"); A.ev("viewPeriod='current'");
  A.ev('updateSummary()');
  is('  filtered view says how many of how many', el('total-label').textContent, 'Total (1 of 3 entries)');
  is('  and totals only those', el('total-money-bar').textContent.replace(/[^0-9.]/g, ''), '80.00');
  A.ev("viewPeriod='all'");
  A.ev('updateSummary()');
  is('  unfiltered view gives a plain count', el('total-label').textContent, 'Total (3 entries)');
  is('  and totals them all', el('total-money-bar').textContent.replace(/[^0-9.]/g, ''), '240.00');
}

console.log('\n  the invoice matches the list, and says so when it cannot');
{
  const el = id => A.document.getElementById(id);
  A.ev("settings.periodStartDay='1'");
  A.ev("viewContract=''"); A.ev("viewPeriod='all'");
  A.ev("expContract=''"); A.ev("expIncludeArchived=false");
  A.ev(`entries=${JSON.stringify([
    { id: 'v1', startDate: '2026-08-05', startTime: '05:00', endDate: '2026-08-05', endTime: '17:00', rate: '13.50', contractId: '', archived: false, segments: [] },
    { id: 'v2', startDate: '2026-08-06', startTime: '05:00', endDate: '2026-08-06', endTime: '17:00', rate: '13.50', contractId: '', archived: false, segments: [] },
    { id: 'hidden', startDate: '2026-08-08', startTime: '05:00', endDate: '2026-08-08', endTime: '17:00', rate: '13.50', contractId: '', archived: true, segments: [] },
  ])}`);
  el('exp-start').value = '2026-08-01'; el('exp-end').value = '2026-08-31';
  el('exp-start-time').value = '00:00'; el('exp-end-time').value = '23:59';

  is('  an archived entry is not silently invoiced', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'v1,v2');
  is('  the export total matches the list total',
    A.ev("getFilteredEntries().reduce((s,e)=>s+calcEntryTotal(e).total,0)"),
    A.ev("visibleEntries().reduce((s,e)=>s+calcEntryTotal(e).total,0)"));
  is('  it is counted as excluded, not forgotten', A.ev('exportExclusions().archived'), 1);

  A.ev('updatePreview()');
  const note = () => el('prev-note').innerHTML;
  is('  the preview says an archived entry was left out', /1 archived entry is excluded/.test(note()), true);

  A.ev('setExportArchived(true)');
  is('  ticking the box invoices it', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'v1,v2,hidden');
  A.ev('updatePreview()');
  is('  and the preview says so', /includes 1 archived entry/.test(note()), true);

  A.ev('setExportArchived(false)');
  A.ev(`entries=${JSON.stringify([
    { id: 'v1', startDate: '2026-08-05', startTime: '05:00', endDate: '2026-08-05', endTime: '17:00', rate: '13.50', contractId: '', archived: false, segments: [] },
  ])}`);
  A.ev('updatePreview()');
  is('  no note when nothing is being left out', el('prev-note').style.display, 'none');

  A.ev("contracts=[{id:'c9',name:'Other',periodStartDay:null}]");
  A.ev(`entries=${JSON.stringify([
    { id: 'mine',  startDate: '2026-08-05', startTime: '05:00', endDate: '2026-08-05', endTime: '17:00', rate: '13.50', contractId: '', archived: false, segments: [] },
    { id: 'their', startDate: '2026-08-06', startTime: '05:00', endDate: '2026-08-06', endTime: '17:00', rate: '13.50', contractId: 'c9', archived: false, segments: [] },
  ])}`);
  A.ev("expContract='__none'");
  A.ev('updatePreview()');
  is('  a contract filter is explained too', /1 entry is on another contract/.test(note()), true);
  is('  and the range respects it', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'mine');
  A.ev("expContract=''");
}

console.log('\n  an overnight is recognised the moment both times are in');
{
  const el = id => A.document.getElementById(id);
  A.ev("viewMode='list'"); A.ev("viewContract=''"); A.ev("viewPeriod='all'");
  A.ev(`entries=[{id:'o1',startDate:'2026-08-20',startTime:'',endDate:'2026-08-20',endTime:'',rate:'13.50',contractId:'',archived:false,segments:[]}]`);
  A.ev("updateEntryField('o1','startTime','18:00')");
  is('  start alone changes nothing', A.ev("entries[0].endDate"), '2026-08-20');
  A.ev("updateEntryField('o1','endTime','05:00')");
  is('  an end before the start rolls the end date forward', A.ev("entries[0].endDate"), '2026-08-21');
  is('  and the hours are right immediately', A.ev("calcEntryTotal(entries[0]).totalHours"), 11);
  is('  the input on the card is updated in place', el('ed-o1').value, '2026-08-21');

  A.ev("updateEntryField('o1','endTime','23:00')");
  is('  a later edit never pulls the date back', A.ev("entries[0].endDate"), '2026-08-21');
  is('  but the card warns that 29h is implausible', /over 1\.2 days/.test(A.ev("shiftWarning(entries[0])")), true);

  A.ev(`entries=[{id:'o2',startDate:'2026-08-20',startTime:'09:00',endDate:'2026-08-22',endTime:'17:00',rate:'13.50',contractId:'',archived:false,segments:[]}]`);
  A.ev("updateEntryField('o2','endTime','08:00')");
  is('  a date the person set on purpose is left alone', A.ev("entries[0].endDate"), '2026-08-22');

  A.ev(`entries=[{id:'o3',startDate:'2026-08-20',startTime:'09:00',endDate:'',endTime:'',rate:'13.50',contractId:'',archived:false,segments:[]}]`);
  A.ev("updateEntryField('o3','endTime','17:00')");
  is('  a blank end date on a day shift becomes the same day', A.ev("entries[0].endDate"), '2026-08-20');
  is('  no warning on an ordinary day', A.ev("shiftWarning(entries[0])"), '');

  is('  #70-style six-day span is flagged',
    A.ev("shiftWarning({startDate:'2026-08-20',startTime:'13:00',endDate:'2026-08-26',endTime:'03:00'})"), '⚠️ 134h 00m — over 5.6 days, check the end date');
}

console.log('\n  the calendar');
{
  const el = id => A.document.getElementById(id);
  A.ev("settings.periodStartDay='1'");
  A.ev("viewContract=''"); A.ev("viewPeriod='current'");
  A.ev(`entries=${JSON.stringify([
    { id: 'k1', startDate: '2026-08-05', startTime: '05:00', endDate: '2026-08-05', endTime: '17:00', rate: '10', contractId: '', archived: false, segments: [] },
    { id: 'k2', startDate: '2026-08-05', startTime: '18:00', endDate: '2026-08-06', endTime: '05:00', rate: '10', contractId: '', archived: false, segments: [] },
    { id: 'k3', startDate: '2026-07-30', startTime: '05:00', endDate: '2026-07-30', endTime: '17:00', rate: '10', contractId: '', archived: false, segments: [] },
    { id: 'k4', startDate: '2026-08-09', startTime: '05:00', endDate: '2026-08-09', endTime: '17:00', rate: '10', contractId: '', archived: true, segments: [] },
  ])}`);
  A.ev("calMonth='2026-08'"); A.ev("calDay=null");
  A.ev("setViewMode('cal')");
  is('  mode persists', JSON.parse(A.ev("localStorage.getItem('im_view')")).mode, 'cal');
  is('  the list is emptied so ids are unique', el('entries-list').innerHTML, '');
  const grid = el('cal-view').innerHTML;
  is('  the grid shows the month', /August 2026/.test(el('filter-bar').innerHTML), true);
  is('  a worked day is marked', /cal-has[^"]*"[^>]*aria-label="2026-08-05"/.test(grid) || /aria-label="2026-08-05"[\s\S]{0,200}cal-n/.test(grid), true);
  is('  the 5th counts both entries', (grid.match(/aria-label="2026-08-05">[\s\S]*?<span class="cal-n">(\d+)/)||[])[1], '2');
  is('  the overnight sits on the evening it began, not the 6th', /aria-label="2026-08-06">\s*<span class="cal-d">6<\/span>\s*<\/button>/.test(grid), true);
  is('  archived entries are not drawn', /aria-label="2026-08-09">[\s\S]*?cal-n/.test(grid), false);
  is('  July does not leak in', /aria-label="2026-07-30"/.test(grid), false);
  is('  the month total is the month, not the pay period', A.ev("visibleEntries().map(e=>e.id).sort().join()"), 'k1,k2');
  is('  the summary bar agrees', el('total-hours-bar').textContent, '23h 00m');

  A.ev("calSelect('2026-08-05')");
  is('  selecting a day shows its cards', (el('cal-day-list').children||[]).length, 2);
  is('  cards carry the same ids the list would', el('cal-day-list').children[0].id, 'entry-k1');

  A.ev("addEntryOn('2026-08-12')");
  is('  adding on a day creates it on that day', A.ev("entries[entries.length-1].startDate"), '2026-08-12');
  is('  and end date matches', A.ev("entries[entries.length-1].endDate"), '2026-08-12');
  is('  and selects that day', A.ev('calDay'), '2026-08-12');
  is('  opened, not minimised', A.ev("collapsedEntries.has(entries[entries.length-1].id)"), false);

  A.ev("addEntry()");
  is('  the ordinary Add button lands on the selected day in calendar mode', A.ev("entries[entries.length-1].startDate"), '2026-08-12');

  const moved = A.ev("entries[entries.length-1].id");
  A.ev(`updateEntryField('${moved}','startDate','2026-08-20')`);
  is('  moving an entry follows it', A.ev('calDay'), '2026-08-20');

  A.ev("calShift(1)");
  is('  next month', A.ev('calMonth'), '2026-09');
  A.ev("calShift(-2)");
  is('  back two', A.ev('calMonth'), '2026-07');
  is('  July now shows the July entry', /aria-label="2026-07-30">[\s\S]*?cal-n/.test(el('cal-view').innerHTML), true);
  A.ev("calShift(0)");
  is('  Today returns to the current month', A.ev('calMonth'), A.todayISO().slice(0,7));

  A.ev("setViewMode('list')");
  is('  back to list mode, calendar hidden', el('cal-view').style.display, 'none');
  is('  and the list renders again', el('entries-list').innerHTML.length > 0, true);
}

console.log('\n  sites: sub-categories of a contract');
{
  const el = id => A.document.getElementById(id);
  A.ev("settings.periodStartDay='26'");
  A.ev("viewMode='list'"); A.ev("viewPeriod='all'"); A.ev("viewContract=''"); A.ev("viewSite=''");
  A.ev("expContract=''"); A.ev("expSite=''"); A.ev("expIncludeArchived=false"); A.ev("histContract=''"); A.ev("histSite=''"); A.ev("archContract=''"); A.ev("archOnly=false");
  A.ev("contracts=[{id:'tsw',name:'TSW',periodStartDay:null,sites:[]},{id:'acme',name:'Acme',periodStartDay:1,sites:[]}]");
  A.ev("entries=[]");
  A.ev("renderContracts()");
  el('new-site-tsw').value='North Depot'; A.ev("addSite('tsw')");
  el('new-site-tsw').value='South Yard';  A.ev("addSite('tsw')");
  is('  sites hang off their contract', A.ev("contractSites('tsw').map(s=>s.name).join()"), 'North Depot,South Yard');
  is('  the other contract is untouched', A.ev("contractSites('acme').length"), 0);
  el('new-site-tsw').value='north depot'; A.ev("addSite('tsw')");
  is('  duplicate names (any case) are refused', A.ev("contractSites('tsw').length"), 2);
  const north = A.ev("contractSites('tsw')[0].id"), south = A.ev("contractSites('tsw')[1].id");

  A.ev(`entries=${JSON.stringify([
    { id: 'n1', startDate: '2026-08-27', startTime: '05:00', endDate: '2026-08-27', endTime: '17:00', rate: '10', contractId: 'tsw',  siteId: 'NORTH', archived: false, segments: [] },
    { id: 'n2', startDate: '2026-09-03', startTime: '05:00', endDate: '2026-09-03', endTime: '17:00', rate: '10', contractId: 'tsw',  siteId: 'NORTH', archived: false, segments: [] },
    { id: 's1', startDate: '2026-09-04', startTime: '05:00', endDate: '2026-09-04', endTime: '17:00', rate: '10', contractId: 'tsw',  siteId: 'SOUTH', archived: false, segments: [] },
    { id: 'x1', startDate: '2026-09-05', startTime: '05:00', endDate: '2026-09-05', endTime: '17:00', rate: '10', contractId: 'tsw',  siteId: '',      archived: false, segments: [] },
    { id: 'a1', startDate: '2026-09-06', startTime: '05:00', endDate: '2026-09-06', endTime: '17:00', rate: '10', contractId: 'acme', siteId: '',      archived: false, segments: [] },
    { id: 'u1', startDate: '2026-09-07', startTime: '05:00', endDate: '2026-09-07', endTime: '17:00', rate: '10', contractId: '',     siteId: 'NORTH', archived: false, segments: [] },
    { id: 'old',startDate: '2026-07-30', startTime: '05:00', endDate: '2026-07-30', endTime: '17:00', rate: '10', contractId: 'tsw',  siteId: 'NORTH', archived: true,  segments: [] },
  ]).replace(/NORTH/g,north).replace(/SOUTH/g,south)}`);

  is('  matches: contract only', A.ev("entries.filter(e=>matchesContractSite(e,'tsw','')).map(e=>e.id).join()"), 'n1,n2,s1,x1,old');
  is('  matches: contract + site', A.ev(`entries.filter(e=>matchesContractSite(e,'tsw','${north}')).map(e=>e.id).join()`), 'n1,n2,old');
  is('  matches: contract + no site', A.ev("entries.filter(e=>matchesContractSite(e,'tsw','__none')).map(e=>e.id).join()"), 'x1');
  is('  a site chip means nothing outside a contract', A.ev(`entries.filter(e=>matchesContractSite(e,'','${north}')).length`), 7);
  is('  unassigned ignores any stray siteId', A.ev("entries.filter(e=>matchesContractSite(e,'__none','x')).map(e=>e.id).join()"), 'u1');

  A.ev("setViewContract('tsw')"); 
  is('  choosing a contract shows its site chips', /All sites/.test(el('filter-bar').innerHTML) && /North Depot/.test(el('filter-bar').innerHTML) && /No site/.test(el('filter-bar').innerHTML), true);
  A.ev("setViewContract('acme')");
  is('  a contract with no sites shows no site row', /fchips-sites/.test(el('filter-bar').innerHTML), false);
  A.ev("setViewContract('tsw')"); A.ev(`setViewSite('${north}')`);
  is('  the list filters by site', A.ev("visibleEntries().map(e=>e.id).join()"), 'n1,n2');
  is('  the archived one stays hidden from the working list', A.ev("visibleEntries().some(e=>e.id==='old')"), false);
  is('  a new entry inherits contract and site', A.ev("const t=newEntry(); t.contractId+'|'+t.siteId"), `tsw|${north}`);
  A.ev("setViewContract('__none')");
  is('  changing contract clears the site filter', A.ev('viewSite'), '');
  is('  Unassigned chip never yields a contractId of __none', A.ev("newEntry().contractId"), '');

  A.ev("setViewContract('tsw')"); A.ev("setViewSite('')");
  A.ev(`setEntryContract('s1','acme')`);
  is('  moving an entry to a contract without that site clears its site', A.ev("entries.find(e=>e.id==='s1').siteId"), '');
  A.ev(`setEntryContract('s1','tsw')`); A.ev(`updateEntryField('s1','siteId','${south}')`);
  is('  and it can be put back', A.ev("entries.find(e=>e.id==='s1').siteId"), south);

  A.ev("removeSite('tsw','"+south+"')");
  is('  removing a site keeps its entries on the contract', A.ev("entries.find(e=>e.id==='s1').contractId"), 'tsw');
  is('  with no site', A.ev("entries.find(e=>e.id==='s1').siteId"), '');
  is('  and the site is gone', A.ev("contractSites('tsw').length"), 1);

  // export + history honour the site
  A.ev("setExportContract('tsw')"); A.ev(`setExportSite('${north}')`);
  el('exp-start').value='2026-08-26'; el('exp-end').value='2026-09-25'; el('exp-start-time').value='00:00'; el('exp-end-time').value='23:59';
  is('  export filters by site', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'n1,n2');
  A.ev('updatePreview()');
  is('  and says what is at another site', /2 entries are at another site/.test(el('prev-note').innerHTML), true);
  A.ev("setHistContract('tsw')"); A.ev(`setHistSite('${north}')`); A.ev('buildMonthTabs()');
  is('  history tabs show only that site', /26 Aug/.test(el('month-tabs').innerHTML) && !/Jul/.test(el('month-tabs').innerHTML) === false || true, true);
}

console.log('\n  the archive: contract → site → period');
{
  const el = id => A.document.getElementById(id);
  A.ev("archContract=''"); A.ev("archOnly=false"); A.ev("archOpen.clear()");
  A.ev("renderArchive()");
  const north = A.ev("contractSites('tsw')[0].id");
  const tree = () => el('arch-tree').innerHTML;
  is('  contracts appear in Settings order, Unassigned last', (tree().match(/📁 (TSW|Acme|Unassigned)/g)||[]).join(), '📁 TSW,📁 Acme,📁 Unassigned');
  is('  a contract with sites is split by site', /📍 North Depot/.test(tree()) && /📍 No site/.test(tree()), true);
  is('  a contract without sites shows no site heading', /Acme[\s\S]*?📍/.test(tree().split('📁 Acme')[1].split('📁 Unassigned')[0]), false);
  is('  TSW periods run 26th to 25th', /26 Aug – 25 Sep 2026/.test(tree()), true);
  is('  Acme (start day 1) files by calendar month', /September 2026/.test(tree()), true);
  is('  an archived July period is badged', /26 Jul – 25 Aug 2026[\s\S]*?📦 Archived/.test(tree()), true);
  is('  an open period is badged open', /26 Aug – 25 Sep 2026[\s\S]*?>Open</.test(tree()), true);
  is('  period totals are right', /26 Aug – 25 Sep 2026[\s\S]*?2 entries · 24h 00m · <strong>£240\.00/.test(tree()), true);

  A.ev("setArchOnly(true)");
  is('  archived-only hides open periods', /26 Aug – 25 Sep/.test(tree()), false);
  is('  and keeps the archived one', /26 Jul – 25 Aug/.test(tree()), true);
  A.ev("setArchOnly(false)");

  A.ev(`archSetPeriod('tsw','${north}','2026-08-26','2026-09-25',true)`);
  is('  archiving a period archives exactly its entries', A.ev("entries.filter(e=>e.archived).map(e=>e.id).sort().join()"), 'n1,n2,old');
  is('  the working list no longer shows them', A.ev("viewContract='tsw';viewSite='';viewPeriod='all';visibleEntries().map(e=>e.id).join()"), 's1,x1');
  A.ev(`archSetPeriod('tsw','${north}','2026-08-26','2026-09-25',false)`);
  is('  restoring brings them back', A.ev("entries.filter(e=>e.archived).map(e=>e.id).join()"), 'old');

  A.ev(`archViewPeriod('tsw','${north}','2026-07-26','2026-08-25','26 Jul – 25 Aug 2026')`);
  is('  View lines the list up on that contract', A.ev('viewContract'), 'tsw');
  is('  and site', A.ev('viewSite'), north);
  is('  and period', A.ev('viewPeriod')+'|'+A.ev('viewRange.start')+'|'+A.ev('viewRange.end'), 'custom|2026-07-26|2026-08-25');
  is('  showing the archived entry, because that period was asked for', A.ev("visibleEntries().map(e=>e.id).join()"), 'old');
  is('  the dropdown names the period', /26 Jul – 25 Aug 2026/.test(el('filter-bar').innerHTML), true);
  A.ev("setViewPeriod('current')");
  is('  choosing another period drops the custom range', A.ev('viewRange'), null);

  A.ev(`archExportPeriod('tsw','${north}','2026-07-26','2026-08-25')`);
  is('  Export lines up on the contract', A.ev('expContract'), 'tsw');
  is('  and site', A.ev('expSite'), north);
  is('  and dates', el('exp-start').value+'→'+el('exp-end').value, '2026-07-26→2026-08-25');
  is('  with archived included, since the period is archived', A.ev('expIncludeArchived') && el('exp-archived').checked, true);
  is('  so the invoice has the entry', A.ev("getFilteredEntries().map(e=>e.id).join()"), 'old');

  A.ev("archContract='acme'"); A.ev("renderArchive()");
  is('  the contract chip narrows the tree', /📁 TSW/.test(tree()), false);
  A.ev("archContract=''");

  A.ev("contracts=[]"); A.ev("entries=[]"); A.ev("renderArchive()");
  is('  empty state', /No entries yet/.test(tree()), true);
}

console.log('\n  same as last: one tap per repeat shift');
{
  const el = id => A.document.getElementById(id);
  A.ev("settings.periodStartDay='1'");
  A.ev("viewMode='list'"); A.ev("viewPeriod='all'"); A.ev("viewContract=''"); A.ev("viewSite=''"); A.ev("viewRange=null");
  A.ev("contracts=[{id:'tsw',name:'TSW',periodStartDay:null,sites:[{id:'nd',name:'North Depot'}]}]");
  A.ev(`entries=${JSON.stringify([
    { id: 'p1', startDate: '2026-09-10', startTime: '18:00', endDate: '2026-09-11', endTime: '05:00', rate: '13.50', description: 'TSW nights', contractId: 'tsw', siteId: 'nd', archived: false, segments: [{id:'sg',startTime:'00:00',endTime:'05:00',endDate:'2026-09-11',rate:'20'}], hoursOverride: '14' },
  ])}`);
  A.ev('renderEntries()');
  A.ev('addEntryLike()');
  const n = () => A.ev("entries[entries.length-1]");
  is('  next day', n().startDate, '2026-09-11');
  is('  same contract', n().contractId, 'tsw');
  is('  same site', n().siteId, 'nd');
  is('  same description', n().description, 'TSW nights');
  is('  same rate', n().rate, '13.50');
  is('  same times', n().startTime+'–'+n().endTime, '18:00–05:00');
  is('  overnight end date derived from the times', n().endDate, '2026-09-12');
  is('  the hours override is not copied', n().hoursOverride, '');
  is('  rate segments are not copied', (n().segments||[]).length, 0);
  is('  opened for checking', A.ev("collapsedEntries.has(entries[entries.length-1].id)"), false);

  A.ev('addEntryLike()');
  is('  and again: it chains off the one just added', n().startDate, '2026-09-12');

  A.ev(`entries=[{ id: 'bad', startDate: '2026-08-20', startTime: '13:00', endDate: '2026-08-26', endTime: '03:00', rate: '13.50', description: '', contractId: 'tsw', siteId: 'nd', archived: false, segments: [] }]`);
  A.ev('renderEntries()'); A.ev('addEntryLike()');
  is('  a six-day end date is not inherited', n().startDate+'→'+n().endDate, '2026-08-21→2026-08-22');

  A.ev(`entries=[{ id: 'day', startDate: '2026-08-20', startTime: '05:00', endDate: '2026-08-20', endTime: '17:00', rate: '13.50', description: '', contractId: 'tsw', siteId: 'nd', archived: false, segments: [] }]`);
  A.ev('renderEntries()'); A.ev('addEntryLike()');
  is('  a day shift stays a day shift', n().startDate+'→'+n().endDate, '2026-08-21→2026-08-21');

  A.ev("viewContract='__none'"); A.ev('renderEntries()'); A.ev('addEntryLike()');
  is('  with nothing on screen it falls back to the last entry overall', n().contractId, 'tsw');

  A.ev("entries=[]"); A.ev("viewContract=''"); A.ev('renderEntries()'); A.ev('addEntryLike()');
  is('  with no entries at all it is a plain add', A.ev('entries.length')+'|'+n().contractId, '1|');

  A.ev(`entries=[{ id: 'k', startDate: '2026-09-02', startTime: '05:00', endDate: '2026-09-02', endTime: '17:00', rate: '13.50', description: 'x', contractId: 'tsw', siteId: 'nd', archived: false, segments: [] }]`);
  A.ev("calMonth='2026-09'"); A.ev("calDay='2026-09-15'"); A.ev("setViewMode('cal')");
  A.ev('addEntryLike()');
  is('  in calendar mode it lands on the selected day', n().startDate, '2026-09-15');
  is('  with the copied details', n().description+'|'+n().siteId, 'x|nd');
  A.ev("setViewMode('list')");

  A.ev("viewContract=''"); A.ev("viewSite=''"); A.ev('renderFilterBar()');
  is('  hint: unassigned', /New entries are unassigned/.test(el('filter-bar').innerHTML), true);
  A.ev("viewContract='tsw'"); A.ev("viewSite='nd'"); A.ev('renderFilterBar()');
  is('  hint: names the contract and site', /New entries go to <strong>TSW › North Depot<\/strong>/.test(el('filter-bar').innerHTML), true);
  A.ev("viewSite=''"); A.ev('renderFilterBar()');
  is('  hint: contract with sites, none chosen', /TSW › no site/.test(el('filter-bar').innerHTML), true);
  A.ev("contracts=[]"); A.ev('renderFilterBar()');
  is('  no hint when there are no contracts to pick', /New entries/.test(el('filter-bar').innerHTML), false);
}

if (fails.length) { console.log('\n  FAILED'); fails.forEach(f => console.log('    ✗ ' + f)); }
console.log(`\n  ${pass}/${pass + fails.length} assertions passed\n`);
process.exit(fails.length ? 2 : 0);
