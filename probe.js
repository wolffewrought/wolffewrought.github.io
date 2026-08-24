#!/usr/bin/env node
/*
  probe.js - boots a single-file HTML app in a fake browser and exercises it.

    node probe.js index.html
    node probe.js index.html --quiet
    TZ=Europe/London node probe.js index.html      run under another clock

  Static analysis cannot tell you whether a button throws when pressed.
  This can. It builds a DOM good enough to run an offline app, boots it,
  then presses everything and watches for anything that breaks.

  Also usable as a module, so app-specific probes can share the shim:

    const { boot } = require('./probe.js');
    const app = boot('index.html');

  Exit code: 0 clean, 2 something threw.
*/

'use strict';
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * a DOM, only as much as these apps actually use
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * selectors
 *
 * The first version matched one simple selector: a class, an id, a tag or
 * an attribute. Real markup is queried with compounds (div.card), with
 * descendants (#ios-tip .close-tip) and with lists (a, button). Those all
 * came back empty, and an empty result is indistinguishable from a genuine
 * absence — so a top level querySelector(...).addEventListener died on
 * null and the whole file failed to boot before one probe ran.
 * ------------------------------------------------------------------ */

function simpleTest(part) {
  const tests = [];
  const re = /([#.]?[\w-]+)|(\[[\w-]+(?:=["']?[^\]"']*["']?)?\])/g;
  let m;
  while ((m = re.exec(part))) {
    const tok = m[0];
    if (tok[0] === '#') { const id = tok.slice(1); tests.push(c => c.id === id); }
    else if (tok[0] === '.') { const cl = tok.slice(1); tests.push(c => c._cls && c._cls.has(cl)); }
    else if (tok[0] === '[') {
      const a = tok.match(/^\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]$/);
      if (a) tests.push(c => {
        const v = c._attrs ? c._attrs[a[1]] : undefined;
        if (v === undefined) return false;
        return a[2] === undefined || String(v) === a[2];
      });
    } else { const t = tok.toLowerCase(); tests.push(c => String(c.tagName || '').toLowerCase() === t); }
  }
  return tests.length ? (c => tests.every(t => t(c))) : (() => false);
}

function descend(roots, part) {
  const test = simpleTest(part);
  const out = [];
  roots.forEach(r => (function walk(n) {
    (n.children || []).forEach(c => { if (test(c)) out.push(c); walk(c); });
  })(r));
  return out;
}

function runSel(root, sel) {
  const out = [];
  String(sel).split(',').forEach(one => {
    const parts = one.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    let cur = [root];
    for (const p of parts) cur = descend(cur, p);
    cur.forEach(c => { if (!out.includes(c)) out.push(c); });
  });
  return out;
}

function makeDom(opts) {
  const registry = {};
  const byClass = {};
  const listeners = { window: {}, document: {} };

  function el(tag, id) {
    const e = {
      tagName: String(tag || 'div').toUpperCase(),
      id: id || '',
      value: '', textContent: '', checked: false, disabled: false,
      selectionStart: 0, selectionEnd: 0,
      /* A plain object is enough until an app sets a CSS custom property.
         Any theming engine does, and setProperty missing kills the boot. */
      style: {
        _p: {},
        setProperty(k, v) { this._p[k] = v; this[k] = v; },
        getPropertyValue(k) { return this._p[k] !== undefined ? this._p[k] : ''; },
        removeProperty(k) { delete this._p[k]; delete this[k]; }
      },
      dataset: {},
      children: [], parentNode: null,
      _cls: new Set(), _handlers: {}, _attrs: {},
      offsetHeight: 40, offsetWidth: 320,

      classList: {
        add(...c) { c.forEach(x => x && e._cls.add(x)); index(e); },
        remove(...c) { c.forEach(x => e._cls.delete(x)); index(e); },
        toggle(c) { e._cls.has(c) ? e._cls.delete(c) : e._cls.add(c); index(e); return e._cls.has(c); },
        contains(c) { return e._cls.has(c); }
      },
      setAttribute(a, v) { e._attrs[a] = String(v); },
      getAttribute(a) { return a in e._attrs ? e._attrs[a] : null; },
      removeAttribute(a) { delete e._attrs[a]; },
      hasAttribute(a) { return a in e._attrs; },
      addEventListener(t, fn) { (e._handlers[t] = e._handlers[t] || []).push(fn); },
      removeEventListener(t, fn) {
        e._handlers[t] = (e._handlers[t] || []).filter(f => f !== fn);
      },
      appendChild(c) { c.parentNode = e; e.children.push(c); index(c); return c; },
      insertBefore(c) { return e.appendChild(c); },
      removeChild(c) { e.children = e.children.filter(x => x !== c); return c; },
      focus() {}, blur() {}, scrollIntoView() {}, reset() { e.value = ''; e.checked = false; },
      setSelectionRange(s, en) { e.selectionStart = s; e.selectionEnd = en; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 320, height: 40 }; },
      click() { e.fire('click'); },
      _submits: null,          /* set for a submit button inside a form */

      querySelector(sel) { return e.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { return runSel(e, sel); },

      fire(type, extra) {
        const ev = Object.assign({
          type, target: e, currentTarget: e,
          preventDefault() { ev.defaultPrevented = true; },
          stopPropagation() {}
        }, extra || {});
        (e._handlers[type] || []).forEach(fn => fn(ev));
        /* A submit button inside a form submits it. Without this, every
           save button in the app looks like it does nothing, because the
           handler is on the form and nothing ever reaches it. */
        if (type === 'click' && e._submits) e._submits.fire('submit');
        return ev;
      }
    };
    let html = '';
    Object.defineProperty(e, 'innerHTML', {
      get: () => html,
      set(v) { html = String(v); if (html === '') e.children = []; }
    });
    Object.defineProperty(e, 'className', {
      get: () => [...e._cls].join(' '),
      set(v) { e._cls = new Set(String(v).split(/\s+/).filter(Boolean)); index(e); }
    });
    Object.defineProperty(e, 'type', {
      get: () => e._attrs.type || 'text',
      set(v) { e._attrs.type = v; }
    });
    return e;
  }

  function index(e) {
    for (const c of e._cls) (byClass[c] = byClass[c] || new Set()).add(e);
  }

  /* Panes and tabs are read from the markup, so activating a view behaves
     the way it does in a browser rather than the way a test hopes. */
  const source = opts.html;

  /* Stands up an element the markup declares but which has no id. Scoped
     by a leading #id where the selector gives one, so "#ios-tip .close-tip"
     is only satisfied by a .close-tip actually inside #ios-tip. */
  const synthCache = {};
  function synth(sel) {
    if (synthCache[sel]) return synthCache[sel];
    const parts = String(sel).split(',')[0].trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return (synthCache[sel] = []);
    let scope = source;
    if (parts.length > 1 && parts[0][0] === '#') {
      const holder = registry[parts[0].slice(1)];
      if (!holder || !holder._bornWith) return (synthCache[sel] = []);
      scope = holder._bornWith;
    }
    const last = parts[parts.length - 1];
    const cls = [...last.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    const tagWant = (last.match(/^([a-zA-Z][\w-]*)/) || [])[1];
    const found = [];
    for (const m of scope.matchAll(/<([a-zA-Z][\w-]*)([^<>]*)>/g)) {
      const [, tag, attrs] = m;
      if (tagWant && tag.toLowerCase() !== tagWant.toLowerCase()) continue;
      const have = ((attrs.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/);
      if (!cls.every(c => have.includes(c))) continue;
      const e = el(tag);
      if (have.filter(Boolean).length) e.className = have.filter(Boolean).join(' ');
      for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) e._attrs[a[1]] = a[2];
      e._synthetic = true;
      found.push(e);
    }
    return (synthCache[sel] = found);
  }

  const declaredIds = [...source.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  for (const id of declaredIds) {
    const before = source.slice(0, source.indexOf('id="' + id + '"'));
    const tag = (before.match(/<([a-zA-Z][\w-]*)[^<>]*$/) || [, 'div'])[1];
    const e = el(tag, id);
    /* carry the classes the markup gives it, so opening state is real */
    const at = source.indexOf('id="' + id + '"');
    const openTag = source.slice(source.lastIndexOf('<', at), source.indexOf('>', at) + 1);
    const cls = (openTag.match(/class="([^"]+)"/) || [])[1];
    if (cls) e.className = cls;
    for (const a of openTag.matchAll(/([\w-]+)="([^"]*)"/g)) e._attrs[a[1]] = a[2];
    /* Carry the markup's own content across. Without it anything that
       reads its own headings back - to sort them, to label something -
       sees nothing, and a test of that behaviour cannot run at all. */
    if (!/\/>$/.test(openTag)) {
      const tagName = (openTag.match(/^<([a-zA-Z][\w-]*)/) || [, ''])[1];
      if (tagName && !/^(input|img|br|hr|meta|link|source)$/i.test(tagName)) {
        const from = source.indexOf('>', at) + 1;
        let depth = 1, k = from;
        const open = new RegExp('<' + tagName + '[\\s>]', 'i');
        const close = new RegExp('</' + tagName + '>', 'i');
        while (k < source.length && depth > 0) {
          const nextOpen = source.slice(k).search(open);
          const nextClose = source.slice(k).search(close);
          if (nextClose === -1) break;
          if (nextOpen !== -1 && nextOpen < nextClose) { depth++; k += nextOpen + 1; }
          else { depth--; if (depth === 0) break; k += nextClose + 1; }
        }
        const endAt = k + source.slice(k).search(close);
        if (endAt > from && endAt - from < 20000) {
          e.innerHTML = source.slice(from, endAt);
          e._bornWith = e.innerHTML;                   /* what the page gave it */
          e.textContent = e.innerHTML.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        }
      }
    }

    if (/type="checkbox"/.test(openTag)) e.checked = /\bchecked\b/.test(openTag);
    if (/value="([^"]*)"/.test(openTag)) e.value = (openTag.match(/value="([^"]*)"/) || [, ''])[1];
    registry[id] = e;
  }

  /* which form each submit button belongs to, read from the markup since
     the shim does not build a real tree */
  for (const fm of source.matchAll(/<form\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    const form = registry[fm[1]];
    if (!form) continue;
    for (const bm of fm[2].matchAll(/<button\b([^>]*)>/g)) {
      const attrs = bm[1];
      if (!/type="submit"/.test(attrs)) continue;
      const bid = (attrs.match(/id="([^"]+)"/) || [])[1];
      if (bid && registry[bid]) registry[bid]._submits = form;
    }
  }

  const body = el('body');
  const head = el('head');
  Object.values(registry).forEach(e => { e.parentNode = body; body.children.push(e); index(e); });

  /* Elements the markup declares with a class and no id. Building only
     the id-bearing ones leaves anything found by class invisible, so code
     that lays out a row of bars by querying for them appears to have
     nothing to lay out. */
  for (const m of source.matchAll(/<([a-zA-Z][\w-]*)\b([^<>]*\bclass="([^"]+)"[^<>]*)>/g)) {
    const tag = m[1], attrs = m[2], cls = m[3];
    if (/\sid="/.test(attrs)) continue;              /* already built */
    if (/^(html|head|body|script|style)$/i.test(tag)) continue;
    const e = el(tag);
    e.className = cls;
    for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) e._attrs[a[1]] = a[2];
    body.appendChild(e);
  }

  const document = {
    readyState: 'complete',
    hidden: false,
    body, head,
    documentElement: el('html'),
    getElementById: id => registry[id] || (registry[id] = el('div', id)),
    createElement: tag => { dom.made++; return el(tag); },
    createTextNode: t => ({ textContent: t }),
    createDocumentFragment: () => el('div'),
    querySelector(sel) { return document.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const want = String(sel).trim();
      /* the fast paths stay for the two common simple cases */
      if (/^\.[\w-]+$/.test(want)) {
        const hit = [...(byClass[want.slice(1)] || [])];
        if (hit.length) return hit;
      } else if (/^#[\w-]+$/.test(want)) {
        return [registry[want.slice(1)]].filter(Boolean);
      } else {
        const hit = runSel(body, want);
        if (hit.length) return hit;
      }
      /* Only elements with an id become real objects above, so anything
         carrying just a class is invisible to the walk — and null from a
         top level querySelector(...).addEventListener kills the whole file
         before a probe runs. If the markup really declares it, stand one
         up from the source rather than reporting an absence that is the
         shim's and not the app's. */
      return synth(want);
    },
    addEventListener(t, fn) { (listeners.document[t] = listeners.document[t] || []).push(fn); },
    removeEventListener() {},
    fire(t, e) { (listeners.document[t] || []).forEach(fn => fn(e || { type: t })); }
  };

  const store = Object.assign({}, opts.store || {});
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: i => Object.keys(store)[i] || null
  };

  const timers = { intervals: 0, timeouts: 0 };
  const win = {
    addEventListener(t, fn) { (listeners.window[t] = listeners.window[t] || []).push(fn); },
    removeEventListener() {},
    fire(t, e) { (listeners.window[t] || []).forEach(fn => fn(e || { type: t })); },
    scrollTo() {}, scrollY: 0, innerWidth: 390, innerHeight: 844,
    location: { hash: '', protocol: 'https:', href: 'https://localhost/index.html', reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    document, localStorage,
    getComputedStyle: () => ({ getPropertyValue: () => '' })
  };

  const dom = { document, window: win, localStorage, listeners, timers, registry, byClass, el, made: 0 };
  return dom;
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

function boot(file, options) {
  const vm = require('vm');
  const opts = options || {};
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const dom = makeDom({ html, store: opts.store });

  const thrown = [];
  const sandbox = {
    console: opts.quiet ? { log() {}, warn() {}, error() {}, info() {}, debug() {} } : console,
    document: dom.document,
    window: dom.window,
    localStorage: dom.localStorage,
    sessionStorage: dom.localStorage,
    /* standalone is iOS-only and absent elsewhere, but an app that reads
       window.navigator.standalone crashes on boot if navigator is not also
       reachable through window — see the reflection loop below. */
    navigator: { userAgent: 'probe', onLine: false, serviceWorker: undefined, storage: undefined, standalone: false },
    location: dom.window.location,
    Blob: function Blob(parts) { this.parts = parts; this.size = 0; },
    File: function File() {},
    FileReader: function FileReader() {
      this.readAsText = () => { this.result = ''; if (this.onload) this.onload({ target: this }); };
      this.readAsArrayBuffer = this.readAsText;
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    /* Present in every browser at a secure origin. Without it any id built
       by crypto.randomUUID throws, which reads as the app being broken. */
    crypto: {
      randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }),
      getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = Math.random() * 256 | 0; return a; }
    },
    event: undefined,
    /* Returns a window-like object rather than null: an export that opens a
       print window is a normal thing to do, and null here would look like
       the popup blocker, which is a different bug. */
    open: () => ({
      document: { write() {}, close() {}, title: '' },
      focus() {}, print() {}, close() {}, closed: false
    }),
    print() {},
    indexedDB: undefined,
    alert() {}, confirm: () => true, prompt: () => null,
    setTimeout(fn) { dom.timers.timeouts++; try { if (typeof fn === 'function') fn(); } catch (e) { thrown.push(e); } return dom.timers.timeouts; },
    clearTimeout() {},
    setInterval() { dom.timers.intervals++; return dom.timers.intervals; },
    clearInterval() {},
    requestAnimationFrame(fn) { try { fn(0); } catch (e) { thrown.push(e); } return 1; },
    cancelAnimationFrame() {},
    Uint8Array, Uint16Array, Float64Array, ArrayBuffer, Buffer,
    Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, TypeError,
    Map, Set, Promise, Symbol, Intl, isNaN, isFinite, parseInt, parseFloat, encodeURIComponent,
    decodeURIComponent, btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary')
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  /* A browser reaches every global two ways: bare (`navigator`) and through
     window (`window.navigator`). The shim only offered the bare form, so an
     app written the second way died at boot before a single probe ran.
     Anything the dom already defines on window wins. */
  for (const k of Object.keys(sandbox)) {
    if (k === 'window' || k === 'document') continue;
    if (dom.window[k] === undefined) dom.window[k] = sandbox[k];
  }

  vm.createContext(sandbox);

  for (const src of scripts) vm.runInContext(src, sandbox, { filename: path.basename(file) });

  return { sandbox, dom, thrown, html, file,
    id: i => dom.document.getElementById(i),
    app: sandbox.app || sandbox.App || null };
}

/* ------------------------------------------------------------------ *
 * layout worked out from something that is not on screen
 * ------------------------------------------------------------------ */

/* An element inside a hidden pane measures zero. Code that positions one
   thing below another by measuring it then puts them in the same place,
   and the lower one disappears behind the upper - which looks exactly like
   a bar that will not stay put. It shipped here because the test set every
   bar to the same height, the one state where it cannot happen. */
function layoutWithHidden(file) {
  const html = fs.readFileSync(file, 'utf8');

  /* which rules ask to be positioned relative to the scroll */
  const sticky = [];
  for (const m of html.matchAll(/([.#][\w-]+)\{[^}]*position:sticky[^}]*\}/g)) sticky.push(m[1]);
  if (!sticky.length) return { skipped: 'nothing here is positioned that way' };

  const ctx = boot(file, { quiet: true });
  const app = ctx.app;
  const layout = ['syncStickyOffset', 'layout', 'reflow', 'measure']
    .find(k => app && typeof app[k] === 'function');
  if (!layout) return { skipped: 'nothing here works out its own offsets' };

  const groups = sticky.map(sel => ({
    sel,
    els: [...ctx.dom.document.querySelectorAll(sel)]
  })).filter(g => g.els.length);

  const clashes = [];
  /* every element that could be measured, hidden in turn */
  const all = groups.reduce((n, g) => n.concat(g.els), []);
  for (let hide = 0; hide < all.length; hide++) {
    all.forEach((e, i) => { e.offsetHeight = i === hide ? 0 : 44; });
    try { app[layout](); } catch (e) { continue; }

    /* two bars given the same resting place means one is behind the other */
    const tops = new Map();
    for (const g of groups) {
      for (const e of g.els) {
        if (e.offsetHeight === 0) continue;         /* hidden, so not on screen */
        const t = e.style.top;
        if (t === undefined || t === '') continue;
        if (!tops.has(t)) tops.set(t, []);
        tops.get(t).push(g.sel);
      }
    }
    for (const [t, sels] of tops) {
      const distinct = [...new Set(sels)];
      if (distinct.length > 1) {
        clashes.push(distinct.join(' and ') + ' both at ' + t +
          ' when one of ' + groups[0].sel + ' is hidden');
      }
    }
    if (clashes.length) break;
  }
  return { bars: all.length, clashes: [...new Set(clashes)] };
}

/* ------------------------------------------------------------------ *
 * pickers with nothing to offer
 * ------------------------------------------------------------------ */

/* A picker reading from the wrong place looks identical to one with no
   data yet: it simply offers nothing. That shipped here twice - guard
   fields wired to no list at all, then a list reading only the shifts
   while the register sat full beside it. Both times a person found it.
   So: fill every list the app holds, open every picker, and any that
   still comes back empty is reading from somewhere that is not there. */
function emptyPickers(file) {
  const html = fs.readFileSync(file, 'utf8');
  const lists = [...html.matchAll(/<div class="autocomplete-list" id="([^"]+)"><\/div>/g)].map(m => m[1]);
  if (!lists.length) return { lists: 0, empty: [] };

  const ctx = boot(file, { quiet: true });
  const app = ctx.app;
  if (!app) return { lists: lists.length, empty: [] };

  /* something in every list the app keeps, so nothing is empty for want
     of data rather than for want of reading it */
  const stock = {
    guards: [{ id: 9001, name: 'Probe Guard', phone: '' }],
    staff: [{ id: 9002, name: 'Probe Staff', role: 'Engineer', vehicles: ['PS1 AAA'] }],
    contractors: [{ id: 9003, name: 'Probe Contracting', vehicles: ['PC1 AAA'],
      reps: [{ name: 'Probe Rep', vehicles: ['PR1 AAA'], inductionDate: '2099-01-01' }] }],
    regularVisitors: [{ id: 9004, name: 'Probe Haulage', vehicles: ['PH1 AAA'],
      reason: 'Delivery', reps: [{ name: 'Probe Driver', vehicles: ['PD1 AAA'] }] }],
    irregulars: [{ id: 9005, name: 'Probe Oneoff', vehicles: ['PO1 AAA'], reps: [] }],
    keys: [{ id: 9006, name: 'Probe Door', tag: 'PK1' }],
    siteVehicles: ['PV1 AAA']
  };
  for (const k of Object.keys(stock)) if (Array.isArray(app[k])) app[k] = stock[k];
  /* Deliberately nothing recorded yet - registers full, no movements. A
     picker reading the day's records rather than the register looks fine
     the moment anything has happened, and is empty exactly when someone
     has just finished setting the app up. */
  ['shifts', 'visitors', 'staffMovements', 'incidents', 'keyMoves'].forEach(function (k) {
    if (Array.isArray(app[k])) app[k] = [];
  });
  try { app.migrate(); } catch (e) {}

  /* which field belongs to which list, read from the markup */
  const owner = {};
  for (const m of html.matchAll(/<input[^>]*\sid="([^"]+)"[^>]*>\s*<div class="autocomplete-list" id="([^"]+)">/g)) {
    owner[m[2]] = m[1];
  }

  const empty = [];
  for (const list of lists) {
    const field = owner[list];
    if (!field) continue;
    try {
      const el = ctx.id(field);
      el.value = '';
      el.fire('focus');
      el.fire('input');
      if (!(ctx.id(list).children || []).length) empty.push(field + ' / ' + list);
    } catch (e) { /* a picker needing more than a bare focus is not this probe's business */ }
  }
  return { lists: lists.length, empty };
}

/* ------------------------------------------------------------------ *
 * saying the same thing twice
 * ------------------------------------------------------------------ */

/* Drawing the same state twice should give the same result. When it does
   not, something in the render is reaching outside its inputs - an unstable
   sort, a random id, a clock read while building - and the symptom is a
   list that reorders itself, or a document that differs from the one you
   just looked at. */
function drawsTheSame(file) {
  const ctx = boot(file, { quiet: true });
  const app = ctx.app;
  if (!app) return { skipped: 'no app object to draw with' };

  /* give it something to draw */
  const html = ctx.html;
  const plausible = t => ({ date: new Date().toISOString().slice(0, 10), time: '07:00',
    number: '8', tel: '01234 567890', email: 'a@b.co' }[t] || 'Probe Co');
  for (const m of html.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)) {
    try {
      const e = ctx.id(m[1]);
      const t = e.getAttribute('type') || 'text';
      if (t === 'checkbox' || t === 'radio') e.checked = true; else e.value = plausible(t);
      e.fire('input'); e.fire('change');
    } catch (err) {}
  }
  for (const m of html.matchAll(/<form[^>]*\sid="([^"]+)"/g)) {
    try { ctx.id(m[1]).fire('submit'); } catch (err) {}
  }

  const renders = Object.keys(app).filter(k => /^render[A-Z]/.test(k) && typeof app[k] === 'function');
  const unstable = [];
  for (const r of renders) {
    let a, b;
    try { app[r](); a = snapshotDom(ctx); app[r](); b = snapshotDom(ctx); }
    catch (e) { continue; }
    if (a !== b) unstable.push(r);
  }
  return { checked: renders.length, unstable };
}

function snapshotDom(ctx) {
  const parts = [];
  for (const id in ctx.dom.registry) {
    const v = ctx.dom.registry[id].innerHTML || '';
    if (v) parts.push(id + '=' + v);
  }
  return parts.join('\u0001');
}

/* A document built from the same records twice should be the same
   document. Anything that differs is either a clock reading, which is
   fine, or something that will not reproduce, which is not. */
function buildsTheSame(file) {
  const ctx = boot(file, { quiet: true });
  const app = ctx.app;
  const maker = ['buildPdf', 'buildDoc', 'buildReport', 'render', 'toPdf']
    .find(k => app && typeof app[k] === 'function');
  if (!maker) return { skipped: 'nothing here builds a document' };

  let one, two;
  try {
    one = Buffer.from(app[maker]()).toString('latin1');
    two = Buffer.from(app[maker]()).toString('latin1');
  } catch (e) { return { skipped: 'the builder needs more than a bare call' }; }

  if (one === two) return { same: true, bytes: one.length };

  /* A timestamp in the file is expected. Stripping only the plain text
     ones misses any that have been encoded on the way in, and reports a
     document that differs by two milliseconds as non-reproducible. */
  const strip = s => s
    .replace(/[A-Za-z0-9+/=]{40,}/g, run => {
      try {
        const text = Buffer.from(run, 'base64').toString('utf8');
        if (!/[ -~]{20}/.test(text)) return run;          /* not text, leave it */
        return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, 'T');
      } catch (e) { return run; }
    })
    .replace(/D:\d{14}/g, 'D:0')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, 'T')
    .replace(/\d{2}:\d{2}(:\d{2})?/g, '0');
  return { same: false, onlyTiming: strip(one) === strip(two), bytes: one.length };
}

/* ------------------------------------------------------------------ *
 * controls that do nothing
 * ------------------------------------------------------------------ */

/* Pressing every button only finds the ones that throw. A button wired to
   nothing is silent: it looks right, it responds to touch, and it does
   nothing at all. Four of those shipped in this app for twenty builds
   because every probe here asked "did it break" and none asked "did it
   do anything". */
function traceOf(ctx) {
  const parts = [];
  const app = ctx.app;
  if (app) {
    for (const k of Object.keys(app)) {
      const v = app[k];
      if (Array.isArray(v)) parts.push(k + ':' + v.length);
      else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(k + '=' + String(v).slice(0, 40));
      }
    }
  }
  for (const id in ctx.dom.registry) {
    const e = ctx.dom.registry[id];
    parts.push(id + '#' + (e.innerHTML || '').length + '/' + (e.value || '') +
      '/' + (e.className || '') + '/' + (e.textContent || '').length +
      '/' + ((e.style && e.style.display) || ''));
  }
  const ls = ctx.sandbox.localStorage;
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    parts.push('~' + k + '=' + String(ls.getItem(k)).length);
  }
  /* A refusal is a response: the app puts a message on screen, and that
     message is a new element. Counting only what existed at boot makes
     every properly guarded button look dead. */
  parts.push('made=' + ctx.dom.made);
  parts.push('body=' + ctx.dom.document.body.children.length);
  return parts.join('|');
}

function silentControls(file) {
  const html = fs.readFileSync(file, 'utf8');
  const ids = [...html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const silent = [];

  let excused = 0;
  for (const id of ids) {
    /* a fresh app each time, so one button cannot mask another */
    const ctx = boot(file, { quiet: true });
    let before, after;
    const el = ctx.id(id);

    /* Some controls are meant to be inert where they stand: one the app
       has disabled, and a tab for the view already showing. Reporting
       those buries the ones that are actually wired to nothing. */
    if (el.disabled || el.hasAttribute('disabled') ||
        (el.classList && (el.classList.contains('active') || el.classList.contains('on')))) {
      excused++;
      continue;
    }

    try {
      before = traceOf(ctx);
      el.fire('click');
      after = traceOf(ctx);
      /* disabled by the app during its own startup, which is the same thing */
      if (ctx.id(id).disabled) { excused++; continue; }
    } catch (e) { continue; }          /* throwing is another probe's business */
    if (before === after) silent.push(id);
  }
  return { checked: ids.length, silent, excused };
}

/* ------------------------------------------------------------------ *
 * does it survive being closed
 * ------------------------------------------------------------------ */

/* For an app that works offline, everything rests on one property: what
   was typed is still there tomorrow. Nothing else in this file tests it,
   and a field that is never persisted looks perfectly correct until the
   phone is closed. */
function fingerprint(app) {
  if (!app) return null;
  const out = {};
  for (const k of Object.keys(app)) {
    const v = app[k];
    if (!Array.isArray(v)) continue;
    const first = v.find(x => x && typeof x === 'object');
    if (!first) continue;                       /* not a record list */
    out[k] = {
      count: v.length,
      fields: [...new Set(v.flatMap(r => Object.keys(r || {})))].sort()
    };
  }
  return out;
}

function survivesRestart(file) {
  const ctx = boot(file, { quiet: true });
  const html = ctx.html;
  const ids = re => [...html.matchAll(re)].map(m => m[1]);
  const plausible = t => ({
    date: new Date().toISOString().slice(0, 10),
    time: '07:00', number: '8', tel: '01234 567890',
    email: 'a@b.co', url: 'https://x.y', search: 'Probe'
  }[t] || 'Probe Co');

  /* put something in, the way a person would */
  for (const id of ids(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)) {
    try {
      const e = ctx.id(id);
      const t = e.getAttribute('type') || 'text';
      if (t === 'checkbox' || t === 'radio') e.checked = true;
      else e.value = plausible(t);
      e.fire('input'); e.fire('change');
    } catch (err) {}
  }
  for (const id of ids(/<form[^>]*\sid="([^"]+)"/g)) {
    try { ctx.id(id).fire('submit'); } catch (err) {}
  }

  const all = fingerprint(ctx.app);
  if (!all || !Object.keys(all).length) return { skipped: 'nothing was recorded to test with' };

  /* close it and open it again */
  const saved = {};
  const ls = ctx.sandbox.localStorage;
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); saved[k] = ls.getItem(k); }

  /* Only what the app puts in storage is meant to come back. A list held
     purely to draw the current view is not data, and demanding it survive
     a restart invents a fault out of a cache doing its job. */
  const persisted = new Set();
  for (const k in saved) {
    try {
      const v = JSON.parse(saved[k]);
      if (v && typeof v === 'object') for (const key of Object.keys(v)) persisted.add(key);
    } catch (e) {}
  }
  const before = {};
  for (const k of Object.keys(all)) if (persisted.has(k)) before[k] = all[k];
  if (!Object.keys(before).length) {
    return { skipped: 'nothing recorded was written to storage' };
  }

  const again = boot(file, { quiet: true, store: saved });
  const after = fingerprint(again.app);

  const lost = [];
  for (const k of Object.keys(before)) {
    const b = before[k], a = after && after[k];
    if (!a) { lost.push(`${k}: ${b.count} record${b.count === 1 ? '' : 's'} did not come back at all`); continue; }
    if (a.count < b.count) lost.push(`${k}: ${b.count} in, ${a.count} back`);
    const gone = b.fields.filter(f => !a.fields.includes(f));
    if (gone.length) lost.push(`${k}: lost the field${gone.length === 1 ? '' : 's'} ${gone.join(', ')}`);
  }
  return { lost, kinds: Object.keys(before).length,
           records: Object.values(before).reduce((n, v) => n + v.count, 0) };
}

