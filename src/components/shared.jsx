import React, { useEffect, useRef, useState } from 'react'
import { getMusicState, subscribeMusic, setMuted } from '../lib/lobbyMusic.js'
import Nose from './Nose.jsx'

// Mute toggle for this device. If the browser blocked autoplay, the first
// tap starts the music instead (the tap itself unlocks audio).
export function MuteButton({ className = '', onGesture }) {
  const [state, setState] = useState(getMusicState)
  useEffect(() => subscribeMusic(setState), [])
  const label = state.muted ? 'Unmute sound' : state.blocked ? 'Start the music' : 'Mute sound'
  return (
    <button
      type="button"
      className={`mute-btn ${state.blocked ? 'blocked' : ''} ${className}`}
      onClick={() => {
        onGesture?.()
        if (!state.blocked) setMuted(!state.muted)
      }}
      aria-pressed={state.muted}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{state.muted ? '🔇' : '🔊'}</span>
      {state.blocked && <span className="mute-hint">Tap for music</span>}
    </button>
  )
}

export const AVATARS = ['🦊', '🐸', '🐙', '🦄', '🐼', '🐯', '🦉', '🐧', '🐵', '🦁', '🐨', '🐷', '🦖', '🐝', '🐢', '🦩']
export const PLAYER_COLORS = ['#FF4F8B', '#3DDC97', '#FFC940', '#5AB8FF', '#B784FF', '#FF8A3D', '#4FE3E3', '#F2F2F2']

export const colorFor = (slot) => PLAYER_COLORS[(slot ?? 0) % PLAYER_COLORS.length]
export const fmt = (n) => (n ?? 0).toLocaleString('en-US')
export const signed = (n) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// Re-renders every `interval` ms, returning the current server-aligned time.
export function useNow(serverNow, interval = 100) {
  const [now, setNow] = useState(() => serverNow())
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), interval)
    return () => clearInterval(id)
  }, [serverNow, interval])
  return now
}

// A player's badge: their mugshot selfie if they took one, else their emoji.
// `crown`: in the lead. `tears`: in last place. `nose`: Nose props (a liar).
export function Avatar({ player, size = 64, done = false, dim = false, flip = true, crown = false, tears = false, nose = null }) {
  if (!player) return null
  return (
    <div
      className={`avatar ${done && flip ? 'avatar-done' : ''} ${dim ? 'avatar-dim' : ''}`}
      style={{ '--size': `${size}px`, '--ring': colorFor(player.slot) }}
      title={player.name}
    >
      <div className="avatar-inner">
        <div className={`avatar-face avatar-front ${player.photo ? 'has-photo' : ''}`}>
          {player.photo ? <img className="avatar-photo" src={player.photo} alt="" /> : player.avatar}
          {tears && <Tears />}
        </div>
        <div className="avatar-face avatar-back">✓</div>
      </div>
      {crown && <Crown />}
      {nose && <Nose size={size} {...nose} />}
    </div>
  )
}

// Gold crown that sits on a badge or mugshot (the leader).
export function Crown() {
  return (
    <svg className="crown" viewBox="0 0 110 76" aria-label="In the lead" role="img">
      <path d="M8 66 L4 18 L30 40 L55 6 L80 40 L106 18 L102 66 Z" fill="#FFC928" stroke="#231A45" strokeWidth="5" strokeLinejoin="round" />
      <rect x="8" y="58" width="94" height="14" fill="#E9A800" stroke="#231A45" strokeWidth="5" />
      <circle cx="55" cy="38" r="6" fill="#FF4F8B" stroke="#231A45" strokeWidth="3" />
      <circle cx="30" cy="65" r="4" fill="#5AB8FF" />
      <circle cx="80" cy="65" r="4" fill="#5AB8FF" />
    </svg>
  )
}

// Tears rolling down from both eyes (last place). Positions match the face
// guide on the phone's mugshot camera.
export function Tears() {
  return (
    <span className="tears" aria-label="In last place" role="img">
      <i style={{ left: '38%', animationDelay: '0s' }} />
      <i style={{ left: '38%', animationDelay: '0.8s' }} />
      <i style={{ left: '62%', animationDelay: '0.4s' }} />
      <i style={{ left: '62%', animationDelay: '1.2s' }} />
    </span>
  )
}

