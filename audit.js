#!/usr/bin/env node
/*
  audit.js - a static auditor for single-file HTML apps and PWAs.

    node audit.js index.html
    node audit.js index.html sw.js manifest.json
    node audit.js --quiet index.html        only problems
    node audit.js --json  index.html        machine readable

  Everything it checks came from a real defect found in a shipped file.
  Each check says what it is looking for and why it matters, so the output
  can be read by someone who did not write the checks.

  Exit code: 0 clean, 1 warnings only, 2 one or more faults.
*/

'use strict';
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * reporting
 * ------------------------------------------------------------------ */

const FAULT = 'fault';     // will bite someone
const WARN = 'warn';       // suspicious, worth a look
const NOTE = 'note';       // informational

const window = {};
const findings = [];
let currentLayer = '';

function layer(name) { currentLayer = name; }
function report(level, check, detail, evidence) {
  findings.push({ layer: currentLayer, level, check, detail, evidence: evidence || null });
}
const fault = (c, d, e) => report(FAULT, c, d, e);
const warn = (c, d, e) => report(WARN, c, d, e);
const note = (c, d, e) => report(NOTE, c, d, e);

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/* Comments and string literals produce most false positives in naive
   source scanning, so they are blanked before any identifier work. */
function blankNoise(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = null;   // 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 'rx'
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (!state) {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i++; continue; }
      /* Telling a regex from a division is the hard part of this. Guessing
         wrong the eager way is far worse than guessing wrong the other way:
         a division read as a regex swallows everything to the next slash
         and silently blanks real code, so every later check runs on a file
         with holes in it. Only accept a regex that closes on its own line. */
      if (c === '/' && /[=(,:[!&|?+\-*%;{}\n]\s*$/.test(out.slice(-12) + '')) {
        const eol = src.indexOf('\n', i);
        const line = src.slice(i + 1, eol === -1 ? n : eol);
        let closes = false;
        for (let k = 0; k < line.length; k++) {
          if (line[k] === '\\') { k++; continue; }
          if (line[k] === '[') { while (k < line.length && line[k] !== ']') { if (line[k] === '\\') k++; k++; } continue; }
          if (line[k] === '/') { closes = true; break; }
        }
        if (closes) { state = 'rx'; out += ' '; i++; continue; }
      }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = null; out += '\n'; } else out += ' '; i++; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = null; out += '  '; i += 2; }
      else { out += (c === '\n' ? '\n' : ' '); i++; }
      continue;
    }
    if (c === '\\') { out += '  '; i += 2; continue; }
    /* A quoted string and a regex both end at the line they began on. If a
       newline arrives first the opener was not what it looked like - an
       apostrophe in prose, or a division sign. Reset rather than swallow
       the rest of the file, which is how a scanner silently reports
       nonsense about code it never actually saw. */
    if (c === '\n' && state !== 'tpl') { state = null; out += '\n'; i++; continue; }
    const closer = { sq: "'", dq: '"', tpl: '`', rx: '/' }[state];
    if (c === closer) { state = null; out += ' '; i++; continue; }
    out += (c === '\n' ? '\n' : ' ');
    i++;
  }
  return out;
}

function uniq(a) { return [...new Set(a)]; }
function matches(re, s) { return [...s.matchAll(re)]; }