/* ------------------------------------------------------------------ *
 * random sequences
 * ------------------------------------------------------------------ */

/* Ordered probes only ever find what you thought to try. Most state bugs
   need a particular order - edit this, switch view, delete that, come back
   - and nobody writes that case down in advance. The seed is printed so a
   failure can be replayed exactly rather than chased. */
function planActions(ctx, seed, steps) {
  let x = seed >>> 0;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = a => a[Math.floor(rnd() * a.length)];

  const html = ctx.html;
  const buttons = [...html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const forms = [...html.matchAll(/<form[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const fields = [...html.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const views = ctx.app && Array.isArray(ctx.app.TABS) ? ctx.app.TABS : [];
  const words = ['', 'a', 'Test Co', '07:00', '2026-10-06', '12', '-1', '0',
                 "O'Brien & Sons", '<b>x</b>', 'AB21 XYZ', '999999', 'x'.repeat(300)];

  const plan = [];
  for (let i = 0; i < steps; i++) {
    const kinds = [];
    if (buttons.length) kinds.push('click');
    if (fields.length) kinds.push('type');
    if (forms.length) kinds.push('submit');
    if (views.length) kinds.push('view');
    kinds.push('lifecycle');
    const kind = pick(kinds);
    if (kind === 'click') plan.push({ kind, id: pick(buttons) });
    else if (kind === 'type') plan.push({ kind, id: pick(fields), value: pick(words), checked: rnd() > 0.5 });
    else if (kind === 'submit') plan.push({ kind, id: pick(forms) });
    else if (kind === 'view') plan.push({ kind, id: pick(views) });
    else plan.push({ kind, hidden: rnd() > 0.5 });
  }
  return plan;
}

function replay(file, plan) {
  const ctx = boot(file, { quiet: true });
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    try {
      if (a.kind === 'click') ctx.id(a.id).fire('click');
      else if (a.kind === 'type') {
        const e = ctx.id(a.id);
        e.value = a.value; e.checked = a.checked;
        e.fire('input'); e.fire('change');
      } else if (a.kind === 'submit') ctx.id(a.id).fire('submit');
      else if (a.kind === 'view') ctx.app.activateTab(a.id);
      else { ctx.dom.document.hidden = a.hidden; ctx.dom.document.fire('visibilitychange'); }
    } catch (e) {
      return { failed: true, index: i, error: e.message };
    }
  }
  return { failed: false };
}

/* A failure at step 111 of 300 is not a bug report. Nearly all of those
   steps are irrelevant; the interesting thing is the shortest sequence
   that still breaks. Drop each action in turn and keep the drop if it
   still fails the same way, which usually leaves two or three. */
function shrink(file, plan, error, budget) {
  let best = plan.slice();
  let spent = 0;
  for (let i = best.length - 1; i >= 0 && spent < (budget || 400); i--) {
    const trial = best.slice(0, i).concat(best.slice(i + 1));
    spent++;
    const r = replay(file, trial);
    if (r.failed && r.error === error) best = trial;
  }
  return best;
}

function describe(a) {
  if (a.kind === 'type') return `type ${JSON.stringify(String(a.value).slice(0, 14))} into ${a.id}`;
  if (a.kind === 'lifecycle') return a.hidden ? 'leave the app' : 'come back to it';
  return a.kind + ' ' + a.id;
}

/* ------------------------------------------------------------------ *
 * things that should be true no matter what was pressed
 * ------------------------------------------------------------------ */

/* Catching exceptions only finds the failures loud enough to throw. A far
   larger class quietly corrupts state and shows up days later as records
   that will not open. These are the properties that should hold after any
   action at all, checked after every one. */
function snapshot(app) {
  if (!app) return null;
  const shape = {};
  const holds = {};
  let records = 0;
  for (const k of Object.keys(app)) {
    const v = app[k];
    if (Array.isArray(v)) {
      shape[k] = 'array';
      records += v.length;
      /* A list of names is not a list of records, and demanding that every
         array hold objects invents a fault out of a settings list. What
         matters is that a list does not change what it holds. */
      const first = v.find(x => x !== undefined && x !== null);
      holds[k] = first === undefined ? null : (typeof first === 'object' ? 'record' : typeof first);
    } else if (typeof v === 'number') shape[k] = 'number';
    else if (typeof v === 'function') shape[k] = 'function';
  }
  return { shape, holds, records };
}

function violations(app, before, ctx) {
  if (!app || !before) return null;
  const out = [];

  for (const k of Object.keys(before.shape)) {
    const want = before.shape[k], v = app[k];
    if (want === 'array' && !Array.isArray(v)) out.push(`${k} was a list and is now ${v === null ? 'null' : typeof v}`);
    if (want === 'function' && typeof v !== 'function') out.push(`${k} was a function and is now ${typeof v}`);
    if (want === 'number' && typeof v === 'number' && isNaN(v)) out.push(`${k} became NaN`);
  }

  /* A record that has lost its identity cannot be edited or deleted
     afterwards - it is stranded in the list. */
  for (const k of Object.keys(app)) {
    if (!Array.isArray(app[k]) || !app[k].length) continue;
    const was = before.holds[k];
    const first = app[k].find(x => x !== undefined && x !== null);
    const now = first === undefined ? null : (typeof first === 'object' ? 'record' : typeof first);
    if (was && now && was !== now) { out.push(`${k} held ${was}s and now holds ${now}s`); continue; }
    if (now !== 'record') continue;
    for (const item of app[k]) {
      if (item === null || typeof item !== 'object') { out.push(`${k} has something in it that is not a record`); break; }
      if ('id' in item && (item.id === undefined || item.id === null || (typeof item.id === 'number' && isNaN(item.id)))) {
        out.push(`${k} holds a record with no usable id, so it can never be edited or deleted`); break;
      }
    }
  }

  return out.length ? out[0] : null;
}

/* Checked once per sequence, being dearer than the per-action ones. */
function deepViolations(ctx) {
  const out = [];

  /* Only markup the app has written since it started. The page's own
     content is full of ids by design, and counting those reports the
     document itself as a fault. */
  const ids = [];
  for (const id in ctx.dom.registry) {
    const el = ctx.dom.registry[id];
    const inner = el.innerHTML || '';
    if (inner === (el._bornWith || '')) continue;      /* untouched since boot */
    for (const m of inner.matchAll(/\sid="([^"]+)"/g)) ids.push(m[1]);
  }
  const dupe = ids.find((v, i) => ids.indexOf(v) !== i);
  if (dupe) out.push(`the app drew id "${dupe}" more than once, so a lookup finds the wrong one`);

  try {
    const ls = ctx.sandbox.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i), v = ls.getItem(k);
      if (v && /^[[{]/.test(v.trim())) JSON.parse(v);
    }
  } catch (e) {
    out.push('something was saved that cannot be read back: ' + e.message.slice(0, 40));
  }

  return out.length ? out[0] : null;
}

/* Replay while counting which methods were reached, so a sequence can be
   judged on what it explored rather than only on whether it survived. */
function replayCovered(file, plan) {
  const ctx = boot(file, { quiet: true });
  const inst = instrument(ctx);
  const hits = inst ? inst.hits : {};
  const base = snapshot(ctx.app);
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    try {
      if (a.kind === 'click') ctx.id(a.id).fire('click');
      else if (a.kind === 'type') {
        const e = ctx.id(a.id);
        e.value = a.value; e.checked = a.checked;
        e.fire('input'); e.fire('change');
      } else if (a.kind === 'submit') ctx.id(a.id).fire('submit');
      else if (a.kind === 'view') ctx.app.activateTab(a.id);
      else { ctx.dom.document.hidden = a.hidden; ctx.dom.document.fire('visibilitychange'); }
    } catch (e) {
      return { failed: true, index: i, error: e.message, reached: reachedFrom(hits) };
    }
    const broke = violations(ctx.app, base, ctx);
    if (broke) return { failed: true, index: i, error: broke, invariant: true, reached: reachedFrom(hits) };
  }
  const deep = deepViolations(ctx);
  if (deep) return { failed: true, index: plan.length - 1, error: deep, invariant: true, reached: reachedFrom(hits) };
  return { failed: false, reached: reachedFrom(hits), startup: inst ? inst.startup : new Set() };
}

function reachedFrom(hits) {
  const out = new Set();
  for (const k in hits) if (hits[k] > 0) out.add(k);
  return out;
}

/* Random alone keeps walking the same few paths. Keeping any sequence
   that reached something new, and mutating those rather than starting
   over, pushes into code that a fresh random run rarely gets to. */
function explore(file, opts) {
  const o = opts || {};
  const budgetMs = o.ms || 6000;
  const started = Date.now();
  let x = (o.seed || 1) >>> 0;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = a => a[Math.floor(rnd() * a.length)];

  const ctx = boot(file, { quiet: true });
  const vocabulary = planActions(ctx, 99, 400);

  /* Starting from nothing, random exploration spends its whole budget
     rediscovering what a single ordered pass already covers. Seed it with
     sequences that reach everything the obvious way, so the mutations are
     spent looking beyond them rather than catching up. */
  const html = ctx.html;
  const ids = re => [...html.matchAll(re)].map(m => m[1]);
  const buttons = ids(/<button[^>]*\sid="([^"]+)"/g);
  const forms = ids(/<form[^>]*\sid="([^"]+)"/g);
  const fields = ids(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g);
  const views = ctx.app && Array.isArray(ctx.app.TABS) ? ctx.app.TABS : [];

  const corpus = [
    [],
    buttons.map(id => ({ kind: 'click', id })),
    forms.map(id => ({ kind: 'submit', id })),
    fields.map(id => ({ kind: 'type', id, value: 'probe', checked: true })),
    views.map(id => ({ kind: 'view', id })),
    /* fill first, then press: the order most real use takes */
    fields.map(id => ({ kind: 'type', id, value: '2026-10-06', checked: true }))
      .concat(buttons.map(id => ({ kind: 'click', id })))
  ].filter(p => p.length || true);

  const seen = new Set();
  let runs = 0, kept = 0, failure = null;

  function mutate(base) {
    const p = base.slice();
    const how = rnd();
    if (how < 0.55 || !p.length) {
      const n = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) p.push(pick(vocabulary));
    } else if (how < 0.75) {
      p.splice(Math.floor(rnd() * p.length), 1);
    } else if (how < 0.9) {
      p[Math.floor(rnd() * p.length)] = pick(vocabulary);
    } else {
      const other = pick(corpus);
      p.push(...other.slice(0, 1 + Math.floor(rnd() * 4)));
    }
    return p.length > 260 ? p.slice(-260) : p;
  }

  while (Date.now() - started < budgetMs) {
    const plan = mutate(pick(corpus));
    const r = replayCovered(file, plan);
    runs++;
    if (r.failed) {
      const upTo = plan.slice(0, r.index + 1);
      failure = {
        error: r.error,
        minimal: shrink(file, upTo, r.error, 250).map(describe),
        from: plan.length
      };
      break;
    }
    let fresh = 0;
    for (const m of r.reached) if (!seen.has(m)) { seen.add(m); fresh++; }
    if (fresh) { corpus.push(plan); kept++; }
  }

  return { runs, kept, corpus: corpus.length, reached: seen, failure,
           ms: Date.now() - started };
}

