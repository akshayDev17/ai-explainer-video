/* onset-audit.mjs — the earliest visual event in each scene, in seconds after the
   narration starts. A scene whose first visual lands more than ~2.5s in opens on a
   near-empty stage (header + badge only), which reads as a dead cut. */
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const off = v => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /^[a-z][a-z0-9-]*@(-?[0-9.]+)$/.exec(v);
    if (m) return parseFloat(m[1]);
  }
  return null;
};
const push = (arr, v) => { const o = off(v); if (o != null) arr.push(o); };

const roots = process.argv.slice(2);
const rows = [];
for (const root of roots) {
  const dir = resolve(root, 'scenes');
  let files;
  try { files = readdirSync(dir).filter(f => f.endsWith('.js')); } catch { continue; }
  for (const f of files) {
    global.window = {};
    await import(pathToFileURL(resolve(dir, f)).href);
    const cfg = global.window.SCENE_CONFIG;
    if (!cfg) { rows.push({ scene: f, onset: null, note: 'no SCENE_CONFIG' }); continue; }
    const onsets = [];
    Object.values(cfg.reveal || {}).forEach(a => push(onsets, a[0]));
    Object.values(cfg.draw || {}).forEach(d => push(onsets, d.at && d.at[0]));
    Object.values(cfg.hide || {}).forEach(a => push(onsets, a[0]));
    (cfg.banners || []).forEach(b => push(onsets, b.from));
    (cfg.flows || []).forEach(fl => push(onsets, fl.from));
    const OV = cfg.overlays || {};
    if (OV.cards) push(onsets, OV.cards.inAt);
    if (OV.chips) push(onsets, OV.chips.at);
    if (OV.title) push(onsets, OV.title.from);
    if (OV.finalLine) push(onsets, OV.finalLine.at);
    const finite = onsets.filter(n => Number.isFinite(n));
    rows.push({ scene: f, onset: finite.length ? Math.min(...finite) : null });
  }
}
rows.sort((a, b) => (b.onset ?? -1) - (a.onset ?? -1));
const bad = rows.filter(r => (r.onset ?? 99) > 2.5);
console.log('scene                            first visual (s after narration start)');
console.log('─'.repeat(72));
rows.forEach(r => console.log(`  ${r.scene.padEnd(30)} ${r.onset == null ? 'NONE' : r.onset.toFixed(1)}`));
console.log('─'.repeat(72));
console.log(`${rows.length} scenes · ${bad.length} open later than 2.5s`);
bad.forEach(r => console.log(`  ✗ ${r.scene}  first visual at ${r.onset.toFixed(1)}s`));
