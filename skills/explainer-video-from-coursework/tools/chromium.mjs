// chromium.mjs — locate the Playwright headless-Chromium binary.
//
// The single source of truth for "where is the browser". Both the renderer
// (render.mjs) and the scene-boot debugger (debug-page.mjs) import this, so the
// platform/architecture logic lives in exactly one place (ROADMAP §2.1).
//
// Resolution order:
//   1. CHROME_BIN                 — explicit binary path
//   2. PLAYWRIGHT_BROWSERS_PATH   — explicit cache root
//   3. the platform default cache root

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const REVISION_PREFIX = 'chromium_headless_shell-';
const BUILD_PREFIX = 'chrome-headless-shell-';

function defaultCacheRoot() {
  switch (process.platform) {
    case 'darwin':
      return join(os.homedir(), 'Library/Caches/ms-playwright');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
    default:
      return join(process.env.XDG_CACHE_HOME || join(os.homedir(), '.cache'), 'ms-playwright');
  }
}

export function findChromium() {
  if (process.env.CHROME_BIN) {
    if (!existsSync(process.env.CHROME_BIN)) {
      throw new Error(`CHROME_BIN is set but not found: ${process.env.CHROME_BIN}`);
    }
    return process.env.CHROME_BIN;
  }

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || defaultCacheRoot();
  if (!existsSync(base)) {
    throw new Error(`Playwright cache not found at ${base} (set PLAYWRIGHT_BROWSERS_PATH or CHROME_BIN)`);
  }

  const revision = readdirSync(base)
    .filter(d => d.startsWith(REVISION_PREFIX))
    .sort()
    .pop();
  if (!revision) throw new Error(`No ${REVISION_PREFIX}* build found in ${base}`);

  const revisionDir = join(base, revision);
  // The binary sits one directory down, and that directory is named per
  // platform+architecture (chrome-headless-shell-mac-arm64, ...-linux64, etc.).
  // Globbing the prefix — rather than hardcoding the name — is what makes this
  // portable instead of Apple-Silicon-only.
  const build = readdirSync(revisionDir).find(d => d.startsWith(BUILD_PREFIX));
  if (!build) throw new Error(`No ${BUILD_PREFIX}* directory found in ${revisionDir}`);

  const binName = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const bin = join(revisionDir, build, binName);
  if (!existsSync(bin)) throw new Error(`Chromium binary not found at ${bin}`);
  return bin;
}

/** findChromium, or print the one-time setup and exit — for the CLI entry points. */
export function chromiumBinOrExit(tool) {
  try {
    return findChromium();
  } catch (err) {
    console.error(`[${tool}] headless Chromium not found:\n  ${err.message}`);
    console.error('  One-time install: npx playwright install --with-deps --only-shell');
    console.error('  Full setup: see SETUP.md (Node ≥ 22, ffmpeg, Chromium, Gemini key).');
    process.exit(1);
  }
}
