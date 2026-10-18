// The end of the game: the winner's front page ("Liar of the Year") and the
// awards, where the Biggest Liar gets a WANTED poster with a £ bounty.

import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import confetti from 'canvas-confetti'
import { Avatar, Mugshot, fmt, useNow } from '../components/shared.jsx'
import Nose from '../components/Nose.jsx'
import { sfx } from '../lib/audio.js'
import { narrate } from '../lib/narrator.js'
import { winnerLines, awardLine, THANKS_LINE } from './narration.js'
import { awardDuration } from '../engine/constants.js'

const byId = (players) => Object.fromEntries(players.map((p) => [p.id, p]))
const gamePlayers = (pub) => pub.players.filter((p) => !p.isAudience)
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`
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
              <Mugshot player={p} width={heroWidth} crown flash={0.9 + i * 0.2} caption="CASE CLOSED" />
              <span className="twinkle a" aria-hidden="true" />
              <span className="twinkle b" aria-hidden="true" />
            </div>
          ))}
        </div>
        <div className="bp-stamp">GOT AWAY WITH IT</div>
      </div>

      <div className="bp-story">
        <RansomHeadline text={solo ? 'LIAR OF THE YEAR' : 'LIARS OF THE YEAR'} />
        <div className="bp-clipping">
          <div className="bp-paper">Ink &amp; Lies · The Final Edition</div>
          {solo ? (
            <p>
              <b>{w?.name}</b> walks free with <b><CountUp value={top} rm={rm} delay={1.6} /> points</b>
              {w?.fooled > 0 ? <> after fooling the room {plural(w.fooled, 'time')}.</> : <> without fooling a single person. Suspiciously honest.</>}{' '}
              “I don't know what you're talking about,” the suspect told reporters.
            </p>
          ) : (
            <p>
              <b>{winners.map((p) => p.name).join(' and ').replace(/ and (?=.* and )/g, ', ')}</b> share the title with{' '}
              <b><CountUp value={top} rm={rm} delay={1.6} /> points</b> each. Police are questioning all of them.
            </p>
          )}
        </div>
        {shown.length > 0 && (
          <>
            <div className="bp-also">Also in the line-up</div>
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

const NICKNAMES = ['Smooth', 'Slippery', 'Shifty', 'Silver Tongue', 'Two-Face', 'The Weasel', 'Porky Pies', 'Fibs']
function nickname(player) {
  let h = 11
  for (const ch of String(player.id)) h = (h * 33 + ch.charCodeAt(0)) % 9973
  return NICKNAMES[h % NICKNAMES.length]
}

function WantedPoster({ player, rm, index = 0, small = false }) {
  const bounty = player.liePoints || 0
  return (
    <div className={`wanted ${small ? 'small' : ''}`} style={{ animationDelay: `${index * 0.25}s, ${0.9 + index * 0.25}s` }}>
      <div className="wanted-paper">
        <span className="wanted-pin left" aria-hidden="true" />
        <span className="wanted-pin right" aria-hidden="true" />
        <span className="wanted-tape" aria-hidden="true" />
        <div className="wanted-title">WANTED</div>
        <div className="wanted-for">FOR LYING TO FRIENDS</div>
        <div className="wanted-rule" />
        <div className="wanted-photo-wrap">
          <div className="wanted-photo">
            {player.photo ? <img src={player.photo} alt={`${player.name}'s mugshot`} /> : <span className="wanted-emoji">{player.avatar}</span>}
          </div>
          {player.fooled > 0 && <Nose size={240} from={0} fools={player.fooled} delay={rm ? 0 : 1.2 + index * 0.4} max={1.1} />}
        </div>
        <div className="wanted-aka">a.k.a. “{nickname(player)}”</div>
        <div className="wanted-name">{player.name}</div>
        <div className="wanted-crimes">
          Fooled {plural(player.fooled || 0, 'friend')}
          {player.lieBuys > 0 && <> · Bought {plural(player.lieBuys, 'lie')}</>}
          <br />
          Do not approach. Will lie to you.
        </div>
        <div className="wanted-rule" />
        <div className="wanted-reward">
          REWARD £<CountUp value={bounty} rm={rm} delay={1.4 + index * 0.25} duration={1400} />
        </div>
      </div>
    </div>
  )
}

function WantedWall({ award, players, pub, rm }) {
  const liars = award.playerIds.map((id) => players[id]).filter(Boolean)
  // The side notices: the truth went missing, and the most gullible lost their dignity.
  const notLiar = (p) => p && !award.playerIds.includes(p.id)
  const lastPlace = gamePlayers(pub).filter(notLiar).sort((a, b) => a.score - b.score)[0]
  const gullible = (pub.awards || []).find((a) => a.key === 'mostGullible')?.playerIds.map((id) => players[id]).find(notLiar) || lastPlace
  useEffect(() => {
    const t = setTimeout(() => sfx('chaChing'), rm ? 0 : 1500)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="screen awards wanted-wall">
      <div className="notice missing">
        <div className="notice-title">MISSING</div>
        <div className="notice-what">THE TRUTH</div>
        <div className="notice-note">Last seen in round one. Answers to “boring”.</div>
      </div>
      {gullible && (
        <div className="notice lost">
          <div className="notice-title">LOST</div>
          <div className="notice-what">{gullible.name.toUpperCase()}'S DIGNITY</div>
          <div className="notice-note">If found, please return. No reward.</div>
        </div>
      )}
      <div className="wanted-row">
        {liars.map((p, i) => <WantedPoster key={p.id} player={p} rm={rm} index={i} small={liars.length > 1} />)}
      </div>
    </div>
  )
}

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

  if (award.key === 'biggestLiar') return <WantedWall key={award.key} award={award} players={players} pub={pub} rm={rm} />

  const value = Number(award.stat.match(/\d+/)?.[0] ?? 0)
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
            {award.stat.split(/\d+/)[0]}<span className="count"><CountUp value={value} rm={rm} delay={0.4} duration={600} /></span>{award.stat.split(/\d+/).slice(1).join('')}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
