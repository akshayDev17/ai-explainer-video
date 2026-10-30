#!/usr/bin/env node
// The dual-file rule, checked. A pipeline's main SKILL.md is the contract of record and each stage also ships as
// its own child skill; nothing read the two side by side, so a change to one could silently leave the other
// describing a different command, gate or refusal. This fails when they drift:
//   - a child's Maintenance note names a section that no main skill has, or the main skill never names the child;
//   - (codebase pipeline) a child invokes a tool or a flag that its sections in the main skill do not, or the
//     reverse;
//   - a passage marked <!-- sync:<id> --> … <!-- /sync:<id> --> differs between a child and the main skill it
//     comes from (tool paths normalised: `<skill>/` and `../<main>/` are the same folder), or a main skill's
//     passage is in no child. A coursework stage skill may also carry a codebase passage, for code-flow videos.
//
//   node scripts/check-skill-sync.mjs [--root <repo>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const ROOT = argv[0] === "--root" && argv[1] ? argv[1] : join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");
const COURSEWORK = "explainer-video-from-coursework";
const CODEBASE = "explainer-video-from-codebase";
// `strict`: the main skill names every child, and every tool and flag a child invokes is the one its sections in the
// main skill invoke (the coursework skill names its children as `craft-video-<stage>` and predates this check).
// `blocksFrom`: the main skills a child's sync blocks may come from, its own first.
const PIPELINES = [
  { main: CODEBASE, children: /^craft-codeflow-/, strict: true, blocksFrom: [CODEBASE] },
  { main: COURSEWORK, children: /^craft-video-/, strict: false, blocksFrom: [COURSEWORK, CODEBASE] },
];

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✗ ${message}`);
};
const read = (skill) => {
  const file = join(SKILLS, skill, "SKILL.md");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

/* ---------------- sections ---------------- */
// every heading with its text (backticks dropped) and its body, up to the next heading of the same or a higher level
function sections(text) {
  const lines = text.split("\n");
  const heads = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6}) (.*)$/.exec(line);
    if (m) heads.push({ level: m[1].length, title: m[2].replaceAll("`", "").trim(), at: i });
  });
  return heads.map((h, k) => {
    const next = heads.slice(k + 1).find((x) => x.level <= h.level);
    return { ...h, body: lines.slice(h.at, next ? next.at : lines.length).join("\n") };
  });
}
// a Maintenance note's name is a heading's title, or its start up to the title's colon
const findSection = (text, name) => sections(text).find((s) => s.title === name || s.title.startsWith(name + ":"));

