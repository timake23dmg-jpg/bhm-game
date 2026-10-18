// Runs the Kokoro AI voice off the main thread, so speech generation never
// stutters the TV's animations. The model (~90-330 MB depending on device) is
// downloaded from Hugging Face once and then served from the browser cache.
//
// in:  { type: 'load', device? } | { type: 'generate', id, text, voice, speed, urgent } | { type: 'cancel' | 'bump', id }
// out: { type: 'progress', pct } | { type: 'ready', device } | { type: 'error', id?, message }
//      | { type: 'audio', id, audio: Float32Array, sampleRate, ms }

import { KokoroTTS } from 'kokoro-js'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
let tts = null
let queue = []
let busy = false

async function hasWebGPU() {
  try {
    return !!(await navigator.gpu?.requestAdapter())
  } catch {
    return false
  }
}

async function load(forceDevice) {
  // WebGPU (graphics card) is fast but wants the full-precision model; the
  // CPU fallback uses the smaller 8-bit one.
  const device = forceDevice || ((await hasWebGPU()) ? 'webgpu' : 'wasm')
  const files = new Map()
  let lastPct = -1
  tts = await KokoroTTS.from_pretrained(MODEL, {
    device,
    dtype: device === 'webgpu' ? 'fp32' : 'q8',
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return
      files.set(p.file, p)
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      const pct = Math.floor((loaded / total) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        self.postMessage({ type: 'progress', pct })
      }
    },
  })
  self.postMessage({ type: 'ready', device })
}

async function pump() {
  if (busy || !tts) return
  const job = queue.shift()
  if (!job) return
  busy = true
  try {
    const t0 = performance.now()
    const out = await tts.generate(job.text, { voice: job.voice, speed: job.speed })
    const audio = out.audio
    self.postMessage({ type: 'audio', id: job.id, audio, sampleRate: out.sampling_rate, ms: performance.now() - t0 }, [audio.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', id: job.id, message: String(err?.message || err) })
  } finally {
    busy = false
    pump()
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'load') {
    load(data.device).then(pump).catch((err) => self.postMessage({ type: 'error', message: String(err?.message || err) }))
  } else if (data.type === 'generate') {
    // Newest requests first: a line for what's on screen now beats a warm-up.
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
