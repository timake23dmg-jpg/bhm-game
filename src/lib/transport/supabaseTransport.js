// Supabase backend (see MULTIPLAYER-ARCHITECTURE.md and supabase/schema.sql).
// Same interface as localTransport.js.

import { createClient } from '@supabase/supabase-js'

// All Fakeout tables and RPCs live in their own Postgres schema (see supabase/schema.sql).
export const DB_SCHEMA = 'bhm'

let client = null
let readyPromise = null
let clockOffset = 0 // serverTime - localTime, in ms

export function getSupabase(url, anonKey) {
  if (!client) client = createClient(url, anonKey, { db: { schema: DB_SCHEMA } })
  return client
}

export function ensureSignedIn(supabase) {
  if (!readyPromise) {
    readyPromise = (async () => {
      const { data } = await supabase.auth.getSession()
      if (data.session) return data.session.user
      const { data: signInData, error } = await supabase.auth.signInAnonymously()
      if (error) throw error
      return signInData.user
    })()
    readyPromise.catch(() => {
      readyPromise = null
    })
  }
  return readyPromise
}

// Estimate the offset to the database clock (best of a few round trips).
async function syncClock(supabase) {
  let best = null
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    const { data, error } = await supabase.rpc('server_now')
    const t1 = Date.now()
    if (error) throw error
    const rtt = t1 - t0
    if (!best || rtt < best.rtt) best = { rtt, offset: Number(data) - (t0 + rtt / 2) }
  }
  clockOffset = best.offset
}

const serverNow = () => Date.now() + clockOffset

function unwrap({ data, error }) {
  if (error) throw new Error(error.message)
  return data
}

const toPlayer = (r) => ({
  id: r.id, gameCode: r.game_code, name: r.name, avatar: r.avatar, slot: r.slot, isAudience: r.is_audience, photo: r.photo ?? null,
})

function baseTransport(url, anonKey) {
  const supabase = getSupabase(url, anonKey)
  let user = null
  return {
    supabase,
    mode: 'supabase',
    get userId() {
      return user?.id
    },
    async init() {
      user = await ensureSignedIn(supabase)
      await syncClock(supabase)
    },
    serverNow,
  }
}

// ------------------------------------------------------------------- host

