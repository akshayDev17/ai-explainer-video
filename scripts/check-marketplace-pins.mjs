#!/usr/bin/env node
// The marketplaces are how Claude, Codex and Gemini install this plugin: each entry
// delivers the plugin from npm with a version RANGE. Nothing read that range, so it
// sat at ^0.1.0 while the package moved to 0.4.0 — and a range of ^0.1.0 on a 0.x
// package means ">=0.1.0 <0.2.0", so those hosts were installing 0.1.2: nine skills,
// no vendored coursework-author, none of the tool fixes. scripts/bump.mjs now rewrites
// the pins during a release; this proves the pins track the package.
//
//   node scripts/check-marketplace-pins.mjs
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const want = `^${pkg.version}`;
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✗ ${message}`);
};

if (!pkg.version) {
  console.error("package.json has no version");
  process.exit(1);
}

for (const file of MARKETPLACES) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`${file}: ${err.message}`);
    continue;
  }

  const entry = (json.plugins ?? []).find((p) => p.source?.package === pkg.name);
  if (!entry) {
    fail(`${file}: does not list ${pkg.name} — that host would install nothing`);
    continue;
  }
  if (entry.source.source !== "npm") {
    fail(`${file}: delivers ${pkg.name} from "${entry.source.source}", not npm`);
    continue;
  }
  if (entry.source.version !== want) {
    fail(`${file}: pins ${pkg.name} at "${entry.source.version}", package.json says ${pkg.version} — a host reading this installs the older release`);
    continue;
  }
  console.log(`✓ ${file}: ${pkg.name}@${want}`);
}

if (failures > 0) {
  console.error(`\n${failures} marketplace pin(s) stale. fix: node scripts/bump.mjs ${pkg.version}`);
  process.exit(1);
}
