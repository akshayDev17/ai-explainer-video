/* =============================================================================
   naming.mjs — one stable, order-preserving folder name per finished video.

   The finished series lands as one folder per video:

       <destination>/<NN>-<slug>/video.mp4
       <destination>/<NN>-<slug>/description.md
       <destination>/<NN>-<slug>/captions.srt

   `NN` is the plan's `videoIndex` — the consumption order, stable and monotonic —
   and `slug` is a filesystem-safe form of the video title. Because each video owns
   its own folder, the fixed sidecar filenames (`description.md`, `captions.srt`)
   can never collide across videos, and listing the destination sorts it into
   watch order. `publish.mjs` and `assemble.mjs` both import this so the two agree
   on the folder, regardless of the ad-hoc `--name` the agent may pick.
   ========================================================================== */

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')                 // decompose, then strip combining accents
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')       // any run of non-alphanumerics → one dash
    .replace(/^-+|-+$/g, '')           // no leading/trailing dashes
    .slice(0, 64);                     // keep folders and paths short
}

/* Derive the per-video folder from the script. Falls back to `fallback` (the work
   dir's `<NN>` basename) when the script is missing or carries no index/title. */
export function videoDir(script, fallback) {
  const hasIdx = script && script.videoIndex != null;
  const idx = hasIdx ? String(script.videoIndex) : '';
  const slug = slugify(script && script.title);
  if (idx && slug) return `${idx}-${slug}`;
  if (idx) return idx;
  if (slug) return slug;
  return fallback || 'video';
}
