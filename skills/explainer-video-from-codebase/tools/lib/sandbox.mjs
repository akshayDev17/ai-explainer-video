/* The OS sandboxes trace.mjs runs a repo's test command in (design §3.17, ADR-014). Each one denies all network (IP,
   localhost and unix-socket connects) and every write outside the scratch dir; the caller passes an empty environment.
   - macos: sandbox-exec with trace/sandbox/macos-nonet.sb;
   - bwrap: bubblewrap through trace/sandbox/linux-bwrap.sh (namespaces, read-only /, a seccomp filter on unix sockets).
   There is no unsandboxed mode: where neither works, the caller refuses (exit 4). */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'trace', 'sandbox');
export const MACOS_PROFILE = join(DIR, 'macos-nonet.sb');
export const BWRAP_SCRIPT = join(DIR, 'linux-bwrap.sh');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOX_LABEL = { macos: 'macos-sandbox-exec:macos-nonet.sb', bwrap: 'linux-bwrap:linux-bwrap.sh' };
const PLATFORM_OF = { macos: 'darwin', bwrap: 'linux' };

// the command line that runs argv inside the sandbox; readOnly paths are exposed again under bwrap's hidden dirs
export function sandboxArgv(kind, { scratch, readOnly = [], argv }) {
  if (kind === 'macos') return [SANDBOX_EXEC, '-f', MACOS_PROFILE, '-D', `SCRATCH=${scratch}`, ...argv];
  // a read-only mount over scratch (or one of its parents) would make scratch read-only too
  const ro = readOnly.filter(p => p && existsSync(p) && !(scratch + sep).startsWith(p.replace(/\/+$/, '') + sep));
  return ['/bin/sh', BWRAP_SCRIPT, scratch, [...new Set(ro)].join('\n'), ...argv];
}

// can this sandbox run here? A probe runs `true` inside it: sandbox-exec refuses inside another sandbox, and bwrap
// fails where unprivileged user namespaces are off
export function sandboxWorks(kind) {
  if (process.platform !== PLATFORM_OF[kind]) return { ok: false, why: `the ${kind} sandbox exists only on ${PLATFORM_OF[kind]}, not ${process.platform}` };
  if (kind === 'macos' && !existsSync(SANDBOX_EXEC)) return { ok: false, why: `${SANDBOX_EXEC} is missing` };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fmtrace-probe-')));
  const [cmd, ...args] = sandboxArgv(kind, { scratch, argv: [kind === 'macos' ? '/usr/bin/true' : '/bin/true'] });
  const r = spawnSync(cmd, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000 });
  rmSync(scratch, { recursive: true, force: true });
  if (r.status === 0) return { ok: true };
  const why = (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n').pop();
  return { ok: false, why: kind === 'bwrap' && /ENOENT|not found/.test(why) ? 'bwrap is not installed' : `the ${kind} sandbox does not start here: ${why}` };
}

// auto picks this platform's sandbox; "none" and any sandbox that cannot run here are refusals, never a fallback
export function pickSandbox(requested) {
  if (requested === 'none') return { why: 'tracing never runs unsandboxed (--sandbox none)' };
  const kind = requested === 'auto' ? { darwin: 'macos', linux: 'bwrap' }[process.platform] : requested;
  if (!kind) return { why: `no OS sandbox is supported on ${process.platform}` };
  const w = sandboxWorks(kind);
  return w.ok ? { kind } : { why: w.why };
}
