// Procedural sound for the host screen (Web Audio, no asset files).
// SFX, music and the narrator voice have separate volumes, plus a master mute
// (the mute button). Music ducks while the narrator speaks (narrator.js).
// When the lobby theme plays is decided in lobbyMusic.js.

let ctx = null
let sfxGain = null
let musicGain = null
let voiceGain = null
let volumes = { music: 0.35, sfx: 0.8, voice: 1 }
let masterMuted = false
let ducked = false
const volumeListeners = new Set()
const DUCK_LEVEL = 0.3

// Effective music level (after ducking), also used by the lobby song.
export const musicLevel = () => volumes.music * (ducked ? DUCK_LEVEL : 1)

function applyGains() {
  if (sfxGain) sfxGain.gain.value = masterMuted ? 0 : volumes.sfx
  if (musicGain) musicGain.gain.setTargetAtTime(masterMuted ? 0 : musicLevel(), ctx.currentTime, 0.08)
  if (voiceGain) voiceGain.gain.value = masterMuted ? 0 : volumes.voice
}

function emitVolumes() {
  for (const fn of volumeListeners) fn(volumes)
}

export function setDucked(value) {
  if (ducked === value) return
  ducked = value
  applyGains()
  emitVolumes()
}

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    ctx = new AC()
    sfxGain = ctx.createGain()
    musicGain = ctx.createGain()
    voiceGain = ctx.createGain()
    applyGains()
    sfxGain.connect(ctx.destination)
    musicGain.connect(ctx.destination)
    voiceGain.connect(ctx.destination)
    // Music waits for the context to actually be running (resume is async).
    ctx.addEventListener('statechange', syncMusic)
    if (import.meta.env.DEV) devMeter()
  }
  if (ctx.state === 'suspended') ctx.resume()
  syncMusic()
}

// Host screen: any click or key press unlocks audio (browsers only allow
// sound after a user gesture), so music starts without a special button.
export function enableGestureUnlock() {
  const unlock = () => unlockAudio()
  const types = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']
  for (const type of types) document.addEventListener(type, unlock, { capture: true, passive: true })
  return () => {
    for (const type of types) document.removeEventListener(type, unlock, { capture: true })
  }
}

export function setVolumes(v) {
  volumes = { ...volumes, ...v }
  applyGains()
  emitVolumes()
}

export const getVolumes = () => volumes
export const audioReady = () => !!ctx && ctx.state === 'running'

// Play generated speech (the AI narrator) on the voice channel. Returns a
// handle whose `ended` promise settles when it finishes or is stopped.
export function playVoice(samples, sampleRate) {
  if (!ctx) return null
  const buf = ctx.createBuffer(1, samples.length, sampleRate)
  buf.copyToChannel(samples, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(voiceGain)
  const ended = new Promise((resolve) => {
    src.onended = resolve
  })
  src.start()
  return {
    ended,
    stop: () => {
      try {
        src.stop()
      } catch {
        // already stopped
      }
    },
  }
}
export const isMasterMuted = () => masterMuted

export function onVolumesChange(fn) {
  volumeListeners.add(fn)
  return () => volumeListeners.delete(fn)
}

export function setMasterMuted(value) {
  masterMuted = value
  applyGains()
  if (value) {
    try {
      window.speechSynthesis?.cancel()
    } catch {
      // no TTS
    }
  }
}

function tone({ freq, to, type = 'sine', dur = 0.15, vol = 0.3, at = 0, out = sfxGain, attack = 0.005 }) {
  if (!ctx) return
  const t = ctx.currentTime + at
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g).connect(out)
  osc.start(t)
  osc.stop(t + dur + 0.05)
}

