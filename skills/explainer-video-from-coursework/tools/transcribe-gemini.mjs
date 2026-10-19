/* =============================================================================
   transcribe-gemini.mjs — word-level timings for a narration WAV.

   Gemini's TTS models return audio only (verified: the response has no timing
   fields at all). But `gemini-3.5-transcribe` can return per-word offsets when
   asked for them — the flag is `wordTimestamp`, which the API discovery schema
   documents but the prose docs never show in an example:

       generationConfig.audioTranscriptionConfig.wordTimestamp = true
       -> candidates[0].content.parts[0].audioTranscription.words[]
          { word, startOffset: "3.900s", endOffset: "4.100s" }

   Two things this module deliberately does NOT do:
     • customVocabulary — the API rejects it together with wordTimestamp.
     • trust the transcript as text. It applies inverse text normalisation
       ("forty" -> "40") and rewrites punctuation, so callers must align the
       returned words back onto their own known text. See align.mjs.

   Audio is sent inline (base64) — no Files API upload, one request per segment.
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { loadKey, scrub } from './key-source.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta';
export const MODEL = 'gemini-3.5-transcribe';

/** "12.600s" | "1.5s" -> 12.6 | 1.5 (null when absent/unparseable) */
export function parseOffset(d) {
  if (typeof d === 'number') return d;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(String(d ?? '').trim());
  return m ? parseFloat(m[1]) : null;
}

/**
 * Transcribe one WAV, returning word records with float offsets in seconds.
 *
 * @param {{wavPath:string, key?:string, languageCode?:string, retries?:number}} opts
 * @returns {Promise<{text:string, words:Array<{w:string,s:number,e:number}>, model:string}>}
 */
export async function transcribeWords({ wavPath, key, languageCode = 'en-US', retries = 3 }) {
  const apiKey = key || loadKey().key;
  if (!apiKey) throw new Error('No API key found — see key-source.mjs for the store command.');

  const b64 = readFileSync(wavPath).toString('base64');
  const body = {
    contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: b64 } }] }],
    generationConfig: {
      audioTranscriptionConfig: { languageCodes: [languageCode], wordTimestamp: true },
    },
  };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();

    if (res.status === 429 && attempt < retries) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message || msg; } catch {}
      throw new Error(`transcribe failed ${res.status}: ${scrub(msg)}`);
    }

    let json;
    try { json = JSON.parse(text); } catch { throw new Error('transcribe returned non-JSON'); }
    const part = json.candidates?.[0]?.content?.parts?.[0] || {};
    const at = part.audioTranscription;
    if (!at) {
      throw new Error(
        'transcribe returned no audioTranscription block — the model may have refused this audio.\n' +
        `  parts: ${JSON.stringify(Object.keys(part))}`
      );
    }

    const words = (at.words || []).map(w => ({
      w: String(w.word ?? ''),
      s: parseOffset(w.startOffset),
      e: parseOffset(w.endOffset),
    })).filter(w => w.s != null && w.e != null);

    if (!words.length) {
      throw new Error(
        'transcribe returned words[] empty — wordTimestamp was set but no offsets came back.\n' +
        '  Refusing to write a timing-less alignment (silent desync is worse than a hard failure).'
      );
    }
    return { text: String(at.text ?? ''), words, model: MODEL };
  }
}
