// The liar's Pinocchio nose: a wooden nose stuck on a mugshot or badge that
// is one notch longer for every person the player's lies have fooled.
// Given `from`, it starts at that many notches and grows to `fools` one notch
// at a time: a creak, a squash, a springy overshoot and a wobble at the tip.
// Leaves sprout at 3 and 6 notches.

import React, { useEffect, useState } from 'react'
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { sfx } from '../lib/audio.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const reducedMotion = () => typeof document !== 'undefined' && document.documentElement.classList.contains('rm')

// Nose length in px for a number of notches (0 = no nose at all).
export const noseLength = (n, size, max = 1.05) => (n <= 0 ? 0 : size * Math.min(0.2 + 0.11 * (n - 1), max))

// A leaf of length L growing from (x, y), up (or down when flipped).
const leafPath = (x, y, L, flip) => {
  if (L <= 0.5) return ''
  const d = flip ? 1 : -1
  return `M${x} ${y} Q${x - L * 0.45} ${y + d * L * 0.55} ${x + L * 0.35} ${y + d * L} Q${x + L * 0.62} ${y + d * L * 0.35} ${x} ${y} Z`
}

export default function Nose({ fools = 0, from = fools, size = 220, delay = 0, max = 1.05, sound = true, flip = false, gap = null }) {
  const start = Math.max(0, Math.min(from, fools))
  const len = useMotionValue(noseLength(start, size, max))
  const tilt = useMotionValue(0)
  const leafA = useMotionValue(start >= 3 ? 1 : 0)
  const leafB = useMotionValue(start >= 6 ? 1 : 0)
  const [shown, setShown] = useState(start > 0)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (reducedMotion()) {
        len.set(noseLength(fools, size, max))
        leafA.set(fools >= 3 ? 1 : 0)
        leafB.set(fools >= 6 ? 1 : 0)
        setShown(fools > 0)
        return
      }
      if (delay) await wait(delay * 1000)
      const steps = fools - start
      // Big jumps speed up so a long nose doesn't take forever.
      const pause = gap ?? (steps > 5 ? 260 : 480)
      for (let k = start + 1; k <= fools && !cancelled; k++) {
        setShown(true)
        if (sound) sfx('creak')
        const target = noseLength(k, size, max)
        // Squash back a little, then shoot out past the mark and settle.
        await animate(len, Math.max(0, len.get() - size * 0.025), { duration: 0.1, ease: 'easeIn' })
        if (cancelled) return
        animate(tilt, [0, -10, 7, -4, 2, 0], { duration: 0.8, ease: 'easeOut' })
        animate(len, target, { type: 'spring', stiffness: 520, damping: 10, mass: 0.8 })
        if (k === 3) animate(leafA, 1, { type: 'spring', stiffness: 300, damping: 9, delay: 0.15 })
        if (k === 6) animate(leafB, 1, { type: 'spring', stiffness: 300, damping: 9, delay: 0.15 })
        await wait(pause)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [fools, start, size])

  const r0 = size * 0.06 // half-thickness at the face
  const r1 = size * 0.032 // half-thickness at the tip
  const sw = Math.max(2, size * 0.014)
  const half = (l, x) => r0 + (r1 - r0) * (l ? x / l : 0)
  // The nose curves up very slightly towards the tip.
  const lift = (l, x) => -((x / Math.max(1, l)) ** 2) * l * 0.06
  const shaft = useTransform(len, (l) => {
    if (l <= 0.5) return ''
    const t = lift(l, l)
    return `M0 ${-r0} Q${l * 0.55} ${-r0 + t * 0.4 - r0 * 0.15} ${l} ${t - r1} A${r1} ${r1} 0 0 1 ${l} ${t + r1} Q${l * 0.55} ${r0 + t * 0.4} 0 ${r0} Z`
  })
  const grain = useTransform(len, (l) => {
    if (l < size * 0.15) return ''
    const line = (k, a, b) => {
      const x1 = l * a
      const x2 = l * b
      return `M${x1} ${lift(l, x1) + half(l, x1) * k} L${x2} ${lift(l, x2) + half(l, x2) * k}`
    }
    return `${line(0.35, 0.22, 0.7)} ${line(-0.2, 0.45, 0.88)}`
  })
  const shine = useTransform(len, (l) => {
    if (l < size * 0.1) return ''
    const x1 = l * 0.12
    const x2 = l * 0.9
    return `M${x1} ${lift(l, x1) - half(l, x1) * 0.55} L${x2} ${lift(l, x2) - half(l, x2) * 0.5}`
  })
  const knob = useTransform(len, (l) => Math.min(1, l / (size * 0.12)))
  const leaf1 = useTransform([len, leafA], ([l, s]) => {
    const x = l * 0.62
    return leafPath(x, lift(l, x) - half(l, x), s * size * 0.14, false)
  })
  const leaf2 = useTransform([len, leafB], ([l, s]) => {
    const x = l * 0.4
    return leafPath(x, lift(l, x) + half(l, x), s * size * 0.11, true)
  })

  if (!shown && fools <= 0) return null
  return (
    <motion.span className={`nose ${flip ? 'flip' : ''}`} style={{ rotate: tilt }} aria-label={`Fooled ${fools}`} role="img">
      <svg className="nose-svg" width="1" height="1" overflow="visible" aria-hidden="true">
        <g strokeLinejoin="round" strokeLinecap="round">
          <motion.path d={leaf1} fill="#4FB548" stroke="#231A45" strokeWidth={sw * 0.7} />
          <motion.path d={leaf2} fill="#3E9C3A" stroke="#231A45" strokeWidth={sw * 0.7} />
          <motion.path d={shaft} fill="#D08A4E" stroke="#231A45" strokeWidth={sw} />
          <motion.path d={grain} fill="none" stroke="#8E5527" strokeWidth={sw * 0.55} />
          <motion.path d={shine} fill="none" stroke="rgba(255,236,200,0.75)" strokeWidth={sw * 0.9} />
          <motion.circle r={r0 * 1.3} fill="#D08A4E" stroke="#231A45" strokeWidth={sw} style={{ scale: knob }} />
          <motion.circle cx={-r0 * 0.35} cy={-r0 * 0.4} r={r0 * 0.35} fill="rgba(255,236,200,0.8)" style={{ scale: knob }} />
        </g>
      </svg>
    </motion.span>
  )
}
