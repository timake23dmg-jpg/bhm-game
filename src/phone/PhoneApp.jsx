import React, { useCallback, useEffect, useState } from 'react'
import { createPlayerTransport } from '../lib/transport/index.js'
import { rankPlayers } from '../engine/hostEngine.js'
import { MAX_PLAYERS, LETTERS, TIMERS, SPIN_LAND_MS } from '../engine/constants.js'
import { CATEGORIES } from '../data/categories.js'
import { AVATARS, Avatar, MuteButton, Prompt, SlotReel, Wordmark, fmt, signed, useNow } from '../components/shared.jsx'
import { setLobbyMusic, primeLobbyMusic, getMusicState, subscribeMusic } from '../lib/lobbyMusic.js'
import MugshotCamera from './MugshotCamera.jsx'

const CODE_KEY = 'fakeout.playerCode'
const PROFILE_KEY = 'fakeout.profile'

const haptic = () => {
  try {
    navigator.vibrate?.(30)
  } catch {
    // no vibration support
  }
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null') || {}
  } catch {
    return {}
  }
}

function saveProfile(patch) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...loadProfile(), ...patch }))
  } catch {
    // profile just won't persist (e.g. storage full)
  }
}

export default function PhoneApp({ initialCode }) {
  const [transport, setTransport] = useState(null)
  const [me, setMe] = useState(null)
  const [code, setCode] = useState(null)
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const [checking, setChecking] = useState(true)
  const [prefill, setPrefill] = useState(initialCode)
  // Mugshot selfie, kept on this phone so it's reused in every room.
  const [photo, setPhoto] = useState(() => loadProfile().photo || null)
  const [cameraOpen, setCameraOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    let created = null
    ;(async () => {
      try {
        const t = await createPlayerTransport()
        created = t
        if (cancelled) return t.close?.()
        setTransport(t)
        // Reconnect: this browser session already has a player in the room?
        const candidate = (initialCode || localStorage.getItem(CODE_KEY) || '').toUpperCase()
        if (candidate) {
          const player = await t.findMyPlayer(candidate)
          if (player && !cancelled) {
            setMe(player)
            setCode(player.gameCode)
            const saved = loadProfile().photo
            if (saved && !player.photo && !player.isAudience) t.setPhoto(player.gameCode, saved).catch(() => {})
          }
        }
      } catch (err) {
        setError(err.message)
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
      created?.close?.()
    }
  }, [initialCode])

  useEffect(() => {
    if (!transport || !code || !me) return
    return transport.subscribeGame(code, me.id, (s) => {
      setState((prev) => (prev && s.startedAt === prev.startedAt && JSON.stringify(s) === JSON.stringify(prev) ? prev : s))
    })
  }, [transport, code, me])

  // Keep our own row (name/avatar/audience) in sync with what the host publishes.
  const meLive = state?.players?.find((p) => p.id === me?.id)

  // Lobby song loops from the join screen through the waiting lobby, and
  // ends when the game starts. (A reconnecting player mid-game hears nothing.)
  const inLobby = !checking && (!me || state?.phase === 'LOBBY' || state?.phase === 'ENDED')
  useEffect(() => {
    setLobbyMusic(inLobby)
  }, [inLobby])

  // Keep the URL's ?code= in step with the room we're in, so a reload
  // doesn't land back in an old (ended) room.
  const setUrlCode = (c) => {
    try {
      window.history.replaceState(null, '', `#/play${c ? `?code=${c}` : ''}`)
    } catch {
      // URL just stays as it was
    }
  }

  const leave = () => {
    localStorage.removeItem(CODE_KEY)
    setUrlCode('')
    setPrefill('')
    setMe(null)
    setCode(null)
    setState(null)
  }

  // After joining: reuse this phone's mugshot, or offer the camera.
  const afterJoin = (t, player) => {
    if (player.isAudience) return
    const saved = loadProfile()
    if (saved.photo) {
      if (player.photo !== saved.photo) t.setPhoto(player.gameCode, saved.photo).catch(() => {})
    } else if (!saved.photoSkipped) {
      setCameraOpen(true)
    }
  }

  const joined = (player) => {
    afterJoin(transport, player)
    localStorage.setItem(CODE_KEY, player.gameCode)
    setUrlCode(player.gameCode)
    setPrefill(player.gameCode)
    setState(null)
    setMe(player)
    setCode(player.gameCode)
  }

  if (checking) return <div className="phone center-fill"><div className="spinner" /></div>
  if (!me) {
    return (
      <JoinForm
        transport={transport}
        initialCode={prefill || localStorage.getItem(CODE_KEY) || ''}
        error={error}
        onJoined={joined}
      />
    )
  }
  if (!state) return <div className="phone center-fill"><p>Connecting to room {code}…</p><div className="spinner" /></div>
  if (state.phase === 'ENDED') {
    return <GameEnded transport={transport} me={meLive || me} nextCode={state.nextCode} onJoined={joined} onLeave={leave} />
  }
  const self = { ...(meLive || me), photo }
  if (cameraOpen && state.phase === 'LOBBY') {
    return (
      <MugshotCamera
        player={self}
        onDone={(shot) => {
          setPhoto(shot)
          saveProfile({ photo: shot, photoSkipped: false })
          setCameraOpen(false)
          transport.setPhoto(code, shot).catch(() => {})
        }}
        onSkip={() => {
          saveProfile({ photoSkipped: true })
          setCameraOpen(false)
        }}
      />
    )
  }

  return (
    <div className="phone">
      <header className="phone-header">
        <Avatar player={self} size={40} flip={false} />
        <span className="phone-name">{(meLive || me).name}</span>
        {meLive?.isAudience ? <span className="tag">Audience</span> : <span className="phone-score">{fmt(meLive?.score ?? 0)}</span>}
        <MuteButton />
        <button className="room-chip" onClick={leave} title="Leave room">{code} ✕</button>
      </header>
      <main className="phone-main">
        {state.phase === 'LOBBY' && !self.isAudience && (
          <button type="button" className="mugcam-open" onClick={() => setCameraOpen(true)}>
            📸 {photo ? 'Retake your mugshot' : 'Take your mugshot'}
          </button>
        )}
        <PhoneView transport={transport} code={code} me={self} state={state} />
      </main>
    </div>
  )
}

// ------------------------------------------------------------------- join

function JoinForm({ transport, initialCode, error: initError, onJoined }) {
  const profile = loadProfile()
  const [code, setCode] = useState(initialCode.toUpperCase())
  const [name, setName] = useState(profile.name || '')
  const [avatar, setAvatar] = useState(profile.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)])
  const [audience, setAudience] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initError)

  const submit = async (e) => {
    primeLobbyMusic() // this tap lets the lobby music play on mobile browsers
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const player = await transport.joinGame(code.trim().toUpperCase(), name.trim(), avatar, audience)
      saveProfile({ name: name.trim(), avatar })
      onJoined(player)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="phone join" onSubmit={submit}>
      <MuteButton className="floating" />
      <Wordmark className="small" />
      <label className="field">
        <span>Room code</span>
        <input className="code-input" value={code} maxLength={4} autoCapitalize="characters" autoComplete="off" placeholder="ABCD"
          onChange={(e) => setCode(e.target.value.toUpperCase())} required />
      </label>
      <label className="field">
        <span>Your name</span>
        <input value={name} maxLength={16} placeholder="Name" onChange={(e) => setName(e.target.value)} required />
      </label>
      <div className="field">
        <span>Pick an avatar</span>
        <div className="avatar-grid">
          {AVATARS.map((a) => (
            <button type="button" key={a} className={`avatar-pick ${a === avatar ? 'selected' : ''}`} onClick={() => setAvatar(a)} aria-pressed={a === avatar}>
              {a}
            </button>
          ))}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={audience} onChange={(e) => setAudience(e.target.checked)} /> Join as audience (vote, no score)
      </label>
      {error && <p className="error">{error}</p>}
      <div className="bottom-actions">
        <button className="btn btn-pink btn-block" disabled={busy || !transport || code.length !== 4 || !name.trim()}>
          {busy ? 'Joining…' : 'Join game'}
        </button>
      </div>
    </form>
  )
}