/* ------------------------------------------------------------------ *
 * layer 1 - document structure
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line',
  'polygon', 'polyline', 'ellipse', 'stop', 'use']);

function checkStructure(html, body, js) {
  window.__js = js;
  layer('structure');

  /* Counting opens against closes per tag is not enough: a file can have
     matching totals and still be mis-nested. Depth has to be walked. */
  const stack = [];
  let worstLine = null;
  const lines = body.split('\n');
  let depth = 0, minDepth = 0;
  for (const m of matches(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g, body)) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosed = /\/\s*$/.test(m[3]);
    if (VOID_TAGS.has(tag) || selfClosed) continue;
    if (closing) {
      depth--;
      const open = stack.pop();
      if (open && open !== tag) {
        fault('nesting', `<${open}> is closed by </${tag}>`, m[0]);
      }
      if (depth < minDepth) { minDepth = depth; worstLine = m[0]; }
    } else { stack.push(tag); depth++; }
  }
  if (depth !== 0) {
    fault('nesting', `${Math.abs(depth)} element${Math.abs(depth) === 1 ? '' : 's'} ` +
      (depth > 0 ? 'left unclosed' : 'closed too many times') +
      ' — totals per tag can still balance, so this is easy to miss',
      stack.slice(-3).map(t => '<' + t + '>').join(' inside ') || null);
  } else {
    note('nesting', 'element nesting balances end to end');
  }
  if (minDepth < 0) fault('nesting', 'a closing tag appears before its opening tag', worstLine);

  const ids = matches(/\sid="([^"]+)"/g, html).map(m => m[1]);
  const dupes = uniq(ids.filter((v, i) => ids.indexOf(v) !== i));
  if (dupes.length) fault('duplicate id', `${dupes.length} id${dupes.length === 1 ? '' : 's'} used more than once — getElementById silently returns the first`, dupes.join(', '));
  else note('duplicate id', `${ids.length} ids, all unique`);

  const fors = uniq(matches(/<label[^>]*\sfor="([^"]+)"/g, html).map(m => m[1]));
  const orphanLabels = fors.filter(f => !ids.includes(f));
  if (orphanLabels.length) warn('label target', 'a label points at no element, so tapping it does nothing', orphanLabels.join(', '));
  else if (fors.length) note('label target', `${fors.length} labels, all resolve`);

  /* A view the markup declares but no route names is unreachable: it is
     still in the file, still maintained, and nobody can get to it. The
     reverse - a route naming a view that no longer exists - lands
     somewhere unexpected instead. */
  const paneIds = uniq(
    matches(/<div[^>]*\sid="([^"]+)"[^>]*class="[^"]*\b(?:tab-content|pane|view|screen|page)\b/g, body).map(m => m[1])
      .concat(matches(/<div[^>]*class="[^"]*\b(?:tab-content|pane|view|screen|page)\b[^"]*"[^>]*\sid="([^"]+)"/g, body).map(m => m[1]))
      .concat(matches(/<[^>]*role="tabpanel"[^>]*\sid="([^"]+)"/g, body).map(m => m[1]))
  );
  if (paneIds.length) {
    const listSrc = (window.__js || '').match(/(?:TABS|VIEWS|PANES|SCREENS|ROUTES)\s*[:=]\s*[[{][\s\S]{0,1500}?[\]}]/g) || [];
    const named = listSrc.join(' ');
    /* A view need not be reached by a route: one opened by a button is
       just as reachable, and demanding a route calls it dead. */
    const reachable = paneIds.filter(p =>
      new RegExp("['\"]" + p + "['\"]").test(named) ||
      new RegExp("\\b" + p + "\\s*:").test(named) ||
      new RegExp("activate\\w*\\(\\s*['\"]" + p + "['\"]").test(window.__js || '') ||
      new RegExp("getElementById\\(\\s*['\"]" + p + "['\"]").test(window.__js || ''));
    const stranded = paneIds.filter(p => !reachable.includes(p));
    if (stranded.length) fault('unreachable view', 'declared in the markup but no route names it, so nothing can open it', stranded.join(', '));
    else note('unreachable view', `${paneIds.length} views, all reachable`);
  }

  /* The same reasoning one level down. A tab's inner panes are declared in
     script and drawn in markup, and nothing forces the two to agree: a
     pane with no button is unreachable, a button with no pane does
     nothing when pressed. Both look fine until someone tries. */
  const subPanes = uniq(matches(/<div[^>]*\sid="([^"]+)"[^>]*class="[^"]*\bsubpane\b/g, body).map(m => m[1])
    .concat(matches(/<div[^>]*class="[^"]*\bsubpane\b[^"]*"[^>]*\sid="([^"]+)"/g, body).map(m => m[1])));
  if (subPanes.length) {
    /* Any control paired with a pane, not only one named to a convention.
       Requiring the "btn" prefix meant a pane opened from somewhere other
       than a tab row read as unreachable. */
    /* A pair may carry more than two entries - a flag saying the control
       is not one of the tabs, say - so do not insist the bracket closes
       right after the pane, or the pane reads as having no control. */
    const declared = matches(/\[\s*['"]([\w$]+)['"]\s*,\s*['"](sub[\w$]+)['"]\s*[,\]]/g, window.__js || '');
    const declaredPanes = declared.map(m => m[2]);
    const declaredBtns = declared.map(m => m[1]);
    const strandedPanes = subPanes.filter(p => !declaredPanes.includes(p));
    const strandedBtns = uniq(declaredBtns.filter(b => !new RegExp('id="' + b + '"').test(body)));
    const missingPanes = uniq(declaredPanes.filter(p => !subPanes.includes(p)));
    if (strandedPanes.length) fault('unreachable sub view', 'drawn in the markup but no button is declared for it', strandedPanes.join(', '));
    if (strandedBtns.length) fault('button with no markup', 'declared in script but the page has no such button', strandedBtns.join(', '));
    if (missingPanes.length) fault('missing sub view', 'a button is declared for a pane the page does not contain', missingPanes.join(', '));
    if (!strandedPanes.length && !strandedBtns.length && !missingPanes.length) {
      note('sub views', `${subPanes.length} inner panes, each with a button that exists`);
    }
  }

  /* A button inside a form with no type submits it. */
  let loose = 0, total = 0;
  for (const f of matches(/<form[\s\S]*?<\/form>/g, body).map(m => m[0])) {
    for (const b of matches(/<button([^>]*)>/g, f)) { total++; if (!/type="/.test(b[1])) loose++; }
  }
  if (loose) fault('button type', `${loose} of ${total} buttons in forms have no type, so they submit the form`);
  else if (total) note('button type', `${total} buttons in forms, all typed`);
}

/* ------------------------------------------------------------------ *
 * layer 2 - wiring between markup and script
 * ------------------------------------------------------------------ */

function checkWiring(html, js, clean) {
  layer('wiring');

  const ids = uniq(matches(/\sid="([^"]+)"/g, html).map(m => m[1]));
  const looked = uniq(matches(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g, js).map(m => m[1]));
  const missing = looked.filter(u => !ids.includes(u));
  if (missing.length) fault('missing element', 'looked up in script but not present in the markup — returns null and usually throws', missing.join(', '));
  else note('missing element', `${looked.length} lookups, all present`);

  /* A duplicate key in an object literal silently shadows the earlier one,
     so edits to the first have no effect whatever. */
  const keys = matches(/^\s{2}([a-zA-Z_$][\w$]*)\s*:/gm, clean).map(m => m[1]);
  const shadowed = uniq(keys.filter((v, i) => keys.indexOf(v) !== i));
  if (shadowed.length) fault('shadowed key', 'defined twice in the same object — the later one wins and the earlier is dead', shadowed.join(', '));
  else note('shadowed key', `${keys.length} top level keys, none shadowed`);

  /* Methods can be declared as object keys, on a prototype, or as plain
     functions. Missing any of those invents undefined calls that are fine. */
  const defined = uniq(
    matches(/^\s{2}([a-zA-Z_$][\w$]*)\s*:\s*function/gm, clean).map(m => m[1])
      .concat(matches(/^\s*([a-zA-Z_$][\w$]*)\s*:\s*function/gm, clean).map(m => m[1]))
      .concat(matches(/\.prototype\.([a-zA-Z_$][\w$]*)\s*=/g, clean).map(m => m[1]))
      .concat(matches(/\bfunction\s+([a-zA-Z_$][\w$]*)/g, clean).map(m => m[1]))
      .concat(matches(/\bvar\s+([a-zA-Z_$][\w$]*)\s*=\s*function/g, clean).map(m => m[1]))
  );
  const props = uniq(keys);
  const called = uniq(matches(/(?:this|self\d*|app)\.([a-zA-Z_$][\w$]*)\s*\(/g, clean).map(m => m[1]));
  const undef = called.filter(c => !props.includes(c) && !defined.includes(c));
  if (undef.length) warn('undefined method', 'called on an object but defined nowhere in this file', undef.join(', '));
  else note('undefined method', `${called.length} method calls, all defined`);

  /* A handler written into generated markup is a call, even though it lives
     inside a string. Searching only the de-stringed source calls it dead. */
  const unused = defined.filter(d => {
    const asCall = new RegExp('(?:this|self\\d*|app|[a-z]\\w*)\\.' + d + '\\s*\\(');
    const body = clean.replace(new RegExp('^\\s*' + d + '\\s*:', 'gm'), '');
    if (asCall.test(body)) return false;
    if (new RegExp('\\b' + d + '\\s*\\(').test(js)) return false;   // includes strings
    if (new RegExp('["\'`]' + d + '["\'`]').test(js)) return false;
    /* handed to something else rather than called here: addEventListener(x, fn) */
    if (new RegExp('[,(]\\s*' + d + '\\s*[,)]').test(body)) return false;
    return true;
  });
  if (unused.length) warn('dead code', 'defined but never called, in source or in generated markup', unused.join(', '));
  else note('dead code', `${defined.length} functions, all reachable`);

  /* var read above its own declaration inside the same function body */
  const hoisted = [];
  for (const fm of matches(/^\s{2}([a-zA-Z_$][\w$]*)\s*:\s*function[^\n]*\{\n((?:\s{4}.*\n|\n)*)/gm, clean)) {
    /* Split on statement ends as well as newlines: two declarations on one
       line are still two statements, and a line-only split cannot see the
       second reading the first. */
    const fname = fm[1];
    const lines = fm[2].replace(/;/g, ';\n').split('\n');

    /* A parameter of a nested function is not a hoisted var, and a var
       declared inside a nested function belongs to that function, not this
       one. Ignoring both invents problems that cannot happen. */
    const params = new Set();
    for (const p of matches(/function\s*[\w$]*\s*\(([^)]*)\)/g, fm[2])) {
      p[1].split(',').map(x => x.trim()).filter(Boolean).forEach(x => params.add(x));
    }

    let depth = 0;
    const atDepth = lines.map(l => {
      const before = depth;
      depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
      return before;
    });

    const decl = {};
    lines.forEach((l, i) => {
      if (atDepth[i] !== 0) return;                 /* inside a nested scope */
      for (const d of matches(/\bvar\s+([a-zA-Z_$][\w$]*)\s*=/g, l)) {
        if (!(d[1] in decl) && !params.has(d[1])) decl[d[1]] = i;
      }
    });

    for (const [name, at] of Object.entries(decl)) {
      for (let i = 0; i < at; i++) {
        if (atDepth[i] !== 0) continue;
        if (new RegExp('\\bvar\\s+' + name + '\\b').test(lines[i])) break;
        if (new RegExp('(?<![.\\w$])' + name + '(?![\\w$:])').test(lines[i])) {
          hoisted.push(`${fname}(): ${name}`);
          break;
        }
      }
    }
  }
  if (hoisted.length) warn('used before declared', 'reads as undefined at that point rather than throwing, so the symptom appears far from the cause', hoisted.join(' | '));
  else note('used before declared', 'no var is read above its own declaration');
}

/* ------------------------------------------------------------------ *
 * layer 3 - hazards
 * ------------------------------------------------------------------ */

function checkHazards(html, body, js, clean) {
  layer('hazards');

  /* An inline handler built by string concatenation is safe only if what
     goes in is a literal. A name or free text can close the quote. */
  const risky = [];
  for (const m of matches(/\son[a-z]+="([^"]*)"/g, body)) {
    const body = m[1];
    if (/^[a-zA-Z_$][\w$.]*\((?:\s*|\s*-?\d+(?:\s*,\s*-?\d+)*\s*|this|event)\)\s*;?$/.test(body)) continue;
    risky.push(body.slice(0, 70));
  }
  /* A handler assembled from a string is only safe if what goes in cannot
     contain a quote. A numeric id is safe; a name, a company, anything a
     person typed is not - escaping it to &quot; does not help, because the
     browser decodes the entity before the script is parsed. */
  const interpolated = [];
  for (const m of matches(/on[a-z]+="([^"]*?)"/g, js)) {
    const inner = m[1];
    if (!/'\s*\+/.test(inner)) continue;
    for (const v of matches(/\+\s*([^+]+?)\s*\+/g, inner)) {
      const expr = v[1].trim();
      /* Provably a number: a literal, a numeric conversion, an index
         lookup, arithmetic, or an id-like property. Anything else could
         carry a quote, whatever it happens to hold today. */
      const safe = /^-?\d+(\.\d+)?$/.test(expr) ||
                   /^[\w$.]*\.(indexOf|lastIndexOf|length|size|count)\s*\(/.test(expr) ||
                   /\.(indexOf|lastIndexOf)\s*\(/.test(expr) ||
                   /^(parseInt|parseFloat|Number|Math\.\w+)\s*\(/.test(expr) ||
                   /^[\w$.]+\.(id|index|idx|seq|num|length)$/.test(expr) ||
                   /^[\w$.[\]]+\s*[-+*/]\s*\d+$/.test(expr) ||
                   /^(i|j|k|n|q|idx|index)$/.test(expr);
      if (!safe) interpolated.push(expr.slice(0, 60));
    }
  }
  const built = matches(/\son[a-z]+="[^"]*'\s*\+/g, js).length;
  if (interpolated.length) {
    fault('handler injection', 'an inline handler interpolates something other than a number — ' +
      'a quote in that value escapes the handler and the rest runs as code',
      uniq(interpolated).slice(0, 5).join(' | '));
  } else if (built) {
    note('handler injection', `${built} handlers built by concatenation, all interpolating numbers only`);
  }
  if (risky.length) note('inline handler', `${risky.length} static handler${risky.length === 1 ? '' : 's'} carry an expression`, risky.slice(0, 3).join(' | '));
  if (!risky.length && !built) note('inline handler', 'no inline handlers carry variable content');

  const raw = matches(/innerHTML\s*=\s*([^;]{0,80})/g, clean).length;
  const escapes = matches(/\besc\s*\(|escapeHtml|textContent\s*=/g, clean).length;
  if (raw && !escapes) fault('escaping', 'innerHTML is assigned but nothing looks like an escaping helper');
  else if (raw) note('escaping', `${raw} innerHTML assignments, ${escapes} escape or textContent uses alongside`);

  const store = uniq(matches(/(?:localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*['"]([^'"]+)['"]/g, js).map(m => m[1]));
  if (store.length) {
    const prefixes = uniq(store.map(k => (k.match(/^[a-z0-9]+[-_]/i) || [''])[0]));
    if (prefixes.length > 1 || prefixes[0] === '') {
      warn('storage keys', 'not consistently namespaced — two apps on one origin will collide', store.join(', '));
    } else note('storage keys', `${store.length} keys, all prefixed "${prefixes[0]}"`);
  }

  const guarded = matches(/try\s*\{[^}]*(?:localStorage|sessionStorage)/g, clean).length;
  const totalStore = matches(/(?:localStorage|sessionStorage)\.(?:set|remove)Item/g, clean).length;
  if (totalStore && guarded < 1) warn('storage failure', 'writes are not wrapped in try — a full or blocked store throws and can break a save');
  else if (totalStore) note('storage failure', 'storage writes are guarded');

  const ext = uniq(matches(/https?:\/\/[^\s"'`)]+/g, html)
    .map(m => m[0]).filter(u => !/w3\.org|schemas\.|purl\.org/.test(u)));
  if (ext.length) warn('external reference', 'an offline app should reach nothing on the network', ext.slice(0, 5).join(', '));
  else note('external reference', 'nothing is fetched from the network');

  /* listeners added inside a render will accumulate unless the element is
     replaced each time */
  const accum = [];
  for (const m of matches(/^\s{2}(render[\w$]*|refresh[\w$]*|update[\w$]*)\s*:\s*function[^\n]*\{\n((?:\s{4}.*\n|\n)*)/gm, clean)) {
    if (/addEventListener/.test(m[2]) && !/innerHTML\s*=\s*''|children\.length|createElement/.test(m[2])) {
      accum.push(m[1]);
    }
  }
  if (accum.length) warn('listener build up', 'adds listeners on every call without replacing the elements', accum.join(', '));
  else note('listener build up', 'no render adds listeners to elements it keeps');
}

/* ------------------------------------------------------------------ *
 * layer 4 - style sheet
 * ------------------------------------------------------------------ */

/* Perceived lightness, so a strong orange is not mistaken for a pale one
   merely because its hex begins with e or f. */
function luminance(hex) {
  if (/^white$/i.test(hex)) return 1;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return 0;
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/* Takes the body rather than the whole file: scanning the file would read
   class attributes inside script strings as if they were markup, which is
   how a fragment like "cls" ends up reported as a missing rule. */
function checkStyles(body, css, js) {
  /* A colour named for a background, used as text. Mapping one hex to one
     name is right until the same hex served two jobs - a bar behind white
     text and a heading beside it. Then the heading takes the bar's dark
     value after dark and disappears. */
  const backNames = ['page', 'surface', 'header', 'chip', 'page-soft',
                     'accent-pale', 'line', 'line-firm', 'panel', 'card', 'bg'];
  const wrongWay = [];
  for (const m of matches(/([^{}]+)\{([^}]*)\}/g, css)) {
    const sel = m[1].replace(/\s+/g, ' ').trim();
    if (sel.indexOf('@') === 0) continue;
    for (const c of matches(/(?<![-\w])color:var\(--([a-z-]+)\)/g, m[2])) {
      if (backNames.indexOf(c[1]) !== -1) wrongWay.push(sel.slice(0, 40) + ' -> ' + c[1]);
    }
  }
  if (wrongWay.length) {
    fault('text given a background colour',
      'a text colour named for a background takes the background\'s value in the other mode, and the text vanishes',
      uniq(wrongWay).slice(0, 4).join(' | '));
  } else note('text given a background colour', 'every text colour is named for text');


  layer('styles');
  if (!css) { note('stylesheet', 'no inline stylesheet found'); return; }

  const defined = uniq(matches(/\.([a-zA-Z][\w-]*)/g, css).map(m => m[1]));
  const usedMarkup = uniq(matches(/class="([^"]+)"/g, body).flatMap(m => m[1].split(/\s+/)));
  const usedScript = uniq(
    matches(/classList\.(?:add|remove|toggle|contains)\(\s*['"]([^'"]+)['"]/g, js).map(m => m[1])
      /* A class attribute assembled from parts yields fragments of source,
         not class names. Splitting one produces plausible-looking rubbish
         like "cls" that sends someone hunting for a rule that never
         existed, so take only the literal part before any concatenation. */
      .concat(matches(/class="([^"]+)"/g, js).flatMap(m => {
        /* leading concatenation counts too: class="' + cls + ' more" */
        const truncated = /['"+]/.test(m[1]);
        if (/^\s*['"]?\s*\+/.test(m[1])) return [];
        const names = m[1].split(/['"]|\s\+/)[0].split(/\s+/).filter(Boolean);
        /* the token adjoining a concatenation is half a name, so drop it */
        return truncated ? names.slice(0, -1) : names;
      }))
      .concat(matches(/className\s*=\s*['"]([^'"]+)['"]/g, js).flatMap(m => m[1].split(/\s+/)))
  );
  /* a class list built by concatenation yields fragments, not names */
  const looksLikeClass = c => /^[a-zA-Z][\w-]*$/.test(c);
  const used = uniq(usedMarkup.concat(usedScript)).filter(Boolean).filter(looksLikeClass);

  const selectorOnly = uniq(matches(/querySelector(?:All)?\(\s*['"]\.([\w-]+)/g, js).map(m => m[1]));
  const undefinedClasses = used.filter(c => !defined.includes(c) && !selectorOnly.includes(c));
  if (undefinedClasses.length) warn('unstyled class', 'applied but never defined in the stylesheet — usually a typo or a leftover', undefinedClasses.slice(0, 12).join(', '));
  else note('unstyled class', `${used.length} classes used, all defined or used only as selectors`);

  const unusedClasses = defined.filter(c => !used.includes(c));
  if (unusedClasses.length) note('unused rule', `${unusedClasses.length} defined but never applied`, unusedClasses.slice(0, 12).join(', '));

  /* dark mode: a rule that sets a light background needs a counterpart */
  const darkSel = /(?:body\.(?:night|dark)|@media\s*\(prefers-color-scheme:\s*dark\))/;
  if (darkSel.test(css)) {
    /* Gathered as rule blocks. Taking whole lines means a minified or
       single-line stylesheet counts every rule on that line as dark, and
       the check silently passes everything. */
    const darkPart = matches(/([^{}]+)\{([^}]*)\}/g, css)
      .filter(m => darkSel.test(m[1]))
      .map(m => m[1]).join('\n');
    const gaps = [];
    for (const m of matches(/\.([a-zA-Z][\w-]*)[^{}]*\{([^}]*)\}/g, css)) {
      const cls = m[1], rule = m[2];
      if (darkSel.test(m[0].split('{')[0])) continue;
      const bg = (rule.match(/background(?:-color)?:\s*(#[0-9a-f]{3,6}|white)/i) || [])[1];
      const light = bg ? luminance(bg) > 0.75 : false;
      if (light && !new RegExp('\\.' + cls + '\\b').test(darkPart)) gaps.push(cls);
    }
    const real = uniq(gaps).filter(c => used.includes(c));
    if (real.length) warn('dark mode gap', 'a light background with no dark counterpart', real.slice(0, 12).join(', '));
    else note('dark mode gap', 'every light surface has a dark counterpart');
  }
}

/* ------------------------------------------------------------------ *
 * layer 6 - reachable by everyone
 * ------------------------------------------------------------------ */

function contrast(fg, bg) {
  const chan = hex => {
    let h = String(hex).replace('#', '');
    if (/^white$/i.test(hex)) h = 'ffffff';
    if (/^black$/i.test(hex)) h = '000000';
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return null;
    return [0, 2, 4].map(i => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
  };
  const a = chan(fg), b = chan(bg);
  if (!a || !b) return null;
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b));
  return (l1 + 0.05) / (l2 + 0.05);
}

function checkAccess(body, css, js) {
  layer('reach');

  const imgs = matches(/<img\b([^>]*)>/g, body);
  const noAlt = imgs.filter(m => !/\balt=/.test(m[1]));
  if (noAlt.length) warn('image text', `${noAlt.length} image${noAlt.length === 1 ? '' : 's'} with no alt, so a screen reader announces the file name or nothing`);
  else if (imgs.length) note('image text', `${imgs.length} images, all with alt`);

  /* A button whose only content is an icon has no name unless one is given. */
  const nameless = [];
  for (const m of matches(/<button\b([^>]*)>([\s\S]*?)<\/button>/g, body)) {
    const attrs = m[1], inner = m[2];
    const text = inner.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').trim();
    if (text) continue;
    if (/aria-label=|aria-labelledby=|\btitle=/.test(attrs)) continue;
    nameless.push((attrs.match(/id="([^"]+)"/) || [, '?'])[1]);
  }
  if (nameless.length) fault('button name', 'a button with no text and no label is announced as just "button"', nameless.join(', '));
  else note('button name', 'every button has text or a label');

  const ids = uniq(matches(/\sid="([^"]+)"/g, body).map(m => m[1]));
  const controls = uniq(matches(/aria-controls="([^"]+)"/g, body).map(m => m[1]));
  const brokenAria = controls.filter(c => !ids.includes(c));
  if (brokenAria.length) warn('aria target', 'aria-controls names an element that does not exist', brokenAria.join(', '));
  else if (controls.length) note('aria target', `${controls.length} aria-controls, all resolve`);

  /* An input with no label is a box a screen reader cannot describe. */
  const labelled = new Set(matches(/<label[^>]*\sfor="([^"]+)"/g, body).map(m => m[1]));
  /* A label may wrap its field rather than name it, which is equally valid
     and much commoner for checkboxes. */
  const wrapped = new Set();
  for (const m of matches(/<label\b[^>]*>([\s\S]*?)<\/label>/g, body)) {
    for (const f of matches(/<(?:input|select|textarea)\b[^>]*id="([^"]+)"/g, m[1])) wrapped.add(f[1]);
  }
  const bare = [];
  for (const m of matches(/<(input|select|textarea)\b([^>]*)>/g, body)) {
    const attrs = m[2];
    if (/type="(hidden|submit|button)"/.test(attrs)) continue;
    if (/display\s*:\s*none/.test(attrs)) continue;   /* not offered to anyone */
    const id = (attrs.match(/id="([^"]+)"/) || [])[1];
    if (id && (labelled.has(id) || wrapped.has(id))) continue;
    if (/aria-label=|aria-labelledby=|\btitle=|placeholder=/.test(attrs)) continue;
    bare.push(id || '<' + m[1] + '>');
  }
  if (bare.length) warn('unlabelled field', 'no label, aria-label or title, so its purpose is not announced', bare.slice(0, 8).join(', '));
  else note('unlabelled field', 'every field is labelled');

  /* Heading levels that jump make a document hard to navigate by structure. */
  const levels = matches(/<h([1-6])\b/g, body).map(m => Number(m[1]));
  const jumps = [];
  for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) jumps.push('h' + levels[i - 1] + ' to h' + levels[i]);
  if (jumps.length) note('heading order', `${jumps.length} jump${jumps.length === 1 ? '' : 's'} in heading level`, uniq(jumps).join(', '));
  else if (levels.length) note('heading order', `${levels.length} headings, no levels skipped`);

  /* Contrast, where a rule sets both colours so no inheritance is guessed. */
  const poor = [];
  for (const m of matches(/([^{}]+)\{([^}]*)\}/g, css)) {
    const sel = m[1].trim(), rule = m[2];
    const fg = (rule.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{3,6}|white|black)/i) || [])[1];
    const bg = (rule.match(/background(?:-color)?:\s*(#[0-9a-f]{3,6}|white|black)/i) || [])[1];
    if (!fg || !bg) continue;
    const r = contrast(fg, bg);
    if (r !== null && r < 4.5) {
      const big = /font-size:\s*(1\.[2-9]|[2-9])/.test(rule);
      if (!(big && r >= 3)) poor.push(`${sel.slice(0, 34)} ${fg} on ${bg} = ${r.toFixed(1)}:1`);
    }
  }
  if (poor.length) warn('contrast', 'below 4.5:1, which is hard to read in daylight or on a cheap screen', poor.slice(0, 6).join(' | '));
  else note('contrast', 'every rule setting both colours reaches 4.5:1');

  /* A tap target much under 44px is hard to hit accurately. */
  const small = [];
  for (const m of matches(/([^{}]+)\{([^}]*)\}/g, css)) {
    const sel = m[1].trim(), rule = m[2];
    if (!/^[.#]?[\w.\-\s>]*(btn|button|tab|swatch|chip|pick)/i.test(sel)) continue;
    const pad = (rule.match(/padding:\s*([\d.]+)rem/) || [])[1];
    const h = (rule.match(/height:\s*([\d.]+)rem/) || [])[1];
    if (h && Number(h) * 16 < 30) small.push(`${sel.slice(0, 28)} height ${h}rem`);
    else if (pad && Number(pad) * 16 * 2 + 16 < 30) small.push(`${sel.slice(0, 28)} padding ${pad}rem`);
  }
  if (small.length) note('tap target', 'smaller than a comfortable finger target', uniq(small).slice(0, 5).join(' | '));
  else note('tap target', 'interactive rules are large enough to hit');
}

/* ------------------------------------------------------------------ *
 * layer 7 - the same thing written twice
 * ------------------------------------------------------------------ */

function checkDuplication(clean, body, raw) {
  layer('duplication');

  /* Building the same feature twice is easy over a long session and very
     hard to spot by reading: both copies work, both are wired up, and the
     second silently wins wherever they collide. */
  const bodies = new Map();
  for (const m of matches(/^\s{2}([a-zA-Z_$][\w$]*)\s*:\s*function[^\n]*\{\n((?:\s{4}.*\n|\n)*)/gm, clean)) {
    const name = m[1];
    const norm = m[2].replace(/\s+/g, ' ').trim();
    if (norm.length < 200) continue;
    /* compare shape rather than exact text, so renamed copies still match */
    const shape = norm.replace(/\b[a-zA-Z_$][\w$]*\b/g, 'x').replace(/\d+/g, '0');
    if (!bodies.has(shape)) bodies.set(shape, []);
    bodies.get(shape).push(name);
  }
  const stem = n => n.replace(/^(get|set|render|show|hide|add|edit|delete|remove|save|clear|open|close|apply|build)/, '');
  const twins = [...bodies.values()].filter(v => v.length > 1);
  /* The same shape across edit/delete pairs is ordinary parallel work. The
     same shape under unrelated names is the shape of a feature written
     twice, which is the one worth interrupting for. */
  /* edit/edit or delete/delete is parallel work; the verbs match. Two
     different verbs, or none, is the shape of a feature written twice. */
  const parallel = twins.filter(t => {
    const verbs = uniq(t.map(n => n.replace(stem(n), '')));
    return verbs.length === 1 && verbs[0] !== '';
  });
  const suspect = twins.filter(t => !parallel.includes(t));
  if (suspect.length) {
    warn('duplicate logic', 'the same shape under unrelated names — check one is not a second implementation of the other',
      suspect.map(t => t.join(' / ')).join(' | '));
  }
  if (parallel.length) note('duplicate logic', `${parallel.length} set${parallel.length === 1 ? '' : 's'} of parallel functions share a shape, which is expected of edit and delete pairs`,
    parallel.map(t => t.join(' / ')).slice(0, 4).join(' | '));
  if (!twins.length) note('duplicate logic', 'no two functions share a body shape');

  /* The same list written out twice is the quietest of these. Both copies
     look right, both are used, and the day one gains an entry the other
     does not, something goes silently unreachable. It has happened here
     with tab groups, time fields and week helpers - each time noticed only
     when a feature turned out to be dead. */
  const lists = [];
  for (const m of matches(/\[\s*((?:['"][\w$ .-]{1,50}['"]\s*,\s*){2,}['"][\w$ .-]{1,50}['"])\s*,?\s*\]/g, raw)) {
    const items = matches(/['"]([\w$ .-]+)['"]/g, m[1]).map(x => x[1]);
    if (items.length < 3) continue;
    lists.push({ items, set: new Set(items), at: m.index });
  }

  const twinned = [];
  for (let a = 0; a < lists.length; a++) {
    for (let b = a + 1; b < lists.length; b++) {
      const A = lists[a], B = lists[b];
      let shared = 0;
      for (const x of A.set) if (B.set.has(x)) shared++;
      if (shared < 3) continue;
      const smaller = Math.min(A.set.size, B.set.size);
      if (shared / smaller < 0.85) continue;
      if (A.set.size === B.set.size && shared === smaller) {
        twinned.push('the same ' + shared + ' names listed twice: ' + [...A.set].slice(0, 4).join(', '));
      } else {
        const extra = A.set.size > B.set.size
          ? [...A.set].filter(x => !B.set.has(x)) : [...B.set].filter(x => !A.set.has(x));
        twinned.push('two lists of the same thing, one missing ' + extra.join(', '));
      }
    }
  }
  if (twinned.length) {
    warn('list written twice', 'one will gain an entry the other does not, and something will go quietly unreachable',
      uniq(twinned).slice(0, 4).join(' | '));
  } else note('list written twice', 'no list of names is duplicated');

  /* Two controls that do the same job usually means one was meant to
     replace the other and the first was never removed. */
  const handlers = matches(/getElementById\('([^']+)'\)\.addEventListener\('click',\s*function[^{]*\{\s*([^;]{5,70});/g, clean);
  const byAction = new Map();
  for (const m of handlers) {
    const action = m[2].replace(/\s+/g, ' ').trim();
    if (!byAction.has(action)) byAction.set(action, []);
    byAction.get(action).push(m[1]);
  }
  const sameJob = [...byAction.entries()].filter(([, ids]) => ids.length > 1);
  if (sameJob.length) {
    note('duplicate control', 'more than one control runs the same thing — deliberate, or a leftover',
      sameJob.map(([a, ids]) => ids.join(' and ') + ' both ' + a.slice(0, 40)).join(' | '));
  } else note('duplicate control', 'no two controls run the same action');

  /* A long run of markup repeated verbatim is usually copy-paste that
     should have been generated. */
  const chunks = new Map();
  const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 40);
  for (let i = 0; i + 4 < lines.length; i++) {
    const block = lines.slice(i, i + 5).join('\n');
    chunks.set(block, (chunks.get(block) || 0) + 1);
  }
  const repeated = [...chunks.entries()].filter(([, n]) => n > 1);
  if (repeated.length) note('repeated markup', `${repeated.length} block${repeated.length === 1 ? '' : 's'} of five or more identical lines`);
  else note('repeated markup', 'no long run of markup is repeated verbatim');
}

/* ------------------------------------------------------------------ *
 * layer 8 - patterns that bite later
 * ------------------------------------------------------------------ */

function checkPatterns(clean) {
  layer('patterns');

  const radix = matches(/parseInt\s*\(([^,()]|\([^)]*\))*\)/g, clean)
    .filter(m => !/,\s*\d+\s*\)$/.test(m[0]));
  if (radix.length) warn('parseInt radix', `${radix.length} call${radix.length === 1 ? '' : 's'} with no radix — a leading zero can be read as octal on older engines`,
    uniq(radix.map(m => m[0].slice(0, 40))).slice(0, 4).join(' | '));
  else note('parseInt radix', 'every parseInt states its radix');

  /* == against anything but null coerces, and the surprise is silent. */
  const loose = matches(/[^=!<>]=[=](?!=)\s*([^\s;)]+)/g, clean)
    .filter(m => !/^null\b/.test(m[1]) && !/^undefined\b/.test(m[1]));
  if (loose.length) warn('loose equality', `${loose.length} use${loose.length === 1 ? '' : 's'} of == against something other than null — "0" == 0 and "" == false`,
    uniq(loose.map(m => m[0].trim().slice(0, 30))).slice(0, 5).join(' | '));
  else note('loose equality', 'no == except against null');

  const assignIf = matches(/\bif\s*\(\s*[\w$.[\]]+\s*=(?![=>])/g, clean);
  if (assignIf.length) fault('assignment in a test', 'assigns rather than compares, so the branch is always taken', assignIf.map(m => m[0].slice(0, 40)).join(' | '));
  else note('assignment in a test', 'no condition assigns');

  const forIn = matches(/for\s*\(\s*var\s+\w+\s+in\s+([\w$.]+)\s*\)/g, clean)
    .filter(m => /\b(list|items|rows|array|arr|entries|records|shifts|visitors|all)\b/i.test(m[1]));
  if (forIn.length) warn('for in over a list', 'walks inherited keys and gives strings, not indices', uniq(forIn.map(m => m[1])).join(', '));
  else note('for in over a list', 'no for-in over anything list shaped');

  /* Looking an element up on every pass costs a search each time. */
  const inLoop = [];
  for (const m of matches(/\bfor\s*\([^)]*\)\s*\{([\s\S]{0,600}?)\n\s*\}/g, clean)) {
    const q = matches(/(getElementById|querySelector(?:All)?)\s*\(/g, m[1]);
    if (q.length) inLoop.push(q[0][1] + ' x' + q.length);
  }
  if (inLoop.length) note('lookup in a loop', `${inLoop.length} loop${inLoop.length === 1 ? '' : 's'} search the document on every pass`, uniq(inLoop).slice(0, 4).join(', '));
  else note('lookup in a loop', 'no loop searches the document repeatedly');

  const bigFns = [];
  for (const m of matches(/^\s{2}([a-zA-Z_$][\w$]*)\s*:\s*function[^\n]*\{\n((?:\s{4}.*\n|\n)*)/gm, clean)) {
    const n = m[2].split('\n').filter(l => l.trim()).length;
    if (n > 120) bigFns.push(m[1] + ' ' + n + ' lines');
  }
  if (bigFns.length) note('long function', 'hard to hold in your head, and where duplicated logic hides', bigFns.slice(0, 5).join(', '));
  else note('long function', 'no function runs past 120 lines');
}

/* ------------------------------------------------------------------ *
 * layer 9 - things that quietly drift apart
 * ------------------------------------------------------------------ */

function checkDrift(html, clean, js, swSrc) {
  layer('drift');

  /* A setting written but never read does nothing; read but never written
     never takes effect. Both look like working code. */
  const written = uniq(matches(/(?:localStorage|sessionStorage)\.setItem\(\s*['"]([^'"]+)['"]/g, clean).map(m => m[1]));
  const read = uniq(matches(/(?:localStorage|sessionStorage)\.getItem\(\s*['"]([^'"]+)['"]/g, clean).map(m => m[1]));
  const writeOnly = written.filter(k => !read.includes(k));
  const readOnly = read.filter(k => !written.includes(k));
  if (writeOnly.length) warn('write only setting', 'saved but never read back, so changing it has no effect', writeOnly.join(', '));
  if (readOnly.length) warn('read only setting', 'read but never written, so it can only ever be the default', readOnly.join(', '));
  if (!writeOnly.length && !readOnly.length && written.length) note('setting round trip', `${written.length} stored keys, each both written and read`);

  /* A class the code toggles should exist in the markup or be added by the
     code, not assumed. The reverse - markup carrying state the code also
     manages - is how an opening view and its handler drift apart. */
  const toggled = uniq(matches(/classList\.(?:add|remove|toggle)\(\s*['"]([\w-]+)['"]/g, clean).map(m => m[1]));
  const inMarkup = uniq(matches(/class="([^"]+)"/g, html).flatMap(m => m[1].split(/\s+/)));
  const both = toggled.filter(c => inMarkup.includes(c) && /^(active|open|on|selected|current|shown)$/.test(c));
  if (both.length) note('state in two places', 'a state class is set in the markup and also managed in code — make sure the code states the opening view rather than trusting the markup', both.join(', '));
  else note('state in two places', 'no state class is fixed in the markup and toggled in code');

  /* A version stamp exists to be checked. Several that disagree are worse
     than none, because one of them is trusted. */
  const stamps = uniq(matches(/(?:BUILD|VERSION|CACHE_VERSION|APP_VERSION)\s*[:=]\s*['"]([^'"]+)['"]/g, js + '\n' + (swSrc || '')).map(m => m[1]));
  if (stamps.length > 1) fault('version stamp', 'more than one version string, and they disagree', stamps.join(' vs '));
  else if (stamps.length) note('version stamp', `one version throughout: ${stamps[0]}`);

  /* toLocaleDateString with no locale renders differently per device, so a
     sheet printed in one place does not match one printed in another. */
  /* Read from the raw source, not the blanked copy: blanking removes the
     string argument, so a call that names a locale looks like one that
     does not. Any check that cares about a literal must see the original. */
  const bareLocale = matches(/toLocale(?:Date|Time|)String\s*\(\s*\)/g, js);
  if (bareLocale.length) warn('device locale', `${bareLocale.length} date or number formatted with no locale, so output varies by device`);
  else note('device locale', 'no locale-dependent formatting is left to the device');

  /* Adding milliseconds to a date walks straight through a clock change. */
  const msMath = matches(/getTime\s*\(\s*\)\s*\+\s*[\w$.]+\s*\*\s*(?:60000|3600000|86400000)/g, clean);
  if (msMath.length) warn('clock change', 'a time built by adding milliseconds to a date is an hour out on the two nights a year the clocks move', msMath[0][0].slice(0, 50));
  else note('clock change', 'no time is built by adding milliseconds to a date');
}

/* ------------------------------------------------------------------ *
 * layer 10 - fields, on a phone
 * ------------------------------------------------------------------ */

function checkInputs(body) {
  layer('fields');

  const fields = matches(/<input\b([^>]*)>/g, body).map(m => m[1]);
  const kind = a => (a.match(/type="([^"]+)"/) || [, 'text'])[1];
  const idOf = a => (a.match(/id="([^"]+)"/) || [, '?'])[1];

  /* Free text with no ceiling is a record that can grow until storage
     fills, and one long paste can push a table off the page. */
  const unbounded = fields.filter(a => /^(text|search|tel|url|email)$/.test(kind(a)) && !/maxlength=/i.test(a));
  if (unbounded.length) warn('unbounded text', `${unbounded.length} text field${unbounded.length === 1 ? '' : 's'} with no maxlength`,
    unbounded.map(idOf).slice(0, 8).join(', '));
  else if (fields.length) note('unbounded text', 'every text field has a maxlength');

  /* A number field with no bounds accepts anything typed, including
     values that break the arithmetic downstream. */
  const loose = fields.filter(a => kind(a) === 'number' && !(/\bmin=/.test(a) && /\bmax=/.test(a)));
  if (loose.length) warn('unbounded number', 'a number field with no min and max takes whatever is typed', loose.map(idOf).join(', '));
  else note('unbounded number', 'every number field states its range');

  /* On a phone the wrong keyboard is a real cost: a number field without
     inputmode can open a full qwerty. */
  const noMode = fields.filter(a => kind(a) === 'number' && !/inputmode=/.test(a));
  if (noMode.length) note('keyboard', 'a number field with no inputmode may open the letter keyboard', noMode.map(idOf).join(', '));
  else note('keyboard', 'number fields ask for the right keyboard');

  /* A placeholder disappears the moment anything is typed, so it cannot
     be the only thing telling you what the field is. */
  const placeholderOnly = [];
  const labelled = new Set(matches(/<label[^>]*\sfor="([^"]+)"/g, body).map(m => m[1]));
  const wrapped = new Set();
  for (const m of matches(/<label\b[^>]*>([\s\S]*?)<\/label>/g, body)) {
    for (const f of matches(/id="([^"]+)"/g, m[1])) wrapped.add(f[1]);
  }
  for (const a of fields) {
    if (!/placeholder=/.test(a)) continue;
    const id = idOf(a);
    if (labelled.has(id) || wrapped.has(id) || /aria-label=/.test(a)) continue;
    placeholderOnly.push(id);
  }
  if (placeholderOnly.length) warn('placeholder as label', 'the only description vanishes as soon as the field is filled', placeholderOnly.join(', '));
  else note('placeholder as label', 'no field relies on its placeholder alone');
}

/* ------------------------------------------------------------------ *
 * layer 11 - failing without saying so
 * ------------------------------------------------------------------ */

function checkFailure(clean, js) {
  layer('failure');

  /* An empty catch turns a fault into wrong behaviour with no symptom.
     Sometimes that is deliberate - a storage write that may be blocked -
     but each one is a decision that should have been made on purpose. */
  /* Guarding a call that is genuinely allowed to fail - storage that may be
     blocked, a caret position, a hash the host will not hand over - is
     deliberate. Counting those alongside the rest buries the ones that are
     actually hiding something, which is the opposite of useful. */
  const DELIBERATE = /localStorage|sessionStorage|indexedDB|IDB|selectionStart|setSelectionRange|location\.hash|matchMedia|JSON\.parse/i;
  let guarded = 0;
  const hiding = [];
  for (const m of matches(/try\s*\{([\s\S]{0,900}?)\}\s*catch\s*\([^)]*\)\s*\{\s*\}/g, clean)) {
    if (DELIBERATE.test(m[1])) guarded++;
    else hiding.push(m[1].replace(/\s+/g, ' ').trim().slice(0, 54));
  }
  if (hiding.length) warn('silent catch', `${hiding.length} catch block${hiding.length === 1 ? '' : 's'} discard an error from something expected to work — the fault becomes wrong behaviour with no symptom`, hiding.slice(0, 4).join(' | '));
  if (guarded) note('silent catch', `${guarded} empty catches guard calls allowed to fail, which is deliberate`);
  if (!guarded && !hiding.length) note('silent catch', 'no catch discards its error');

  /* A catch that only logs tells the developer and not the user, who is
     left looking at a control that appears to have done nothing. */
  const logOnly = matches(/catch\s*\([^)]*\)\s*\{\s*console\.\w+\([^)]*\);?\s*\}/g, clean);
  if (logOnly.length) warn('logged not shown', `${logOnly.length} catch block${logOnly.length === 1 ? '' : 's'} only log — the person using it sees nothing happen`);
  else note('logged not shown', 'no catch reports only to the console');

  const thens = matches(/\.then\s*\(/g, clean).length;
  const catches = matches(/\.catch\s*\(/g, clean).length;
  if (thens && catches === 0) warn('unhandled promise', `${thens} then() with no catch anywhere — a rejection is lost`);
  else if (thens) note('unhandled promise', `${thens} then, ${catches} catch`);

  /* console left in shipped code is noise at best and a leak at worst. */
  const logs = matches(/console\.(log|debug|info)\s*\(/g, clean).length;
  if (logs > 3) note('console output', `${logs} console calls remain in the shipped file`);
  else note('console output', logs ? `${logs} console calls` : 'no console output');

  /* alert and confirm block everything; confirm before a destructive act
     is right, but alert as a way of telling someone something is not. */
  const alerts = matches(/(?:^|[^.\w])alert\s*\(/g, clean).length;
  if (alerts) warn('blocking alert', `${alerts} alert${alerts === 1 ? '' : 's'} — blocks the page and cannot be styled or dismissed by anything else`);
  else note('blocking alert', 'nothing uses alert');
}

/* ------------------------------------------------------------------ *
 * layer 12 - the same words in several places
 * ------------------------------------------------------------------ */

function checkCopy(js, body) {
  layer('copy');

  /* A phrase written out in several places is a phrase that will be
     renamed in some of them and not the others. */
  const strings = matches(/['"]([A-Z][a-z][^'"]{12,60})['"]/g, js).map(m => m[1]);
  const counts = new Map();
  for (const t of strings) counts.set(t, (counts.get(t) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n >= 3);
  if (repeated.length) note('repeated wording', `${repeated.length} phrase${repeated.length === 1 ? '' : 's'} written out three or more times — renaming one means finding them all`,
    repeated.slice(0, 4).map(([t, n]) => `"${t.slice(0, 32)}" x${n}`).join(' | '));
  else note('repeated wording', 'no user facing phrase is written out three or more times');

  /* A heading in the markup that the script also writes is two sources for
     one piece of text. */
  const headings = uniq(matches(/<h[1-6][^>]*>([^<]{4,40})<\/h[1-6]>/g, body).map(m => m[1].trim()));
  const alsoInJs = headings.filter(t => new RegExp("['\"`]" + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"`]").test(js));
  if (alsoInJs.length) note('heading in two places', 'a heading is written in the markup and again in the script', alsoInJs.slice(0, 5).join(', '));
  else note('heading in two places', 'no heading is written twice');
}

/* ------------------------------------------------------------------ *
 * layer 13 - what could leave the device
 * ------------------------------------------------------------------ */

function checkContainment(html, clean, extras) {
  layer('containment');

  /* For an app meant to work with no network, every one of these is a way
     for records to leave the device, deliberately or otherwise. */
  const ways = [
    [/\bfetch\s*\(/g, 'fetch'],
    [/new\s+XMLHttpRequest/g, 'XMLHttpRequest'],
    [/navigator\.sendBeacon/g, 'sendBeacon'],
    [/new\s+WebSocket/g, 'WebSocket'],
    [/new\s+EventSource/g, 'EventSource'],
    [/navigator\.share\s*\(/g, 'navigator.share'],
    [/navigator\.geolocation/g, 'geolocation']
  ];
  const found = ways.map(([re, name]) => [name, matches(re, clean).length]).filter(x => x[1]);
  if (found.length) warn('outbound channel', 'a way for data to leave the device — deliberate or not, it should be a decision',
    found.map(([n, c]) => n + ' x' + c).join(', '));
  else note('outbound channel', 'nothing here can send data anywhere');

  const forms = matches(/<form\b([^>]*)>/g, html).filter(m => /\saction=/.test(m[1]));
  if (forms.length) fault('form action', 'a form with an action posts somewhere when submitted', forms[0][1].slice(0, 60));
  else note('form action', 'no form posts anywhere');

  const remote = matches(/<(?:img|script|link|iframe|source)\b[^>]*(?:src|href)="(https?:)?\/\/[^"]*"/g, html);
  if (remote.length) fault('remote asset', 'loaded across the network, so the app does not work offline and the request is visible', remote[0][0].slice(0, 70));
  else note('remote asset', 'every asset is local');

  const blank = matches(/<a\b[^>]*target="_blank"[^>]*>/g, html).filter(m => !/rel="[^"]*noopener/.test(m[0]));
  if (blank.length) warn('window opener', 'target="_blank" without rel="noopener" hands the new page a reference back to this one');
  else note('window opener', 'no link opens without noopener');

  const dynamic = matches(/\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"]/g, clean);
  if (dynamic.length) fault('code from a string', 'eval, new Function or a timer given a string runs whatever it is handed', dynamic.map(m => m[0].trim()).join(', '));
  else note('code from a string', 'nothing turns a string into code');

  const jsUrl = matches(/(?:href|src)="javascript:/g, html);
  if (jsUrl.length) fault('javascript url', 'a javascript: url is code in an attribute');
  else note('javascript url', 'no javascript: urls');

  /* Android backs app data up to the cloud unless told not to, which for
     an app whose point is that records stay on site is an exfiltration
     path nobody asked for. */
  for (const [name, src] of extras) {
    if (!/\.(yml|yaml|xml|gradle)$/i.test(name)) continue;
    /* A build script names the setting twice: once as the thing to find
       and once as the value to write. What matters is whether anything
       sets it false, not whether the word "true" appears. */
    const setsFalse = /allowBackup\s*=\s*\\?["']?false/.test(src);
    const setsTrue = /allowBackup\s*=\s*\\?["']?true/.test(src);
    if (setsFalse) {
      note('cloud backup', `${path.basename(name)} turns android auto backup off`);
    } else if (setsTrue) {
      fault('cloud backup', `${path.basename(name)} leaves android auto backup on, so records are copied to the user's cloud`);
    } else if (/AndroidManifest|capacitor|cordova|bubblewrap/i.test(src)) {
      warn('cloud backup', `${path.basename(name)} builds an android app without setting allowBackup, and the default is on`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * layer 14 - numbers and timers
 * ------------------------------------------------------------------ */

function checkConstants(clean) {
  layer('constants');

  /* A number written out in many places is a number that will be changed
     in some of them. Column widths that must sum to a page width are the
     classic: change one, forget another, and the table runs off the edge. */
  const ordinary = new Set([0, 1, 2, 3, 4, 5, 10, 12, 24, 30, 31, 50, 60, 100, 255, 360, 365, 1000, 1440, 60000, 86400000]);
  const seen = new Map();
  for (const m of matches(/(?<![\w$.])(\d{2,5})(?![\w$.])/g, clean)) {
    const v = Number(m[1]);
    if (ordinary.has(v)) continue;
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]);
  if (repeated.length) note('repeated number', 'written out many times rather than named once — change one and the others drift',
    repeated.slice(0, 5).map(([v, n]) => v + ' x' + n).join(', '));
  else note('repeated number', 'no bare number is repeated six or more times');

  /* An interval with no handle can never be stopped, so it keeps running
     after whatever wanted it has gone. */
  const intervals = matches(/setInterval\s*\(/g, clean).length;
  const cleared = matches(/clearInterval\s*\(/g, clean).length;
  const held = matches(/(?:var|let|const|this\.[\w$]+)\s*=\s*setInterval/g, clean).length;
  if (intervals && !cleared && !held) warn('timer left running', `${intervals} setInterval with no handle kept and no clearInterval — it cannot be stopped`);
  else if (intervals) note('timer left running', `${intervals} interval${intervals === 1 ? '' : 's'}, ${held} with a handle kept, ${cleared} cleared`);
  else note('timer left running', 'no repeating timers');

  /* A magic string used as a key in several places has the same problem
     as a magic number, and renaming it is worse because it is silent. */
  const keys = matches(/(?:getItem|setItem|removeItem)\(\s*['"]([^'"]+)['"]/g, clean).map(m => m[1]);
  const inline = keys.filter((v, i) => keys.indexOf(v) !== i);
  if (uniq(inline).length > 3) note('key written out', `${uniq(inline).length} storage keys written out more than once rather than named`, uniq(inline).slice(0, 5).join(', '));
  else note('key written out', 'storage keys are not repeated much');
}

/* ------------------------------------------------------------------ *
 * layer 15 - lists of element names, and families of elements
 * ------------------------------------------------------------------ */

/* Three separate checks in this file grew out of the same mistake made in
   three places: a list in the script naming elements, and the markup
   drifting away from it. Enumerating each case by hand means the next one
   goes unnoticed until something is dead for months, so this looks for the
   shape rather than the instances. */
function checkRegisters(body, js, clean) {
  layer('registers');

  const ids = new Set(matches(/\sid="([^"]+)"/g, body).map(m => m[1]));
  if (!ids.size) { note('name lists', 'no ids to check against'); return; }

  /* A list where most entries are element names is a list of element
     names, and the odd one out is almost always a rename that was not
     carried through. */
  const broken = [];
  for (const m of matches(/\[\s*((?:['"][\w$-]{2,40}['"]\s*,\s*){2,}['"][\w$-]{2,40}['"])\s*,?\s*\]/g, js)) {
    const items = matches(/['"]([\w$-]+)['"]/g, m[1]).map(x => x[1]);
    /* A list holding a key and the two fields it names - ['shift',
       'shiftStart', 'shiftEnd'] - is an ordinary pattern, not a list of
       ids with one wrong. Only a list that is almost entirely element
       names says anything about the one that is not. */
    const known = items.filter(i => ids.has(i));
    if (known.length < 4 || known.length / items.length < 0.85) continue;
    const strays = items.filter(i => !ids.has(i));
    if (strays.length) broken.push(strays.join(', ') + ' (in a list of ' + items.length + ')');
  }
  if (broken.length) fault('name lists', 'a list of element names contains one the page does not have', uniq(broken).slice(0, 4).join(' | '));
  else note('name lists', 'every list of element names resolves');

  /* The important family is the one built by concatenation: getElementById
     ('fold_' + slug). Those ids never appear whole in the source, so
     looking for literals finds nothing and the check quietly passes on a
     file where half the sections are unreachable. Find the prefixes
     instead, then hold the markup and the list to each other. */
  /* Read from the raw source. The de-stringed copy has had every literal
     taken out of it, so looking for string content there finds nothing and
     the whole check passes on a file it never examined. */
  const prefixes = uniq(matches(/['"]([a-zA-Z][\w-]{1,20}[_-])['"]\s*\+/g, js).map(m => m[1])
    .concat(matches(/['"]([a-z]{2,10})['"]\s*\+\s*[\w$.]+\s*\)/g, js).map(m => m[1])));

  const drifted = [];
  const strandedMembers = [];
  for (const pre of prefixes) {
    const members = [...ids].filter(id => id.indexOf(pre) === 0 && id.length > pre.length);
    if (members.length < 3) continue;
    const tails = members.map(id => id.slice(pre.length));

    /* every tail should be named somewhere, or that element is drawn and
       driven by nothing */
    const unnamed = tails.filter(t => !new RegExp("['\"`]" + t + "['\"`]").test(js));
    if (unnamed.length && unnamed.length < tails.length) {
      strandedMembers.push(pre + '{' + unnamed.join(', ') + '}');
    }

    /* and every name in a list of tails should have its element, or the
       lookup returns nothing at run time */
    for (const m of matches(/\[\s*((?:['"][\w$-]{2,40}['"]\s*,\s*){2,}['"][\w$-]{2,40}['"])\s*,?\s*\]/g, js)) {
      const items = matches(/['"]([\w$-]+)['"]/g, m[1]).map(x => x[1]);
      /* A list is often used with more than one prefix, and not every
         member needs every one - a time field may have no Now button.
         Only the odd one out matters, so require nearly all of them to
         have the element before calling the remainder a fault. */
      const hit = items.filter(i => tails.includes(i));
      if (hit.length < 3 || hit.length / items.length < 0.85) continue;
      const missing = items.filter(i => !tails.includes(i));
      if (missing.length) drifted.push(pre + missing.join(', ' + pre));
    }
  }

  if (strandedMembers.length) {
    fault('element nothing drives', 'drawn in the markup and named nowhere, while its siblings are — it cannot be reached',
      uniq(strandedMembers).slice(0, 4).join(' | '));
  } else note('element nothing drives', 'every member of a built-id family is named');

  if (drifted.length) {
    fault('name with no element', 'named in a list alongside real ones, but the page has no such element',
      uniq(drifted).slice(0, 4).join(' | '));
  } else note('name with no element', 'every name in a list has its element');
}

/* ------------------------------------------------------------------ *
 * layer 5 - progressive web app
 * ------------------------------------------------------------------ */

function checkPwa(html, js, dir, swPath, manifestPath) {
  layer('pwa');

  let sw = null, manifest = null;
  if (swPath && fs.existsSync(swPath)) sw = fs.readFileSync(swPath, 'utf8');
  if (manifestPath && fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { fault('manifest', 'is not valid JSON, so the app will not install', e.message); }
  }
  if (!sw && !manifest) { note('pwa', 'no service worker or manifest alongside'); return; }

  if (sw) {
    const listed = matches(/'([^']+\.(?:html|js|css|png|ico|json|svg|webmanifest))'/g, sw).map(m => m[1]);
    /* A tool's own output is not part of the app. Counting it as an
       unshipped asset makes the audit fail because it was run. */
    const shipped = fs.readdirSync(dir)
      .filter(f => /\.(html|css|png|ico|json|svg)$/.test(f))
      .filter(f => f[0] !== '.' && !/^\.?check|baseline/i.test(f));
    const notCached = shipped.filter(f => !listed.some(l => path.basename(l) === f));
    if (notCached.length) warn('precache', 'shipped but not precached, so it will not be there offline', notCached.join(', '));
    else note('precache', `${listed.length} entries, everything shipped is covered`);

    const swVer = (sw.match(/(?:CACHE_VERSION|CACHE_NAME|VERSION)\s*=\s*['"]([^'"]+)/) || [])[1];
    const appVer = (js.match(/(?:BUILD|VERSION|APP_VERSION)\s*=\s*['"]([^'"]+)/) || [])[1];
    if (swVer && appVer && swVer !== appVer) {
      fault('cache version', `the worker says "${swVer}" and the app says "${appVer}" — one will serve stale files`);
    } else if (swVer) note('cache version', `worker and app agree on "${swVer}"`);

    if (!/caches\.delete/.test(sw)) warn('stale caches', 'old caches are never deleted, so storage grows without bound');
    else note('stale caches', 'old caches are cleared on activate');

    if (!/cache:\s*['"]reload['"]/.test(sw)) {
      warn('http cache', "navigations do not use cache:'reload', so a CDN or host cache can pin an old build");
    } else note('http cache', 'navigations bypass the http cache');

    const swExt = matches(/https?:\/\//g, sw).length;
    if (swExt) warn('worker network', `${swExt} external reference${swExt === 1 ? '' : 's'} in the worker`);
  }

  if (manifest) {
    for (const icon of manifest.icons || []) {
      const p = path.join(dir, icon.src.replace(/^\.\//, ''));
      if (!fs.existsSync(p)) fault('manifest icon', 'listed but missing from the folder', icon.src);
    }
    if (manifest.start_url) {
      const p = path.join(dir, manifest.start_url.replace(/^\.\//, '').split('#')[0].split('?')[0]);
      if (p && !fs.existsSync(p)) fault('start url', 'points at a file that is not there', manifest.start_url);
    }
    /* a shortcut to a route the app no longer has is silently dead */
    /* a route may be listed in a whitelist, a route map, or both */
    const routes = (js.match(/(?:TABS|ROUTES|PANES|VIEWS|SCREENS)\s*[:=]\s*[[{][\s\S]{0,1200}?[\]}]/g) || []).join(' ');
    const dead = [];
    for (const s of manifest.shortcuts || []) {
      const hash = (s.url || '').split('#')[1];
      const named = new RegExp("['\"]" + hash + "['\"]|\\b" + hash + "\\s*:").test(routes);
      if (hash && routes && !named) dead.push(s.name + ' -> #' + hash);
    }
    if (dead.length) fault('dead shortcut', 'a home screen shortcut points at a route the app no longer has', dead.join(', '));
    else if ((manifest.shortcuts || []).length) note('dead shortcut', `${manifest.shortcuts.length} shortcuts, all resolve`);
  }
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

function run(files, opts) {
  const htmlPath = files.find(f => /\.html?$/i.test(f));
  if (!htmlPath) { console.error('give me an .html file to audit'); process.exit(2); }
  const dir = path.dirname(path.resolve(htmlPath));
  const html = fs.readFileSync(htmlPath, 'utf8');

  const scripts = matches(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g, html).map(m => m[1]);
  const js = scripts.join('\n');
  const clean = blankNoise(js);
  const css = matches(/<style[^>]*>([\s\S]*?)<\/style>/g, html).map(m => m[1]).join('\n');
  /* Slice between the body tags, not from </head>: starting after the head
     leaves </body></html> with no openings, which reads as a fault that
     is not there. */
  /* Strip scripts and styles BEFORE slicing. An app that builds a whole
     HTML document in a template literal — any PDF or print export does —
     puts a </body> inside the script. Slicing first stops at that one,
     cutting the script in half, which leaves an unterminated <script> the
     strip cannot match, so the entire script stays in `body` and every
     comparison like a<b reads as an open tag. */
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const bOpen = markup.search(/<body[^>]*>/i);
  const bClose = markup.search(/<\/body>/i);
  const body = (bOpen !== -1 && bClose !== -1 ? markup.slice(markup.indexOf('>', bOpen) + 1, bClose) : markup);

  const swPath = files.find(f => /sw|service.?worker/i.test(path.basename(f))) ||
    (fs.existsSync(path.join(dir, 'sw.js')) ? path.join(dir, 'sw.js') : null);
  const manifestPath = files.find(f => /manifest/i.test(f)) ||
    (fs.existsSync(path.join(dir, 'manifest.json')) ? path.join(dir, 'manifest.json') : null);

  /* If most of the source vanished, the checks that read it are guesses.
     Better to say so than to report confidently about code never seen. */
  const kept = clean.replace(/\s/g, '').length;
  const whole = js.replace(/\s/g, '').length;
  const ratio = whole ? kept / whole : 1;
  layer('scan');
  if (ratio < 0.55) {
    fault('source scan', `only ${Math.round(ratio * 100)}% of the script could be read as code — ` +
      'the wiring and hazard checks below are unreliable on this file');
  } else {
    note('source scan', `${Math.round(ratio * 100)}% of the script read as code, ` +
      'the rest is comments and string literals');
  }

  const extras = files.filter(f => f !== htmlPath && fs.existsSync(f)).map(f => [f, fs.readFileSync(f, 'utf8')]);

  checkStructure(html, body, js);
  checkWiring(html, js, clean);
  checkHazards(html, body, js, clean);
  checkStyles(body, css, js);
  checkAccess(body, css, js);
  checkDuplication(clean, body, js);
  checkPatterns(clean);
  checkInputs(body);
  checkFailure(clean, js);
  checkCopy(js, body);
  checkContainment(html, clean, extras);
  checkConstants(clean);
  checkRegisters(body, js, clean);
  checkDrift(html, clean, js, swPath && fs.existsSync(swPath) ? fs.readFileSync(swPath, 'utf8') : '');
  checkPwa(html, js, dir, swPath, manifestPath);

  if (opts.json) { console.log(JSON.stringify(findings, null, 2)); }
  else {
    const faults = findings.filter(f => f.level === FAULT);
    const warns = findings.filter(f => f.level === WARN);
    let lastLayer = null;
    console.log('\n  ' + path.basename(htmlPath) + '  ' + Math.round(html.length / 1024) + ' KB  ' +
      scripts.length + ' script block' + (scripts.length === 1 ? '' : 's'));
    for (const f of findings) {
      if (opts.quiet && f.level === NOTE) continue;
      if (f.layer !== lastLayer) { console.log('\n  ' + f.layer); lastLayer = f.layer; }
      const tag = f.level === FAULT ? 'FAULT' : (f.level === WARN ? 'warn ' : '     ');
      console.log('    ' + tag + '  ' + f.check + ' — ' + f.detail);
      if (f.evidence) console.log('             ' + String(f.evidence).slice(0, 150));
    }
    console.log('\n  ' + faults.length + ' fault' + (faults.length === 1 ? '' : 's') +
      ', ' + warns.length + ' warning' + (warns.length === 1 ? '' : 's') +
      ', ' + findings.filter(f => f.level === NOTE).length + ' checks clean\n');
  }

  const faults = findings.filter(f => f.level === FAULT).length;
  const warns = findings.filter(f => f.level === WARN).length;
  process.exit(faults ? 2 : (warns ? 1 : 0));
}

const argv = process.argv.slice(2);
run(argv.filter(a => a[0] !== '-'), {
  quiet: argv.includes('--quiet'),
  json: argv.includes('--json')
});