function noise({ dur = 0.3, vol = 0.2, at = 0, from = 800, to = 4000, q = 1 }) {
  if (!ctx) return
  const t = ctx.currentTime + at
  const len = Math.floor(ctx.sampleRate * dur)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  const src = ctx.createBufferSource()
  src.buffer = buf
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = q
  filter.frequency.setValueAtTime(from, t)
  filter.frequency.exponentialRampToValueAtTime(to, t + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  src.connect(filter).connect(g).connect(sfxGain)
  src.start(t)
}

const SOUNDS = {
  whoosh: () => noise({ dur: 0.4, vol: 0.25, from: 400, to: 3000 }),
  drum: () => {
    tone({ freq: 120, to: 40, dur: 0.35, vol: 0.8 })
    noise({ dur: 0.15, vol: 0.3, from: 2000, to: 800 })
    tone({ freq: 90, to: 30, dur: 0.3, vol: 0.6, at: 0.25 })
  },
  flick: () => noise({ dur: 0.08, vol: 0.3, from: 3000, to: 5000, q: 3 }),
  ding: () => {
    tone({ freq: 1320, dur: 0.6, vol: 0.25 })
    tone({ freq: 1980, dur: 0.4, vol: 0.1 })
  },
  typeTick: () => tone({ freq: 2400, type: 'square', dur: 0.02, vol: 0.05 }),
  pop: () => tone({ freq: 500, to: 1200, dur: 0.09, vol: 0.3 }),
  tick: () => tone({ freq: 1000, type: 'square', dur: 0.04, vol: 0.12 }),
  bubble: () => tone({ freq: 300 + Math.random() * 400, to: 900, dur: 0.1, vol: 0.2 }),
  riser: () => noise({ dur: 1.6, vol: 0.18, from: 300, to: 6000, q: 4 }),
  buzzer: () => {
    tone({ freq: 110, type: 'sawtooth', dur: 0.45, vol: 0.3 })
    tone({ freq: 116, type: 'sawtooth', dur: 0.45, vol: 0.3 })
  },
  chaChing: () => {
    tone({ freq: 1568, type: 'triangle', dur: 0.15, vol: 0.3 })
    tone({ freq: 2093, type: 'triangle', dur: 0.4, vol: 0.3, at: 0.1 })
    noise({ dur: 0.3, vol: 0.12, from: 5000, to: 8000, at: 0.1, q: 2 })
  },
  drumroll: () => {
    for (let i = 0; i < 20; i++) noise({ dur: 0.06, vol: 0.12 + i * 0.01, from: 1500, to: 900, at: i * 0.05 })
  },
  fanfare: () => {
    ;[523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: i === 3 ? 0.8 : 0.18, vol: 0.28, at: i * 0.14 }))
  },
  sadTrombone: () => {
    ;[392, 370, 349].forEach((f, i) => tone({ freq: f, type: 'sawtooth', dur: 0.4, vol: 0.12, at: i * 0.42 }))
    tone({ freq: 330, to: 300, type: 'sawtooth', dur: 1.1, vol: 0.12, at: 1.26 })
  },
  blip: () => tone({ freq: 700 + Math.random() * 500, dur: 0.07, vol: 0.15 }),
  // The liar's nose growing: a wooden creak, then a springy boing.
  creak: () => {
    noise({ dur: 0.32, vol: 0.22, from: 220, to: 700, q: 14 })
    tone({ freq: 140, to: 260, type: 'sawtooth', dur: 0.28, vol: 0.06 })
    tone({ freq: 260, to: 620, type: 'triangle', dur: 0.12, vol: 0.22, at: 0.26 })
    tone({ freq: 620, to: 420, type: 'triangle', dur: 0.3, vol: 0.12, at: 0.38 })
  },
  // A press camera's shutter.
  shutter: () => {
    noise({ dur: 0.05, vol: 0.35, from: 4000, to: 6000, q: 2 })
    noise({ dur: 0.07, vol: 0.25, from: 2500, to: 1800, q: 2, at: 0.07 })
  },
  cheer: () => {
    noise({ dur: 2.2, vol: 0.2, from: 800, to: 1800, q: 0.5 })
    SOUNDS.fanfare()
  },
  chime: () => {
    tone({ freq: 880, dur: 0.5, vol: 0.2 })
    tone({ freq: 1320, dur: 0.7, vol: 0.15, at: 0.12 })
  },
}

export function sfx(name) {
  if (!ctx || !volumes.sfx || masterMuted) return
  SOUNDS[name]?.()
}

// ------------------------------------------------------------------ music
//
// Procedural backing tracks for the whole game (the lobby has its real song,
// see lobbyMusic.js). A small step sequencer: each song is a chord loop plus
// 16-step patterns per bar for drums, bass, arpeggio and a soft pad.
//
// Pattern characters: drums 'x' = hit, 'o' = soft hit; bass/arp digits pick a
// chord tone (0 = root, 1, 2, ... wrapping up an octave); '.' = rest.
//
// Notes are scheduled ahead on the audio clock (not by timer timing), so the
// music stays in time when timers jitter. Each song has its own gain node, so
// switching songs crossfades and silences notes already scheduled.

const midi = (n) => 440 * 2 ** ((n - 69) / 12)

