// The Truth Be Told state machine (a speed quiz: each question shows the truth
// and three wrong answers; faster correct answers score more). Runs in the host (TV) tab, which acts as the
// game's server: it holds the full secret state, publishes a filtered public
// state for phones, and advances phases on timers or when everyone is in.
//
// The engine is UI-free and talks to the backend only through `transport`
// (see src/lib/transport/*), so it runs the same against Supabase, the local
// demo server, or a test harness.

import {
  TIMERS, QUIZ_SCORES, AWARDS, MIN_PLAYERS, OPTIONS_PER_QUESTION, awardsDuration,
  SHORT_GAME_MIN_PLAYERS, questionsInRound, quizPoints,
} from './constants.js'
import { normalize, matchesTruth } from '../lib/rules.js'

const DEFAULT_SETTINGS = {
  shortGame: false,
  profanityFilter: true,
  tts: true, // the narrator
  reducedMotion: false,
}

const QUESTION_PHASES = ['QUESTION', 'LIE_ENTRY', 'PICK_TRUTH', 'REVEAL', 'SCOREBOARD']

export function shuffle(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const blankStats = () => ({
  truths: 0, wrong: 0, correctMs: 0, streak: 0, bestStreak: 0, lifelineUsed: false,
  fooled: 0, liePoints: 0, lieBuys: 0, // lie mode only; always 0 in the quiz
})

export function initialState(settings = {}) {
  return {
    phase: 'LOBBY',
    round: 1,
    questionIndex: 0,
    questionNo: 0,
    deadline: null,
    startedAt: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    shortGameLocked: false,
    scores: {}, // playerId -> { score, stats }
    pickedThisRound: [],
    current: null,
    prevScores: {},
    lastDeltas: {},
    winners: [],
    awards: [],
  }
}

// Competition ranking (1, 2, 2, 4) by score, highest first.
export function rankPlayers(players, scoreOf) {
  const sorted = [...players].sort((a, b) => scoreOf(b) - scoreOf(a) || a.slot - b.slot)
  let rank = 0
  return sorted.map((p, i) => {
    if (i === 0 || scoreOf(p) !== scoreOf(sorted[i - 1])) rank = i + 1
    return { ...p, rank }
  })
}

export class HostEngine {
  // `history` (optional) remembers questions this TV has played across rooms:
  // { recent(): string[], add(id) }. Recent questions are avoided when drawing.
  constructor({ transport, code, saved = null, settings = {}, onPublic = () => {}, timeScale = 1, history = null }) {
    this.t = transport
    this.history = history
    this.code = code
    this.s = saved || initialState(settings)
    this.onPublic = onPublic
    this.timeScale = timeScale
    this.players = []
    this.online = null // Set of connected player ids; null = unknown (treat all as connected)
    this.queue = Promise.resolve()
    this.timer = null
    this.flushTimer = null
    this.dirty = false
    this.stopped = false
    this.publicState = null
  }

  // ---------------------------------------------------------------- setup

  async start() {
    this.players = await this.t.fetchPlayers(this.code)
    this.syncPlayers()
    this.unsubscribe = this.t.subscribeHost(this.code, {
      onPlayers: (list) => {
        this.players = list
        this.syncPlayers()
        this.markDirty()
      },
      onLie: (row) => this.enqueue(() => this.handleLie(row)),
      onPick: (row) => this.enqueue(() => this.handlePick(row)),
      onCommand: (row) => this.enqueue(() => this.handleCommand(row)),
      onPresence: (ids) => {
        this.online = ids
        this.markDirty()
        this.enqueue(() => this.checkEarly())
      },
    })
    // Safety net for missed realtime events while players are submitting.
    this.poll = setInterval(() => this.enqueue(() => this.pollRoundRows()), 3000)

    await this.enqueue(async () => {
      if (this.s.phase === 'LOBBY' || this.s.deadline == null) {
        await this.publish(null)
      } else {
        // Resuming after a host reload: keep the phase, restart its timer.
        const remaining = Math.max(2000, this.s.deadline - this.t.serverNow())
        await this.publish(remaining, { scaled: true })
      }
    })
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.flushTimer)
    clearInterval(this.poll)
    this.unsubscribe?.()
  }

  enqueue(fn) {
    this.queue = this.queue.then(() => (this.stopped ? undefined : fn())).catch((err) => {
      console.error('[fakeout] engine error', err)
    })
    return this.queue
  }

  syncPlayers() {
    for (const p of this.players) {
      if (!p.isAudience && !this.s.scores[p.id]) this.s.scores[p.id] = { score: 0, stats: blankStats() }
    }
  }

  // ------------------------------------------------------------- players

  gamePlayers() {
    return this.players.filter((p) => !p.isAudience).sort((a, b) => a.slot - b.slot)
  }

  isOnline(id) {
    return this.online == null || this.online.has(id)
  }

  activePlayerIds() {
    return this.gamePlayers().filter((p) => this.isOnline(p.id)).map((p) => p.id)
  }

  vipId() {
    const list = this.gamePlayers()
    return (list.find((p) => this.isOnline(p.id)) || list[0])?.id ?? null
  }

  scoreOf(id) {
    return this.s.scores[id]?.score ?? 0
  }

  // ------------------------------------------------------------ publishing

  // Batches small updates (a lie in, a pick in) into one publish. Every publish
  // reaches every phone, so big rooms batch for longer to stay within the
  // backend's realtime message quota (Supabase Free: 100 messages/s in total).
  // Phase changes don't wait: they publish directly.
  markDirty() {
    this.dirty = true
    if (this.flushTimer) return
    const delay = this.gamePlayers().length > 8 ? 1000 : 80
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.enqueue(() => (this.dirty ? this.publish(null, { keepTimer: true }) : undefined))
    }, delay)
  }

  // durationMs is in real game time; it's scaled by timeScale (tests) unless already scaled.
  async publish(durationMs, { keepTimer = false, scaled = false } = {}) {
    this.dirty = false
    const s = this.s
    const pub = this.buildPublic()
    const ms = durationMs == null ? null : Math.round(scaled ? durationMs : durationMs * this.timeScale)
    const { deadline, startedAt } = await this.t.setState(this.code, {
      phase: s.phase,
      questionNo: s.questionNo,
      state: pub,
      durationMs: ms,
      keepTimer,
    })
    s.deadline = deadline
    s.startedAt = startedAt
    this.publicState = { ...pub, deadline, startedAt }
    this.onPublic(this.publicState)
    await this.t.saveSecrets(this.code, s)
    this.schedule()
  }

  buildPublic() {
    const s = this.s
    const c = s.current
    const scoreFor = (id) => (s.phase === 'REVEAL' ? s.prevScores[id] ?? 0 : this.scoreOf(id))
    const pub = {
      phase: s.phase,
      round: s.round,
      multiplier: s.round,
      questionIndex: s.questionIndex,
      questionsInRound: questionsInRound(s.round, s.shortGameLocked),
      questionNo: s.questionNo,
      settings: { ...s.settings },
      vipId: this.vipId(),
      players: this.players
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          slot: p.slot,
          isAudience: !!p.isAudience,
          score: p.isAudience ? 0 : scoreFor(p.id),
          lieBuys: s.scores[p.id]?.stats.lieBuys ?? 0,
          streak: s.scores[p.id]?.stats.streak ?? 0,
          lifelineUsed: !!s.scores[p.id]?.stats.lifelineUsed,
          fooled: s.scores[p.id]?.stats.fooled ?? 0,
          liePoints: s.scores[p.id]?.stats.liePoints ?? 0,
          connected: this.isOnline(p.id),
        })),
    }
    if (c) {
      if (s.phase === 'CATEGORY_PICK') {
        pub.pickerId = c.pickerId
        pub.categoryOptions = c.categoryOptions
      }
      if (QUESTION_PHASES.includes(s.phase) && c.question) {
        pub.question = { category: c.question.category, prompt: c.question.prompt, isFinal: !!c.question.isFinal }
      }
      if (s.phase === 'LIE_ENTRY') pub.submitted = Object.keys(c.lies)
      if (s.phase === 'PICK_TRUTH' || s.phase === 'REVEAL') {
        pub.options = c.options.map((o) => ({ id: o.id, text: o.text }))
      }
      if (s.phase === 'PICK_TRUTH') pub.picked = Object.keys(c.picks)
      if (s.phase === 'PICK_TRUTH' || s.phase === 'REVEAL') pub.lifelines = c.lifelines || []
      if (s.phase === 'REVEAL') pub.reveal = c.reveal
      if (s.phase === 'SCOREBOARD') {
        pub.scoreboard = { prev: s.prevScores, deltas: s.lastDeltas, charges: c.reveal?.charges || {} }
        pub.truth = c.question?.answer
      }
    }
    if (s.phase === 'WINNER' || s.phase === 'AWARDS') {
      pub.winners = s.winners
      pub.awards = s.awards
    }
    if (s.phase === 'ENDED') pub.nextCode = s.nextCode ?? null
    return pub
  }

  schedule() {
    clearTimeout(this.timer)
    if (this.s.deadline == null || this.stopped) return
    const { phase, questionNo } = this.s
    const ms = Math.max(0, this.s.deadline - this.t.serverNow())
    this.timer = setTimeout(() => this.enqueue(() => this.onTimeout(phase, questionNo)), ms)
  }

  async onTimeout(phase, questionNo) {
    if (this.s.phase !== phase || this.s.questionNo !== questionNo) return
    await this.advance()
  }

  // ---------------------------------------------------------- host actions

  startGame() {
    return this.enqueue(() => this.goStart())
  }

  updateSettings(patch) {
    return this.enqueue(async () => {
      Object.assign(this.s.settings, patch)
      await this.publish(null, { keepTimer: true })
    })
  }

  skip() {
    return this.enqueue(async () => {
      if (this.s.phase === 'INTRO') await this.advance()
    })
  }

  playAgain() {
    return this.enqueue(async () => {
      if (this.s.phase === 'AWARDS' || this.s.phase === 'WINNER') await this.goStart()
    })
  }

  backToLobby() {
    return this.enqueue(async () => {
      if (this.s.phase === 'AWARDS' || this.s.phase === 'WINNER') await this.goLobby()
    })
  }

  // Close this room for good, from any phase. Phones see phase ENDED and are
  // offered `nextCode` (the host's new room) to rejoin with one tap.
  endGame(nextCode = null) {
    return this.enqueue(async () => {
      const s = this.s
      s.phase = 'ENDED'
      s.current = null
      s.nextCode = nextCode
      try {
        await this.publish(null)
      } finally {
        this.stop()
      }
    })
  }

  // ------------------------------------------------------------ inbound

  async handleCommand(row) {
    const s = this.s
    const isVip = row.playerId === this.vipId()
    switch (row.cmd) {
      case 'start':
        if (s.phase === 'LOBBY' && isVip) await this.goStart()
        break
      case 'skipIntro':
        if (s.phase === 'INTRO' && isVip) await this.advance()
        break
      case 'pickCategory': {
        const cat = row.payload?.category
        if (s.phase === 'CATEGORY_PICK' && row.playerId === s.current?.pickerId && s.current.categoryOptions.includes(cat)) {
          s.current.category = cat
          await this.advance()
        }
        break
      }
      case 'playAgain':
        if ((s.phase === 'AWARDS' || s.phase === 'WINNER') && isVip) await this.goStart()
        break
      case 'backToLobby':
        if ((s.phase === 'AWARDS' || s.phase === 'WINNER') && isVip) await this.goLobby()
        break
    }
  }

  async handleLie(row) {
    const c = this.s.current
    if (this.s.phase !== 'LIE_ENTRY' || !c || row.questionNo !== this.s.questionNo) return
    if (c.lies[row.playerId]) return
    c.lies[row.playerId] = row.text
    this.markDirty()
    await this.checkEarly()
  }

  async handlePick(row) {
    const c = this.s.current
    if (this.s.phase !== 'PICK_TRUTH' || !c || row.questionNo !== this.s.questionNo) return
    if (c.picks[row.playerId]) return
    if (!c.options.some((o) => o.id === row.optionId)) return
    c.picks[row.playerId] = row.optionId
    this.recordPickTime(row)
    this.markDirty()
    await this.checkEarly()
  }

  // How long after the answers appeared this pick came in (server clock).
  recordPickTime(row) {
    const c = this.s.current
    c.pickTimes ||= {}
    if (c.pickTimes[row.playerId] != null) return
    const start = c.pickStart ?? this.s.startedAt
    c.pickTimes[row.playerId] = row.at != null && start != null ? Math.max(0, row.at - start) : null
  }

  // Truth Detectors used this question (each player gets one per game).
  recordLifelines(ids = []) {
    const c = this.s.current
    if (!c) return
    c.lifelines ||= []
    for (const id of ids) {
      if (c.lifelines.includes(id) || !this.s.scores[id]) continue
      c.lifelines.push(id)
      this.s.scores[id].stats.lifelineUsed = true
      this.markDirty()
    }
  }

  async pollRoundRows() {
    const s = this.s
    if (s.phase !== 'LIE_ENTRY' && s.phase !== 'PICK_TRUTH') return
    const rows = await this.t.fetchRoundRows(this.code, s.questionNo)
    if (s.phase === 'LIE_ENTRY') {
      for (const l of rows.lies) await this.handleLie({ ...l, questionNo: s.questionNo })
    } else {
      this.recordLifelines(rows.lifelines)
      for (const p of rows.picks) await this.handlePick({ ...p, questionNo: s.questionNo })
    }
  }

  async checkEarly() {
    const s = this.s
    const c = s.current
    if (!c) return
    const active = this.activePlayerIds()
    if (s.phase === 'LIE_ENTRY') {
      if (active.length && active.every((id) => c.lies[id])) await this.advance()
    } else if (s.phase === 'PICK_TRUTH') {
      // Only players who have an option to pick need to pick (everyone, in practice).
      if (active.length && active.every((id) => c.picks[id])) await this.advance()
    }
  }

  // ------------------------------------------------------------ transitions

  async advance() {
    const s = this.s
    switch (s.phase) {
      case 'INTRO': return this.goRoundTitle(1)
      case 'ROUND_TITLE': return this.goCategoryPick()
      case 'CATEGORY_PICK': return this.goQuestion(s.current.category ?? shuffle(s.current.categoryOptions)[0], false)
      case 'FINAL_TITLE': return this.goQuestion(null, true)
      case 'QUESTION': return this.goPickTruth()
      case 'LIE_ENTRY': return this.goPickTruth()
      case 'PICK_TRUTH': return this.goReveal()
      case 'REVEAL': return this.goScoreboard()
      case 'SCOREBOARD': return this.afterScoreboard()
      case 'WINNER': return this.goAwards()
      default: return undefined
    }
  }

  async goLobby() {
    const s = this.s
    s.phase = 'LOBBY'
    s.current = null
    await this.publish(null)
  }

  async goStart() {
    const s = this.s
    const players = this.gamePlayers()
    if (players.length < MIN_PLAYERS) return
    s.scores = {}
    this.syncPlayers()
    s.shortGameLocked = !!s.settings.shortGame && players.length >= SHORT_GAME_MIN_PLAYERS
    s.round = 1
    s.questionIndex = 0
    s.pickedThisRound = []
    s.current = null
    s.prevScores = {}
    s.lastDeltas = {}
    s.winners = []
    s.awards = []
    s.phase = 'INTRO'
    await this.publish(TIMERS.INTRO)
  }

  async goRoundTitle(round) {
    const s = this.s
    s.round = round
    s.questionIndex = 0
    s.pickedThisRound = []
    s.phase = 'ROUND_TITLE'
    await this.publish(TIMERS.ROUND_TITLE)
  }

  newQuestion(extra = {}) {
    this.s.questionNo += 1
    this.s.current = {
      category: null,
      categoryOptions: [],
      pickerId: null,
      question: null,
      lies: {},
      options: [],
      picks: {},
      reveal: null,
      ...extra,
    }
  }

  choosePicker() {
    const s = this.s
    let candidates = this.activePlayerIds().filter((id) => !s.pickedThisRound.includes(id))
    if (!candidates.length) candidates = this.activePlayerIds()
    if (!candidates.length) return null
    const low = Math.min(...candidates.map((id) => this.scoreOf(id)))
    const pickerId = shuffle(candidates.filter((id) => this.scoreOf(id) === low))[0]
    s.pickedThisRound.push(pickerId)
    return pickerId
  }

  async goCategoryPick() {
    const s = this.s
    const categoryOptions = await this.t.drawCategories(this.code, this.history?.recent() ?? [])
    this.newQuestion({ categoryOptions, pickerId: this.choosePicker() })
    s.phase = 'CATEGORY_PICK'
    await this.publish(TIMERS.CATEGORY_PICK)
  }

  async goQuestion(category, isFinal) {
    const s = this.s
    if (isFinal) this.newQuestion()
    const q = await this.t.drawQuestion(this.code, category, isFinal, this.history?.recent() ?? [])
    this.history?.add(q.id)
    s.current.question = q
    s.current.category = q.category
    s.phase = 'QUESTION'
    await this.publish(TIMERS.QUESTION)
  }

  // The truth plus three wrong answers from the question's own list, shuffled.
  buildOptions() {
    const q = this.s.current.question
    const seen = new Set([normalize(q.answer)])
    const wrong = []
    for (const text of shuffle(q.suggestedLies || [])) {
      const key = normalize(text)
      if (seen.has(key) || matchesTruth(text, q)) continue
      seen.add(key)
      wrong.push({ text, authors: [], isTruth: false, isDecoy: true })
      if (wrong.length === OPTIONS_PER_QUESTION - 1) break
    }
    const truth = { text: q.answer, authors: [], isTruth: true, isDecoy: false }
    return shuffle([...wrong, truth]).map((o, i) => ({ id: `o${i + 1}`, ...o }))
  }

  async goPickTruth() {
    const s = this.s
    s.current.options = this.buildOptions()
    s.current.picks = {}
    s.current.pickTimes = {}
    s.current.pickStart = null
    s.phase = 'PICK_TRUTH'
    await this.publish(TIMERS.PICK_TRUTH)
    s.current.pickStart = s.startedAt
  }

  // Scores the question. Returns the public reveal: how many picked each
  // answer, who found the truth, the fastest correct answers, and everyone's
  // points for this question.
  computeReveal() {
    const s = this.s
    const c = s.current
    const m = Math.min(2, s.round - 1)
    const audience = new Set(this.players.filter((p) => p.isAudience).map((p) => p.id))
    const scored = new Set(this.gamePlayers().map((p) => p.id))
    const truth = c.options.find((o) => o.isTruth)
    const windowMs = TIMERS.PICK_TRUTH * this.timeScale
    const counts = Object.fromEntries(c.options.map((o) => [o.id, 0]))
    const audienceCounts = { ...counts }
    const deltas = {}
    const correct = []
    for (const [pid, optionId] of Object.entries(c.picks)) {
      if (audience.has(pid)) {
        audienceCounts[optionId] = (audienceCounts[optionId] || 0) + 1
        continue
      }
      if (!scored.has(pid) || !s.scores[pid]) continue
      counts[optionId] = (counts[optionId] || 0) + 1
      const stats = s.scores[pid].stats
      if (optionId === truth.id) {
        // A missing time (shouldn't happen) counts as the slowest correct answer.
        const ms = c.pickTimes?.[pid] ?? windowMs
        const realMs = Math.round(ms / this.timeScale)
        deltas[pid] = quizPoints(s.round, ms, windowMs)
        correct.push({ id: pid, ms: realMs, points: deltas[pid] })
        stats.truths++
        stats.correctMs += realMs
        stats.streak++
        stats.bestStreak = Math.max(stats.bestStreak, stats.streak)
      } else {
        deltas[pid] = QUIZ_SCORES.wrong[m]
        stats.wrong++
        stats.streak = 0
      }
    }
    // No answer breaks a streak too.
    for (const id of scored) if (!c.picks[id] && s.scores[id]) s.scores[id].stats.streak = 0
    correct.sort((a, b) => a.ms - b.ms)
    const correctIds = correct.map((x) => x.id)
    const at = (ms) => Math.round(ms * this.timeScale)
    return {
      truthId: truth.id,
      truthText: truth.text,
      counts,
      audienceCounts,
      answered: Object.values(counts).reduce((a, b) => a + b, 0),
      correct: correctIds,
      fastest: correct.slice(0, 5),
      detected: (c.lifelines || []).filter((id) => correctIds.includes(id)),
      deltas,
      nobodyFound: correct.length === 0 && !audienceCounts[truth.id],
      truthAt: at(2200), // the answer counts show first, then the truth
      fastestAt: at(4000),
      duration: TIMERS.QUIZ_REVEAL,
    }
  }

  async goReveal() {
    const s = this.s
    const rows = await this.t.fetchRoundRows(this.code, s.questionNo)
    this.recordLifelines(rows.lifelines)
    for (const p of rows.picks) {
      if (s.current.picks[p.playerId] || !s.current.options.some((o) => o.id === p.optionId)) continue
      s.current.picks[p.playerId] = p.optionId
      this.recordPickTime(p)
    }
    const reveal = this.computeReveal()
    s.prevScores = Object.fromEntries(Object.entries(s.scores).map(([id, v]) => [id, v.score]))
    for (const [id, d] of Object.entries(reveal.deltas)) if (s.scores[id]) s.scores[id].score += d
    s.lastDeltas = reveal.deltas
    s.current.reveal = reveal
    s.phase = 'REVEAL'
    await this.publish(reveal.duration)
  }

  async goScoreboard() {
    this.s.phase = 'SCOREBOARD'
    await this.publish(TIMERS.SCOREBOARD)
  }

  async afterScoreboard() {
    const s = this.s
    const perRound = questionsInRound(s.round, s.shortGameLocked)
    if (s.round < 3 && s.questionIndex + 1 < perRound) {
      s.questionIndex += 1
      return this.goCategoryPick()
    }
    if (s.round === 1) return this.goRoundTitle(2)
    if (s.round === 2) {
      s.round = 3
      s.questionIndex = 0
      s.phase = 'FINAL_TITLE'
      return this.publish(TIMERS.FINAL_TITLE)
    }
    return this.goWinner()
  }

  computeAwards() {
    const ids = this.gamePlayers().map((p) => p.id)
    const awards = []
    const stat = (id, key) => {
      const st = this.s.scores[id]?.stats
      if (!st) return 0
      if (key === 'avgCorrectMs') return st.truths ? Math.round(st.correctMs / st.truths) : 0
      return st[key] ?? 0
    }
    for (const def of AWARDS) {
      const pool = ids.filter((id) => (this.s.scores[id]?.stats.truths ?? 0) >= (def.minCorrect ?? 0) && stat(id, def.stat) >= (def.min ?? 0))
      if (!pool.length) continue
      const vals = pool.map((id) => stat(id, def.stat))
      const best = def.lowest ? Math.min(...vals) : Math.max(...vals)
      awards.push({ key: def.key, title: def.title, playerIds: pool.filter((id) => stat(id, def.stat) === best), stat: def.label(best) })
    }
    return awards
  }

  async goWinner() {
    const s = this.s
    const ids = this.gamePlayers().map((p) => p.id)
    const top = Math.max(...ids.map((id) => this.scoreOf(id)))
    s.winners = ids.filter((id) => this.scoreOf(id) === top)
    s.awards = this.computeAwards()
    s.current = null
    s.phase = 'WINNER'
    await this.publish(TIMERS.WINNER)
  }

  async goAwards() {
    const s = this.s
    s.phase = 'AWARDS'
    // Cards cycle for this long; after that the screen waits for the VIP.
    await this.publish(Math.max(TIMERS.AWARD_CARD, awardsDuration(s.awards)))
  }
}
