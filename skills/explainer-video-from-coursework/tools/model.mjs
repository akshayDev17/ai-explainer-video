/* =============================================================================
   model.mjs — the ONE place the duration/estimate constants live.

   These feed ONLY the estimation layer: planner packing, script-check budget,
   and pacing-check's fallback. The audio/video stages never read them — they
   measure real durations with ffprobe (build-audio → timeline.json → render).

   Both numbers are MEASURED, not guessed (video 6, the one fully-produced run):
     WPM       = 153    Gemini Aoede narration pace: 508 words → 199.0s of audio
     EXPANSION = 1.10   picture-over-narration overhead: 205.7s picture / 199.0s
                        narration = 1.03, plus a small buffer for code-heavy
                        videos we have not measured yet.

   If a future run measures a different pace, change it HERE, not in the tools.
   ========================================================================== */
export const WPM = 153;
export const EXPANSION = 1.10;