export function createSupabaseHostTransport({ url, anonKey }) {
  const base = baseTransport(url, anonKey)
  const { supabase } = base

  const fetchPlayers = async (code) =>
    unwrap(await supabase.from('players').select('*').eq('game_code', code).order('slot')).map(toPlayer)

  return {
    ...base,
    async createGame(settings) {
      return unwrap(await supabase.rpc('create_game', { p_settings: settings }))
    },
    async loadHostedGame(code) {
      const game = unwrap(await supabase.from('games').select('host_user_id').eq('code', code).maybeSingle())
      if (!game || game.host_user_id !== base.userId) return null
      const secrets = unwrap(await supabase.from('game_secrets').select('data').eq('code', code).maybeSingle())
      return secrets?.data && Object.keys(secrets.data).length ? { data: secrets.data } : null
    },
    fetchPlayers,
    subscribeHost(code, { onPlayers, onLie, onPick, onCommand, onPresence }) {
      // Commands (VIP start/skip, category picks) must never be lost, e.g. one
      // sent while the realtime channel is still joining or reconnecting. Deliver
      // each command id exactly once, from realtime or from a catch-up query.
      // Commands that existed before this host subscribed (older games) are skipped.
      const delivered = new Set()
      let baselineId = 0
      let cursor = 0
      const baseline = supabase.from('commands').select('id').eq('game_code', code)
        .order('id', { ascending: false }).limit(1)
        .then(({ data }) => { baselineId = cursor = data?.[0]?.id ?? 0 })
      const deliver = (r) => {
        if (delivered.has(r.id) || r.id <= baselineId) return
        delivered.add(r.id)
        cursor = Math.max(cursor, r.id)
        onCommand?.({ playerId: r.player_id, cmd: r.cmd, payload: r.payload })
      }
      const catchUpCommands = async () => {
        await baseline
        const { data } = await supabase.from('commands').select('*').eq('game_code', code).gt('id', cursor).order('id')
        data?.forEach(deliver)
      }

      const channel = supabase
        .channel(`bhm-room:${code}`)
        .on('postgres_changes', { event: '*', schema: DB_SCHEMA, table: 'players', filter: `game_code=eq.${code}` },
          () => fetchPlayers(code).then(onPlayers).catch(console.error))
        .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'lies', filter: `game_code=eq.${code}` },
          ({ new: r }) => onLie?.({ playerId: r.player_id, text: r.text, questionNo: r.question_no }))
        .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'picks', filter: `game_code=eq.${code}` },
          ({ new: r }) => onPick?.({ playerId: r.player_id, optionId: r.option_id, questionNo: r.question_no }))
        .on('postgres_changes', { event: 'INSERT', schema: DB_SCHEMA, table: 'commands', filter: `game_code=eq.${code}` },
          ({ new: r }) => baseline.then(() => deliver(r)))
      // Who's online comes from phones' heartbeats (see heartbeat() in schema.sql),
      // not realtime presence, which can't keep up with a 70-player room.
      // Only report changes, so a steady room doesn't trigger republishing.
      let onlineKey = null
      const checkOnline = async () => {
        const ids = unwrap(await supabase.rpc('host_online', { p_code: code }))
        const key = [...ids].sort().join(',')
        if (key === onlineKey) return
        onlineKey = key
        onPresence?.(new Set(ids))
      }
      checkOnline().catch(console.error)
      channel.subscribe((status) => {
        // After a (re)connect, catch up on anything missed.
        if (status === 'SUBSCRIBED') {
          fetchPlayers(code).then(onPlayers).catch(console.error)
          catchUpCommands().catch(console.error)
        }
      })
      const poll = setInterval(() => fetchPlayers(code).then(onPlayers).catch(() => {}), 10000)
      const commandPoll = setInterval(() => catchUpCommands().catch(() => {}), 2000)
      const onlinePoll = setInterval(() => checkOnline().catch(() => {}), 3000)
      return () => {
        clearInterval(poll)
        clearInterval(commandPoll)
        clearInterval(onlinePoll)
        supabase.removeChannel(channel)
      }
    },
    async setState(code, { phase, questionNo, state, durationMs, keepTimer }) {
      const res = unwrap(await supabase.rpc('host_set_state', {
        p_code: code, p_phase: phase, p_question_no: questionNo, p_state: state,
        p_duration_ms: durationMs, p_keep_timer: !!keepTimer,
      }))
      return { deadline: res.deadline, startedAt: res.startedAt }
    },
    async saveSecrets(code, data) {
      unwrap(await supabase.from('game_secrets').update({ data }).eq('code', code))
    },
    async drawCategories(code, exclude = []) {
      return unwrap(await supabase.rpc('host_draw_categories', { p_code: code, p_exclude: exclude }))
    },
    async drawQuestion(code, category, isFinal, exclude = []) {
      return unwrap(await supabase.rpc('host_draw_question', {
        p_code: code, p_category: category, p_final: !!isFinal, p_exclude: exclude,
      }))
    },
    async fetchRoundRows(code, questionNo) {
      const q = (table, cols) => supabase.from(table).select(cols).eq('game_code', code).eq('question_no', questionNo)
      const [lies, picks, likes, secrets] = await Promise.all([
        q('lies', 'player_id, text'), q('picks', 'player_id, option_id'), q('likes', 'player_id, option_id'),
        supabase.from('game_secrets').select('lie_handouts, handouts_question_no, lifelines, lifelines_question_no').eq('code', code).maybeSingle(),
      ])
      const sec = unwrap(secrets)
      return {
        lies: unwrap(lies).map((r) => ({ playerId: r.player_id, text: r.text })),
        picks: unwrap(picks).map((r) => ({ playerId: r.player_id, optionId: r.option_id })),
        likes: unwrap(likes).map((r) => ({ playerId: r.player_id, optionId: r.option_id })),
        // "Lie for me" suggestions handed out this question: { playerId: [text] }
        handouts: sec?.handouts_question_no === questionNo ? sec.lie_handouts || {} : {},
        // Players who used their Truth Detector this question
        lifelines: sec?.lifelines_question_no === questionNo ? Object.keys(sec.lifelines || {}) : [],
      }
    },
  }
}