// [{skill, section}] named by a child's Maintenance note: `<skill>` skill's **"<section>"** (one or more)
function maintenanceRefs(text) {
  const note = sections(text).find((s) => s.title === "Maintenance");
  if (!note) return null;
  const body = note.body.replace(/^>\s?/gm, "").replace(/\s+/g, " ");
  const refs = [];
  const parts = body.split(/`([a-z0-9-]+)` skill's/);
  for (let i = 1; i < parts.length; i += 2) {
    const upto = parts[i + 1].split(/`[a-z0-9-]+` skill's/)[0];
    for (const m of upto.matchAll(/\*\*"([^"]+)"\*\*/g)) refs.push({ skill: parts[i], section: m[1] });
  }
  return refs;
}

/* ---------------- paths ---------------- */
// one spelling for a skill folder, whichever file it is written in
function normalise(text, owner) {
  return text
    .replaceAll("<skill>/", `<skill:${owner}>/`)
    .replaceAll("<coursework>/", `<skill:${COURSEWORK}>/`)
    .replaceAll("](./", `](<skill:${owner}>/`)
    .replace(/\.\.\/([a-z0-9-]+)\//g, "<skill:$1>/");
}

/* ---------------- tools and flags ---------------- */
// tool ("<skill>:<tool>") -> sorted flags, over every command in the text's fenced code blocks
function toolFlags(text, owner) {
  const lines = normalise(text, owner).split("\n").map((l) => l.replace(/^\s*>\s?/, ""));
  const code = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) code.push(line);
  }
  const commands = code.join("\n").replace(/\\\n/g, " ").split("\n");
  const tools = new Map();
  for (const cmd of commands) {
    for (const m of cmd.matchAll(/(?:<skill:([a-z0-9-]+)>\/)?tools\/([\w.-]+)\.mjs/g)) {
      const key = `${m[1] || owner}:${m[2]}`;
      const flags = tools.get(key) || new Set();
      for (const f of cmd.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) flags.add(f[0]);
      tools.set(key, flags);
    }
  }
  return tools;
}
const show = (tools) => [...tools].map(([t, f]) => `${t} ${[...f].sort().join(" ")}`.trim()).sort();

/* ---------------- sync blocks ---------------- */
// id -> normalised text; a marker without its partner, or an id used twice, is a failure
function syncBlocks(text, owner, file) {
  const blocks = new Map();
  for (const m of text.matchAll(/<!-- sync:([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- \/sync:\1 -->/g)) {
    if (blocks.has(m[1])) fail(`${file}: sync block "${m[1]}" appears twice`);
    blocks.set(m[1], normalise(m[2], owner));
  }
  const opened = [...text.matchAll(/<!-- sync:([a-z0-9-]+) -->/g)].map((m) => m[1]);
  const closed = [...text.matchAll(/<!-- \/sync:([a-z0-9-]+) -->/g)].map((m) => m[1]);
  for (const id of new Set([...opened, ...closed])) {
    if (!blocks.has(id)) fail(`${file}: sync block "${id}" is not closed as <!-- /sync:${id} --> on its own line`);
  }
  return blocks;
}
// the first line that differs, for the failure message
function firstDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  const i = x.findIndex((line, k) => line !== y[k]);
  const k = i === -1 ? x.length : i;
  return `line ${k + 1}: main "${(y[k] ?? "<end>").slice(0, 90)}" vs child "${(x[k] ?? "<end>").slice(0, 90)}"`;
}

/* ---------------- check ---------------- */
// main skill -> {file, text, blocks, used}; a missing main skill is a failure and its pipeline is skipped
const mains = new Map();
for (const p of PIPELINES) {
  const file = `skills/${p.main}/SKILL.md`;
  const text = read(p.main);
  if (text == null) fail(`${file} is missing`);
  else mains.set(p.main, { file, text, blocks: syncBlocks(text, p.main, file), used: new Set() });
}

for (const p of PIPELINES) {
  if (!mains.has(p.main)) continue;
  const { file: mainFile, text: main } = mains.get(p.main);
  const sources = p.blocksFrom.map((m) => mains.get(m)).filter(Boolean);
  const children = readdirSync(SKILLS).filter((d) => p.children.test(d) && existsSync(join(SKILLS, d, "SKILL.md"))).sort();
  if (!children.length) fail(`${p.main}: no child skills match ${p.children}`);

  for (const child of children) {
    const file = `skills/${child}/SKILL.md`;
    const text = read(child);
    const before = failures;
    const name = /^---\n[\s\S]*?^name:\s*(\S+)/m.exec(text)?.[1];
    if (name !== child) fail(`${file}: frontmatter name is "${name}", not its folder "${child}"`);
    if (p.strict && !main.includes(`\`${child}\``)) fail(`${mainFile} never names \`${child}\`: the contract of record does not know this stage skill`);

    const refs = maintenanceRefs(text);
    if (!refs) fail(`${file}: no "## Maintenance" note naming its section in ${p.main}`);
    const own = (refs || []).filter((r) => r.skill === p.main);
    if (refs && !own.length) fail(`${file}: its Maintenance note names no section of ${p.main}`);
    for (const r of refs || []) {
      const target = read(r.skill);
      if (target == null) fail(`${file}: its Maintenance note names the skill ${r.skill}, which does not exist`);
      else if (!findSection(target, r.section)) fail(`${file}: its Maintenance note names "${r.section}", which is no section of ${r.skill}`);
    }

    if (p.strict && own.length) {
      const sectionsText = own.map((r) => findSection(main, r.section)?.body || "").join("\n");
      const want = show(toolFlags(sectionsText, p.main)), got = show(toolFlags(text, child));
      for (const t of want.filter((x) => !got.includes(x))) fail(`${file}: the main skill's ${own.map((r) => `"${r.section}"`).join(" + ")} runs \`${t}\`; this skill does not`);
      for (const t of got.filter((x) => !want.includes(x))) fail(`${file}: runs \`${t}\`; the main skill's ${own.map((r) => `"${r.section}"`).join(" + ")} does not`);
    }

    for (const [id, block] of syncBlocks(text, child, file)) {
      const source = sources.find((m) => m.blocks.has(id));
      if (!source) { fail(`${file}: sync block "${id}" is not in ${sources.map((m) => m.file).join(" or ")}`); continue; }
      source.used.add(id);
      if (source.blocks.get(id) !== block) fail(`${file}: sync block "${id}" differs from ${source.file} (${firstDiff(block, source.blocks.get(id))})`);
    }
    if (failures === before) console.log(`✓ ${file} in step with ${mainFile}`);
  }
}
for (const m of mains.values()) for (const id of m.blocks.keys()) if (!m.used.has(id)) fail(`${m.file}: sync block "${id}" is in no child skill`);

if (failures > 0) {
  console.error(`\n${failures} drift(s) between a main skill and its stage skills: update both files (the dual-file rule).`);
  process.exit(1);
}
