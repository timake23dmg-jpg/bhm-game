// In-memory stand-in for the Supabase backend, used by local demo mode and
// tests. Every method mirrors an RPC or table access in supabase/schema.sql,
// including its checks (host-only, phase/question guards, lie validation).

import { normalize, validateLie, liePrice, lieCost, isValidPhoto } from '../rules.js'

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_PLAYERS = 70

function randomCode() {
  let code = ''
  for (let i = 0; i < 4; i++) code += CHARSET[Math.floor(Math.random() * CHARSET.length)]
  return code
}

function randomId() {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)]

export class LocalServer {
  constructor({ questions, snapshot = null, now = () => Date.now() }) {
    this.questions = questions
    this.now = now
    this.db = snapshot || { games: {}, secrets: {}, players: [], lies: [], picks: [], likes: [], commands: [] }
    this.listeners = new Set()
  }

  // Change feed: { table, code, row }
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(table, code, row) {
    for (const fn of this.listeners) fn({ table, code, row })
  }

  game(code) {
    const g = this.db.games[String(code || '').trim().toUpperCase()]
    if (!g) throw new Error('Room not found')
    return g
  }

  hostGame(userId, code) {
    const g = this.game(code)
    if (g.hostUserId !== userId) throw new Error('Only the host can do that')
    return g
  }

  playerFor(userId, code) {
    return this.db.players.find((p) => p.gameCode === code && p.userId === userId) || null
  }

  // ---------------------------------------------------------------- host

  createGame(userId, settings = {}) {
    let code
    do code = randomCode()
    while (this.db.games[code])
    this.db.games[code] = {
      code, hostUserId: userId, phase: 'LOBBY', questionNo: 0,
      state: { phase: 'LOBBY', settings }, usedQuestionIds: [],
    }
    this.db.secrets[code] = { data: null, question: null, given: [] }
    return code
  }

  loadSecrets(userId, code) {
    this.hostGame(userId, code)
    return this.db.secrets[code].data
  }

  saveSecrets(userId, code, data) {
    this.hostGame(userId, code)
    this.db.secrets[code].data = JSON.parse(JSON.stringify(data))
  }

  setState(userId, code, { phase, questionNo, state, durationMs, keepTimer }) {
    const g = this.hostGame(userId, code)
    const now = this.now()
    let deadline = g.deadline ?? null
    let startedAt = g.startedAt ?? null
    if (!keepTimer) {
      startedAt = now
      deadline = durationMs == null ? null : now + durationMs
    }
    Object.assign(g, { phase, questionNo, deadline, startedAt, state: { ...state, deadline, startedAt } })
    this.emit('games', code, g.state)
    return { deadline, startedAt }
  }

  // `exclude`: questions this TV played recently (in earlier rooms), avoided
  // when possible. Categories offered are ones that still have fresh questions.
  drawCategories(userId, code, exclude = []) {
    const g = this.hostGame(userId, code)
    const regular = this.questions.filter((q) => !q.isFinal && !g.usedQuestionIds.includes(q.id))
    const catsOf = (list) => [...new Set(list.map((q) => q.category))]
    let cats = catsOf(regular.filter((q) => !exclude.includes(q.id)))
    if (cats.length < 3) cats = catsOf(regular)
    if (cats.length < 3) {
      g.usedQuestionIds = g.usedQuestionIds.filter((id) => this.questions.find((q) => q.id === id)?.isFinal)
      cats = catsOf(this.questions.filter((q) => !q.isFinal))
    }
    return shuffleCopy(cats).slice(0, 3)
  }

  drawQuestion(userId, code, category, isFinal, exclude = []) {
    const g = this.hostGame(userId, code)
    const pool = this.questions.filter((q) => q.isFinal === !!isFinal && (isFinal || !category || q.category === category))
    const fresh = pool.filter((q) => !g.usedQuestionIds.includes(q.id))
    const freshest = fresh.filter((q) => !exclude.includes(q.id))
    const q = pickRandom(freshest.length ? freshest : fresh.length ? fresh : pool)
    if (!q) throw new Error('No questions available')
    g.usedQuestionIds = [...g.usedQuestionIds.filter((id) => id !== q.id), q.id]
    this.db.secrets[code].question = q
    this.db.secrets[code].given = []
    this.db.secrets[code].handouts = {}
    this.db.secrets[code].lifelines = {}
    return JSON.parse(JSON.stringify(q))
  }

  fetchPlayers(userId, code) {
    const g = this.game(code)
    if (g.hostUserId !== userId && !this.playerFor(userId, g.code)) throw new Error('Not in this room')
    return this.db.players.filter((p) => p.gameCode === g.code).map(publicPlayer)
  }