// ------------------------------------------------------------------ phone

export function createSupabasePlayerTransport({ url, anonKey }) {
  const base = baseTransport(url, anonKey)
  const { supabase } = base

  const fetchGame = async (code) => {
    const row = unwrap(await supabase.from('games').select('state').eq('code', code).maybeSingle())
    return row?.state ?? null
  }

  return {
    ...base,
    async joinGame(code, name, avatar, audience) {
      return toPlayer(unwrap(await supabase.rpc('join_game', {
        p_code: code, p_name: name, p_avatar: avatar, p_audience: !!audience,
      })))
    },
    async findMyPlayer(code) {
      const row = unwrap(await supabase.from('players').select('*')
        .eq('game_code', code).eq('user_id', base.userId).maybeSingle())
      return row ? toPlayer(row) : null
    },
    fetchGame,
    subscribeGame(code, playerId, onState) {
      const channel = supabase
        .channel(`bhm-room:${code}`)
        .on('postgres_changes', { event: 'UPDATE', schema: DB_SCHEMA, table: 'games', filter: `code=eq.${code}` },
          ({ new: r }) => r?.state && onState(r.state))
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          fetchGame(code).then((s) => s && onState(s)).catch(console.error)
        }
      })
      // Tell the host we're here (it counts us offline after ~20 s of silence).
      const beat = () => supabase.rpc('heartbeat', { p_code: code }).then(() => {}, () => {})
      beat()
      const heartbeat = setInterval(beat, 5000)
      // Backup against missed events (e.g. phone slept).
      const refresh = () => fetchGame(code).then((s) => s && onState(s)).catch(() => {})
      const poll = setInterval(refresh, 5000)
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return
        beat()
        refresh()
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        clearInterval(heartbeat)
        clearInterval(poll)
        document.removeEventListener('visibilitychange', onVisible)
        supabase.removeChannel(channel)
      }
    },
    async submitLie(code, qn, text) {
      return unwrap(await supabase.rpc('submit_lie', { p_code: code, p_question_no: qn, p_text: text }))
    },
    async lieForMe(code, qn) {
      return unwrap(await supabase.rpc('lie_for_me', { p_code: code, p_question_no: qn }))
    },
    async setPhoto(code, photo) {
      return unwrap(await supabase.rpc('set_photo', { p_code: code, p_photo: photo }))
    },
    async useLifeline(code, qn) {
      return unwrap(await supabase.rpc('use_lifeline', { p_code: code, p_question_no: qn }))
    },
    async submitPick(code, qn, optionId) {
      return unwrap(await supabase.rpc('submit_pick', { p_code: code, p_question_no: qn, p_option_id: optionId }))
    },
    async setLike(code, qn, playerId, optionId, on) {
      if (on) {
        unwrap(await supabase.from('likes').upsert(
          { game_code: code, question_no: qn, player_id: playerId, option_id: optionId },
          { ignoreDuplicates: true }))
      } else {
        unwrap(await supabase.from('likes').delete()
          .match({ game_code: code, question_no: qn, player_id: playerId, option_id: optionId }))
      }
    },
    async sendCommand(code, playerId, cmd, payload = {}) {
      // No .select(): see "RETURNING vs RLS" gotcha in the architecture doc.
      unwrap(await supabase.from('commands').insert({ game_code: code, player_id: playerId, cmd, payload }))
    },
    async fetchMine(code, qn, playerId) {
      const q = (table, cols) => supabase.from(table).select(cols)
        .eq('game_code', code).eq('question_no', qn).eq('player_id', playerId)
      const [lie, pick, likes] = await Promise.all([q('lies', 'text'), q('picks', 'option_id'), q('likes', 'option_id')])
      return {
        lie: unwrap(lie)[0]?.text ?? null,
        pick: unwrap(pick)[0]?.option_id ?? null,
        likes: unwrap(likes).map((r) => r.option_id),
      }
    },
  }
}
