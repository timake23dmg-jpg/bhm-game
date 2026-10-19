// The end of the game: the winner's front page ("Champion of the Night") and
// the award cards (Fastest Fingers, Hot Streak, Truth Seeker).

import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import confetti from 'canvas-confetti'
import { Avatar, Mugshot, fmt, useNow } from '../components/shared.jsx'
import { sfx } from '../lib/audio.js'
import { narrate } from '../lib/narrator.js'
import { winnerLines, awardLine, THANKS_LINE } from './narration.js'
import { awardDuration } from '../engine/constants.js'

const byId = (players) => Object.fromEntries(players.map((p) => [p.id, p]))
const gamePlayers = (pub) => pub.players.filter((p) => !p.isAudience)
const ordinal = (n) => `${n}${['TH', 'ST', 'ND', 'RD'][n % 100 >= 11 && n % 100 <= 13 ? 0 : Math.min(n % 10, 4) % 4] || 'TH'}`

function fire(rm, opts = {}) {
  if (rm) return
  confetti({ particleCount: 160, spread: 90, startVelocity: 55, origin: { y: 0.6 }, zIndex: 50, ...opts })
}

// Counts up to `value` once `delay` seconds have passed.
function CountUp({ value, rm, delay = 0, duration = 900 }) {
  const [n, setN] = useState(rm ? value : 0)
  useEffect(() => {
    if (rm) return setN(value)
    let id
    const t = setTimeout(() => {
      const start = Date.now()
      id = setInterval(() => {
        const k = Math.min(1, (Date.now() - start) / duration)
        setN(Math.round(value * (1 - (1 - k) ** 3)))
        if (k >= 1) clearInterval(id)
      }, 30)
    }, delay * 1000)
    return () => {
      clearTimeout(t)
      clearInterval(id)
    }
  }, [value])
  return <>{fmt(n)}</>
}

// "LIAR OF THE YEAR" cut out of different papers, like a ransom note.
function RansomHeadline({ text, delay = 0.5 }) {
  let n = 0
  return (
    <h2 className="ransom" aria-label={text}>
      {text.split(' ').map((word, w) => (
        <span key={w} className="ransom-word">
          {word.split('').map((ch, i) => {
            const k = n++
            return (
              <span key={i} className={`ransom-ch r${(k * 5) % 6}`} style={{ animationDelay: `${delay + k * 0.06}s, ${delay + k * 0.06 + 0.5}s` }} aria-hidden="true">
                {ch}
              </span>
            )
          })}
        </span>
      ))}
    </h2>
  )
}

// ----------------------------------------------------------------- WINNER