  fetchRoundRows(userId, code, questionNo) {
    const g = this.hostGame(userId, code)
    const mine = (r) => r.gameCode === code && r.questionNo === questionNo
    return {
      lies: this.db.lies.filter(mine).map((r) => ({ playerId: r.playerId, text: r.text })),
      picks: this.db.picks.filter(mine).map((r) => ({ playerId: r.playerId, optionId: r.optionId })),
      likes: this.db.likes.filter(mine).map((r) => ({ playerId: r.playerId, optionId: r.optionId })),
      // "Lie for me" suggestions handed out this question: { playerId: [text] }
      handouts: g.questionNo === questionNo ? JSON.parse(JSON.stringify(this.db.secrets[code].handouts || {})) : {},
      // Players who used their Truth Detector this question
      lifelines: g.questionNo === questionNo ? Object.keys(this.db.secrets[code].lifelines || {}) : [],
    }
  }

  // --------------------------------------------------------------- phones

  joinGame(userId, code, name, avatar, audience = false) {
    const g = this.game(code)
    const existing = this.playerFor(userId, g.code)
    const cleanName = String(name || '').trim()
    if (existing) {
      if (cleanName) {
        existing.name = cleanName.slice(0, 16)
        if (avatar) existing.avatar = avatar
        this.emit('players', g.code, publicPlayer(existing))
      }
      return publicPlayer(existing)
    }
    if (cleanName.length < 1 || cleanName.length > 16) throw new Error('Name must be 1-16 characters')
    const inRoom = this.db.players.filter((p) => p.gameCode === g.code)
    const count = inRoom.filter((p) => !p.isAudience).length
    const player = {
      id: randomId(),
      gameCode: g.code,
      userId,
      slot: inRoom.length ? Math.max(...inRoom.map((p) => p.slot)) + 1 : 0,
      name: cleanName,
      avatar: avatar || '🦊',
      isAudience: !!audience || g.phase !== 'LOBBY' || count >= MAX_PLAYERS,
    }
    this.db.players.push(player)
    this.emit('players', g.code, publicPlayer(player))
    return publicPlayer(player)
  }

