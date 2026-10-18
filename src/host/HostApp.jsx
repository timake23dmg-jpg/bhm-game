import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { createHostTransport, BACKEND } from '../lib/transport/index.js'
import { HostEngine } from '../engine/hostEngine.js'
import { unlockAudio, enableGestureUnlock, preloadMusic, sfx, playMusic, stopMusic, songForPhase, setVolumes } from '../lib/audio.js'
import { narrate, prepareLines, stopNarration } from '../lib/narrator.js'
import { loadAiVoice, subscribeAiVoice, voiceIsLive } from '../lib/aiVoice.js'
import { MuteButton, Wordmark } from '../components/shared.jsx'
import { Masthead, Ticker } from './Chrome.jsx'
import { setLobbyMusic, primeLobbyMusic } from '../lib/lobbyMusic.js'
import {
  phaseLine, questionLine, answerLine, revealLines, winnerLines, awardLine, lifelineLine, tenSecondsLine, playerLines, FIXED_LINES,
} from './narration.js'
import { revealContext } from './revealContext.js'
import {
  LobbyScreen, IntroScreen, RoundTitleScreen, CategoryPickScreen, QuestionScreen, LieEntryScreen,
  PickTruthScreen, RevealScreen, ScoreboardScreen,
} from './HostScreens.jsx'
import { WinnerScreen, AwardsScreen } from './EndScreens.jsx'

const HOST_CODE_KEY = 'fakeout.hostCode'
const PLAYED_KEY = 'fakeout.playedQuestions'
const PLAYED_MAX = 250 // most of the bank: older questions come back eventually

