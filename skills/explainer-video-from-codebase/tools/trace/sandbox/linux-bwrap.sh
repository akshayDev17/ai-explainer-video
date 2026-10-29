#!/bin/sh
# linux-bwrap.sh — trace.mjs's Linux sandbox (bubblewrap), for running a repo's test command.
#
# Usage: linux-bwrap.sh <scratch> <read-only paths, one per line> <command> [args...]
#
# - no network at all: a new network namespace (no route out, and its own empty loopback, so nothing on
#   the host's localhost is reachable); a seccomp filter makes socket(AF_UNIX, ...) fail with EPERM, so no
#   unix socket (docker.sock, a database or agent socket) can be connected to, wherever it lives — a
#   read-only mount does not stop a connect. socketpair() still works, so asyncio does;
# - no writes outside scratch: / is mounted read-only, the dirs that hold host state (/run, /tmp, /var/tmp,
#   home dirs) are replaced by empty tmpfs mounts, and <scratch> is the only writable host path;
# - the read-only paths (the interpreter, the original repo for editable installs) are mounted back over
#   the hidden dirs; trace.mjs never passes one that contains <scratch>;
# - new user, pid, ipc, uts and cgroup namespaces. No --die-with-parent: trace.mjs's time limit signals the whole
#   process group, and the collector must outlive bwrap long enough to write the partial trace.
# The caller passes an empty environment; bwrap hands it to the command unchanged.
set -eu
scratch=$1
ro=$2
shift 2

# the seccomp filter, as the classic-BPF program bwrap --seccomp loads (struct sock_filter, little-endian):
#   arch is not this one -> kill · x32 syscall -> kill · socket(AF_UNIX, ...) -> EPERM · anything else -> allow
case $(uname -m) in
  x86_64) arch=$((0xC000003E)); socket_nr=41 ;;
  aarch64) arch=$((0xC00000B7)); socket_nr=198 ;;
  *) echo "linux-bwrap.sh: no seccomp filter for $(uname -m)" >&2; exit 70 ;;
esac
byte() { printf "\\$(printf '%03o' "$1")"; }
ins() { byte $(($1 & 255)); byte $((($1 >> 8) & 255)); byte "$2"; byte "$3"
  byte $(($4 & 255)); byte $((($4 >> 8) & 255)); byte $((($4 >> 16) & 255)); byte $((($4 >> 24) & 255)); }
LD=32 JEQ=21 JGE=53 RET=6 KILL=$((0x80000000)) ALLOW=$((0x7FFF0000)) EPERM=$((0x00050001))
bpf="$scratch/.fmtrace-seccomp.bpf"
{
  ins $LD 0 0 4                       # 0  A = arch
  ins $JEQ 1 0 "$arch"                # 1  this arch -> 3
  ins $RET 0 0 "$KILL"                # 2
  ins $LD 0 0 0                       # 3  A = syscall number
  ins $JGE 4 0 $((0x40000000))        # 4  x32 -> 9
  ins $JEQ 0 2 "$socket_nr"           # 5  not socket() -> 8
  ins $LD 0 0 16                      # 6  A = low 32 bits of the domain argument
  ins $JEQ 2 0 1                      # 7  AF_UNIX -> 10
  ins $RET 0 0 "$ALLOW"               # 8
  ins $RET 0 0 "$KILL"                # 9
  ins $RET 0 0 "$EPERM"               # 10
} > "$bpf"

# the mount options are built back to front (each `set --` prepends), so bwrap applies them in this order:
# / read-only, /dev, /proc, the hidden dirs, scratch, the read-only paths, then runs the command
set -- -- "$@"
set -f
IFS='
'
for p in $ro; do
  set -- --ro-bind "$p" "$p" "$@"
done
unset IFS
set +f
set -- --bind "$scratch" "$scratch" "$@"
for d in /srv /media /mnt /root /home /var/tmp /tmp /run; do
  if [ -d "$d" ] && [ ! -L "$d" ]; then set -- --tmpfs "$d" "$@"; fi
done
exec bwrap --unshare-all --seccomp 3 --ro-bind / / --dev /dev --proc /proc "$@" 3<"$bpf"