  // A player's mugshot selfie (or null to remove it).
  setPhoto(userId, code, photo) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p) throw new Error('You are not in this room')
    if (photo !== null && !isValidPhoto(photo)) return { ok: false, reason: 'badPhoto' }
    p.photo = photo
    this.emit('players', g.code, publicPlayer(p))
    return { ok: true }
  }

  findMyPlayer(userId, code) {
    const g = this.db.games[String(code || '').trim().toUpperCase()]
    if (!g) return null
    const p = this.playerFor(userId, g.code)
    return p ? publicPlayer(p) : null
  }

  fetchGame(userId, code) {
    const g = this.db.games[String(code || '').trim().toUpperCase()]
    return g ? g.state : null
  }

  submitLie(userId, code, questionNo, text) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p) throw new Error('You are not in this room')
    if (p.isAudience) return { ok: false, reason: 'audience' }
    if (g.phase !== 'LIE_ENTRY' || g.questionNo !== questionNo) return { ok: false, reason: 'closed' }
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    const reason = validateLie(clean, this.db.secrets[g.code].question, {
      profanityFilter: g.state?.settings?.profanityFilter ?? true,
    })
    if (reason) return { ok: false, reason }
    if (this.db.lies.some((r) => r.gameCode === g.code && r.questionNo === questionNo && r.playerId === p.id)) return { ok: true }
    const row = { gameCode: g.code, questionNo, playerId: p.id, text: clean, norm: normalize(clean) }
    this.db.lies.push(row)
    this.emit('lies', g.code, { playerId: p.id, text: clean, questionNo })
    return { ok: true }
  }

  // Hands out a suggested lie. The first per game is free; after that each
  // costs points (see liePrice), checked against the score the host published.
  // The host charges for every handout when lie entry closes.
  lieForMe(userId, code, questionNo) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p || p.isAudience) throw new Error('You are not a player in this room')
    if (g.phase !== 'LIE_ENTRY' || g.questionNo !== questionNo) return { ok: false, reason: 'closed' }
    const secrets = this.db.secrets[g.code]
    if (!secrets.question) return { ok: false, reason: 'closed' }
    const me = (g.state.players || []).find((x) => x.id === p.id) || {}
    const bought = me.lieBuys || 0
    const mineNow = (secrets.handouts ||= {})[p.id] || []
    const cost = liePrice(bought + mineNow.length)
    if ((me.score || 0) - lieCost(bought, mineNow.length) < cost) return { ok: false, reason: 'broke', cost }
    const used = new Set(this.db.lies.filter((r) => r.gameCode === g.code && r.questionNo === questionNo).map((r) => r.norm))
    const open = secrets.question.suggestedLies.filter((x) => !used.has(normalize(x)) && !mineNow.includes(x))
    const fresh = open.filter((x) => !secrets.given.includes(x))
    const pick = pickRandom(fresh.length ? fresh : open) ?? null
    if (!pick) return { ok: false, reason: 'empty' }
    secrets.given.push(pick)
    secrets.handouts[p.id] = [...mineNow, pick]
    return { ok: true, text: pick, cost }
  }

  // Truth Detector: once per game, before picking, narrows this player's
  // options to the truth and one lie. Returns { ok, keep: [optionId, optionId] }.
  useLifeline(userId, code, questionNo) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p || p.isAudience) throw new Error('You are not a player in this room')
    if (g.phase !== 'PICK_TRUTH' || g.questionNo !== questionNo) return { ok: false, reason: 'closed' }
    const secrets = this.db.secrets[g.code]
    const me = (g.state.players || []).find((x) => x.id === p.id) || {}
    if (me.lifelineUsed) return { ok: false, reason: 'used' }
    const mine = (secrets.lifelines ||= {})
    if (mine[p.id]) return { ok: true, keep: mine[p.id] }
    const row = (t) => t.gameCode === g.code && t.questionNo === questionNo && t.playerId === p.id
    if (this.db.picks.some(row)) return { ok: false, reason: 'picked' }
    const ownLie = this.db.lies.find(row)?.norm
    const truthNorm = normalize(secrets.question.answer)
    const options = g.state.options || []
    const truth = options.find((o) => normalize(o.text) === truthNorm)
    const lies = options.filter((o) => o !== truth && normalize(o.text) !== ownLie)
    if (!truth || !lies.length) return { ok: false, reason: 'closed' }
    const keep = shuffleCopy([truth.id, pickRandom(lies).id])
    mine[p.id] = keep
    return { ok: true, keep }
  }

  submitPick(userId, code, questionNo, optionId) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p) throw new Error('You are not in this room')
    if (g.phase !== 'PICK_TRUTH' || g.questionNo !== questionNo) return { ok: false, reason: 'closed' }
    if (!(g.state.options || []).some((o) => o.id === optionId)) return { ok: false, reason: 'badOption' }
    if (this.db.picks.some((r) => r.gameCode === g.code && r.questionNo === questionNo && r.playerId === p.id)) return { ok: true }
    this.db.picks.push({ gameCode: g.code, questionNo, playerId: p.id, optionId })
    this.emit('picks', g.code, { playerId: p.id, optionId, questionNo })
    return { ok: true }
  }

  setLike(userId, code, questionNo, playerId, optionId, on) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p || p.id !== playerId) throw new Error('Not your player')
    const match = (r) => r.gameCode === g.code && r.questionNo === questionNo && r.playerId === p.id && r.optionId === optionId
    this.db.likes = this.db.likes.filter((r) => !match(r))
    if (on) this.db.likes.push({ gameCode: g.code, questionNo, playerId: p.id, optionId })
  }

  sendCommand(userId, code, playerId, cmd, payload = {}) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p || p.id !== playerId) throw new Error('Not your player')
    const row = { playerId: p.id, cmd, payload }
    this.db.commands.push({ gameCode: g.code, ...row })
    this.emit('commands', g.code, row)
  }

  fetchMine(userId, code, questionNo, playerId) {
    const g = this.game(code)
    const p = this.playerFor(userId, g.code)
    if (!p || p.id !== playerId) return { lie: null, pick: null, likes: [] }
    const mine = (r) => r.gameCode === g.code && r.questionNo === questionNo && r.playerId === p.id
    return {
      lie: this.db.lies.find(mine)?.text ?? null,
      pick: this.db.picks.find(mine)?.optionId ?? null,
      likes: this.db.likes.filter(mine).map((r) => r.optionId),
    }
  }
}

function shuffleCopy(list) {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function publicPlayer(p) {
  return { id: p.id, gameCode: p.gameCode, name: p.name, avatar: p.avatar, slot: p.slot, isAudience: p.isAudience, photo: p.photo ?? null }
}

// Methods phones may call over the local channel (everything else is host-only).
export const PHONE_METHODS = [
  'joinGame', 'findMyPlayer', 'fetchGame', 'submitLie', 'lieForMe', 'submitPick', 'useLifeline', 'setPhoto', 'setLike', 'sendCommand', 'fetchMine',
]