function monkey(file, seed, steps, opts) {
  const ctx = boot(file, { quiet: true });
  const plan = planActions(ctx, seed, steps);
  const r = replay(file, plan);
  if (!r.failed) return { failed: false, seed, steps };

  const upTo = plan.slice(0, r.index + 1);
  const minimal = (opts && opts.shrink === false) ? upTo : shrink(file, upTo, r.error);
  return {
    failed: true, seed, step: r.index + 1, error: r.error,
    action: describe(plan[r.index]),
    minimal: minimal.map(describe),
    from: plan.length
  };
}

/* ------------------------------------------------------------------ *
 * what nothing touched
 * ------------------------------------------------------------------ */

/* A run of probes that passes tells you nothing about the code it never
   reached. Wrapping every method and counting turns "all clean" into
   "all clean, and here is what that did not cover". */
function instrument(ctx) {
  const app = ctx.app;
  if (!app) return null;
  const hits = {};
  for (const key of Object.keys(app)) {
    const fn = app[key];
    if (typeof fn !== 'function') continue;
    hits[key] = 0;
    app[key] = function (...args) { hits[key]++; return fn.apply(this, args); };
  }
  /* Counting starts after the app has started, so anything that only runs
     at startup would read as unreached. Those are named from the source
     instead, and set aside rather than counted against the probes. */
  const startup = new Set();
  const src = ctx.html;
  const roots = ['init', 'boot', 'start', 'main', 'setup'];
  for (const r of roots) {
    const m = src.match(new RegExp('\\b' + r + '\\s*:\\s*function[\\s\\S]{0,4000}?\\n  \\},'));
    if (!m) continue;
    startup.add(r);
    for (const c of m[0].matchAll(/(?:this|self)\.([a-zA-Z_$][\w$]*)\s*\(/g)) startup.add(c[1]);
  }
  return { hits, startup };
}

function coverage(inst) {
  if (!inst) return null;
  const { hits, startup } = inst;
  const names = Object.keys(hits).filter(n => !startup.has(n));
  const cold = names.filter(n => hits[n] === 0);
  return { total: names.length, reached: names.length - cold.length, cold, skipped: startup.size };
}

/* ------------------------------------------------------------------ *
 * awkward dates
 * ------------------------------------------------------------------ */

/* Anything that reasons about dates has a handful of days each year where
   it can be wrong, and none of them are today. */
const AWKWARD = [
  ['a leap day', '2028-02-29T09:00:00'],
  ['the day after a leap day', '2028-03-01T09:00:00'],
  ['the last day of a 31 day month', '2026-01-31T23:30:00'],
  ['new year eve, late', '2026-12-31T23:50:00'],
  ['new year day, early', '2027-01-01T00:10:00'],
  ['the clocks going forward', '2026-03-29T01:30:00'],
  ['the clocks going back', '2026-10-25T01:30:00'],
  ['the last day of february', '2027-02-28T22:00:00']
];

function atDate(file, iso) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  /* Only a no-argument Date is pinned; parsing a given date must still
     work normally or every probe would be testing the shim. */
  class Pinned extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  }
  global.Date = Pinned;
  try {
    const ctx = boot(file, { quiet: true });
    const buttons = [...ctx.html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
    for (const id of buttons) ctx.id(id).fire('click');
    if (ctx.app && Array.isArray(ctx.app.TABS)) ctx.app.TABS.forEach(t => ctx.app.activateTab(t));
    return null;
  } catch (e) {
    return e.message;
  } finally {
    global.Date = RealDate;
  }
}

