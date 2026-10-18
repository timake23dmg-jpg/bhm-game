// Main-thread side of the AI narrator voices, each running in a worker:
//   - Kokoro (tts.worker.js): natural and expressive. The default. Too slow on
//     many computers to speak on the fly, so lines are generated ahead.
//   - Piper (piper.worker.js): fast enough to speak on the fly on basic
//     laptops, but more robotic. Optional, and the fallback if Kokoro fails.
// Every generated line is kept in the browser (IndexedDB), so after the first
// session the host's lines play instantly. The browser's built-in voice is
// only used if picked in the lobby.

export const AUTO = 'auto'
export const BROWSER_VOICE = 'browser'
export const VOICE_GROUPS = [
  {
    label: 'Natural voices (recommended)',
    engine: 'kokoro',
    voices: [
      { id: 'af_heart', label: 'Heart (US, female)' },
      { id: 'af_bella', label: 'Bella (US, female)' },
      { id: 'am_michael', label: 'Michael (US, male)' },
      { id: 'am_fenrir', label: 'Fenrir (US, male)' },
      { id: 'bf_emma', label: 'Emma (UK, female)' },
      { id: 'bm_george', label: 'George (UK, male)' },
    ],
  },
  {
    label: 'Fast voices (read questions too, more robotic)',
    engine: 'piper',
    voices: [
      { id: 'en_US-lessac-medium', label: 'Lessac (US, female)' },
      { id: 'en_US-ryan-medium', label: 'Ryan (US, male)' },
      { id: 'en_GB-alan-medium', label: 'Alan (UK, male)' },
    ],
  },
]
const DEFAULT_VOICE = { piper: 'en_US-lessac-medium', kokoro: 'af_heart' }
const VOICE_KEY = 'fakeout.voice3'
// Generation slower than this many times the audio's own length can't keep
// up with the game on the fly (lines prepared ahead are still fine).
const LIVE_SPEED = 1.2

const engineOf = (choice) => (choice === AUTO ? 'kokoro' : choice.includes(':') ? choice.split(':')[0] : null)
const voiceOf = (choice) => (choice === AUTO ? DEFAULT_VOICE.kokoro : choice.split(':')[1])

let choice = (() => {
  try {
    return localStorage.getItem(VOICE_KEY) || AUTO
  } catch {
    return AUTO
  }
})()

// ------------------------------------------------------------------ engines

const listeners = new Set()
function emit() {
  for (const fn of listeners) fn(getAiVoiceState())
}

class Engine {
  constructor(name, makeWorker) {
    this.name = name
    this.makeWorker = makeWorker
    this.worker = null
    this.status = 'idle' // idle | loading | ready | error
    this.pct = 0
    this.voice = null // voice loaded (Piper holds one voice at a time)
    this.jobs = new Map()
    this.nextId = 1
    this.speed = null // generation time / audio length, smoothed
  }

  set(patch) {
    Object.assign(this, patch)
    emit()
  }

  // Start (or switch to) a voice. Kokoro loads once and speaks any voice.
  load(voice) {
    if (this.status === 'error') return
    if (this.name === 'kokoro' && this.worker) return
    if (this.name === 'piper' && this.worker && this.voice === voice) return
    if (!this.worker) {
      try {
        this.worker = this.makeWorker()
      } catch (err) {
        this.fail(err)
        return
      }
      this.worker.onmessage = ({ data }) => this.onMessage(data)
      this.worker.onerror = (e) => this.fail(e.message || 'worker failed')
    }
    this.voice = voice
    this.set({ status: 'loading', pct: 0 })
    this.worker.postMessage({ type: 'load', voice })
  }

  fail(err) {
    console.warn(`[fakeout] ${this.name} voice unavailable:`, err?.message || err)
    this.set({ status: 'error' })
    ensureLoaded() // Kokoro failing brings in Piper
  }

  onMessage(data) {
    if (data.type === 'progress') this.set({ pct: data.pct })
    else if (data.type === 'ready') this.set({ status: 'ready', device: data.device })
    else if (data.id != null) {
      const job = this.jobs.get(data.id)
      this.jobs.delete(data.id)
      if (!job) return
      if (data.type === 'audio') {
        const ratio = data.ms / 1000 / Math.max(0.3, data.audio.length / data.sampleRate)
        this.speed = this.speed == null ? ratio : this.speed * 0.7 + ratio * 0.3
        job.resolve({ audio: data.audio, sampleRate: data.sampleRate })
      } else job.reject(new Error(data.message))
    } else if (data.type === 'error') this.fail(data.message)
  }

  // `onId` receives the job id, so the job can be bumped later.
  // priority: 0 = needed now, then lower numbers first. `onId` receives the
  // job id, so the job can be bumped later.
  generate(text, voice, priority, onId) {
    const id = this.nextId++
    onId?.(id)
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject })
      this.worker.postMessage({ type: 'generate', id, text, voice, speed: 1.08, priority })
    })
  }

  bump(id) {
    if (this.jobs.has(id)) this.worker.postMessage({ type: 'bump', id })
  }
}

