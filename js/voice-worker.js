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
      const parts = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const audio = await tts.generate(parts[i], { voice, speed });
        const wav = audio.toWav();
        self.postMessage({ type: 'audio', id: m.id, wav, part: i, last: i === parts.length - 1 }, [wav]);
      }
      if (!parts.length) self.postMessage({ type: 'error', id: m.id, message: 'nothing to say' });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
    }
  });
};
