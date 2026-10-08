// Resolve a Google API key from the OS's native secret store — never from a
// plaintext file and never from the environment. The secret stays protected
// from the shell, the harness, and anyone reading /proc, `ps`, or `env`.
//
// The store, per platform:
//   macOS   Keychain           security find-generic-password -s gemini-tts -w
//   Linux   Secret Service     secret-tool lookup service gemini-tts   (libsecret)
//   Windows Credential Manager read via CredRead (advapi32) — the "generic credential"
//                               whose Internet/network address is "gemini-tts"
//
// Resolution order (first hit wins):
//   1. --key <value>          explicit CLI arg — transient; visible in the
//                             process list, so one-off runs only
//   2. the platform secret store
//
// Nothing here ever logs, echoes or returns the key to stdout.
// Error text is scrubbed before it is printed.
//
// NOTE: the Linux and Windows branches are written from documented behaviour
// and have not been run on those platforms (ROADMAP §2.1 — unverified off macOS).
// Windows retrieval: https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw

import { execFileSync } from 'node:child_process';

const SERVICE = 'gemini-tts';

// Windows CredMan read. CRED_TYPE_GENERIC = 1; the blob is UTF-16LE. The target
// name is the "Internet or network address" typed in Credential Manager's GUI.
const CRED_READ = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr credential);
  public static string Get(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;   // 1 = CRED_TYPE_GENERIC
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlobSize == 0) return "";
      var b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return System.Text.Encoding.Unicode.GetString(b);
    } finally { CredFree(p); }
  }
}
'@
$key = [Cred]::Get('${SERVICE}')
if ($null -eq $key) { exit 44 }
[Console]::Write($key)
`;

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

/** The secret-store backend for this platform, or null if there is none. */
function backend() {
  switch (process.platform) {
    case 'darwin':
      return {
        name: 'Keychain',
        retrieve: () => run('security', ['find-generic-password', '-s', SERVICE, '-w']),
        storeHint: `security add-generic-password -U -s ${SERVICE} -a "$USER" -w   (prompts for the key)`,
      };
    case 'linux':
      return {
        name: 'Secret Service (secret-tool)',
        retrieve: () => run('secret-tool', ['lookup', 'service', SERVICE]),
        storeHint: `secret-tool store --label="Gemini TTS" service ${SERVICE}   (reads the key from stdin — paste it, then Ctrl-D)`,
      };
    case 'win32':
      return {
        name: 'Credential Manager',
        retrieve: () => run('powershell.exe', ['-NoProfile', '-Command', CRED_READ]),
        storeHint: `Control Panel → User Accounts → Credential Manager → Windows Credentials → "Add a generic credential" — Internet or network address: ${SERVICE}, Password: your API key`,
      };
    default:
      return null;
  }
}

/**
 * @returns {{status:'ok'|'empty'|'missing'|'unsupported', key?:string}}
 */
export function fromSecretStore() {
  const b = backend();
  if (!b) return { status: 'unsupported' };
  let out;
  try {
    out = b.retrieve();
  } catch {
    return { status: 'missing' };   // macOS exits 44 when the item is absent
  }
  const key = out.trim();
  // An entry that exists but was stored empty has a zero-length password.
  return key ? { status: 'ok', key } : { status: 'empty' };
}

/**
 * @returns {{key: string|null, source: string, store: string}}
 */
export function loadKey(explicit) {
  const st = fromSecretStore();

  if (explicit && typeof explicit === 'string' && explicit !== 'true') {
    return { key: explicit, source: 'cli --key', store: st.status };
  }
  if (st.status === 'ok') {
    return { key: st.key, source: `secret store (${backend().name})`, store: st.status };
  }
  return { key: null, source: 'none', store: st.status };
}

/** Remove anything that looks like a key from a string before printing it. */
export function scrub(text) {
  if (!text) return text;
  return String(text)
    .replace(/AIza[0-9A-Za-z_\-]{10,}/g, 'AIza***REDACTED***')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1***REDACTED***')
    .replace(/(x-goog-api-key["':\s]+)[0-9A-Za-z_\-]{10,}/gi, '$1***REDACTED***');
}

/** Human-readable description of where a key came from, with no secret in it. */
export function describe(src, key) {
  if (!key) return 'not found';
  return `${src}, ${key.length} chars`;
}

/** User-facing "here is how to store your key", per platform and status. */
export function storeHint(status) {
  const b = backend();
  if (!b) return '';
  if (status === 'empty') {
    return `\n  A ${b.name} credential exists but is empty — store it again:\n      ${b.storeHint}\n`;
  }
  if (status === 'missing') {
    return `\n  Store the key in ${b.name}:\n      ${b.storeHint}\n`;
  }
  return '';
}
