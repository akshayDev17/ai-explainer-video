/* =============================================================================
   workdir.mjs — one work dir per video, enforced rather than assumed.

   Why this exists
   ---------------
   The per-video work dir (`out/<name>/<NN>/`) holds artefacts named the SAME for
   every video: `narration.wav`, `timeline.json`, `timeline.js`, `lines.json`,
   `manifest.json`, the rendered MP4. Nothing in those names carries the video's
   identity, so pointing two videos at one directory does not fail — the second
   run silently overwrites the first's timeline, and every later stage then reads
   a timeline that describes a different video. Stage 4 is where that first
   becomes possible, which is why this check runs there.

   The fix is an identity marker, not a filename heuristic. A directory may hold
   whatever it likes — plan files, a `scripts/` dir, a single-video plan whose
   work dir genuinely IS the plan dir — and that is all fine. The only thing that
   is refused is a directory already claimed by a DIFFERENT video.

   Identity is the plan's `videoIndex`: it is the stable, monotonic key the whole
   pipeline is indexed by (see `naming.mjs`). The title is recorded too, but a
   title change is NOT a conflict — re-running `apply-enrichment` legitimately
   retitles a video, so a same-index/different-title run updates the marker and
   carries on.

   Cross-stage behaviour belongs in a tool, not in either SKILL.md — `build-audio`,
   `align` and `assemble` all import this so they cannot disagree.
   ========================================================================== */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '.video-identity';

function readMarker(dir) {
  const p = join(dir, MARKER);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

/* Atomic: a half-written marker would read as corrupt and block a legitimate run. */
function writeMarker(dir, identity) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, MARKER);
  const tmp = p + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n');
  renameSync(tmp, p);
}

/**
 * Claim (or verify) a work dir for one video.
 *
 * Exits non-zero when the dir belongs to a different `videoIndex`, naming both
 * videos and the path it was asked to write. Otherwise returns the identity now
 * recorded, writing or refreshing the marker as needed.
 *
 * @param {string} workDir  the per-video work dir the caller was given
 * @param {object} script   the parsed script.json
 * @param {string} tool     short stage label for messages, e.g. 'build-audio'
 */
export function claimWorkDir(workDir, script, tool = 'stage') {
  const idxRaw = script && script.videoIndex != null ? Number(script.videoIndex) : null;
  const idx = Number.isFinite(idxRaw) ? idxRaw : null;
  const title = String((script && script.title) || '').trim();

  const label = i => (i && i.title ? `video ${i.videoIndex} — "${i.title}"` : `video ${i.videoIndex}`);
  const mine = idx != null ? `video ${idx}${title ? ` — "${title}"` : ''}` : `an unnamed video${title ? ` ("${title}")` : ''}`;

  const prev = readMarker(workDir);

  if (prev && prev.corrupt) {
    console.error(`\n[workdir] ${workDir}/${MARKER} is unreadable — rewriting it for ${mine}.`);
    console.error(`[workdir] If that dir was already in use by another video, its artefacts may be mixed.`);
  } else if (prev && prev.videoIndex != null && idx != null && Number(prev.videoIndex) !== idx) {
    console.error(`
[workdir] Refusing to write: this work dir already belongs to ${label(prev)}.

            dir      ${workDir}
            ${tool.padEnd(8)} asked for ${mine}

          Every video's work dir holds the same file names — narration.wav,
          timeline.json, timeline.js, lines.json, manifest.json — so writing a
          second video here silently overwrites the first's timeline and every
          later stage then reads the wrong video's timings.

          Give each video its own dir:

              --out out/<name>/<videoIndex>          e.g.  --out out/<name>/${idx}

          If ${label(prev)} is finished with this dir, move or delete it first.
`);
    process.exit(3);
  } else if (prev && prev.videoIndex == null && idx == null && prev.title && title && prev.title !== title) {
    console.error(`\n[workdir] warning: ${workDir} holds "${prev.title}" but was given "${title}",`);
    console.error(`[workdir] and neither script declares a videoIndex — assuming one video. Set videoIndex in the`);
    console.error(`[workdir] script to get a hard guarantee.`);
  }

  const identity = {
    videoIndex: idx,
    title: title || null,
    claimed_by: tool,
    claimed_at: new Date().toISOString(),
    ...(prev && prev.claimed_at && idx != null && Number(prev.videoIndex) === idx ? { first_claimed_at: prev.first_claimed_at || prev.claimed_at } : {}),
  };

  /* A same-index title change is legitimate (re-enrichment retitles videos). */
  const titleChanged = !!(prev && !prev.corrupt && prev.title && title && prev.title !== title);
  writeMarker(workDir, identity);
  if (titleChanged) {
    console.log(`[workdir] retitled in place: "${prev.title}" → "${title}" (same videoIndex ${idx})`);
  }

  return identity;
}

/** Read a work dir's identity without claiming it (for reporting/diagnostics). */
export function readWorkDirIdentity(workDir) {
  return readMarker(workDir);
}
