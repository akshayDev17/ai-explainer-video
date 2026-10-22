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