/* ------------------------------------------------------------------ *
 * probes that apply to any app of this shape
 * ------------------------------------------------------------------ */

function run(file, opts) {
  const results = [];
  const ok = (n, d) => results.push(['ok  ', n, d || '']);
  const bad = (n, d) => results.push(['FAIL', n, d || '']);

  let ctx;
  try {
    ctx = boot(file, { quiet: true });
  } catch (e) {
    console.log('\n  could not boot at all: ' + e.message + '\n');
    process.exit(2);
  }
  ok('boots without throwing');
  const hits = instrument(ctx);
  if (ctx.thrown.length) bad('nothing threw during boot', ctx.thrown[0].message);
  else ok('nothing threw during boot');

  const html = ctx.html;
  const app = ctx.app;

  /* Pressing every button is the cheapest way to find a handler that
     assumes something the page has not got yet. */
  const buttonIds = [...html.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const broke = [];
  for (const id of buttonIds) {
    try { ctx.id(id).fire('click'); }
    catch (e) { broke.push(id + ': ' + e.message.slice(0, 50)); }
  }
  if (broke.length) bad(`pressing all ${buttonIds.length} buttons`, broke.slice(0, 4).join(' | '));
  else ok(`pressing all ${buttonIds.length} buttons`, 'nothing threw');

  /* An empty form submitted is what happens when someone taps save by
     mistake, and it should be refused rather than break. */
  const formIds = [...html.matchAll(/<form[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const badForms = [];
  for (const id of formIds) {
    try { ctx.id(id).fire('submit'); }
    catch (e) { badForms.push(id + ': ' + e.message.slice(0, 50)); }
  }
  if (badForms.length) bad(`submitting all ${formIds.length} forms empty`, badForms.slice(0, 4).join(' | '));
  else ok(`submitting all ${formIds.length} forms empty`, 'nothing threw');

  /* Changing every input, in case a handler assumes a shape of value. */
  const inputIds = [...html.matchAll(/<(?:input|select|textarea)[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const badInputs = [];
  for (const id of inputIds) {
    try {
      const e = ctx.id(id);
      e.value = 'probe';
      e.fire('input'); e.fire('change'); e.fire('blur');
    } catch (err) { badInputs.push(id + ': ' + err.message.slice(0, 50)); }
  }
  if (badInputs.length) bad(`typing into all ${inputIds.length} fields`, badInputs.slice(0, 4).join(' | '));
  else ok(`typing into all ${inputIds.length} fields`, 'nothing threw');

  /* Every view reachable, in case one was renamed and its route was not. */
  if (app && Array.isArray(app.TABS)) {
    const stuck = [];
    for (const t of app.TABS) {
      try { app.activateTab(t); } catch (e) { stuck.push(t + ': ' + e.message.slice(0, 40)); }
    }
    if (stuck.length) bad('opening every view', stuck.join(' | '));
    else ok(`opening all ${app.TABS.length} views`, 'nothing threw');
  }

  /* The page being hidden and shown again, and the window resized, which
     is what a folding phone does every time it opens. */
  try {
    ctx.dom.document.hidden = true; ctx.dom.document.fire('visibilitychange');
    ctx.dom.document.hidden = false; ctx.dom.document.fire('visibilitychange');
    ctx.dom.window.fire('resize');
    ctx.dom.window.fire('orientationchange');
    ok('hiding, showing and resizing', 'nothing threw');
  } catch (e) { bad('hiding, showing and resizing', e.message); }

  /* Corrupt settings, which is what a half-written store looks like. */
  try {
    const junk = boot(file, { quiet: true });
    const keys = [...html.matchAll(/(?:getItem|setItem)\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const k of new Set(keys)) junk.sandbox.localStorage.setItem(k, '{"broken":');
    const j2 = boot(file, { quiet: true });
    for (const k of new Set(keys)) j2.sandbox.localStorage.setItem(k, 'not json at all');
    ok(`booting with ${new Set(keys).size} corrupt settings`, 'nothing threw');
  } catch (e) { bad('booting with corrupt settings', e.message); }

  /* Storage that refuses to write, which is a full or locked down device. */
  try {
    const full = boot(file, { quiet: true });
    full.sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    for (const id of buttonIds.slice(0, 40)) { try { full.id(id).fire('click'); } catch (e) {} }
    ok('working with storage that refuses writes', 'nothing threw out of the app');
  } catch (e) { bad('working with storage that refuses writes', e.message); }

  /* Listeners must not pile up when a view is drawn repeatedly. */
  if (app) {
    const renders = Object.keys(app).filter(k => /^render[A-Z]/.test(k) && typeof app[k] === 'function');
    let grew = null;
    for (const r of renders) {
      try {
        app[r]();
        const base = countHandlers(ctx.dom);
        for (let i = 0; i < 10; i++) app[r]();
        const ten = countHandlers(ctx.dom);
        for (let i = 0; i < 10; i++) app[r]();
        const twenty = countHandlers(ctx.dom);
        /* Compare the growth of the second ten draws against the first.
           A threshold guessed against a total misses a slow leak; two
           equal, non-zero increments are the signature of one. */
        const first = ten - base, second = twenty - ten;
        if (first > 2 && second > 2 && Math.abs(first - second) <= Math.max(2, first * 0.3)) {
          grew = `${r}: +${first} then +${second} handlers per ten draws`;
        }
      } catch (e) { /* a render needing state it has not got is not this probe's business */ }
    }
    if (grew) bad('drawing a view twenty times', 'listeners piled up — ' + grew);
    else ok(`drawing all ${renders.length} views twenty times`, 'no listener build up');
  }

  /* random sequences, with the seed printed so a failure can be replayed */
  const seeds = [1, 7, 42, 1337, 90210];
  const shaken = [];
  for (const seed of seeds) {
    const r = monkey(file, seed, 300);
    if (r.failed) {
      shaken.push(`${r.error.slice(0, 70)}\n               shortest sequence that does it, from ${r.from} actions down to ${r.minimal.length}:\n` +
        r.minimal.map((a, i) => `                 ${i + 1}. ${a}`).join('\n') +
        `\n               replay with seed ${seed}`);
    }
  }
  if (shaken.length) bad(`${seeds.length} random runs of 300 actions`, shaken[0]);
  else ok(`${seeds.length} random runs of 300 actions`, 'nothing threw in any order');

  /* awkward dates */
  const badDates = [];
  for (const [name, iso] of AWKWARD) {
    const err = atDate(file, iso);
    if (err) badDates.push(name + ': ' + err.slice(0, 50));
  }
  if (badDates.length) bad(`booting on ${AWKWARD.length} awkward dates`, badDates.join(' | '));
  else ok(`booting on ${AWKWARD.length} awkward dates`, 'leap days, clock changes and year ends');

  /* two bars put in the same place because one was measured while hidden */
  const lay = layoutWithHidden(file);
  if (lay.skipped) results.push(['    ', 'layout with a pane hidden', lay.skipped]);
  else if (lay.clashes.length) {
    bad('layout with a pane hidden', 'two bars land on the same spot, so one sits behind the other: ' +
      lay.clashes.slice(0, 3).join(' | '));
  } else ok(`layout holds with any of ${lay.bars} bars hidden`, 'nothing lands behind anything else');

  /* a picker that offers nothing while the registers are full */
  const pick = emptyPickers(file);
  if (pick.empty.length) {
    bad(`${pick.empty.length} of ${pick.lists} pickers offered nothing`,
      'with every register filled, so they are reading from somewhere that has nothing in it: ' +
      pick.empty.slice(0, 6).join(', '));
  } else if (pick.lists) {
    ok(`all ${pick.lists} pickers offered something`, 'each reads a list that has data in it');
  }

  /* drawing the same thing twice should give the same thing */
  const stable = drawsTheSame(file);
  if (stable.skipped) results.push(['    ', 'drawing twice', stable.skipped]);
  else if (stable.unstable.length) {
    bad('drawing the same state twice', 'gives a different result, so something in the render reads outside its inputs: ' +
      stable.unstable.join(', '));
  } else ok(`drawing all ${stable.checked} views twice`, 'the same state gives the same result');

  const doc = buildsTheSame(file);
  if (doc.skipped) results.push(['    ', 'building a document twice', doc.skipped]);
  else if (doc.same) ok('building the same document twice', `identical, ${Math.round(doc.bytes / 1024)} KB`);
  else if (doc.onlyTiming) ok('building the same document twice', 'identical but for the timestamp');
  else bad('building the same document twice', 'the two differ by more than the time of day');

  /* a control that responds to touch and changes nothing */
  const quiet = silentControls(file);
  if (quiet.silent.length) {
    results.push(['thin', `${quiet.silent.length} of ${quiet.checked} buttons changed nothing when pressed` +
      (quiet.excused ? ` (${quiet.excused} disabled or already active, not counted)` : ''),
      'worth checking each is meant to: ' + quiet.silent.slice(0, 10).join(', ') +
      (quiet.silent.length > 10 ? ` and ${quiet.silent.length - 10} more` : '')]);
  } else {
    ok(`all ${quiet.checked - quiet.excused} live buttons changed something when pressed`,
      quiet.excused ? `${quiet.excused} disabled or already active, not counted` : 'none is wired to nothing');
  }

  /* the one property everything else rests on */
  const rt = survivesRestart(file);
  if (rt.skipped) results.push(['    ', 'surviving a restart', rt.skipped]);
  else if (rt.lost.length) bad('surviving a restart', rt.lost.slice(0, 4).join(' | '));
  else ok(`surviving a restart, ${rt.records} records across ${rt.kinds} lists`, 'everything came back');

  /* Half of what these apps do lives in markup they write themselves -
     the edit and delete buttons on each row. Those handlers are strings
     until a row exists, so nothing that only presses the static page has
     ever run them. Harvest them and call them. */
  /* Rows only exist once something has been recorded, and an empty form
     is rightly refused, so fill everything plausibly and submit before
     looking for what the app drew. */
  const plausible = t => ({
    date: new Date().toISOString().slice(0, 10),
    time: '07:00', number: '8', tel: '01234 567890',
    email: 'a@b.co', url: 'https://x.y', search: 'Probe'
  }[t] || 'Probe Co');

  for (const id of inputIds) {
    try {
      const e = ctx.id(id);
      const t = (e.getAttribute('type') || 'text');
      if (t === 'checkbox' || t === 'radio') e.checked = true;
      else e.value = plausible(t);
      e.fire('input'); e.fire('change');
    } catch (err) { /* covered by the earlier pass */ }
  }
  for (const id of formIds) {
    try { ctx.id(id).fire('submit'); } catch (err) { /* covered by the earlier pass */ }
  }

  const generated = new Set();
  for (const id in ctx.dom.registry) {
    const inner = ctx.dom.registry[id].innerHTML || '';
    /* a boundary, or "aria-controls=" matches as "ontrols=" and every
       panel id gets called as if it were code */
    for (const m of inner.matchAll(/\son[a-z]+="([^"]+)"/g)) generated.add(m[1]);
  }
  const brokeGen = [];
  for (const expr of generated) {
    try {
      require('vm').runInContext(expr, ctx.sandbox);
    } catch (e) {
      brokeGen.push(expr.slice(0, 40) + ': ' + e.message.slice(0, 40));
    }
  }
  if (brokeGen.length) bad(`calling ${generated.size} handlers the app wrote itself`, brokeGen.slice(0, 3).join(' | '));
  else if (generated.size) ok(`calling ${generated.size} handlers the app wrote itself`, 'row level edit and delete, nothing threw');
  else ok('handlers the app wrote itself', 'none generated by this point');

  /* Random alone plateaus quickly; guiding it by coverage does not. */
  const dig = explore(file, { ms: 5000, seed: 20260818 });
  if (dig.failure) {
    bad(`exploring for ${Math.round(dig.ms / 1000)}s, ${dig.runs} sequences`,
      `${dig.failure.error.slice(0, 70)}\n               shortest sequence that does it, from ${dig.failure.from} actions down to ${dig.failure.minimal.length}:\n` +
      dig.failure.minimal.map((a, i) => `                 ${i + 1}. ${a}`).join('\n'));
  } else {
    ok(`exploring ${dig.runs} sequences, keeping ${dig.kept} that found new ground`,
      `${dig.reached.size} methods reached`);
  }

  /* Fold in what exploration reached before reading the total, or the
     figure describes only the ordered pass and understates the rest. */
  if (hits && dig.reached.size) {
    for (const m of dig.reached) if (m in hits.hits && hits.hits[m] === 0) hits.hits[m] = 1;
  }

  /* what all of that never went near */
  const cov = coverage(hits);
  if (cov) {
    const pct = Math.round(cov.reached / cov.total * 100);
    results.push([pct >= 50 ? 'ok  ' : 'thin',
      `${cov.reached} of ${cov.total} methods reached by the probes (${pct}%)`,
      (cov.skipped ? `${cov.skipped} startup methods set aside. ` : '') +
      (cov.cold.length ? 'not reached: ' + cov.cold.slice(0, 12).join(', ') +
        (cov.cold.length > 12 ? ` and ${cov.cold.length - 12} more` : '') : '')]);
  }

  const worst = results.filter(r => r[0] === 'FAIL');
  if (!opts.json) {
    console.log('\n  ' + path.basename(file) + '   ' + (process.env.TZ || 'system clock'));
    for (const [tag, name, detail] of results) {
      if (opts.quiet && tag === 'ok  ') continue;
      console.log('    [' + tag + ']  ' + name + (detail ? '\n               ' + detail : ''));
    }
    console.log('\n  ' + (results.length - worst.length) + '/' + results.length + ' probes clean\n');
  } else console.log(JSON.stringify(results, null, 2));

  process.exit(worst.length ? 2 : 0);
}

function countHandlers(dom) {
  let n = 0;
  const seen = new Set();
  (function walk(e) {
    if (!e || seen.has(e)) return;
    seen.add(e);
    for (const t in e._handlers || {}) n += e._handlers[t].length;
    (e.children || []).forEach(walk);
  })(dom.document.body);
  for (const id in dom.registry) {
    const e = dom.registry[id];
    if (seen.has(e)) continue;
    seen.add(e);
    for (const t in e._handlers || {}) n += e._handlers[t].length;
  }
  return n;
}

module.exports = { boot, makeDom, monkey, atDate, replay, replayCovered, shrink, planActions, instrument, coverage, explore, snapshot, violations, deepViolations, survivesRestart, fingerprint, silentControls, traceOf, drawsTheSame, buildsTheSame, emptyPickers, layoutWithHidden };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find(a => a[0] !== '-');
  if (!file) { console.error('give me an .html file to probe'); process.exit(2); }
  run(file, { quiet: argv.includes('--quiet'), json: argv.includes('--json') });
}