const SONGS = {
  // The Fakeout theme: relaxed and groovy, for the lobbies (TV and phones).
  lobby: {
    bpm: 100,
    chords: [[60, 64, 67, 71], [57, 60, 64, 67], [62, 65, 69, 72], [55, 59, 62, 65]], // Cmaj7 Am7 Dm7 G7
    kick: 'x.....x...x.....',
    snare: '....x.......x...',
    hat: 'o.o.o.o.o.o.o.o.',
    bass: '0..2..0.1..2..0.',
    arp: '0.2.1.3.2.0.3.1.',
    arpType: 'triangle',
    pad: 0.035,
  },
  // Upbeat, for titles, category picks, questions and scores.
  bounce: {
    bpm: 112,
    chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]], // C Am F G
    kick: 'x.......x.......',
    snare: '....x.......x...',
    hat: '..o...o...o...o.',
    bass: '0..0..2.0..0.2..',
    arp: '0.1.2.1.3.2.1.2.',
    arpType: 'triangle',
    pad: 0.035,
  },
  // Mellow and jazzy while players write their lies.
  think: {
    bpm: 92,
    chords: [[65, 69, 72, 76], [64, 67, 71, 74], [62, 65, 69, 72], [60, 64, 67, 71]], // Fmaj7 Em7 Dm7 Cmaj7
    kick: 'x.........x.....',
    snare: '....o.......o...',
    hat: 'o.o.o.o.o.o.o.o.',
    bass: '0.....2...0...1.',
    arp: '3...2.....1...2.',
    arpType: 'sine',
    pad: 0.045,
  },
  // Driving and tense while players pick the truth.
  tense: {
    bpm: 128,
    chords: [[57, 60, 64], [57, 60, 64], [53, 57, 60], [52, 56, 59]], // Am Am F E
    kick: 'x...x...x...x...',
    snare: '....x.......x..o',
    hat: 'oxoxoxoxoxoxoxox',
    bass: '0.0.0.0.0.0.0.0.',
    arp: '0.2.3.2.0.2.3.2.',
    arpType: 'square',
    pad: 0,
  },
  // A quiet heartbeat under the reveal, so the drumrolls and stamps land.
  reveal: {
    bpm: 72,
    chords: [[57, 60, 64], [53, 57, 60]], // Am F
    kick: 'x..o............',
    snare: '................',
    hat: '................',
    bass: '0...............',
    arp: '................',
    arpType: 'sine',
    pad: 0.03,
  },
  // Celebration for the winner and awards.
  victory: {
    bpm: 124,
    chords: [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]], // C F G C
    kick: 'x...x...x...x...',
    snare: '....x.......x.x.',
    hat: 'o.x.o.x.o.x.o.x.',
    bass: '0.0.2.0.0.0.2.1.',
    arp: '0123012301230123',
    arpType: 'triangle',
    pad: 0.03,
  },
}

// Stand-ins for the news theme and the round sting while they load.
SONGS.news = SONGS.bounce
SONGS.sting = SONGS.bounce

// Which song each game phase gets (no entry = silence).
const PHASE_SONGS = {
  INTRO: 'news', ROUND_TITLE: 'sting', FINAL_TITLE: 'sting', CATEGORY_PICK: 'bounce', QUESTION: 'bounce',
  LIE_ENTRY: 'think', PICK_TRUTH: 'tense', REVEAL: 'reveal', SCOREBOARD: 'bounce',
  WINNER: 'victory', AWARDS: 'victory',
}
export const songForPhase = (phase) => PHASE_SONGS[phase] ?? null

const LOOKAHEAD = 1.0 // seconds scheduled ahead (covers background-tab timer throttling)
const TICK_MS = 200
const FADE_IN = 0.6
const FADE_OUT = 0.8
const MUSIC_BOOST = 2 // the songs are written quiet; this matches the lobby song's level

let musicBus = null // compressor shared by all songs, into musicGain
let noiseBuf = null
let wantedSong = null // what should be playing (kept even before audio is unlocked)
let playing = null // { name, out, kind: 'synth' | 'track', stop() }
const musicListeners = new Set()

// What's audible right now (null while silent or before audio is unlocked).
export const currentSong = () => playing?.name ?? null
export function onMusicChange(fn) {
  musicListeners.add(fn)
  return () => musicListeners.delete(fn)
}

