import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import confetti from 'canvas-confetti'
import QRCode from 'qrcode'
import { Avatar, Mugshot, Prompt, SlotReel, TimerRing, Wordmark, colorFor, displayCategory, fmt, signed, useNow } from '../components/shared.jsx'
import { sfx, setVolumes, getVolumes } from '../lib/audio.js'
import { narrate } from '../lib/narrator.js'
import { AUTO, BROWSER_VOICE, VOICE_GROUPS, getAiVoiceState, setVoiceChoice, subscribeAiVoice } from '../lib/aiVoice.js'
import { revealLines, winnerLines, awardLine, THANKS_LINE } from './narration.js'
import { TIMERS, MIN_PLAYERS, MAX_PLAYERS, SHORT_GAME_MIN_PLAYERS, LETTERS, SPIN_LAND_MS } from '../engine/constants.js'
import { CATEGORIES } from '../data/categories.js'

const spring = { type: 'spring', stiffness: 420, damping: 22 }
// Sticker tilts (degrees) for the cartoon theme. Animated cards get them via
// Framer Motion, since its inline transform would override a CSS rotate.
const TILTS = [-2, 1.5, -1, 2, 1, -1.5, 2, -1]

function useConfetti(rm) {
  return (opts = {}) => {
    if (rm) return
    confetti({ particleCount: 160, spread: 90, startVelocity: 55, origin: { y: 0.6 }, zIndex: 50, ...opts })
  }
}

const byId = (players) => Object.fromEntries(players.map((p) => [p.id, p]))
const gamePlayers = (pub) => pub.players.filter((p) => !p.isAudience)
// Big rooms (the 70-player event build): the TV shows a sample of faces plus counts,
// because 70 mugshots won't fit on one screen. Phones still show each player their own rank.
const CROWD = 8
const isCrowd = (pub) => gamePlayers(pub).length > CROWD

// Who wears the crown (the leaders) and who cries (last place), once anyone
// has scored. Nobody cries while everyone is tied.
export function standings(pub) {
  const players = gamePlayers(pub)
  const none = { crown: () => false, tears: () => false }
  if (pub.phase === 'LOBBY' || !players.length) return none
  const scores = players.map((p) => p.score)
  const top = Math.max(...scores)
  const bottom = Math.min(...scores)
  if (top <= 0) return none
  return {
    crown: (p) => !p.isAudience && p.score === top,
    tears: (p) => !p.isAudience && players.length >= 2 && bottom < top && p.score === bottom,
  }
}

// -------------------------------------------------------------- chrome

function TopBar({ pub, serverNow, label }) {
  return (
    <div className="host-topbar">
      <div className="category-label">{label ?? displayCategory(pub.question?.category)}</div>
      <div className="topbar-right">
        {pub.multiplier > 1 && <div className="mult-badge small">×{pub.multiplier}</div>}
        <TimerRing deadline={pub.deadline} startedAt={pub.startedAt} serverNow={serverNow} onTick={() => sfx('tick')} />
      </div>
    </div>
  )
}

