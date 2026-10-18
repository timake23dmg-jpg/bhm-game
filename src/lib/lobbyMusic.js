// Lobby music: the "Fakeout theme" (a procedural song from audio.js) loops on
// the TV's start screen and lobby and on phones' join/waiting screens, and
// stops when the game starts. The mute choice is per device, remembered, and
// on the TV also silences all game audio.

import { setMasterMuted, unlockAudio, audioReady, playMusic, stopMusic, currentSong, onMusicChange } from './audio.js'

const MUTE_KEY = 'fakeout.muted'
const SONG = 'lobby'

let wanted = false // should the theme be playing right now (i.e. we're in a lobby)?
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
})()
const listeners = new Set()

setMasterMuted(muted)

function emit() {
  const state = getMusicState()
  for (const fn of listeners) fn(state)
}
onMusicChange(emit)

export function getMusicState() {
  return {
    muted,
    // The browser hasn't allowed sound yet: it needs a tap.
    blocked: wanted && !muted && !audioReady(),
    playing: !muted && audioReady() && currentSong() === SONG,
  }
}

export function subscribeMusic(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function sync() {
  if (wanted && !muted) playMusic(SONG)
  else if (currentSong() === SONG) stopMusic()
  emit()
}

// In a lobby → play the theme; leaving it (game started) → fade it out.
export function setLobbyMusic(on) {
  if (wanted === on) return
  wanted = on
  sync()
}

export function setMuted(value) {
  muted = value
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0')
  } catch {
    // preference just won't persist
  }
  setMasterMuted(value)
  if (!value) unlockAudio() // unmuting is a tap, so sound can start
  sync()
}

// Call from a real tap (e.g. the Join button): browsers only allow sound
// after a user gesture.
export function primeLobbyMusic() {
  unlockAudio()
  sync()
}

// Any tap or key press retries while the browser is still blocking sound.
// Touch screens count the END of a touch as the gesture (touchend / pointerup
// / click), mice count mousedown/pointerdown, so listen for all of them
// (capture phase, so a component stopping propagation can't swallow it).
if (typeof document !== 'undefined') {
  const retry = () => {
    if (wanted && !muted && !audioReady()) primeLobbyMusic()
  }
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    document.addEventListener(type, retry, { capture: true, passive: true })
  }
}
