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

for (const file of ["package.json", "plugin.json", ".claude-plugin/plugin.json"]) {
  const path = resolve(file);
  const before = readFileSync(path, "utf8");
  const after = before.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`);
  if (after === before) {
    console.error(`bump: no "version" field found in ${file}`);
    process.exit(1);
  }
  writeFileSync(path, after);
  console.log(`bump: ${file} -> ${version}`);
}
