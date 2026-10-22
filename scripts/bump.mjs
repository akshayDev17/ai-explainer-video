#!/usr/bin/env node
// Write a version into all three manifests, preserving their exact formatting
// via a targeted replace of the "version" field.
//   node scripts/bump.mjs <version>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`bump: expected a semver version argument, got: ${JSON.stringify(version)}`);
  process.exit(1);
}

const MANIFESTS = ["package.json", "plugin.json", ".claude-plugin/plugin.json"];
const VERSION = /"version"\s*:\s*"([^"]*)"/;
let found = 0;
let touched = 0;

for (const file of MANIFESTS) {
  const path = resolve(file);
  const before = readFileSync(path, "utf8");
  // "no version field" and "already that version" used to share this branch, so a
  // no-op bump reported a missing field and failed the release re-run it existed to
  // make possible. They are different outcomes, so test for the field itself.
  if (!VERSION.test(before)) {
    console.error(`bump: no "version" field in ${file}`);
    process.exit(1);
  }
  found++;
  const after = before.replace(VERSION, `"version": "${version}"`);
  if (after === before) {
    console.log(`bump: ${file} already ${version}`);
    continue;
  }
  writeFileSync(path, after);
  console.log(`bump: ${file} -> ${version}`);
  touched++;
}

if (!found) {
  console.error("bump: found no manifests to bump");
  process.exit(1);
}
console.log(`bump: ${found} manifest(s), ${touched} changed`);

// The marketplaces are how Claude, Codex and Gemini install this plugin: each entry
// points at the npm package with a version RANGE, and a range that was right when it
// was written quietly rots. `^0.1.0` was still sitting in both files after six
// releases, so those hosts were installing 0.1.2 — nine skills, and none of the fixes
// since. Pinning it here means a release cannot leave them behind.
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")).name;
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];

for (const file of MARKETPLACES) {
  const path = resolve(file);
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`bump: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
  const entry = (json.plugins ?? []).find((p) => p.source?.package === pkg);
  if (!entry) {
    console.error(`bump: ${file} does not list ${pkg} — that host would get no update`);
    process.exit(1);
  }
  const want = `^${version}`;
  const before = readFileSync(path, "utf8");
  if (entry.source.version === want) {
    console.log(`bump: ${file} already ${want}`);
    continue;
  }
  entry.source.version = want;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`bump: ${file} -> ${want}`);
}

