// Runs the Piper AI voice off the main thread. Piper is lighter than Kokoro
// (tts.worker.js): it runs faster than real time even on basic laptops. Each
// voice (~60 MB) downloads once and is then kept in the browser's storage.
//
// Same messages as tts.worker.js:
// in:  { type: 'load', voice } | { type: 'generate', id, text, urgent } | { type: 'cancel' | 'bump', id }
// out: { type: 'progress', pct } | { type: 'ready', device, voice } | { type: 'error', id?, message }
//      | { type: 'audio', id, audio: Float32Array, sampleRate, ms }

import { TtsSession } from '@mintplex-labs/piper-tts-web'

// Must match the installed onnxruntime-web version (pinned in package.json).
const ORT_VERSION = '1.30.0'
const PIPER_WASM = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize'
const WASM_PATHS = {
  onnxWasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`,
  piperData: `${PIPER_WASM}.data`,
  piperWasm: `${PIPER_WASM}.wasm`,
}

let session = null
let loadId = 0
let queue = []
let busy = false

async function load(voice) {
  const my = ++loadId
  session = null
  // Lines queued for the previous voice are dropped.
  for (const job of queue) self.postMessage({ type: 'error', id: job.id, message: 'voice changed' })
  queue = []
  // The library keeps one shared session and ignores a new voice unless reset.
  TtsSession._instance = null
  let lastPct = -1
  const s = await TtsSession.create({
    voiceId: voice,
    wasmPaths: WASM_PATHS,
    progress: (p) => {
      if (!p.total || my !== loadId) return
      const pct = Math.floor((p.loaded / p.total) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        self.postMessage({ type: 'progress', pct })
      }
    },
  })
  if (my !== loadId) return // a newer voice was requested meanwhile
  session = s
  self.postMessage({ type: 'ready', device: 'wasm', voice })
  pump()
}

// Piper returns a 16-bit PCM WAV; turn it into float samples.
async function decodeWav(blob) {
  const buf = await blob.arrayBuffer()
  const view = new DataView(buf)
  const sampleRate = view.getUint32(24, true)
  let offset = 12
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(buf, offset, 4))
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') {
      const count = Math.min(size, view.byteLength - offset - 8) >> 1
      const audio = new Float32Array(count)
      for (let i = 0; i < count; i++) audio[i] = view.getInt16(offset + 8 + i * 2, true) / 32768
      return { audio, sampleRate }
    }
    offset += 8 + size + (size & 1)
  }
  throw new Error('Bad WAV from Piper')
}

async function pump() {
  if (busy || !session) return
  const job = queue.shift()
  if (!job) return
  busy = true
  try {
    const t0 = performance.now()
    const { audio, sampleRate } = await decodeWav(await session.predict(job.text))
    self.postMessage({ type: 'audio', id: job.id, audio, sampleRate, ms: performance.now() - t0 }, [audio.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', id: job.id, message: String(err?.message || err) })
  } finally {
    busy = false
    pump()
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'load') {
    load(data.voice).catch((err) => self.postMessage({ type: 'error', message: String(err?.message || err) }))
  } else if (data.type === 'generate') {
    // Lower priority number first (0 = needed now); FIFO within a priority.
    const priority = data.priority ?? (data.urgent ? 0 : 2)
    const job = { ...data, priority }
    const at = queue.findIndex((j) => j.priority > priority)
    if (at < 0) queue.push(job)
    else queue.splice(at, 0, job)
    pump()
  } else if (data.type === 'cancel') {
    queue = queue.filter((j) => j.id !== data.id)
  } else if (data.type === 'bump') {
    // A line prepared ahead is needed now: move it to the front.
    const i = queue.findIndex((j) => j.id === data.id)
    if (i > 0) queue.unshift({ ...queue.splice(i, 1)[0], priority: 0 })
  }
}
