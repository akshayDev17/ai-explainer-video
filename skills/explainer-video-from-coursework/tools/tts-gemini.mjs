// Google Gemini TTS backend — no npm dependencies (Node 22 global fetch).
//
//   node tools/tts-gemini.mjs --probe
//   node tools/tts-gemini.mjs --text "Hello there" --voice Kore --style "warm, conversational" --out out.wav
//   node tools/tts-gemini.mjs --voices
//
// Auth (first hit wins, no key is ever logged or echoed):
//   1. --key <value>          explicit CLI arg — transient, visible in ps
//   2. the OS secret store    macOS Keychain · Linux secret-tool · Windows Credential Manager
//
// Model: gemini-3.8-flash-tts  (Interactions API)
//   POST https://generativelanguage.googleapis.com/v1beta/interactions
//   Response: interaction.output_audio.data  -> base64 WAV
//
// TTS is "controllable": `speech_metadata.style` steers style, accent, pace, tone.

import { writeFileSync, readFileSync } from 'node:fs';
import { loadKey, scrub, describe, storeHint } from './key-source.mjs';

export const API = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
export const FALLBACK_MODEL = 'gemini-3.8-flash-lite-tts';

// Prebuilt voice options (from the Gemini TTS docs).
export const VOICES = [
  'Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

let lastSource = 'none';

function apiKey(explicit) {
  const { key, source, store } = loadKey(explicit);
  lastSource = source;
  if (!key) {
    throw new Error(
      'No API key found. Store it in your OS secret store, then re-run.\n' +
      storeHint(store) +
      '  One-off override: pass --key <value> (visible in the process list).\n' +
      '  Free key: https://aistudio.google.com/apikey'
    );
  }
  return key;
}

/** Scrub anything key-shaped out of an error message before it is shown. */
const safe = msg => scrub(msg);

function errMessage(json, text) {
  // Google returns either {error:{message}} or [{error:{message}}]
  const j = Array.isArray(json) ? json[0] : json;
  return scrub(j?.error?.message || text.slice(0, 400).replace(/\s+/g, ' '));
}

/**
 * Locate the audio payload in an Interactions response.
 *
 * The SDK exposes a convenience field `output_audio`, but the raw REST body
 * nests it as a model_output step:
 *   steps[i].content[j] = { type:"audio", mime_type:"audio/wav", data:"<base64>" }
 * Handle the SDK shape too, in case it is ever present.
 */
function extractAudio(json) {
  const direct = json?.output_audio || json?.outputAudio;
  if (direct?.data) return { data: direct.data, mime: direct.mime_type || 'audio/wav' };

  for (const step of json?.steps || []) {
    for (const c of step?.content || []) {
      const isAudio = c?.type === 'audio' || String(c?.mime_type || '').startsWith('audio/');
      if (c?.data && isAudio) return { data: c.data, mime: c.mime_type || 'audio/wav' };
    }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * POST/GET with automatic retry, but ONLY for limits that can plausibly clear.
 *
 * Free tier has BOTH:
 *   • RPM  — "3 requests per minute"      -> retry after Ns, works
 *   • RPD  — "10 requests per day"        -> retry after Nh, futile; fail fast
 *
 * Retrying an RPD exhaustion just burns wall-clock for nothing, so detect it
 * from the message and abort immediately with an actionable error.
 */
async function call(path, body, key, method = 'POST', { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (res.status === 429) {
      const msg = errMessage(json, text);

      // Daily quota: not worth waiting for.
      if (/per day/i.test(msg) || /retry in\s*\d+\s*h/i.test(msg)) {
        const eta = /retry in\s*([0-9hm\s.]+)/i.exec(msg)?.[1]?.trim() || 'unknown';
        const err = new Error(
          `Daily quota exhausted (${eta} until reset, ~midnight Pacific).\n` +
          `  ${msg}\n` +
          `  Options: wait for the reset, enable billing (Tier 1 raises limits; ` +
          `this whole build costs ~2 cents), or use a different model which has its own quota:\n` +
          `    --model gemini-3.8-flash-lite-tts\n` +
          `    --model gemini-2.5-flash-preview-tts`
        );
        err.daily = true;
        throw err;
      }

      // Per-minute throttle: waiting genuinely helps.
      if (attempt < retries) {
        const m = /retry in\s*(\d+(?:\.\d+)?)\s*s/i.exec(msg);
        const wait = m ? Math.ceil(parseFloat(m[1])) + 3 : 25 * (attempt + 1);
        process.stderr.write(`  [rate limit] per-minute 429 — waiting ${wait}s (retry ${attempt + 1}/${retries})\n`);
        await sleep(wait * 1000);
        continue;
      }
    }
    return { status: res.status, ok: res.ok, json, text };
  }
}

/** Synthesize one segment -> WAV buffer. */
export async function synthesize({
  text,
  voice = 'Kore',
  style = 'warm, natural, conversational — like explaining to a colleague',
  model = DEFAULT_MODEL,
  key,
  speechConfig,
} = {}) {
  const k = apiKey(key);

  // A voice id from voice replication / voice design is passed through as-is;
  // a prebuilt voice is passed by name. Both go in speech_config[].voice.
  const voiceEntry = speechConfig || { voice };

  const body = {
    model,
    input: [{
      type: 'user_input',
      content: [{
        type: 'text',
        text,
        annotations: style ? [{ type: 'speech_metadata', style }] : [],
      }],
    }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [voiceEntry] },
  };

  const r = await call('/interactions', body, k);
  if (!r.ok) {
    const msg = errMessage(r.json, r.text);
    throw new Error(`Gemini TTS ${r.status}: ${msg}`);
  }
  const audio = extractAudio(r.json);
  if (!audio) {
    throw new Error('No audio in response. Top-level keys: ' +
      Object.keys(r.json || {}).join(', '));
  }
  const wav = Buffer.from(audio.data, 'base64');
  return { wav, mime: audio.mime, usage: r.json?.usage || null, raw: r.json };
}

/* ---- Batch TTS (generateContent + batchGenerateContent) ----
   Batch is token-metered, not request-metered, so it sidesteps the per-day RPD
   wall. It is generateContent-only and uses a DIFFERENT voice schema than the
   Interactions API: speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName. */

export function genTtsRequest(text, style, voice) {
  const part = { text };
  if (style) part.speech_metadata = { style };
  return {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
}

/**
 * Synthesize many styled segments in one batch job. Returns the segments that
 * produced audio, so a partial success still yields something.
 *
 * Fallback ladder: on a quota/transient failure the *remaining* segments spill
 * onto `fallbackModel` — the "exhaust one model's daily budget, then the next"
 * behaviour. The whole job is never silently downgraded; only the leftovers are.
 *
 * @returns {Promise<{segments: Array<{key, wav}>, jobs: number}>}
 */
export async function synthesizeBatch({
  segments,                          // [{ key, text, style }]
  voice = 'Kore',
  model = DEFAULT_MODEL,
  fallbackModel = FALLBACK_MODEL,
  key,
  pollMs = 15000,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  const k = apiKey(key);
  const done = new Map();            // key -> WAV Buffer

  const submit = async (m, segs) => {
    const body = {
      batch: {
        display_name: 'narration',
        input_config: {
          requests: {
            requests: segs.map(s => ({ request: genTtsRequest(s.text, s.style, voice), metadata: { key: s.key } })),
          },
        },
      },
    };
    const res = await fetch(`${API}/models/${m}:batchGenerateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!res.ok) {
      const msg = scrub(json?.error?.message || text).slice(0, 300).replace(/\s+/g, ' ');
      const err = new Error(`batch ${res.status}: ${msg}`);
      err.quota = /quota|per day|RESOURCE_EXHAUSTED|exhausted/i.test(msg);
      err.transient = err.quota || res.status === 429 || res.status === 503;
      throw err;
    }
    const name = json?.name || json?.metadata?.name;
    if (!name) throw new Error('batch submit returned no job name');
    return name;
  };

  const poll = async (name) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      if (Date.now() > deadline) {
        const e = new Error(`batch job not finished after ${Math.round(timeoutMs / 60000)} min (${name})`);
        e.timeout = true; throw e;
      }
      await sleep(pollMs);
      const res = await fetch(`${API}/${name}`, { headers: { 'x-goog-api-key': k } });
      const gj = await res.json();
      const state = gj?.state || gj?.metadata?.state;
      if (state !== last) { process.stderr.write(`  [batch] ${state}\n`); last = state; }
      if (state === 'BATCH_STATE_SUCCEEDED') return gj;
      if (state === 'BATCH_STATE_FAILED' || state === 'BATCH_STATE_CANCELLED') {
        throw new Error(`batch job ${state}`);
      }
    }
  };

  /* Map each inlined response back to its segment (by echoed metadata key, else
     by request order) and stash any audio. Returns the segments still missing. */
  const harvest = (job, segs) => {
    const list = job?.metadata?.output?.inlinedResponses?.inlinedResponses
      || job?.output?.inlinedResponses?.inlinedResponses || [];
    list.forEach((item, i) => {
      const parts = item?.response?.candidates?.[0]?.content?.parts || [];
      const audio = parts.find(p => (p?.inlineData?.mimeType || '').startsWith('audio'));
      if (!audio) return;
      const mk = item?.metadata?.key;
      const seg = mk ? segs.find(s => s.key === mk) : segs[i];
      if (seg) done.set(seg.key, Buffer.from(audio.inlineData.data, 'base64'));
    });
    return segs.filter(s => !done.has(s.key));
  };

  const rungs = [model];
  if (fallbackModel && fallbackModel !== model) rungs.push(fallbackModel);

  let pending = segments.slice();
  let jobs = 0;
  for (const m of rungs) {
    if (!pending.length) break;
    let failed = [];
    try {
      const name = await submit(m, pending);
      jobs++;
      failed = harvest(await poll(name), pending);
    } catch (e) {
      if (!e.transient && !e.timeout && !/BATCH_STATE_FAILED/.test(e.message)) throw e;
      process.stderr.write(`  [batch] ${m} unavailable — ${e.message.split('\n')[0]}\n`);
      failed = pending.slice();       // retry everything on the next rung
    }
    pending = failed;
  }

  if (pending.length) {
    throw new Error(`[batch] ${pending.length} segment(s) still lack audio after all models: ${pending.map(s => s.key).join(', ')}`);
  }
  return {
    segments: segments.filter(s => done.has(s.key)).map(s => ({ key: s.key, wav: done.get(s.key) })),
    jobs,
  };
}

/** List voices available to this project (prebuilt + extended library + custom). */
export async function listVoices(key) {
  const r = await call('/voices', null, apiKey(key), 'GET');
  if (!r.ok) throw new Error(`voices ${r.status}: ${errMessage(r.json, r.text)}`);
  return r.json;
}

/** Voice replication: reference audio + consent audio -> voice id. */
export async function replicateVoice({ referenceWav, consentWav, displayName = 'Replicated Voice', model = DEFAULT_MODEL, store = true, key } = {}) {
  const k = apiKey(key);
  const b64 = p => (Buffer.isBuffer(p) ? p : readFileSync(p)).toString('base64');
  const r = await call('/voices', {
    store,
    voice: {
      model,
      type: 'replicated',
      display_name: displayName,
      replicated: {
        source_audio: { mime_type: 'audio/wav', data: b64(referenceWav) },
        consent_audio: { mime_type: 'audio/wav', data: b64(consentWav) },
      },
    },
  }, k);
  if (!r.ok) throw new Error(`replicate ${r.status}: ${errMessage(r.json, r.text)}`);
  return r.json;
}

/* ---------------- CLI ---------------- */
const isMain = process.argv[1] && process.argv[1].endsWith('tts-gemini.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf('--' + n);
    return i === -1 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
  };

  try {
    if (flag('probe')) {
      const k = apiKey(flag('key'));
      console.log(`[auth] key source: ${describe(lastSource, k)}`);   // never the key itself
      console.log('[probe] POST /v1beta/interactions  (expect 200 with a valid key)\n');
      const r = await call('/interactions', {
        model: DEFAULT_MODEL,
        input: [{ type: 'user_input', content: [{ type: 'text', text: 'Testing one two three.',
          annotations: [{ type: 'speech_metadata', style: 'neutral' }] }] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: 'Kore' }] },
      }, k);
      console.log('  status:', r.status);
      if (r.ok) {
        const a = extractAudio(r.json);
        if (a) {
          const n = Buffer.from(a.data, 'base64').length;
          console.log(`  AUDIO OK — ${n} bytes, ${a.mime}`);
          if (r.json.usage?.total_output_tokens != null) {
            console.log(`  output tokens: ${r.json.usage.total_output_tokens}`);
          }
        } else {
          console.log('  no audio found. keys:', Object.keys(r.json || {}).join(', '));
        }
      } else {
        console.log('  body:', scrub(r.json?.error?.message || r.text).slice(0, 400));
      }
    } else if (flag('voices')) {
      const v = await listVoices(flag('key'));
      console.log(JSON.stringify(v, null, 2).slice(0, 2000));
    } else if (flag('text')) {
      const { wav } = await synthesize({
        text: String(flag('text')),
        voice: flag('voice', 'Kore'),
        style: flag('style', undefined),
        model: flag('model', DEFAULT_MODEL),
        key: flag('key'),
      });
      const out = flag('out', 'tts-out.wav');
      writeFileSync(out, wav);
      console.log(`[ok] ${out}  ${(wav.length / 1024).toFixed(0)} KB`);
    } else {
      console.log('usage: --probe | --voices | --text "..." [--voice Kore] [--style "..."] [--out f.wav]');
    }
  } catch (e) {
    console.error('[error]', scrub(e.message));
    process.exit(1);
  }
}