function AvatarRow({ pub, doneIds = [], detectorIds = [] }) {
  const done = new Set(doneIds)
  const st = standings(pub)
  if (isCrowd(pub)) {
    const all = gamePlayers(pub)
    const n = all.filter((p) => done.has(p.id)).length
    const recent = all.filter((p) => done.has(p.id)).slice(-CROWD)
    return (
      <div className="avatar-row crowd">
        {recent.map((p) => (
          <div key={p.id} className="avatar-chip is-done">
            <Avatar player={p} size={64} done crown={st.crown(p)} tears={st.tears(p)} />
          </div>
        ))}
        <div className="crowd-count"><strong>{n}</strong> / {all.length} locked in</div>
      </div>
    )
  }
  return (
    <div className="avatar-row">
      {gamePlayers(pub).map((p) => (
        <div key={p.id} className={`avatar-chip ${p.connected ? '' : 'offline'} ${done.has(p.id) ? 'is-done' : 'is-waiting'}`} style={{ '--i': gamePlayers(pub).indexOf(p) }}>
          <Avatar player={p} size={84} done={done.has(p.id)} crown={st.crown(p)} tears={st.tears(p)} />
          <span className="chip-name">
            {p.name}
            {detectorIds.includes(p.id) && <span className="detector-badge" title="Used the Truth Detector">🔍</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

// --------------------------------------------------------------- LOBBY

export function LobbyScreen({ pub, code, engine, joinUrl, backend }) {
  const [qr, setQr] = useState(null)
  const [vol, setVol] = useState(getVolumes())
  useEffect(() => {
    QRCode.toDataURL(joinUrl, { margin: 1, width: 360, color: { dark: '#231A45', light: '#FFFFFF' } }).then(setQr)
  }, [joinUrl])
  const players = gamePlayers(pub)
  const audience = pub.players.filter((p) => p.isAudience)
  const s = pub.settings || {}
  const toggle = (key) => engine.updateSettings({ [key]: key === 'tts' ? s.tts === false : !s[key] })
  const changeVol = (key, v) => {
    const next = { ...vol, [key]: v }
    setVol(next)
    setVolumes(next)
    try {
      localStorage.setItem('fakeout.volumes', JSON.stringify(next))
    } catch {
      // volumes just won't persist
    }
  }
  const canStart = players.length >= MIN_PLAYERS

  return (
    <div className="screen lobby">
      <div className="lobby-left">
        <div className="hiring">
          <h1 className="hiring-title">Who knows <span>the truth?</span></h1>
          <p className="hiring-sub">Every question is a true story from Black history. Fake it, then find it.</p>
        </div>
        <div className="join-box">
          {qr && <img className="qr" src={qr} alt={`QR code to join room ${code}`} />}
          <div>
            <div className="join-label">Join on your phone at</div>
            <div className="join-url">
              {joinUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, '').split('/').map((part, i) => (
                <React.Fragment key={i}>{i > 0 && <>/<wbr /></>}{part}</React.Fragment>
              ))}
            </div>
            <div className="join-label">Room code</div>
            <div className="room-code">{code}</div>
          </div>
        </div>
        {backend === 'local' && <p className="demo-note">Local demo: open players as new tabs in this browser.</p>}
      </div>

      <div className="lobby-right">
        <div className="lobby-players">
          {(players.length > CROWD ? players.slice(-CROWD) : Array.from({ length: CROWD }, (_, i) => players[i])).map((p, i) =>
            p ? (
              <motion.div key={p.id} className={`lobby-slot mug ${p.connected ? '' : 'offline'}`} initial={{ scale: 0, rotate: 0 }} animate={{ scale: 1, rotate: TILTS[i % TILTS.length] }} transition={spring}>
                <div className="sway" style={{ animationDelay: `${-i * 0.7}s` }}>
                  <Mugshot player={p} width={168} flash={0.25} />
                </div>
                {p.id === pub.vipId && <span className="vip-tag">EDITOR</span>}
              </motion.div>
            ) : (
              <div key={`empty-${i}`} className="lobby-slot vacancy" style={{ rotate: `${TILTS[i % TILTS.length]}deg` }}>
                <span className="vacancy-frame">?</span>
                <span className="vacancy-label">VACANCY</span>
              </div>
            ),
          )}
        </div>
        <div className="audience-count">
          <strong>{players.length}</strong> / {MAX_PLAYERS} players in{players.length > CROWD ? ' · newest arrivals shown' : ''}
          {audience.length > 0 && ` · 👀 Audience: ${audience.length}`}
        </div>

        <details className="settings-drawer">
          <summary>Settings · sound, narrator, game length</summary>
        <div className="settings">
          <label className={players.length < SHORT_GAME_MIN_PLAYERS ? 'disabled' : ''}>
            <input type="checkbox" checked={!!s.shortGame} disabled={players.length < SHORT_GAME_MIN_PLAYERS} onChange={() => toggle('shortGame')} />
            Short game (2 + 2 + 1, needs 5+ players)
          </label>
          <label><input type="checkbox" checked={s.profanityFilter !== false} onChange={() => toggle('profanityFilter')} /> Profanity filter</label>
          <label><input type="checkbox" checked={s.tts !== false} onChange={() => toggle('tts')} /> Narrator (reads each round aloud)</label>
          <label><input type="checkbox" checked={!!s.reducedMotion} onChange={() => toggle('reducedMotion')} /> Reduced motion</label>
          <label className="slider">Music <input type="range" min="0" max="1" step="0.05" value={vol.music} onChange={(e) => changeVol('music', +e.target.value)} /></label>
          <label className="slider">SFX <input type="range" min="0" max="1" step="0.05" value={vol.sfx} onChange={(e) => changeVol('sfx', +e.target.value)} /></label>
          <VoicePicker />
          <label className="slider">Voice <input type="range" min="0" max="1" step="0.05" value={vol.voice ?? 1} onChange={(e) => changeVol('voice', +e.target.value)} /></label>
        </div>
        </details>

        <div className="lobby-start">
          <button className="btn btn-pink btn-xl" disabled={!canStart} onClick={() => engine.startGame()}>
            Start the game
          </button>
          <span className="hint">
            {canStart ? 'Or the VIP can start from their phone.' : `Need at least ${MIN_PLAYERS} players (3+ recommended).`}
          </span>
          <p className="music-credit">Music: Kevin MacLeod (incompetech.com), CC BY 4.0</p>
        </div>
      </div>
    </div>
  )
}

function VoicePicker() {
  const [ai, setAi] = useState(getAiVoiceState)
  useEffect(() => subscribeAiVoice(setAi), [])
  return (
    <div className="voice-picker">
      <label className="slider">
        Narrator voice
        <select value={ai.choice} onChange={(e) => setVoiceChoice(e.target.value)}>
          <option value={AUTO}>Auto (Heart, natural voice)</option>
          {VOICE_GROUPS.map((g) => (
            <optgroup key={g.engine} label={g.label}>
              {g.voices.map((v) => <option key={v.id} value={`${g.engine}:${v.id}`}>{v.label}</option>)}
            </optgroup>
          ))}
          <option value={BROWSER_VOICE}>Browser voice (robotic)</option>
        </select>
        <button type="button" className="btn btn-ghost voice-test" onClick={() => narrate("Hi! I'm your Truth Be Told host. Let's play!", { maxWait: 20000 })}>▶ Test</button>
      </label>
      {ai.text && <span className={`voice-status ${ai.tone}`}>{ai.text}</span>}
    </div>
  )
}

// --------------------------------------------------------- INTRO / TITLES

export function IntroScreen({ engine }) {
  const rules = [
    ['No. 1', 'Read the true story'],
    ['No. 2', 'Tap the right answer'],
    ['No. 3', 'Faster = more points'],
  ]
  return (
    <div className="screen intro">
      <motion.h1 className="logo" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}>
        Truth <span>Be</span> Told
      </motion.h1>
      <p className="tagline big">Four answers. One true story. Wrong answers cost points.</p>
      <div className="rules">
        {rules.map(([icon, text], i) => (
          <motion.div key={text} className="rule" initial={{ y: 60, opacity: 0, rotate: 0 }} animate={{ y: 0, opacity: 1, rotate: TILTS[i] }} transition={{ ...spring, delay: 0.4 + i * 0.15 }}>
            <div className="rule-icon">{icon}</div>
            <div>{text}</div>
          </motion.div>
        ))}
      </div>
      <button className="btn btn-ghost skip" onClick={() => engine.skip()}>Skip ▶</button>
    </div>
  )
}

export function RoundTitleScreen({ pub, final = false }) {
  useEffect(() => sfx('drum'), [])
  const title = final ? 'THE FINAL ROUND' : `ROUND ${pub.round}`
  const sub = final ? 'Triple points!' : pub.round === 2 ? 'Double points!' : 'Know it. Tap it. Win it.'
  return (
    <div className="screen round-title">
      <div className="fp-spin">
        <div className="fp-mast"><span>{final ? 'THE FINAL ROUND' : 'BLACK HISTORY MONTH'}</span><b>Truth Be Told</b><span>OCTOBER 2026</span></div>
        <h1 className="huge"><span className="swipe">{title}</span></h1>
      </div>
      {pub.multiplier > 1 && (
        <motion.div className="mult-badge" initial={{ scale: 3, opacity: 0 }} animate={{ scale: 1, opacity: 1, x: [0, -10, 10, -6, 6, 0] }} transition={{ delay: 0.5, duration: 0.6 }}>
          ×{pub.multiplier}
        </motion.div>
      )}
      <p className="tagline">{sub}</p>
    </div>
  )
}

// ---------------------------------------------------------- CATEGORY_PICK

export function CategoryPickScreen({ pub, serverNow, rm }) {
  const fire = useConfetti(rm)
  // Scaled with the phase (tests run the clock faster).
  const landMs = (SPIN_LAND_MS / TIMERS.CATEGORY_PICK) * (pub.deadline ? pub.deadline - pub.startedAt : TIMERS.CATEGORY_PICK)
  const [landed, setLanded] = useState(false)
  useEffect(() => { sfx('riser') }, [])
  const land = () => {
    setLanded(true)
    sfx('ding')
    fire({ particleCount: 90, spread: 70, origin: { y: 0.55 } })
  }
  return (
    <div className="screen category-pick">
      <TopBar pub={pub} serverNow={serverNow} label={`Question ${pub.questionIndex + 1} of ${pub.questionsInRound}`} />
      <div className="picker-text">{landed ? 'The category is…' : 'Spinning for a category…'}</div>
      <div className="slot-machine">
        <div className="slot-lights" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <span key={i} style={{ animationDelay: `${i * 0.08}s` }} />)}</div>
        <SlotReel
          items={CATEGORIES}
          target={pub.category}
          seed={pub.questionNo}
          startedAt={pub.startedAt}
          landMs={landMs}
          serverNow={serverNow}
          rowHeight={120}
          onTick={() => sfx('tick')}
          onLand={land}
        />
      </div>
    </div>
  )
}

// --------------------------------------------------------------- QUESTION

export function QuestionScreen({ pub, serverNow, rm }) {
  const words = pub.question.prompt.split(' ')
  useEffect(() => {
    if (rm) return
    const id = setInterval(() => sfx('typeTick'), 70)
    const stop = setTimeout(() => clearInterval(id), Math.min(1500, words.length * 70))
    return () => {
      clearInterval(id)
      clearTimeout(stop)
    }
  }, [])
  const per = rm ? 0 : Math.min(0.09, 1.3 / words.length)
  return (
    <div className="screen question">
      <TopBar pub={pub} serverNow={serverNow} />
      <div className="question-body">
        <p className="question-text big">
          {words.map((w, i) => {
            const parts = w.split(/(_{2,})/)
            return (
              <motion.span key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * per, duration: 0.05 }}>
                {parts.map((p, j) =>
                  /_{2,}/.test(p) ? (
                    <motion.span key={j} className="blank blank-draw" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: words.length * per + 0.1, duration: 0.4 }}>
                      {' '.repeat(12)}
                    </motion.span>
                  ) : (
                    p
                  ),
                )}{' '}
              </motion.span>
            )
          })}
        </p>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- PICK_TRUTH

