// Local demo mode: no backend. The host tab owns a LocalServer and serves
// phone tabs in the same browser over a BroadcastChannel. Phones heartbeat
// for presence. Handy for trying the game on one computer and for tests.

import { LocalServer, PHONE_METHODS } from './localServer.js'

const CHANNEL = 'fakeout-local'
const STORE_KEY = 'fakeout.local.db'
const HEARTBEAT_MS = 1500
const OFFLINE_AFTER_MS = 5000

function safeStorage() {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------- host

export function createLocalHostTransport({ userId, questions, server = null, channelName = CHANNEL }) {
  const storage = safeStorage()
  let snapshot = null
  if (!server) {
    try {
      snapshot = JSON.parse(storage?.getItem(STORE_KEY) || 'null')
    } catch {
      snapshot = null
    }
  }
  const srv = server || new LocalServer({ questions, snapshot })
  const channel = typeof BroadcastChannel !== 'undefined' && channelName ? new BroadcastChannel(channelName) : null
  const lastSeen = new Map() // playerId -> ms
  const ownsCode = (code) => !!srv.db.games[String(code || '').trim().toUpperCase()]

  let saveTimer = null
  const persist = () => {
    if (!storage || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      try {
        storage.setItem(STORE_KEY, JSON.stringify(srv.db))
      } catch {
        // storage full or blocked: demo keeps working without reload recovery
      }
    }, 300)
  }

  srv.on(({ table, code, row }) => {
    persist()
    if (table === 'games') channel?.postMessage({ type: 'game', code, state: row })
  })

  if (channel) {
    channel.onmessage = async ({ data }) => {
      if (!data) return
      if (data.type === 'hb') {
        if (ownsCode(data.code)) lastSeen.set(data.playerId, Date.now())
        return
      }
      if (data.type !== 'req' || !PHONE_METHODS.includes(data.method)) return
      if (!ownsCode(data.args?.[0])) return // another host tab may own it
      try {
        const result = await srv[data.method](data.userId, ...data.args)
        channel.postMessage({ type: 'res', id: data.id, result })
      } catch (err) {
        channel.postMessage({ type: 'res', id: data.id, error: err.message })
      }
    }
  }

  return {
    mode: 'local',
    userId,
    server: srv,
    async init() {},
    close() {
      channel?.close()
    },
    serverNow: () => Date.now(),
    async createGame(settings) {
      const code = srv.createGame(userId, settings)
      persist()
      return code
    },
    async loadHostedGame(code) {
      try {
        const data = srv.loadSecrets(userId, code)
        return data ? { data } : null
      } catch {
        return null
      }
    },
    async fetchPlayers(code) {
      return srv.fetchPlayers(userId, code)
    },
    subscribeHost(code, { onPlayers, onLie, onPick, onCommand, onPresence }) {
      const off = srv.on(({ table, code: c, row }) => {
        if (c !== code) return
        if (table === 'players') onPlayers?.(srv.fetchPlayers(userId, code))
        if (table === 'lies') onLie?.(row)
        if (table === 'picks') onPick?.(row)
        if (table === 'commands') onCommand?.(row)
      })
      let lastKey = null
      const presenceTimer = channel
        ? setInterval(() => {
            // Phones answer pings from their message handler, which hidden
            // tabs still run promptly (their own timers get throttled).
            channel.postMessage({ type: 'ping', code })
            const now = Date.now()
            const ids = new Set([...lastSeen].filter(([, t]) => now - t < OFFLINE_AFTER_MS).map(([id]) => id))
            const key = [...ids].sort().join(',')
            if (key !== lastKey) {
              lastKey = key
              onPresence?.(ids)
            }
          }, 1000)
        : null
      return () => {
        off()
        clearInterval(presenceTimer)
      }
    },
    async setState(code, args) {
      return srv.setState(userId, code, args)
    },
    async saveSecrets(code, data) {
      srv.saveSecrets(userId, code, data)
      persist()
    },
    async drawCategories(code, exclude) {
      return srv.drawCategories(userId, code, exclude)
    },
    async drawQuestion(code, category, isFinal, exclude) {
      return srv.drawQuestion(userId, code, category, isFinal, exclude)
    },
    async fetchRoundRows(code, questionNo) {
      return srv.fetchRoundRows(userId, code, questionNo)
    },
  }
}

// ------------------------------------------------------------------ phone

export function createLocalPlayerTransport({ userId, channelName = CHANNEL }) {
  const channel = new BroadcastChannel(channelName)
  const pending = new Map()
  const gameListeners = new Set()
  let seq = 0

  channel.onmessage = ({ data }) => {
    if (!data) return
    if (data.type === 'res' && pending.has(data.id)) {
      const { resolve, reject, timer } = pending.get(data.id)
      clearTimeout(timer)
      pending.delete(data.id)
      data.error ? reject(new Error(data.error)) : resolve(data.result)
    }
    if (data.type === 'game' || data.type === 'ping') for (const fn of gameListeners) fn(data)
  }

  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = `${userId}:${++seq}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(method === 'joinGame' ? 'Room not found' : 'The host screen is not responding'))
      }, 3000)
      pending.set(id, { resolve, reject, timer })
      channel.postMessage({ type: 'req', id, userId, method, args })
    })

  return {
    mode: 'local',
    userId,
    async init() {},
    close() {
      channel.close()
    },
    serverNow: () => Date.now(),
    joinGame: (code, name, avatar, audience) => call('joinGame', code, name, avatar, audience),
    findMyPlayer: (code) => call('findMyPlayer', code).catch(() => null),
    fetchGame: (code) => call('fetchGame', code).catch(() => null),
    subscribeGame(code, playerId, onState) {
      const beat = () => channel.postMessage({ type: 'hb', code, playerId })
      const listener = (msg) => {
        if (msg.code !== code) return
        if (msg.type === 'ping') beat()
        else onState(msg.state)
      }
      gameListeners.add(listener)
      beat()
      const hb = setInterval(beat, HEARTBEAT_MS)
      return () => {
        gameListeners.delete(listener)
        clearInterval(hb)
      }
    },
    submitLie: (code, qn, text) => call('submitLie', code, qn, text),
    lieForMe: (code, qn) => call('lieForMe', code, qn),
    submitPick: (code, qn, optionId) => call('submitPick', code, qn, optionId),
    useLifeline: (code, qn) => call('useLifeline', code, qn),
    setPhoto: (code, photo) => call('setPhoto', code, photo),
    setLike: (code, qn, playerId, optionId, on) => call('setLike', code, qn, playerId, optionId, on),
    sendCommand: (code, playerId, cmd, payload) => call('sendCommand', code, playerId, cmd, payload),
    fetchMine: (code, qn, playerId) => call('fetchMine', code, qn, playerId),
  }
}
