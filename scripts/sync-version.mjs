#!/usr/bin/env node
// Kept deliberately tiny. Reads the new version (argv[2]) and writes it into the
// two plugin manifests, preserving their exact formatting via a targeted replace.
//
// Invoked by semantic-release's @semantic-release/exec prepareCmd as:
//   node scripts/sync-version.mjs ${nextRelease.version}
//
// package.json is NOT touched here — @semantic-release/npm bumps that one itself.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("sync-version: expected a semver version argument, got:", version);
  process.exit(1);
}

for (const file of ["plugin.json", ".claude-plugin/plugin.json"]) {
  const path = resolve(file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`);
  if (after === before) {
    console.error(`sync-version: no "version" field found in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`sync-version: ${file} -> ${version}`);
}