// Questions this TV has played, newest last, across rooms and sessions, so a
// new room doesn't serve the same questions again.
const questionHistory = {
  recent() {
    try {
      const list = JSON.parse(localStorage.getItem(PLAYED_KEY) || '[]')
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  },
  add(id) {
    try {
      const list = [...this.recent().filter((x) => x !== id), id].slice(-PLAYED_MAX)
      localStorage.setItem(PLAYED_KEY, JSON.stringify(list))
    } catch {
      // history just won't persist
    }
  },
}

function loadVolumes() {
  try {
    const v = JSON.parse(localStorage.getItem('fakeout.volumes') || 'null')
    if (v) setVolumes(v)
  } catch {
    // defaults
  }
}

// Fixed 1920x1080 stage scaled to fit any TV/monitor.
function Stage({ children }) {
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return (
    <div className="stage-wrap">
      <div className="stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>{children}</div>
    </div>
  )
}

export default function HostApp() {
  const [transport, setTransport] = useState(null)
  const [pub, setPub] = useState(null)
  const [code, setCode] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [needsSoundClick, setNeedsSoundClick] = useState(false)
  const engineRef = useRef(null)
  // Hidden tabs get no animation frames, so exit transitions stall and
  // screens pile up. Remount the transition layer when we become visible.
  const [visKey, setVisKey] = useState(0)
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden')
  useEffect(() => {
    const onVis = () => {
      setHidden(document.visibilityState === 'hidden')
      if (document.visibilityState === 'visible') setVisKey((k) => k + 1)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  const startEngine = useCallback(async (t, roomCode, saved, settings) => {
    engineRef.current?.stop()
    const engine = new HostEngine({
      transport: t, code: roomCode, saved, settings, history: questionHistory,
      // Ignore a replaced engine's last publishes (e.g. the ENDED state).
      onPublic: (p) => engineRef.current === engine && setPub(p),
    })
    engineRef.current = engine
    setCode(roomCode)
    await engine.start()
  }, [])

  // Browsers only allow sound after a click: any click on the TV unlocks it.
  useEffect(() => {
    preloadMusic()
    return enableGestureUnlock()
  }, [])

  // The AI host voice downloads in the background (kept after the first time).
  // Once it's ready, or the voice changes, the host's lines are generated
  // ahead: stock lines first, then each player's name lines.
  const namesKey = (pub?.players || []).filter((p) => !p.isAudience).map((p) => p.name).join('|')
  const namesRef = useRef([])
  namesRef.current = namesKey ? namesKey.split('|') : []
  useEffect(() => {
    loadAiVoice()
    const prepareAll = () => {
      prepareLines(FIXED_LINES)
      for (const name of namesRef.current) prepareLines(playerLines(name), { priority: 1 })
    }
    prepareAll()
    return subscribeAiVoice(prepareAll)
  }, [])
  useEffect(() => {
    for (const name of namesRef.current) prepareLines(playerLines(name), { priority: 1 })
  }, [namesKey])

  useEffect(() => {
    loadVolumes()
    let cancelled = false
    let created = null
    ;(async () => {
      try {
        const t = await createHostTransport()
        created = t
        if (cancelled) return t.close?.()
        setTransport(t)
        const stored = localStorage.getItem(HOST_CODE_KEY)
        if (stored) {
          const saved = await t.loadHostedGame(stored)
          if (saved && !cancelled) {
            setNeedsSoundClick(true)
            await startEngine(t, stored, saved.data)
          }
        }
      } catch (err) {
        setError(err.message)
      }
    })()
    return () => {
      cancelled = true
      engineRef.current?.stop()
      created?.close?.()
      stopMusic()
      stopNarration()
    }
  }, [startEngine])

  // End the current room (mid-game or not) and open a fresh one with a new
  // code. Phones in the old room are offered the new code to rejoin.
  const [confirmEnd, setConfirmEnd] = useState(false)
  const endAndNewRoom = async () => {
    unlockAudio()
    setConfirmEnd(false)
    setBusy(true)
    setError(null)
    const old = engineRef.current
    try {
      const newCode = await transport.createGame({ profanityFilter: true })
      engineRef.current = null
      stopMusic()
      stopNarration()
      await old?.endGame(newCode)
      localStorage.setItem(HOST_CODE_KEY, newCode)
      await startEngine(transport, newCode, null, old ? { ...old.s.settings } : undefined)
    } catch (err) {
      if (!engineRef.current) engineRef.current = old
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const createRoom = async () => {
    unlockAudio()
    primeLobbyMusic()
    setBusy(true)
    setError(null)
    try {
      const roomCode = await transport.createGame({ profanityFilter: true })
      localStorage.setItem(HOST_CODE_KEY, roomCode)
      await startEngine(transport, roomCode, null)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const phase = pub?.phase
  // Party game on a TV: full motion unless the host ticks Reduced motion in the lobby.
  const rm = !!pub?.settings?.reducedMotion
  useEffect(() => {
    document.documentElement.classList.toggle('rm', rm)
  }, [rm])

  // The lobby theme plays from the moment the TV opens (start screen and
  // lobby) and hands over to the game music when the game starts.
  const preGame = !pub || pub.phase === 'LOBBY'
  useEffect(() => {
    setLobbyMusic(preGame)
  }, [preGame])

  // Phase-level sound and music.
  const phaseKey = pub ? `${pub.phase}:${pub.questionNo}:${pub.round}` : null
  const narrating = pub?.settings?.tts !== false
  useEffect(() => {
    if (!pub) return
    if (pub.phase !== 'LOBBY') sfx('whoosh')
    // The lobby theme is handled by setLobbyMusic above.
    const song = songForPhase(pub.phase)
    if (song) playMusic(song)
    else if (pub.phase !== 'LOBBY') stopMusic()
    if (!narrating) return
    // Lines that will be needed shortly, generated now so they're on time.
    if (pub.phase === 'QUESTION') {
      // The answer is said at the reveal: start on it now (only the TV knows it).
      const answer = engineRef.current?.s.current?.question?.answer
      if (answer) prepareLines([answerLine(answer)], { priority: 1 })
    } else if (pub.phase === 'REVEAL') {
      const players = Object.fromEntries(pub.players.map((p) => [p.id, p]))
      for (const step of pub.reveal.steps) {
        const l = revealLines(step, players, pub.reveal.nobodyFound, revealContext(pub))
        prepareLines([...l.start, ...l.verdict], { priority: 1 })
      }
    } else if (pub.phase === 'WINNER') {
      const players = Object.fromEntries(pub.players.map((p) => [p.id, p]))
      const winners = (pub.winners || []).map((id) => players[id]).filter(Boolean)
      if (winners.length) prepareLines(winnerLines(winners).verdict, { priority: 1 })
      prepareLines((pub.awards || []).flatMap((a) => awardLine(a, players)), { priority: 1 })
    }
    if (pub.phase === 'QUESTION') {
      // Read the question only on computers fast enough to voice it in time.
      if (voiceIsLive()) narrate(questionLine(pub), { maxWait: 2500 })
      else stopNarration()
      return
    }
    const line = phaseLine(pub)
    // The lie prompt waits for the question to finish being read.
    if (line.length) narrate(line, { queue: pub.phase === 'LIE_ENTRY' })
    else if (pub.phase !== 'REVEAL' && pub.phase !== 'WINNER' && pub.phase !== 'AWARDS') stopNarration()
  }, [phaseKey])

  // The host calls out each Truth Detector as it's used.
  const announced = useRef(new Set())
  const lifelineKey = (pub?.lifelines || []).join(',')
  useEffect(() => {
    if (!pub || pub.phase !== 'PICK_TRUTH' || !narrating) return
    for (const id of pub.lifelines || []) {
      const key = `${pub.questionNo}:${id}`
      if (announced.current.has(key)) continue
      announced.current.add(key)
      const name = pub.players.find((p) => p.id === id)?.name
      if (name) narrate(lifelineLine(name), { queue: true })
    }
  }, [lifelineKey])

  // "Ten seconds left!" while players are still writing or picking.
  const waitingOn = pub?.phase === 'LIE_ENTRY' ? pub.submitted : pub?.phase === 'PICK_TRUTH' ? pub.picked : null
  const allIn = !!waitingOn && pub.players.filter((p) => !p.isAudience && p.connected).every((p) => waitingOn.includes(p.id))
  useEffect(() => {
    if (!narrating || !waitingOn || allIn || pub.deadline == null) return
    const ms = pub.deadline - 10000 - transport.serverNow()
    if (ms < 0) return
    const id = setTimeout(() => narrate(tenSecondsLine()), ms)
    return () => clearTimeout(id)
  }, [phaseKey, allIn, narrating])

  if (error && !pub) {
    return (
      <div className="center-fill host-start">
        <Wordmark />
        <p className="error">{error}</p>
        <button className="btn btn-pink btn-xl" onClick={() => window.location.reload()}>Try again</button>
      </div>
    )
  }

  if (!pub) {
    return (
      <div className="center-fill host-start">
        <Wordmark />
        <p className="tagline">Lie. Spot. Win.</p>
        <button className="btn btn-pink btn-xl" disabled={!transport || busy} onClick={createRoom}>
          {transport ? (busy ? 'Creating room…' : '📺 Create a room') : 'Connecting…'}
        </button>
        <p className="hint">This screen is the shared TV. Players join on their phones.</p>
        <p className="music-credit">Music: Kevin MacLeod (incompetech.com), CC BY 4.0</p>
        <MuteButton className="host" onGesture={unlockAudio} />
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  const joinUrl = `${window.location.origin}${window.location.pathname}#/play?code=${code}`
  const serverNow = transport.serverNow
  // Mugshot selfies live on the players' rows (the engine has them); they're
  // kept out of the published state, which phones download on every change.
  const photoOf = Object.fromEntries((engineRef.current?.players || []).map((p) => [p.id, p.photo || null]))
  const view = { ...pub, players: pub.players.map((p) => ({ ...p, photo: photoOf[p.id] ?? null })) }
  const props = { pub: view, serverNow, rm, engine: engineRef.current }
  const screens = {
    LOBBY: <LobbyScreen {...props} code={code} joinUrl={joinUrl} backend={BACKEND} />,
    INTRO: <IntroScreen {...props} />,
    ROUND_TITLE: <RoundTitleScreen {...props} />,
    FINAL_TITLE: <RoundTitleScreen {...props} final />,
    CATEGORY_PICK: <CategoryPickScreen {...props} />,
    QUESTION: <QuestionScreen {...props} />,
    LIE_ENTRY: <LieEntryScreen {...props} />,
    PICK_TRUTH: <PickTruthScreen {...props} />,
    REVEAL: <RevealScreen {...props} />,
    SCOREBOARD: <ScoreboardScreen {...props} />,
    WINNER: <WinnerScreen {...props} />,
    AWARDS: <AwardsScreen {...props} />,
  }
  const variants = rm
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '-100%' } }

  return (
    <MotionConfig reducedMotion={rm ? 'always' : 'never'}>
      <Stage>
        <Masthead pub={view} code={code} />
        <Ticker pub={view} code={code} />
        {hidden ? (
          <div key={phaseKey} className="phase-layer">{screens[phase]}</div>
        ) : (
          <AnimatePresence initial={false} key={visKey}>
            <motion.div
              key={phaseKey}
              className="phase-layer"
              variants={variants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: rm ? 0.2 : 0.4, ease: [0.34, 1.2, 0.64, 1] }}
            >
              {screens[phase]}
            </motion.div>
          </AnimatePresence>
        )}
      </Stage>
      <MuteButton className="host" onGesture={unlockAudio} />
      {needsSoundClick && (
        <button
          className="sound-banner"
          onClick={() => {
            unlockAudio()
            primeLobbyMusic()
            setNeedsSoundClick(false)
          }}
        >
          🔊 Click to enable sound
        </button>
      )}
      {confirmEnd ? (
        <div className="end-confirm" role="dialog" aria-label="End game">
          <p>{phase === 'LOBBY' ? 'Close this room and open a new one?' : 'End this game for everyone?'}</p>
          <p className="hint">You'll get a new room code. Phones will be offered the new code to rejoin.</p>
          <div className="end-confirm-buttons">
            <button className="btn btn-pink" onClick={endAndNewRoom}>{phase === 'LOBBY' ? 'New room' : 'End game'}</button>
            <button className="btn btn-ghost" onClick={() => setConfirmEnd(false)}>Keep playing</button>
          </div>
        </div>
      ) : (
        <button className={`new-room ${phase === 'LOBBY' || phase === 'AWARDS' ? '' : 'end'}`} disabled={busy} onClick={() => setConfirmEnd(true)}>
          {busy ? 'Opening new room…' : phase === 'LOBBY' || phase === 'AWARDS' ? 'New room' : '⏹ End game'}
        </button>
      )}
      {error && <p className="host-error">{error}</p>}
    </MotionConfig>
  )
}
