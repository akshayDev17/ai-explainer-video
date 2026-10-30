// The shared renderers' additions for code videos (design §4.6, §5.5), checked offline without a browser: scene-code's
// language sets, real line numbers, elision lines and focus windows, with coursework panels unchanged; and scene-core's
// sequence primitive. The byte-for-byte renderer guard (stills of the _pt-* scenes and the coursework code scenes in
// fixtures/regression, before and after) needs headless Chromium and is run by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const SRC = join(ROOT, 'skills', 'explainer-video-from-coursework', 'src');
const load = (file, extra = {}) => { const ctx = { window: {}, ...extra }; vm.runInNewContext(readFileSync(join(SRC, file), 'utf8'), ctx); return ctx.window; };
const { CodeScenes } = load('scene-code.js');
const kinds = (line, lang) => [...CodeScenes.highlight(line, lang).matchAll(/<span class="t-(\w)">([^<]*)<\/span>/g)].map(m => `${m[1]}:${m[2]}`).filter(s => !s.endsWith(': '));

test('each new language colours its own keywords, strings and comments', () => {
  assert.deepEqual(kinds('func Get(k string) error { // hit', 'go').filter(s => /^[ktsc]:/.test(s)), ['k:func', 't:Get', 't:string', 't:error', 'c:// hit']);
  assert.ok(kinds('s := `raw "x"`', 'go').includes('s:`raw "x"`'));
  assert.deepEqual(kinds('export async function f(): Promise<number> {', 'ts').filter(s => /^[kt]:/.test(s)), ['k:export', 'k:async', 'k:function', 't:Promise', 't:number']);
  assert.ok(kinds('const s = `a ${b}`;', 'js').includes('s:`a ${b}`'));
  assert.deepEqual(kinds('#include <stdio.h>', 'c').slice(0, 1), ['k:#include']);
  assert.deepEqual(kinds('static size_t n = sizeof(x); /* n */', 'c').filter(s => /^[ktc]:/.test(s)), ['k:static', 't:size_t', 'k:sizeof', 'c:/* n */']);
  assert.deepEqual(kinds('template <typename T> class Box {', 'cpp').filter(s => /^k:/.test(s)), ['k:template', 'k:typename', 'k:class']);
});

test('every lang name the code map emits gets its own colouring, not the java fallback', () => {
  const own = { python: 'def', typescript: 'async', tsx: 'let', javascript: 'let', go: 'func', c: 'sizeof', cpp: 'template' };
  for (const [lang, kw] of Object.entries(own)) {
    assert.ok(kinds(`${kw} x`, lang).includes(`k:${kw}`), `${lang} colours ${kw} as a keyword`);
    assert.ok(!kinds(`${kw} x`, 'java').includes(`k:${kw}`), `java does not, so ${lang} is not falling back`);
  }
});

test('java and python colouring is unchanged, and an unknown language still falls back to java', () => {
  assert.equal(CodeScenes.highlight('def f(self):  # hi', 'python'),
    '<span class="t-k">def</span><span class="t-p"> </span><span class="t-f">f</span><span class="t-u">(</span><span class="t-k">self</span><span class="t-u">)</span><span class="t-p">:</span><span class="t-p"> </span><span class="t-p"> </span><span class="t-c"># hi</span>');
  assert.equal(CodeScenes.highlight('func x() {', 'kotlin'), CodeScenes.highlight('func x() {', 'java'));
  assert.deepEqual(kinds('public String get(String key) {', 'java').filter(s => /^[kt]:/.test(s)), ['k:public', 't:String', 't:String']);
});

test('a coursework panel\'s markup is exactly what it was: numbers from 1, no elision', () => {
  const p = { lines: ['class A {', '  int x = 1;', '}'], lang: 'java' };
  const before = p.lines.map((ln, i) => `<div class="ln" data-i="${i}"><span class="num">${i + 1}</span><span class="txt">${CodeScenes.highlight(ln, 'java')}</span></div>`).join('');
  assert.equal(CodeScenes.panelLinesHtml(p), before);
});

test('an excerpt panel shows its real line numbers, and its elision markers blank-numbered and unhighlighted', () => {
  const html = CodeScenes.panelLinesHtml({ lang: 'python', lines: ['def f():', '    ⋯ 6 lines', '    return x'], numbers: [9, null, 16], elided: [{ at: 1, from: 10, to: 15 }] });
  assert.match(html, /^<div class="ln" data-i="0"><span class="num">9<\/span>/);
  assert.match(html, /<div class="ln elided" data-i="1"><span class="num"><\/span><span class="txt">    ⋯ 6 lines<\/span><\/div>/);
  assert.match(html, /<div class="ln" data-i="2"><span class="num">16<\/span>/);
});

test('focus: an excerpt panel has one window per sentence, chained without flashing back; a coursework panel keeps its first', () => {
  const acts = [{ op: 'focus', panel: 'p', lines: [1], from: 1, to: 3 }, { op: 'focus', panel: 'p', lines: [2, 3], from: 3, to: 5 }, { op: 'focus', panel: 'q', lines: [1], from: 0, to: 9 }];
  const numbered = t => CodeScenes.focusState(acts, 'p', true, t);
  assert.deepEqual(numbered(2).foc.lines, [1]);
  assert.deepEqual([numbered(3).foc.lines, numbered(3).active, numbered(3).k], [[2, 3], true, 1], 'the second window takes over at full dim');
  assert.equal(numbered(1).k, 0, 'the first window fades its dim in');
  assert.equal(numbered(6).active, false);
  const coursework = t => CodeScenes.focusState(acts, 'p', false, t);
  assert.deepEqual([coursework(4).foc.lines, coursework(4).active], [[1], false], 'a coursework panel ignores a second focus act, as before');
  assert.equal(CodeScenes.focusState(acts, 'r', true, 1), null);
});

