// tools/thumbnail.mjs (stage 6b): the PNG check the upload depends on, the series label and where Part X comes from,
// the hook rules, the refusals that come before any browser starts, and stamp's stage id. The render itself needs the
// headless Chromium, so that one test skips where it is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ROOT, scratch, cleanup } from './helpers.mjs';

const TOOLS = join(ROOT, 'skills', 'explainer-video-from-coursework', 'tools');
const { pngInfo, checkThumbnail, partOf, seriesLabel, checkConfig, markedWords, MAX_BYTES } = await import(join(TOOLS, 'thumbnail.mjs'));
const { findChromium } = await import(join(TOOLS, 'chromium.mjs'));
const run = (args, cwd) => spawnSync(process.execPath, [join(TOOLS, 'thumbnail.mjs'), ...args], { cwd, encoding: 'utf8' });

/* a real, decodable PNG: 8-bit RGB, every row filter 0, one colour */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(width, height, rgb = [40, 60, 120]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a 1280x720 PNG under 2 MB passes; the wrong size, a JPEG and an oversized file fail loudly', () => {
  assert.deepEqual(pngInfo(png(1280, 720)), { width: 1280, height: 720 });
  assert.deepEqual(checkThumbnail(png(1280, 720)), []);
  assert.match(checkThumbnail(png(1920, 1080)).join('\n'), /1920x1080; a thumbnail is 1280x720/);
  assert.match(checkThumbnail(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])).join('\n'), /a JPEG named as a PNG/);
  assert.match(checkThumbnail(Buffer.concat([png(1280, 720), Buffer.alloc(MAX_BYTES)])).join('\n'), /the upload refuses more than 2,000,000/);
});

test('Part X is the position among the videos curation kept, and the label reads "<playlist>-Part X, <title>"', () => {
  const plan = { videos: [{ index: 1 }, { index: 2 }, { index: 4 }, { index: 7 }] };   // 3, 5 and 6 were skipped or merged
  assert.deepEqual(partOf(plan, 4), { part: 3, of: 4 });
  assert.deepEqual(partOf(plan, 1), { part: 1, of: 4 });
  assert.equal(partOf(plan, 3), null, 'a skipped video has no part');
  assert.equal(seriesLabel('Systems 101', 3, 'Why Your Cache Serves Stale Data'), 'Systems 101-Part 3, Why Your Cache Serves Stale Data');
});

test('the hook is a few big words that add to the title, and a code-flow hook never names code', () => {
  const title = 'Why Your Cache Serves Stale Data';
  const ok = checkConfig({ hook: 'The bug nobody catches', highlight: 'nobody', still: 'still.png' }, { title });
  assert.deepEqual(ok, { errors: [], warnings: [] });
  assert.match(checkConfig({ hook: 'Stale Data', still: 's.png' }, { title }).errors.join('\n'), /repeats the upload title/);
  assert.match(checkConfig({ hook: 'cache serves stale data now', still: 's.png' }, { title }).warnings.join('\n'), /shares most of its words/);
  assert.match(checkConfig({ hook: 'one two three four five six', still: 's.png' }, { title }).errors.join('\n'), /6 words; at most 5/);
  assert.match(checkConfig({ hook: 'Read this', still: 's.png', highlight: 'that' }, { title }).errors.join('\n'), /"highlight" word "that" is not in the hook/);
  assert.match(checkConfig({ hook: 'Read this' }, { title }).errors.join('\n'), /"still" is missing/);
  assert.match(checkConfig({ hook: 'Read this', still: 's.png', accent: 'red; x' }, { title }).errors.join('\n'), /hex colour/);
  for (const hook of ['Inside api/routes.py', 'Who calls handle_order', 'processPayment breaks', 'Svc::run explained',
    'Why getUser lies', 'Open ./config first', 'Past ../lib/db', 'Through src/api/users', 'Inside os.path.join', 'Why fn() blocks', '"getUser" lies'])
    assert.match(checkConfig({ hook, still: 's.png' }, { title, codebase: true }).errors.join('\n'), /names code/, hook);
  for (const hook of ['One click, three services', 'Why TypeScript lies', 'GitHub hides this', 'JavaScript vs PostgreSQL', 'macOS breaks it',
    'gRPC under load', 'WebSocket drops silently', 'Where I/O blocks', 'CI/CD in one push', 'TCP/IP, step by step', 'Up 24/7, really?',
    'Rated 4.5/5', 'Scored 9.5/10'])
    assert.deepEqual(checkConfig({ hook, still: 's.png' }, { title, codebase: true }).errors, [], hook);
  assert.deepEqual(checkConfig({ hook: 'Read handle_order', still: 's.png' }, { title }).errors, [], 'the code rule is for code-flow plans only');
});

test('a highlight names a whole hook word, so a hyphenated word can be marked and half of one cannot', () => {
  const title = 'Why Your Cache Serves Stale Data';
  assert.deepEqual(checkConfig({ hook: 'Zero-copy beats memcpy', highlight: 'Zero-copy', still: 's.png' }, { title }).errors, []);
  assert.deepEqual(markedWords('Zero-copy beats memcpy', 'zero-copy'), [0]);
  assert.match(checkConfig({ hook: 'Zero-copy beats memcpy', highlight: 'copy', still: 's.png' }, { title }).errors.join('\n'), /"highlight" word "copy" is not in the hook/);
  assert.deepEqual(markedWords('Zero-copy beats memcpy', 'copy'), [], 'nothing the template would colour');
  assert.deepEqual(markedWords('The naïve fix, nobody!', ['naïve', 'NOBODY']), [1, 3]);
});