const engines = {
  kokoro: new Engine('kokoro', () => new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' })),
  piper: new Engine('piper', () => new Worker(new URL('./piper.worker.js', import.meta.url), { type: 'module' })),
}

// --------------------------------------------------------------- selection

// Which engine + voice the narrator uses right now, or null for none.
function current() {
  if (choice === BROWSER_VOICE) return null
  const want = engineOf(choice)
  if (want === 'kokoro' && engines.kokoro.status === 'ready') return { engine: 'kokoro', voice: voiceOf(choice) }
  if (want === 'piper' || engines.kokoro.status === 'error') {
    const p = engines.piper
    return p.status === 'ready' ? { engine: 'piper', voice: p.voice } : null
  }
  return null
}

// Load whatever the current choice needs (Piper only if picked, or if
// Kokoro can't run here).
function ensureLoaded() {
  if (typeof Worker === 'undefined' || choice === BROWSER_VOICE) return
  const want = engineOf(choice)
  if (want === 'kokoro') engines.kokoro.load()
  if (want === 'piper' || engines.kokoro.status === 'error') {
    engines.piper.load(want === 'piper' ? voiceOf(choice) : DEFAULT_VOICE.piper)
  }
}

export const loadAiVoice = () => ensureLoaded()

export const getVoiceChoice = () => choice
export function setVoiceChoice(id) {
  choice = id
  try {
    localStorage.setItem(VOICE_KEY, id)
  } catch {
    // choice just won't persist
  }
  ensureLoaded()
  emit()
}

export const aiVoiceActive = () => current() != null
export const browserVoiceChosen = () => choice === BROWSER_VOICE
// Fast enough to say things that can't be prepared (like the question) on the fly.
export function voiceIsLive() {
  const cur = current()
  const speed = cur && engines[cur.engine].speed
  return !!cur && speed != null && speed < LIVE_SPEED
}

// One line for the lobby: what the narrator is doing.
export function getAiVoiceState() {
  const k = engines.kokoro
  const cur = current()
  let text = ''
  let tone = 'info'
  if (choice === BROWSER_VOICE) text = 'Using the browser voice'
  else if (!cur) {
    const e = engineOf(choice) === 'kokoro' && k.status !== 'error' ? k : engines.piper
    text = e.status === 'error' ? 'AI voice unavailable on this computer' : `Downloading the host voice: ${e.pct}% (first time only)…`
  } else {
    tone = 'ready'
    text = 'Host voice ready'
    if (prep.total > prep.done) text += ` · preparing lines ${prep.done}/${prep.total} (saved for next time)`
    else if (!voiceIsLive() && cur.engine === 'kokoro' && engines.kokoro.speed != null) text += ' · questions shown, not read (slow computer)'
  }
  return { text, tone, choice }
}

export function subscribeAiVoice(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ------------------------------------------------------- saved lines (IDB)

const DB_NAME = 'fakeout-voice'
const STORE = 'lines'
let dbPromise = null
function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch(() => null)
  return dbPromise
}

async function loadSaved(key) {
  try {
    const d = await db()
    if (!d) return null
    const row = await new Promise((resolve, reject) => {
      const req = d.transaction(STORE).objectStore(STORE).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!row) return null
    const audio = new Float32Array(row.pcm.length)
    for (let i = 0; i < audio.length; i++) audio[i] = row.pcm[i] / 32767
    return { audio, sampleRate: row.sampleRate }
  } catch {
    return null
  }
}

async function save(key, { audio, sampleRate }) {
  try {
    const d = await db()
    if (!d) return
    const pcm = new Int16Array(audio.length)
    for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-1, Math.min(1, audio[i])) * 32767
    d.transaction(STORE, 'readwrite').objectStore(STORE).put({ pcm, sampleRate }, key)
  } catch {
    // just won't be saved
  }
}

// ------------------------------------------------------------ synthesizing

const cache = new Map() // key -> Promise<{ audio, sampleRate }>
const prep = { total: 0, done: 0 } // lines prepared ahead, for the lobby status

// Audio for a line in the current voice: from memory, then from the browser's
// saved lines, else generated (and saved). `urgent` jumps the queue (a line
// needed now); lines prepared ahead go by `priority` (lower first).
export function synthesize(text, { urgent = false, priority = 2 } = {}) {
  const cur = current()
  if (!cur) return Promise.reject(new Error('no AI voice ready'))
  const key = `${cur.engine}:${cur.voice}|${text}`
  let p = cache.get(key)
  if (p) {
    if (urgent && p.jobId != null) engines[cur.engine].bump(p.jobId)
    return p
  }
  p = (async () => {
    const saved = await loadSaved(key)
    if (saved) return saved
    const r = await engines[cur.engine].generate(text, cur.voice, urgent ? 0 : priority, (id) => {
      p.jobId = id
    })
    save(key, r)
    return r
  })()
  if (!urgent) {
    prep.total++
    p.finally(() => {
      prep.done++
      emit()
    })
  }
  p.then(() => {
    p.jobId = null
  }, () => cache.delete(key))
  cache.set(key, p)
  return p
}