function setupMusicBus() {
  if (musicBus) return
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -18
  comp.ratio.value = 4
  comp.attack.value = 0.01
  comp.release.value = 0.2
  const boost = ctx.createGain()
  boost.gain.value = MUSIC_BOOST
  comp.connect(boost).connect(musicGain)
  musicBus = comp
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const data = noiseBuf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
}

function env(g, t, peak, attack, dur) {
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(peak, t + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
}

function kick(out, t, v) {
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.frequency.setValueAtTime(150, t)
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12)
  env(g, t, v, 0.003, 0.28)
  o.connect(g).connect(out)
  o.start(t)
  o.stop(t + 0.3)
}

function noiseHit(out, t, v, { hp, dur }) {
  const s = ctx.createBufferSource()
  s.buffer = noiseBuf
  const f = ctx.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = hp
  const g = ctx.createGain()
  env(g, t, v, 0.002, dur)
  s.connect(f).connect(g).connect(out)
  s.start(t, Math.random() * 0.5)
  s.stop(t + dur + 0.02)
}

function snare(out, t, v) {
  noiseHit(out, t, v, { hp: 1500, dur: 0.16 })
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.frequency.setValueAtTime(220, t)
  o.frequency.exponentialRampToValueAtTime(140, t + 0.08)
  env(g, t, v * 0.5, 0.002, 0.1)
  o.connect(g).connect(out)
  o.start(t)
  o.stop(t + 0.12)
}

function voice(out, t, freq, dur, v, { type, cutoff, attack = 0.005, detune = 0 }) {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.value = freq
  o.detune.value = detune
  const f = ctx.createBiquadFilter()
  f.type = 'lowpass'
  f.frequency.value = cutoff
  const g = ctx.createGain()
  env(g, t, v, attack, dur)
  o.connect(f).connect(g).connect(out)
  o.start(t)
  o.stop(t + dur + 0.05)
}

// Chord tone by index: 0 = root, wrapping up an octave past the last tone.
const chordTone = (chord, i) => chord[i % chord.length] + 12 * Math.floor(i / chord.length)

function playStep(song, out, step, t, sixteenth) {
  const pos = step % 16
  const chord = song.chords[Math.floor(step / 16) % song.chords.length]
  const hit = (pattern) => pattern[pos]
  if (hit(song.kick) !== '.') kick(out, t, hit(song.kick) === 'x' ? 0.55 : 0.3)
  if (hit(song.snare) !== '.') snare(out, t, hit(song.snare) === 'x' ? 0.22 : 0.1)
  if (hit(song.hat) !== '.') noiseHit(out, t, hit(song.hat) === 'x' ? 0.07 : 0.035, { hp: 7000, dur: 0.04 })
  const b = hit(song.bass)
  if (b !== '.') {
    voice(out, t, midi(chordTone(chord, +b) - 24), sixteenth * 1.8, 0.2, { type: 'sawtooth', cutoff: 500 })
  }
  const a = hit(song.arp)
  if (a !== '.') {
    voice(out, t, midi(chordTone(chord, +a) + 12), sixteenth * 1.5, song.arpType === 'square' ? 0.035 : 0.07,
      { type: song.arpType, cutoff: 3000 })
  }
  if (song.pad && pos === 0) {
    const bar = sixteenth * 16
    for (const n of chord) {
      for (const detune of [-7, 7]) {
        voice(out, t, midi(n), bar * 0.98, song.pad, { type: 'sawtooth', cutoff: 1100, attack: 0.25, detune })
      }
    }
  }
}

// ----------------------------------------------------------- recorded tracks
// Real recordings replace the procedural songs once they've loaded (the
// procedural version plays meanwhile, or if loading fails). Each track
// resumes where it left off, so short phases don't keep restarting it.
// Music by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.

// The Ink & Lies soundtrack: 70s cop-show funk and film-noir jazz.
const TRACKS = {
  lobby: 'music/lobby.mp3', // "Hard Boiled"
  news: 'music/news.mp3', // "News Theme"
  sting: 'music/sting.mp3', // "NewsSting"
  bounce: 'music/bounce.mp3', // "Private Eye"
  think: 'music/think.mp3', // "Covert Affair"
  tense: 'music/tense.mp3', // "Dances and Dames"
  victory: 'music/victory.mp3', // "Hot Swing"
}
// Short news stings always start from the top (the rest resume where they left off).
const FROM_TOP = new Set(['news', 'sting'])
const TRACK_LEVEL = 1.6 // matches the procedural songs' loudness
const fetched = {} // name -> Promise<ArrayBuffer>
const decoded = {} // name -> { buffer, start, end } (start/end trim the MP3's silent padding)
const resumeAt = {} // name -> seconds into the track