export function WinnerScreen({ pub, rm }) {
  const players = byId(pub.players)
  const winners = (pub.winners || []).map((id) => players[id]).filter(Boolean)
  const others = gamePlayers(pub)
    .filter((p) => !pub.winners?.includes(p.id))
    .sort((a, b) => b.score - a.score || a.slot - b.slot)
  const top = winners[0]?.score ?? 0
  const bottom = Math.min(...gamePlayers(pub).map((p) => p.score))
  // The rest of the line-up: 2nd and 3rd, and always whoever came last.
  const shown = others.length <= 3 ? others : [others[0], others[1], others[others.length - 1]]
  const place = (p) => 1 + gamePlayers(pub).filter((q) => q.score > p.score).length

  useEffect(() => {
    const lines = pub.settings?.tts !== false && winners.length ? winnerLines(winners) : null
    if (lines) narrate(lines.start)
    const t = setTimeout(() => {
      if (lines) narrate(lines.verdict, { queue: true })
      sfx('cheer')
      fire(rm, { particleCount: 300, spread: 160, origin: { y: 0.4 } })
    }, rm ? 0 : 1400)
    const s = setTimeout(() => sfx('buzzer'), rm ? 0 : 2300)
    return () => {
      clearTimeout(t)
      clearTimeout(s)
    }
  }, [])

  const solo = winners.length === 1
  const w = winners[0]
  const heroWidth = solo ? 460 : winners.length === 2 ? 300 : 220
  return (
    <div className="screen winner big-picture">
      <div className="bp-hero">
        <div className="bp-heroes">
          {winners.map((p, i) => (
            <div key={p.id} className="bp-hero-card" style={{ '--tilt': `${i % 2 ? 2 : -2}deg`, animationDelay: `${0.3 + i * 0.2}s` }}>
              <Mugshot player={p} width={heroWidth} crown flash={0.9 + i * 0.2} caption="CHAMPION" />
              <span className="twinkle a" aria-hidden="true" />
              <span className="twinkle b" aria-hidden="true" />
            </div>
          ))}
        </div>
        <div className="bp-stamp">TRUTH BE TOLD</div>
      </div>

      <div className="bp-story">
        <RansomHeadline text={solo ? 'CHAMPION OF THE NIGHT' : 'CHAMPIONS OF THE NIGHT'} />
        <div className="bp-clipping">
          <div className="bp-paper">Truth Be Told · Black History Month</div>
          {solo ? (
            <p>
              <b>{w?.name}</b> takes the crown with <b><CountUp value={top} rm={rm} delay={1.6} /> points</b>.
              Quick thinking, sharp knowledge, and a true story at every turn.
            </p>
          ) : (
            <p>
              <b>{winners.map((p) => p.name).join(' and ').replace(/ and (?=.* and )/g, ', ')}</b> share the crown with{' '}
              <b><CountUp value={top} rm={rm} delay={1.6} /> points</b> each. A dead heat at the top!
            </p>
          )}
        </div>
        {shown.length > 0 && (
          <>
            <div className="bp-also">Also on the leaderboard</div>
            <div className="bp-lineup">
              {shown.map((p, i) => {
                const last = p.score === bottom && bottom < top
                return (
                  <div key={p.id} className="bp-mini" style={{ animationDelay: `${2.4 + i * 0.25}s` }}>
                    <Mugshot player={p} width={168} tears={last} flash={2.5 + i * 0.25} />
                    <span className={`bp-place ${last ? 'last' : ''}`}>{last ? 'LAST' : ordinal(place(p))}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- AWARDS

export function AwardsScreen({ pub, serverNow, engine, rm }) {
  const now = useNow(serverNow, 200)
  const players = byId(pub.players)
  const awards = pub.awards || []
  // Which card is up: each award has its own time on screen.
  const elapsed = now - pub.startedAt
  let idx = 0
  for (let t = 0; idx < awards.length && elapsed >= t + awardDuration(awards[idx]); idx++) t += awardDuration(awards[idx])
  const done = idx >= awards.length
  const award = awards[Math.min(idx, awards.length - 1)]
  const narrating = pub.settings?.tts !== false
  useEffect(() => {
    if (!done && award) {
      sfx('chime')
      if (narrating) narrate(awardLine(award, players))
    } else if (narrating) narrate(THANKS_LINE)
  }, [done ? -1 : idx])

  if (done || !award) {
    const ranked = [...gamePlayers(pub)].sort((a, b) => b.score - a.score)
    return (
      <div className="screen awards-done">
        <h2 className="screen-title">Thanks for playing!</h2>
        <div className="final-list">
          {ranked.slice(0, 10).map((p, i) => (
            <div key={p.id} className="final-row" style={{ animationDelay: `${i * 0.12}s` }}>
              <Avatar player={p} size={60} /> <span>{p.name}</span> <strong>{fmt(p.score)}</strong>
            </div>
          ))}
        </div>
        <div className="end-buttons">
          <button className="btn btn-pink btn-xl" onClick={() => engine.playAgain()}>Play again</button>
          <button className="btn btn-ghost btn-xl" onClick={() => engine.backToLobby()}>Back to lobby</button>
        </div>
        <p className="hint">…or the VIP can choose on their phone.</p>
      </div>
    )
  }

  // Whole numbers count up; others (like 2.4 seconds) just appear.
  const [before, num, after] = award.stat.match(/^(.*?)(\d+(?:\.\d+)?)(.*)$/)?.slice(1) ?? [award.stat, '', '']
  return (
    <div className="screen awards">
      <AnimatePresence mode="wait">
        <motion.div
          key={award.key}
          className="award-card"
          initial={rm ? { opacity: 0 } : { rotateY: 90, opacity: 0 }}
          animate={{ rotateY: 0, opacity: 1 }}
          exit={rm ? { opacity: 0 } : { rotateY: -90, opacity: 0 }}
          transition={{ duration: rm ? 0.2 : 0.5 }}
        >
          <div className="award-title">{award.title}</div>
          <div className="award-players">
            {award.playerIds.map((id) => players[id] && (
              <div key={id} className="award-player">
                <Mugshot player={players[id]} width={award.playerIds.length > 2 ? 150 : 200} flash={0.4} />
              </div>
            ))}
          </div>
          <div className="award-stat">
            {before}
            {num && <span className="count">{num.includes('.') ? num : <CountUp value={Number(num)} rm={rm} delay={0.4} duration={600} />}</span>}
            {after}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
