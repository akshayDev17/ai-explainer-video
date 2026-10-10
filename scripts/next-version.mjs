#!/usr/bin/env node
// Compute the next semver from the current one and a bump type.
//   node scripts/next-version.mjs <current> <patch|minor|major>
// Prints the next version. Pure — touches nothing on disk.
const [, , current, bump] = process.argv;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current || "");
if (!m) {
  console.error(`next-version: bad current version: ${JSON.stringify(current)}`);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);
if (bump === "major") { major += 1; minor = 0; patch = 0; }
else if (bump === "minor") { minor += 1; patch = 0; }
else if (bump === "patch") { patch += 1; }
else {
  console.error(`next-version: bad bump: ${JSON.stringify(bump)}`);
  process.exit(1);
}
console.log(`${major}.${minor}.${patch}`);