test('clock: a coursework scene keeps the video clock and its own total; a scene naming its segment plays from that window', () => {
  const TL = { total: 120, windows: { hook: { start: 0, end: 30 }, hop2: { start: 30, end: 75 } } };
  const clock = (cfg, tl) => ({ ...CodeScenes.clockOf(cfg, tl) });   // out of the vm realm, for deepEqual
  assert.deepEqual(clock({ total: 8 }, TL), { offset: 0, total: 8 });
  assert.deepEqual(clock({ total: 8 }, undefined), { offset: 0, total: 8 }, 'no timeline is fine for a coursework scene');
  assert.deepEqual(clock({ total: 45, segment: 'hop2' }, TL), { offset: 30, total: 120 });
  assert.throws(() => CodeScenes.clockOf({ total: 45, segment: 'hop9' }, TL), /no window for it/);
  assert.throws(() => CodeScenes.clockOf({ total: 45, segment: 'hop2' }, undefined), /no window for it/);
});

test('progress bar: a coursework scene draws and fills it; a scene naming its segment draws none', () => {
  // the smallest DOM create() touches for a scene with no panels: a root that finds ids in its children's markup
  const el = () => ({ style: {}, innerHTML: '', textContent: '', children: [], setAttribute() {}, appendChild(c) { this.children.push(c); return c; } });
  const stage = () => {
    const root = el(), found = {};
    root.querySelector = sel => root.children.some(c => c.innerHTML.includes(`id="${sel.slice(1)}"`)) ? (found[sel] ||= el()) : null;
    return { root, found };
  };
  const doc = { createElement: el, createElementNS: el };
  const scene = cfg => { const s = stage(); load('scene-code.js', { document: doc }).CodeScenes.create({ root: s.root, config: cfg }).renderAt(4); return s.found; };
  assert.equal(scene({ total: 8 })['#progFill'].style.width, '960.0px', 'a coursework scene fills the bar on its own total');
  assert.equal(scene({ total: 8, segment: 'hop2' })['#progFill'], undefined);
  assert.equal(scene({ total: 8, segment: 'hop2', progress: true })['#progFill'], undefined, 'no flag brings the bar back');
});

/* ---------------- scene-core: primitives.sequence ---------------- */
// the smallest DOM the SVG helpers touch: elements record their attributes, children and text
const node = tag => ({ tag, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = String(v); }, appendChild(c) { this.children.push(c); return c; } });
const document = { createElementNS: (_, tag) => node(tag), createElement: () => ({ getContext: () => ({ font: '', measureText: s => ({ width: s.length * 12 }) }) }) };
const { SceneCore } = load('scene-core.js', { document });
const draw = (params, t) => { const svg = node('svg'); SceneCore.primitives.sequence(svg, params, t); return svg.children; };
const PARAMS = { at: 1, participants: [{ id: 'caller', label: 'POST /v1/loans', sub: 'HTTP request' }, { id: 'api', label: 'library.api' }, { id: 'svc', label: 'library.service' }],
  messages: [{ from: 'caller', to: 'api', label: 'borrow', kind: 'http' }, { from: 'api', to: 'svc', label: 'LoanService.borrow', kind: 'call' }, { from: 'svc', to: 'svc', label: 'check', kind: 'call' }] };
const texts = els => els.filter(e => e.tag === 'text').map(e => e.textContent);

test('sequence: nothing before `at`; then the participants, and each message in turn', () => {
  assert.equal(draw(PARAMS, 0.5).length, 0);
  assert.deepEqual(texts(draw(PARAMS, 1.2)), ['POST /v1/loans', 'HTTP request', 'library.api', 'library.service']);
  const all = draw(PARAMS, 9);
  assert.deepEqual(texts(all).slice(4), ['borrow', 'http', 'LoanService.borrow', 'check']);
  const http = all.find(e => e.tag === 'line' && e.attrs['stroke-dasharray'] === '12 8');
  assert.ok(http, 'a crossing is dashed');
  assert.ok(all.some(e => e.tag === 'path' && /^M [\d.]+ [\d.]+ h 60 v [\d.]+ h -60$/.test(e.attrs.d)), 'a call within one participant loops back');
  assert.equal(all.filter(e => e.tag === 'line' && !e.attrs['stroke-dasharray']).length, 1, 'the plain call is solid');
});

test('sequence boxes narrow so that seven participants never overlap', () => {
  const parts = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, label: `library.module${i}` }));
  const rects = draw({ at: 0, participants: parts, messages: [] }, 5).filter(e => e.tag === 'rect').map(e => [Number(e.attrs.x), Number(e.attrs.width)]);
  for (let i = 1; i < rects.length; i++) assert.ok(rects[i][0] - (rects[i - 1][0] + rects[i - 1][1]) >= 15.9, `box ${i} keeps its gap`);
});
