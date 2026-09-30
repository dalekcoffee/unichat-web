/* UniChat voice: turns alert text into speech with Kokoro (an open-source voice model, Apache-2.0), entirely on this
   device, in the background so the chat never freezes. Everything it loads comes from this site (vendor/kokoro/):
   the model downloads once (about 90 MB) and the browser keeps it.
   Messages in:  { type: 'load' } · { type: 'speak', id, text, voice, speed }
   Messages out: { type: 'ready' } · { type: 'audio', id, wav } · { type: 'error', id, message } */
import { KokoroTTS, env } from '../vendor/kokoro/kokoro.web.js';

env.wasmPaths = new URL('../vendor/kokoro/', import.meta.url).href;
const VOICES = ['af_heart', 'af_kore', 'af_bella', 'af_sky'];
let loading = null;

function load() {
  if (!loading) {
    loading = KokoroTTS.from_pretrained('model', { dtype: 'q8', device: 'wasm' })
      .then(tts => { self.postMessage({ type: 'ready' }); return tts; })
      .catch(err => { loading = null; throw err; });
  }
  return loading;
}

// The voices come out quiet and uneven (Sky is softer than Heart), so every line is brought to the same loudness,
// without letting its loudest moment clip.
function level(samples) {
  if (!samples || !samples.length) return;
  let peak = 0, sum = 0;
  for (const v of samples) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
  const rms = Math.sqrt(sum / samples.length);
  if (!rms || !peak) return;
  const gain = Math.min(0.1 / rms, 0.95 / peak);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
}

// One at a time, in order.
let chain = Promise.resolve();
self.onmessage = ev => {
  const m = ev.data || {};
  if (m.type === 'load') { load().catch(err => self.postMessage({ type: 'error', message: String(err && err.message || err) })); return; }
  if (m.type !== 'speak') return;
  chain = chain.then(async () => {
    try {
      const tts = await load();
      const voice = VOICES.includes(m.voice) ? m.voice : VOICES[0];
      const text = String(m.text || '').slice(0, 500);
      const speed = Math.max(0.5, Math.min(2, Number(m.speed) || 1));
      // Sentence by sentence, so the first one can play while the rest is still being made.
      // A long stretch without full stops is cut after a comma, or else between words, at about 120 characters.
      const parts = text.split(/(?<=[.!?…])\s+/).flatMap(s => {
        const out = [];
        s = s.trim();
        while (s.length > 150) {
          const cut = s.lastIndexOf(', ', 130) > 40 ? s.lastIndexOf(', ', 130) + 1 : (s.lastIndexOf(' ', 120) > 40 ? s.lastIndexOf(' ', 120) : 120);
          out.push(s.slice(0, cut).trim());
          s = s.slice(cut).trim();
        }
        out.push(s);
        return out;
      }).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const audio = await tts.generate(parts[i], { voice, speed });
        level(audio.audio);
        const wav = audio.toWav();
        self.postMessage({ type: 'audio', id: m.id, wav, part: i, last: i === parts.length - 1 }, [wav]);
      }
      if (!parts.length) self.postMessage({ type: 'error', id: m.id, message: 'nothing to say' });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
    }
  });
};