// a scratch root with an enriched plan of `videos`, video 2's script and work dir, and (unless `noTitle`) its title.txt
function project({ videos = [1, 2, 4], noTitle = false, kind } = {}) {
  const root = scratch();
  mkdirSync(join(root, 'out/s/02'), { recursive: true });
  mkdirSync(join(root, 'out/s/scripts'), { recursive: true });
  writeFileSync(join(root, 'out/s/plan.enriched.json'), JSON.stringify({ ...(kind ? { kind } : {}), videos: videos.map((index) => ({ index, title: `Video ${index}` })) }));
  writeFileSync(join(root, 'out/s/scripts/02-caches.json'), JSON.stringify({ videoIndex: 2, title: 'Caches', segments: [] }));
  writeFileSync(join(root, 'out/s/02/still.png'), png(1920, 1080));
  writeFileSync(join(root, 'out/s/02/thumbnail.json'), JSON.stringify({ hook: 'The bug nobody catches', highlight: 'nobody', still: 'still.png' }));
  if (!noTitle) { mkdirSync(join(root, 'videos/2-caches'), { recursive: true }); writeFileSync(join(root, 'videos/2-caches/title.txt'), 'Why Your Cache Serves Stale Data\n'); }
  return root;
}
const ARGS = ['--work', 'out/s/02', '--script', 'out/s/scripts/02-caches.json', '--plan', 'out/s/plan.enriched.json', '--dest', 'videos'];

test('a series with no playlist decision is refused with exit 3, before any browser starts: the agent asks, never invents', () => {
  const root = project();
  const r = run(ARGS, root);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /3 videos.*Ask the user for the playlist name.*Never invent one/s);
  assert.equal(run([...ARGS, '--playlist', ' '], root).status, 1, 'a blank playlist is not a name');
  assert.match(run([...ARGS, '--playlist', 'X', '--standalone'], root).stderr, /not both/);
  cleanup(root);
});

test('the thumbnail needs the final upload title, so it refuses to run before /publish', () => {
  const root = project({ noTitle: true });
  const r = run([...ARGS, '--standalone'], root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no title\.txt .*run \/publish \(stage 6\) first/);
  cleanup(root);
});

test('a code-flow plan holds the hook to the code-flow rule', () => {
  const root = project({ kind: 'codebase' });
  writeFileSync(join(root, 'out/s/02/thumbnail.json'), JSON.stringify({ hook: 'Inside cache_get()', still: 'still.png' }));
  const r = run([...ARGS, '--standalone'], root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /names code/);
  cleanup(root);
});

const chromium = (() => { try { return findChromium(); } catch { return null; } })();
test('the render lands a valid thumbnail.png beside title.txt, labelled for its series', { skip: !chromium && 'no headless Chromium' }, () => {
  const root = project();
  const r = run([...ARGS, '--playlist', 'Systems 101'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /label {4}: "Systems 101-Part 2, Why Your Cache Serves Stale Data"/);
  const out = join(root, 'videos/2-caches/thumbnail.png');
  assert.ok(existsSync(out));
  assert.deepEqual(checkThumbnail(readFileSync(out)), []);
  cleanup(root);
});

// lay the host page out in the headless Chromium and read back the series label's settled font size and wrapping
function labelLayout(label) {
  const url = pathToFileURL(join(ROOT, 'skills', 'explainer-video-from-coursework', 'src', 'thumbnail.html')).href +
    '?c=' + encodeURIComponent(JSON.stringify({ hook: 'The bug nobody catches', marked: [], label }));
  const r = spawnSync(chromium, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1280,720', '--dump-dom', url], { encoding: 'utf8', timeout: 60_000 });
  const style = (r.stdout.match(/<div id="label" style="([^"]*)"/) || [])[1] || '';
  return { size: parseFloat((style.match(/font-size:\s*([\d.]+)px/) || [])[1]), wrap: (style.match(/white-space:\s*([a-z]+)/) || [])[1] };
}
test('the series label is sized to fit: a short label sits on one line at a readable size, a long one still fits', { skip: !chromium && 'no headless Chromium' }, () => {
  const short = labelLayout('Sys-Part 2, Caches');
  assert.equal(short.wrap, 'nowrap', 'a short label stays on one line');
  assert.ok(short.size >= 30, `a short label is readable, not the 18px minimum (got ${short.size}px)`);
  const long = labelLayout('Event-Driven Systems-Part 3, How One Event Bus Feeds Five Systems And Then Some More Of Them');
  assert.ok(long.size > 18 && long.size <= short.size, `a long label shrinks but stays above the minimum (got ${long.size}px)`);
});

test('stamp accepts the thumbnail stage between publish and render', () => {
  const root = scratch();
  const stamp = (cmd) => spawnSync(process.execPath, [join(TOOLS, 'stamp.mjs'), cmd, '--out', join(root, 'out'), '--video', '2', '--stage', '6b'], { encoding: 'utf8' });
  assert.equal(stamp('begin').status, 0);
  const end = stamp('end');
  assert.equal(end.status, 0, end.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, 'out/timing.jsonl'), 'utf8')).stage, '6b');
  cleanup(root);
});