// Four-digit "case number" for a player, stable for their id.
export function suspectNumber(player) {
  let h = 7
  for (const ch of String(player?.id ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 9000
  return String(1000 + h)
}

// A police mugshot card: photo (or emoji) on a height chart, with a placard.
// `flash`: a camera flash goes off when it appears (delay in seconds, or true).
export function Mugshot({ player, width = 220, crown = false, tears = false, tag = null, tagTone = 'plain', footer = null, dim = false, flash = false, caption = null, nose = null }) {
  if (!player) return null
  return (
    <div className={`mugshot ${dim ? 'mugshot-dim' : ''}`} style={{ '--w': `${width}px`, '--ring': colorFor(player.slot) }}>
      {tag && <div className={`mugshot-tag ${tagTone}`}>{tag}</div>}
      <div className="mugshot-frame">
        {player.photo ? <img className="mugshot-photo" src={player.photo} alt={`${player.name}'s mugshot`} /> : <span className="mugshot-emoji">{player.avatar}</span>}
        <span className="mugshot-chart" aria-hidden="true" />
        {tears && <Tears />}
        {crown && <Crown />}
        {nose && <Nose size={width} {...nose} />}
        {flash !== false && <span className="mug-flash" style={{ animationDelay: `${flash === true ? 0 : flash}s` }} aria-hidden="true" />}
      </div>
      <div className="mugshot-placard">
        <span>{caption ?? `SUSPECT ${suspectNumber(player)}`}</span>
        <strong>{player.name}</strong>
      </div>
      {footer}
    </div>
  )
}

export function TimerRing({ deadline, startedAt, serverNow, size = 120, onTick }) {
  const now = useNow(serverNow, 100)
  const lastSecond = useRef(null)
  const total = Math.max(1, (deadline ?? 0) - (startedAt ?? 0))
  const left = Math.max(0, (deadline ?? 0) - now)
  const secs = Math.ceil(left / 1000)
  useEffect(() => {
    if (secs !== lastSecond.current) {
      lastSecond.current = secs
      if (secs > 0 && secs <= 5) onTick?.(secs)
    }
  }, [secs, onTick])
  if (deadline == null) return null
  const r = size / 2 - 8
  const c = 2 * Math.PI * r
  const urgent = secs <= 10
  return (
    <div className={`timer ${urgent ? 'timer-urgent' : ''}`} style={{ width: size, height: size }} role="timer" aria-label={`${secs} seconds left`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} className="timer-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="timer-bar"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - left / total)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span key={urgent ? secs : 'n'} className={urgent ? 'timer-num pulse' : 'timer-num'}>{secs}</span>
    </div>
  )
}

// Splits a prompt around its blank ("______") so the blank can be styled.
// The game's name as a newspaper masthead.
export function Wordmark({ className = '' }) {
  return <h1 className={`logo ${className}`}>Truth <span>Be</span> Told</h1>
}

// Category names as shown to players ("Final Fakeout" is the bank's
// internal name for the last-question pool).
export const displayCategory = (c) => (c === 'Final Fakeout' ? 'The Final Round' : c)

export function Prompt({ text, fill = null, className = '' }) {
  const parts = String(text || '').split(/_{2,}/)
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {p}
          {i < parts.length - 1 && <span className="blank">{fill ?? ' '.repeat(12)}</span>}
        </React.Fragment>
      ))}
    </span>
  )
}

// ------------------------------------------------------------ slot machine
// A one-reel slot machine through every category, landing on `target`.
// Driven by the server clock, so the TV and every phone spin in step (and a
// phone that joins mid-spin picks up at the right spot).
const easeOut = (x) => 1 - Math.pow(1 - x, 4)
const ROWS_SHOWN = 2 // rows visible above and below the winning line

export function SlotReel({ items, target, seed = 0, startedAt, landMs, serverNow, rowHeight = 120, onTick, onLand, className = '' }) {
  // A fixed order per question (same on every screen), with the target in it.
  const list = React.useMemo(() => {
    const base = items.includes(target) || !target ? [...items] : [...items, target]
    let h = (seed * 2654435761) >>> 0
    for (let i = base.length - 1; i > 0; i--) {
      h = (h * 1103515245 + 12345) >>> 0
      const j = h % (i + 1)
      ;[base[i], base[j]] = [base[j], base[i]]
    }
    return base
  }, [items, target, seed])
  const n = list.length
  const finalPos = 5 * n + Math.max(0, list.indexOf(target)) // five full turns, then the target

  const posAt = (t) => finalPos * easeOut(Math.min(1, Math.max(0, (t - startedAt) / landMs)))
  const [pos, setPos] = useState(() => posAt(serverNow()))
  const last = useRef(Math.floor(pos))
  const landed = pos >= finalPos - 1e-6

  useEffect(() => {
    if (landed) { onLand?.(); return undefined }
    let id
    const frame = () => {
      const p = posAt(serverNow())
      setPos(p)
      const row = Math.floor(p + 0.5)
      if (row !== last.current) {
        last.current = row
        onTick?.()
      }
      if (p < finalPos) id = requestAnimationFrame(frame)
      else onLand?.()
    }
    id = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(id)
  }, [startedAt, landMs, finalPos])

  const base = Math.floor(pos)
  const rows = []
  for (let i = base - ROWS_SHOWN; i <= base + ROWS_SHOWN + 1; i++) {
    const offset = i - pos
    const item = list[((i % n) + n) % n]
    const isWinner = landed && i === finalPos
    rows.push(
      <div key={i} className={`reel-row ${isWinner ? 'reel-win' : ''}`}
        style={{ height: rowHeight, transform: `translateY(${offset * rowHeight}px)`, opacity: 1 - Math.min(0.75, Math.abs(offset) * 0.32) }}>
        {item}
      </div>,
    )
  }
  return (
    <div className={`slot ${landed ? 'slot-landed' : 'slot-spinning'} ${className}`} style={{ '--row': `${rowHeight}px` }}>
      <div className="slot-window" style={{ height: rowHeight * (ROWS_SHOWN * 2 + 1) }}>
        <div className="slot-rows" style={{ top: rowHeight * ROWS_SHOWN }}>{rows}</div>
        <div className="slot-line" style={{ top: rowHeight * ROWS_SHOWN, height: rowHeight }} />
      </div>
    </div>
  )
}