// The host ended the room. Offer their new room (same name and avatar).
function GameEnded({ transport, me, nextCode, onJoined, onLeave }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const rejoin = async () => {
    primeLobbyMusic()
    setBusy(true)
    setError(null)
    try {
      const player = await transport.joinGame(nextCode, me.name, me.avatar, false)
      onJoined(player)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return (
    <div className="phone">
      <main className="phone-main">
        <Waiting title="Game over!" sub={nextCode ? 'The host opened a new room.' : 'The host ended the game.'}>
          {nextCode && <div className="room-code-big">{nextCode}</div>}
          {error && <p className="error">{error}</p>}
          <div className="bottom-actions">
            {nextCode && (
              <button className="btn btn-pink btn-block" disabled={busy} onClick={rejoin}>
                {busy ? 'Joining…' : `Join new room as ${me.name}`}
              </button>
            )}
            <button className="btn btn-ghost btn-block" onClick={onLeave}>{nextCode ? 'Use a different code' : 'Back'}</button>
          </div>
        </Waiting>
      </main>
    </div>
  )
}

// ------------------------------------------------------------------ views

function useMine(transport, code, me, questionNo) {
  const [mine, setMine] = useState({ questionNo: null, lie: null, pick: null, likes: [] })
  useEffect(() => {
    if (!questionNo) return
    let cancelled = false
    transport.fetchMine(code, questionNo, me.id).then((m) => {
      if (!cancelled) setMine((prev) => (prev.questionNo === questionNo ? { ...m, ...pickTruthy(prev) } : { questionNo, ...m }))
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [transport, code, me.id, questionNo])
  const update = useCallback((patch) => setMine((prev) => ({ ...prev, questionNo, ...patch })), [questionNo])
  return [mine.questionNo === questionNo ? mine : { questionNo, lie: null, pick: null, likes: [] }, update]
}

// Local values win over a slower fetch that raced them.
function pickTruthy(prev) {
  const out = {}
  if (prev.lie) out.lie = prev.lie
  if (prev.pick) out.pick = prev.pick
  if (prev.likes?.length) out.likes = prev.likes
  if (prev.bought) out.bought = prev.bought
  if (prev.keep) out.keep = prev.keep
  return out
}

function Countdown({ transport, state }) {
  const now = useNow(transport.serverNow, 250)
  if (state.deadline == null) return null
  const secs = Math.max(0, Math.ceil((state.deadline - now) / 1000))
  return <div className={`phone-timer ${secs <= 10 ? 'urgent' : ''}`}>⏱ {secs}s</div>
}

function Waiting({ title, sub, children }) {
  return (
    <div className="waiting">
      <h2>{title}</h2>
      {sub && <p>{sub}</p>}
      {children}
    </div>
  )
}

function PhoneView({ transport, code, me, state }) {
  const [mine, updateMine] = useMine(transport, code, me, state.questionNo)
  const isVip = state.vipId === me.id
  const audience = me.isAudience
  const players = state.players.filter((p) => !p.isAudience)
  const byId = Object.fromEntries(state.players.map((p) => [p.id, p]))
  const send = (cmd, payload) => transport.sendCommand(code, me.id, cmd, payload).catch(() => {})

  switch (state.phase) {
    case 'LOBBY':
      return <PartyLobby me={me} state={state} code={code} players={players} audienceCount={state.players.length - players.length}
        isVip={isVip} vipName={byId[state.vipId]?.name} onStart={() => send('start')} />


    case 'INTRO':
      return (
        <Waiting title="Get ready!" sub="Tap the true answer. The faster you are, the more you score.">
          {isVip && (
            <div className="bottom-actions">
              <button className="btn btn-ghost btn-block" onClick={() => send('skipIntro')}>Skip intro ▶</button>
            </div>
          )}
        </Waiting>
      )

    case 'ROUND_TITLE':
    case 'FINAL_TITLE':
      return <Waiting title="Look at the screen" sub={state.phase === 'FINAL_TITLE' ? 'The Final Round — triple points!' : `Round ${state.round}${state.round === 2 ? ' — double points!' : ''}`} />

    case 'CATEGORY_PICK':
      return <CategorySpin transport={transport} state={state} />

    case 'QUESTION':
      return (
        <Waiting title="Get ready…" sub="The answers are coming!">
          <p className="phone-question"><Prompt text={state.question.prompt} /></p>
        </Waiting>
      )

    case 'PICK_TRUTH':
      return <PickTruth transport={transport} code={code} me={me} state={state} mine={mine} updateMine={updateMine} />

    case 'REVEAL':
      return <RevealResult transport={transport} me={me} state={state} />

    case 'SCOREBOARD': {
      if (audience) return <Waiting title="Scores are up!" sub="Look at the screen" />
      const ranked = rankPlayers(players, (p) => p.score)
      const mineRank = ranked.find((p) => p.id === me.id)
      const delta = state.scoreboard?.deltas?.[me.id] ?? 0
      return (
        <Waiting title={`#${mineRank?.rank ?? '–'}`} sub={`of ${players.length}`}>
          <div className="big-score">{fmt(mineRank?.score ?? 0)}</div>
          {delta !== 0 && <div className={`delta ${delta < 0 ? 'neg' : ''}`}>{signed(delta)} this question</div>}
        </Waiting>
      )
    }

    case 'WINNER': {
      if (audience) return <Waiting title="And the winner is…" sub="Look at the screen!" />
      const won = state.winners?.includes(me.id)
      const rank = rankPlayers(players, (p) => p.score).find((p) => p.id === me.id)?.rank
      return (
        <Waiting title={won ? (state.winners.length > 1 ? 'You tied for the win!' : 'You won! 👑') : `You placed #${rank}`}>
          <div className="big-score">{fmt(me.score)}</div>
        </Waiting>
      )
    }

    case 'AWARDS': {
      const myAwards = (state.awards || []).filter((a) => a.playerIds.includes(me.id))
      return (
        <Waiting title={myAwards.length ? 'You got an award!' : 'Awards'} sub={myAwards.length ? null : 'Look at the screen'}>
          {myAwards.map((a) => (
            <div key={a.key} className="phone-award">
              <strong>{a.title}</strong>
              <span>{a.stat}</span>
            </div>
          ))}
          {isVip && (
            <div className="bottom-actions stack">
              <button className="btn btn-pink btn-block" onClick={() => send('playAgain')}>Play again</button>
              <button className="btn btn-ghost btn-block" onClick={() => send('backToLobby')}>Back to lobby</button>
            </div>
          )}
        </Waiting>
      )
    }

    default:
      return <Waiting title="Look at the screen" />
  }
}

function PickTruth({ transport, code, me, state, mine, updateMine }) {
  const [error, setError] = useState(null)
  const options = state.options || []

  const pick = async (optionId) => {
    haptic()
    updateMine({ pick: optionId })
    try {
      const res = await transport.submitPick(code, state.questionNo, optionId)
      if (!res.ok) {
        updateMine({ pick: null })
        setError(res.reason === 'closed' ? 'Too late — time is up!' : 'Could not pick that.')
      }
    } catch (err) {
      updateMine({ pick: null })
      setError(err.message)
    }
  }

  // Truth Detector: once per game, cuts the options down to the truth + one wrong answer.
  const [detecting, setDetecting] = useState(false)
  const detect = async () => {
    setError(null)
    setDetecting(true)
    try {
      const res = await transport.useLifeline(code, state.questionNo)
      if (res?.ok) {
        haptic()
        updateMine({ keep: res.keep })
      } else {
        setError(res?.reason === 'closed' ? 'Too late — time is up!' : res?.reason === 'picked' ? 'You already picked!' : 'Your Truth Detector is used up.')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setDetecting(false)
    }
  }

  if (!mine.pick) {
    return (
      <div className="pick-list">
        <Countdown transport={transport} state={state} />
        <p className="phone-question small"><Prompt text={state.question.prompt} /></p>
        {error && <p className="error">{error}</p>}
        {mine.keep && <p className="detector-note">🔍 One of these two is the truth!</p>}
        <div className="stack">
          {options.map((o, i) => {
            const ruledOut = mine.keep && !mine.keep.includes(o.id)
            return (
              <button key={o.id} className={`btn btn-option btn-block ${ruledOut ? 'ruled-out' : ''}`} disabled={ruledOut} onClick={() => pick(o.id)}>
                <span className="opt-letter">{LETTERS[i]}</span>
                <span className="opt-text">{o.text}</span>
              </button>
            )
          })}
        </div>
        {!mine.keep && !me.lifelineUsed && !me.isAudience && (
          <button type="button" className="btn btn-ghost btn-block detector-btn" disabled={detecting} onClick={detect}>
            🔍 Truth Detector <small>once per game: leaves the truth + one wrong answer</small>
          </button>
        )}
      </div>
    )
  }

  const i = options.findIndex((o) => o.id === mine.pick)
  return (
    <Waiting title="Locked in! 🔒" sub="Watch the screen for the answer.">
      <Countdown transport={transport} state={state} />
      {i >= 0 && (
        <div className="btn btn-option btn-block chosen">
          <span className="opt-letter">{LETTERS[i]}</span>
          <span className="opt-text">{options[i].text}</span>
        </div>
      )}
    </Waiting>
  )
}

// The category slot machine, in step with the TV.
function CategorySpin({ transport, state }) {
  const landMs = (SPIN_LAND_MS / TIMERS.CATEGORY_PICK) * (state.deadline ? state.deadline - state.startedAt : TIMERS.CATEGORY_PICK)
  const [landed, setLanded] = useState(false)
  return (
    <Waiting title={landed ? 'The category is…' : '🎰 Spinning…'} sub={landed ? 'Get ready for the question!' : 'Watch the screen'}>
      <SlotReel
        items={CATEGORIES}
        target={state.category}
        seed={state.questionNo}
        startedAt={state.startedAt}
        landMs={landMs}
        serverNow={transport.serverNow}
        rowHeight={56}
        className="slot-phone"
        onLand={() => { haptic(); setLanded(true) }}
      />
    </Waiting>
  )
}

// Right or wrong, and the points, once the TV shows the truth.
function RevealResult({ transport, me, state }) {
  const now = useNow(transport.serverNow, 250)
  const r = state.reveal
  if (me.isAudience || !r) return <Waiting title="Watch the reveal 👀" />
  if (now - state.startedAt < r.truthAt) return <Waiting title="And the truth is…" sub="Look at the screen 👀" />
  const delta = r.deltas[me.id]
  const place = r.correct.indexOf(me.id)
  const title = delta == null ? 'No answer' : delta > 0 ? 'Correct! ✅' : 'Wrong ❌'
  return (
    <Waiting title={title} sub={`The truth: ${r.truthText}`}>
      <div className={`big-score ${delta < 0 ? 'neg' : ''}`}>{delta ? signed(delta) : '±0'}</div>
      {place === 0 && r.correct.length > 1 && <p className="hint">⚡ You were the fastest!</p>}
      {place > 0 && place < 5 && <p className="hint">⚡ #{place + 1} fastest</p>}
      {(me.streak ?? 0) >= 3 && <p className="hint">🔥 {me.streak} in a row!</p>}
    </Waiting>
  )
}

// ------------------------------------------------------------ party lobby

const TIPS = [
  'The faster you tap the right answer, the more points you get.',
  'Wrong answers cost points, so don’t just guess wildly!',
  'Stuck? Use your Truth Detector: once per game, it leaves just two answers.',
  'Points double in Round 2 and triple in the Final Round!',
  'Prizes for the winner, Fastest Fingers and the longest Hot Streak.',
]

function NowPlaying() {
  const [music, setMusic] = useState(getMusicState)
  useEffect(() => subscribeMusic(setMusic), [])
  if (music.muted) return <p className="now-playing off">🔇 Music muted</p>
  if (music.blocked) return <p className="now-playing off">🔈 Tap anywhere for music</p>
  if (!music.playing) return null
  return (
    <p className="now-playing">
      <span className="eq" aria-hidden="true"><i /><i /><i /></span>
      Now playing: Monkeys Spinning Monkeys
    </p>
  )
}

function PartyLobby({ me, state, code, players, audienceCount, isVip, vipName, onStart }) {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length))
  useEffect(() => {
    const id = setInterval(() => setTip((t) => (t + 1) % TIPS.length), 5000)
    return () => clearInterval(id)
  }, [])
  const open = Math.max(0, 8 - players.length) // placeholder tiles only for small rooms

  return (
    <div className="party">
      <h2 className="party-title">{me.isAudience ? "You're in the audience! 👀" : "You're in! 🎉"}</h2>
      <p className="party-sub">
        Room <strong>{code}</strong> · {players.length}/{MAX_PLAYERS} players{audienceCount > 0 ? ` · ${audienceCount} watching` : ''}
      </p>

      <div className="party-grid">
        {(players.length > 24 ? [players.find((p) => p.id === me.id), ...players.filter((p) => p.id !== me.id).slice(-23)].filter(Boolean) : players).map((p, i) => (
          <div key={p.id} className={`party-player ${p.id === me.id ? 'me' : ''}`} style={{ '--delay': `${(i % 4) * 0.15}s` }}>
            {p.id === state.vipId && <span className="party-crown" aria-label="VIP">👑</span>}
            <div className="party-bounce"><Avatar player={p.id === me.id ? { ...p, photo: me.photo } : p} size={56} flip={false} /></div>
            <span className="party-name">{p.id === me.id ? 'You' : p.name}</span>
          </div>
        ))}
        {Array.from({ length: open }, (_, i) => (
          <div key={`open-${i}`} className="party-player empty"><div className="party-empty" /><span className="party-name">…</span></div>
        ))}
      </div>

      <p className="party-tip" key={tip}>💡 {TIPS[tip]}</p>
      <NowPlaying />

      {isVip ? (
        <div className="bottom-actions">
          <p className="hint">You're the VIP: start when everyone's here.</p>
          <button className="btn btn-pink btn-block" disabled={players.length < 2} onClick={onStart}>
            {players.length < 2 ? 'Waiting for another player…' : "Everybody's in!"}
          </button>
        </div>
      ) : (
        <p className="hint party-wait">Waiting for {vipName ?? 'the VIP'} to start the game…</p>
      )}
    </div>
  )
}
