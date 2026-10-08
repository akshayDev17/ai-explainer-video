// env.mjs — fail loud on missing prerequisites, instead of a raw ENOENT or a
// cryptic WebSocket error. Each prerequisite maps to a SETUP.md section.
//
//   requireNode()   — the tools need Node ≥ 22 (global WebSocket / fetch)
//   requireCmd(x)   — x must be on PATH (ffmpeg / ffprobe)

import { spawnSync } from 'node:child_process';

const NODE_MAJOR = 22;

export function requireNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < NODE_MAJOR) {
    console.error(`[node] Node ${process.versions.node} is too old — ${NODE_MAJOR}+ required (global WebSocket).`);
    console.error('  See SETUP.md (Node ≥ 22).');
    process.exit(1);
  }
}

export function requireCmd(cmd) {
  // spawnSync reports `error` only when the binary could not be launched (ENOENT
  // = not on PATH). A non-zero exit still means it exists, so that is not an error
  // here — `-version` exists precisely because some builds reject `--version`.
  const r = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  if (r.error) {
    console.error(`[setup] ${cmd} not found on PATH.`);
    console.error('  See SETUP.md (ffmpeg + ffprobe).');
    process.exit(1);
  }
}