export function PickTruthScreen({ pub, serverNow, rm }) {
  const count = pub.picked?.length ?? 0
  const prev = useRef(count)
  useEffect(() => {
    if (count > prev.current) sfx('pop')
    prev.current = count
  }, [count])
  useEffect(() => {
    const ids = pub.options.map((_, i) => setTimeout(() => sfx('bubble'), 80 * i))
    return () => ids.forEach(clearTimeout)
  }, [])
  return (
    <div className="screen pick-truth">
      <TopBar pub={pub} serverNow={serverNow} />
      <p className="question-text small"><Prompt text={pub.question.prompt} /></p>
      <div className="options-grid quiz">
        {pub.options.map((o, i) => (
          <motion.div
            key={o.id}
            className="option-card"
            initial={rm ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={rm ? { duration: 0.2 } : { ...spring, delay: i * 0.08 }}
          >
            <span className="opt-letter">{LETTERS[i]}</span>
            <span className="opt-text">{o.text}</span>
          </motion.div>
        ))}
      </div>
      <AvatarRow pub={pub} doneIds={pub.picked} detectorIds={pub.lifelines} />
    </div>
  )
}

// ----------------------------------------------------------------- REVEAL

// The answer counts grow in, then the truth lights up, then the fastest
// correct answers are shown.
export function RevealScreen({ pub, serverNow, rm }) {
  const now = useNow(serverNow, 100)
  const elapsed = now - pub.startedAt
  const r = pub.reveal
  const showTruth = elapsed >= r.truthAt
  const showFastest = elapsed >= r.fastestAt
  const players = byId(pub.players)
  const fire = useConfetti(rm)
  const narrating = pub.settings?.tts !== false
  const lines = useMemo(() => (narrating ? revealLines(r, players) : { start: [], verdict: [] }), [])
  useEffect(() => {
    if (!r.nobodyFound) sfx('drumroll')
    if (lines.start.length) narrate(lines.start)
  }, [])
  useEffect(() => {
    if (!showTruth) return
    if (lines.verdict.length) narrate(lines.verdict, { queue: !r.nobodyFound })
    if (r.nobodyFound) {
      sfx('sadTrombone')
    } else {
      sfx('fanfare')
      fire({ colors: ['#F2B705', '#146B45', '#D7263D', '#FFF5DD'] })
    }
  }, [showTruth])

  const max = Math.max(1, ...Object.values(r.counts))
  const total = gamePlayers(pub).length
  return (
    <div className="screen reveal quiz-reveal">
      <p className="question-text small"><Prompt text={pub.question.prompt} /></p>
      <div className="answer-bars">
        {pub.options.map((o, i) => {
          const isTruth = o.id === r.truthId
          const n = r.counts[o.id] ?? 0
          const state = showTruth ? (isTruth ? 'is-truth' : 'is-wrong') : ''
          return (
            <div key={o.id} className={`answer-bar ${state}`}>
              <motion.span
                className="answer-fill"
                initial={{ width: rm ? `${(n / max) * 100}%` : '0%' }}
                animate={{ width: `${(n / max) * 100}%` }}
                transition={{ duration: rm ? 0 : 1.2, delay: rm ? 0 : 0.2 + i * 0.1, ease: [0.2, 0.7, 0.3, 1] }}
              />
              <span className="opt-letter">{LETTERS[i]}</span>
              <span className="answer-text">{o.text}</span>
              {showTruth && isTruth && (
                <motion.span className="true-stamp" initial={rm ? { opacity: 0 } : { scale: 3, opacity: 0, rotate: -8 }} animate={{ scale: 1, opacity: 1, rotate: -4 }} transition={{ duration: 0.28 }}>
                  TRUE STORY
                </motion.span>
              )}
              <span className="answer-count">{n}</span>
            </div>
          )
        })}
      </div>
      <div className="fastest">
        {showFastest && (
          <motion.div initial={rm ? { opacity: 0 } : { y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={rm ? { duration: 0.2 } : spring}>
            {r.nobodyFound ? (
              <div className="fastest-title">Nobody found the truth this time!</div>
            ) : (
              <>
                <div className="fastest-title">
                  <strong>{r.correct.length}</strong> of {total} found the truth · Fastest fingers
                </div>
                <div className="fastest-list">
                  {r.fastest.map((f, i) => players[f.id] && (
                    <motion.div key={f.id} className="fastest-chip" initial={rm ? { opacity: 0 } : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ ...spring, delay: rm ? 0 : i * 0.12 }}>
                      <span className="fastest-rank">{i + 1}</span>
                      <Avatar player={players[f.id]} size={64} />
                      <span className="chip-name">{players[f.id].name}</span>
                      <span className="fastest-time">{(f.ms / 1000).toFixed(1)}s</span>
                      <span className="points">+{fmt(f.points)}</span>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------- SCOREBOARD

export function ScoreboardScreen({ pub, rm }) {
  const [settled, setSettled] = useState(rm)
  const players = gamePlayers(pub)
  const prev = pub.scoreboard?.prev || {}
  const deltas = pub.scoreboard?.deltas || {}
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), 900)
    players.slice(0, CROWD).forEach((_, i) => setTimeout(() => sfx('blip'), 150 * i))
    return () => clearTimeout(t)
  }, [])
  const scoreOf = (p) => (settled ? p.score : prev[p.id] ?? 0)
  const sortedAll = [...players].sort((a, b) => scoreOf(b) - scoreOf(a) || a.slot - b.slot)
  const sorted = sortedAll.slice(0, CROWD) // top of the table; everyone sees their own rank on their phone
  // The line-up: crown and tears appear once the new scores have settled.
  const st = settled ? standings(pub) : standings({ ...pub, phase: 'LOBBY' })
  const width = sorted.length > 6 ? 170 : sorted.length > 4 ? 210 : 240
  return (
    <div className="screen scoreboard">
      <h2 className="screen-title">Leaderboard</h2>
      {pub.truth && <p className="truth-recap">The truth: <strong>{pub.truth}</strong> ✓</p>}
      <LayoutGroup>
        <div className="lineup">
          {sorted.map((p, i) => (
            <motion.div layout={!rm} key={p.id} className="lineup-slot" transition={spring} style={{ '--tilt': `${TILTS[i % TILTS.length] / 2}deg`, animationDelay: `${0.1 + i * 0.15}s, ${-i * 0.8}s` }}>
              <Mugshot
                player={p}
                width={width}
                flash={0.15 + i * 0.15}
                crown={st.crown(p)}
                tears={st.tears(p)}
                tag={`#${i + 1}`}
                tagTone={st.crown(p) ? 'gold' : st.tears(p) ? 'blue' : 'plain'}
                footer={
                  <div className="lineup-score">
                    <span className="score-num">{fmt(scoreOf(p))}</span>
                    <span className={`score-delta ${(deltas[p.id] ?? 0) < 0 ? 'neg' : ''}`}>
                      {deltas[p.id] ? signed(deltas[p.id]) : ''}
                    </span>
                  </div>
                }
              />
            </motion.div>
          ))}
        </div>
      </LayoutGroup>
      {sortedAll.length > sorted.length && <p className="truth-recap">Top {sorted.length} of {sortedAll.length} · check your phone for your rank</p>}
    </div>
  )
}
