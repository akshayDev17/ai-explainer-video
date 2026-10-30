/* The OS sandboxes trace.mjs runs a repo's test command in (design §3.17, ADR-014). Each one denies all network (IP,
   localhost and unix-socket connects), every write outside the scratch dir, and every read of the hidden paths (the
   user's home folder and the original repo) except the read-only paths the run needs (the interpreter and its
   virtualenv); the caller passes an empty environment.
   - macos: sandbox-exec with trace/sandbox/macos-nonet.sb, plus the read rules built here for these paths;
   - bwrap: bubblewrap through trace/sandbox/linux-bwrap.sh (namespaces, read-only /, the hidden paths replaced by
     empty dirs, a seccomp filter on unix sockets).
   There is no unsandboxed mode: where this platform's sandbox does not start, the caller refuses (exit 4). */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, mkdtempSync, rmSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'trace', 'sandbox');
export const MACOS_PROFILE = join(DIR, 'macos-nonet.sb');
export const BWRAP_SCRIPT = join(DIR, 'linux-bwrap.sh');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const SANDBOX_LABEL = { macos: 'macos-sandbox-exec:macos-nonet.sb', bwrap: 'linux-bwrap:linux-bwrap.sh' };
const KIND_OF = { darwin: 'macos', linux: 'bwrap' };

const strip = p => p.replace(/\/+$/, '') || '/';
const inside = (p, dir) => p === dir || p.startsWith(dir === '/' ? '/' : dir + sep);
const sbString = p => `"${p.replace(/[\\"]/g, c => '\\' + c)}"`;
const ancestors = p => { const out = []; for (let d = dirname(p); d !== dirname(d); d = dirname(d)) out.push(d); return out; };

// the read-only paths the sandbox may expose: never scratch or one of its parents (a read-only mount there would make
// scratch read-only too), never a hidden path or one of its parents (that would expose all of it)
export function exposable(p, { scratch, hidden }) {
  if (!p || !existsSync(p)) return false;
  const d = strip(p);
  return !inside(strip(scratch), d) && !hidden.some(h => inside(strip(h), d));
}

// a file the sandboxed run wrote (or could have replaced), read from outside the sandbox: opened without following a
// symlink, and read only when the open file is a plain file; null otherwise (`encoding` null: a Buffer)
export function readRunFile(p, encoding = 'utf8') {
  let fd = null;
  try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW); return fstatSync(fd).isFile() ? readFileSync(fd, encoding) : null; }
  catch { return null; } finally { if (fd != null) closeSync(fd); }
}
// the same, parsed as JSON: [value], or [] when it cannot be read or parsed
export function readRunJson(p) {
  const t = readRunFile(p); if (t == null) return [];
  try { return [JSON.parse(t)]; } catch { return []; }
}

// the read rules the macOS profile gets for this run: nothing under a hidden path, except scratch and the read-only
// paths, and the metadata (not the contents) of the hidden dirs above those, so a path to them still resolves
function macosReadRules({ scratch, hidden, readOnly }) {
  const allowed = [scratch, ...readOnly].map(strip);
  const above = [...new Set(allowed.flatMap(ancestors).filter(a => hidden.some(h => inside(a, strip(h)))))].sort();
  if (!hidden.length) return '';
  return [
    `(deny file-read* ${hidden.map(h => `(subpath ${sbString(strip(h))})`).join(' ')})`,
    `(allow file-read* ${allowed.map(p => `(subpath ${sbString(p)})`).join(' ')})`,
    ...(above.length ? [`(allow file-read-metadata ${above.map(a => `(literal ${sbString(a)})`).join(' ')})`] : []),
  ].join('\n');
}

// the command line that runs argv inside the sandbox
export function sandboxArgv(kind, { scratch, hidden = [homedir()], readOnly = [], argv }) {
  const ro = readOnly.filter(p => exposable(p, { scratch, hidden })).map(strip);
  if (kind === 'macos') {
    const profile = `${readFileSync(MACOS_PROFILE, 'utf8')}\n; reads, for this run\n${macosReadRules({ scratch, hidden, readOnly: [...new Set(ro)] })}\n`;
    return [SANDBOX_EXEC, '-p', profile, '-D', `SCRATCH=${scratch}`, ...argv];
  }
  // the script applies each list last line first: longest first, so a dir is mounted before the paths inside it
  const deepestFirst = ps => [...new Set(ps)].sort((a, b) => b.length - a.length).join('\n');
  return ['/bin/sh', BWRAP_SCRIPT, scratch, deepestFirst(hidden.filter(h => existsSync(h)).map(strip)), deepestFirst(ro), ...argv];
}

// can this platform's sandbox run here? A probe runs `true` inside it: sandbox-exec refuses inside another sandbox,
// and bwrap fails where unprivileged user namespaces are off
export function sandboxWorks(kind) {
  if (kind === 'macos' && !existsSync(SANDBOX_EXEC)) return { ok: false, why: `${SANDBOX_EXEC} is missing` };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fmtrace-probe-')));
  const [cmd, ...args] = sandboxArgv(kind, { scratch, argv: [kind === 'macos' ? '/usr/bin/true' : '/bin/true'] });
  const r = spawnSync(cmd, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, encoding: 'utf8', timeout: 20000 });
  rmSync(scratch, { recursive: true, force: true });
  if (r.status === 0) return { ok: true };
  const why = (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n').pop();
  return { ok: false, why: kind === 'bwrap' && /ENOENT|not found/.test(why) ? 'bwrap is not installed' : `the ${kind} sandbox does not start here: ${why}` };
}

// this platform's sandbox, or why there is none: a platform without one and a sandbox that cannot start here are
// refusals, never a fallback
export function pickSandbox() {
  const kind = KIND_OF[process.platform];
  if (!kind) return { why: `no OS sandbox is supported on ${process.platform}` };
  const w = sandboxWorks(kind);
  return w.ok ? { kind } : { why: w.why };
}