// Start downloading tracks before they're needed (no sound needed for that).
export function preloadMusic(names = Object.keys(TRACKS)) {
  for (const name of names) {
    if (!TRACKS[name] || fetched[name]) continue
    fetched[name] = fetch(`${import.meta.env.BASE_URL}${TRACKS[name]}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
    fetched[name].catch(() => {})
  }
}

async function decodeTrack(name) {
  preloadMusic([name])
  if (decoded[name] !== undefined) return
  decoded[name] = null // loading
  try {
    const buffer = await ctx.decodeAudioData(await fetched[name])
    const d = buffer.getChannelData(0)
    let a = 0
    let b = d.length - 1
    while (a < b && Math.abs(d[a]) < 0.001) a++
    while (b > a && Math.abs(d[b]) < 0.001) b--
    decoded[name] = { buffer, start: a / buffer.sampleRate, end: (b + 1) / buffer.sampleRate }
    // Swap the procedural stand-in for the real thing.
    if (playing?.name === name && playing.kind === 'synth') {
      stopSong()
      startSong(name)
    }
  } catch {
    // keep the procedural version
  }
}

function startTrack(name) {
  const { buffer, start, end } = decoded[name]
  const out = ctx.createGain()
  out.gain.setValueAtTime(0.0001, ctx.currentTime)
  out.gain.exponentialRampToValueAtTime(TRACK_LEVEL, ctx.currentTime + FADE_IN)
  out.connect(musicGain)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.loop = true
  src.loopStart = start
  src.loopEnd = end
  src.connect(out)
  const offset = FROM_TOP.has(name) ? start : resumeAt[name] ?? start
  src.start(ctx.currentTime, offset)
  const startedAt = ctx.currentTime
  playing = {
    name, out, kind: 'track',
    stop: () => {
      const len = end - start
      resumeAt[name] = start + ((offset - start + ctx.currentTime - startedAt) % len)
      src.stop(ctx.currentTime + FADE_OUT + 0.1)
    },
  }
}

function startSong(name) {
  if (TRACKS[name]) {
    if (decoded[name]) return startTrack(name)
    decodeTrack(name)
  }
  const song = SONGS[name]
  setupMusicBus()
  const out = ctx.createGain()
  out.gain.setValueAtTime(0.0001, ctx.currentTime)
  out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + FADE_IN)
  out.connect(musicBus)
  const sixteenth = 60 / song.bpm / 4
  let step = 0
  let next = ctx.currentTime + 0.05
  const fill = () => {
    // After a long timer stall, skip ahead instead of bunching notes up.
    if (next < ctx.currentTime) next = ctx.currentTime + 0.05
    while (next < ctx.currentTime + LOOKAHEAD) {
      playStep(song, out, step, next, sixteenth)
      step++
      next += sixteenth
    }
  }
  fill()
  const timer = setInterval(fill, TICK_MS)
  playing = { name, out, kind: 'synth', stop: () => clearInterval(timer) }
}

function stopSong() {
  if (!playing) return
  const { out } = playing
  playing.stop()
  out.gain.cancelScheduledValues(ctx.currentTime)
  out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), ctx.currentTime)
  out.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + FADE_OUT)
  setTimeout(() => out.disconnect(), (FADE_OUT + LOOKAHEAD) * 1000 + 200)
  playing = null
}

// Start (or crossfade to) a song. Remembered if audio isn't unlocked yet, and
// started by unlockAudio() on the next click.
export function playMusic(name) {
  wantedSong = SONGS[name] ? name : null
  syncMusic()
}

export function stopMusic() {
  wantedSong = null
  syncMusic()
}

function syncMusic() {
  if (ctx?.state === 'running' && playing?.name !== wantedSong) {
    stopSong()
    if (wantedSong) startSong(wantedSong)
  }
  for (const fn of musicListeners) fn()
}

// Dev-only console handle for checking music levels:
// window.__fakeoutAudio.peak() -> loudest sample of the music in the last ~0.1 s
function devMeter() {
  const an = ctx.createAnalyser()
  an.fftSize = 4096
  musicGain.connect(an)
  const buf = new Float32Array(an.fftSize)
  window.__fakeoutAudio = {
    state: () => ctx.state,
    playing: () => playing?.name ?? null,
    peak: () => {
      an.getFloatTimeDomainData(buf)
      return Math.max(...buf.map(Math.abs))
    },
  }
}
