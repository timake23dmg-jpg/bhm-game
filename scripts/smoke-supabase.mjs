// Smoke test against a live Supabase project (see MULTIPLAYER-ARCHITECTURE.md §10).
// Signs in a host and three anonymous players as separate sessions, then plays
// one full game through the real RPCs, RLS policies and realtime, using the
// same HostEngine the TV runs (timers sped up).
//
//   npm run smoke        (reads VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from .env)

import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { HostEngine } from '../src/engine/hostEngine.js'

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_ANON_KEY
if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env first.')
  process.exit(1)
}

// Separate clients = separate anonymous sessions (no shared storage in Node).
const session = async () => {
  const sb = createClient(url, key, { db: { schema: 'bhm' }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await sb.auth.signInAnonymously()
  if (error) throw error
  return { sb, userId: data.user.id }
}
const ok = ({ data, error }) => {
  if (error) throw new Error(error.message)
  return data
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// The browser transport touches `document`; give Node a tiny stand-in.
globalThis.document ??= { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
const { createSupabaseHostTransport } = await import('../src/lib/transport/supabaseTransport.js')

async function main() {
  const host = createSupabaseHostTransport({ url, anonKey: key })
  await host.init()
  const code = await host.createGame({ profanityFilter: true })
  console.log('room', code)

  const players = []
  // SMOKE_PLAYERS=70 npm run smoke  → a load test at event size (needs the
  // anonymous sign-in rate limit raised; see README "Running a 70-player event").
  const count = Math.max(3, Number(process.env.SMOKE_PLAYERS) || 3)
  const names = ['Ana', 'Ben', 'Cat', ...Array.from({ length: count - 3 }, (_, i) => `P${i + 4}`)]
  for (const name of names) {
    const s = await session()
    const row = ok(await s.sb.rpc('join_game', { p_code: code, p_name: name, p_avatar: '🦊', p_audience: false }))
    players.push({ ...s, id: row.id, name })
  }
  const [ana, ben, cat] = players

  // Like real phones: listen for game state on the room channel and send
  // heartbeats. Count what the phones receive, to compare with the realtime quota.
  const received = new Map() // second -> state updates delivered to all phones
  await Promise.all(players.map((p) => new Promise((resolve) => {
    const ch = p.sb.channel(`bhm-room:${code}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'bhm', table: 'games', filter: `code=eq.${code}` }, () => {
        const sec = Math.floor(Date.now() / 1000)
        received.set(sec, (received.get(sec) || 0) + 1)
      })
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve()
    })
    const beat = () => p.sb.rpc('heartbeat', { p_code: code }).then(() => {}, () => {})
    beat()
    setInterval(beat, 5000)
  })))
  const reportMessages = () => {
    const counts = [...received.values()]
    const total = counts.reduce((a, b) => a + b, 0)
    console.log(`realtime: ${total} state updates delivered to phones, peak ${Math.max(0, ...counts)}/s`)
  }

  // RLS: a player cannot read questions or the host's secrets.
  assert.equal(ok(await ana.sb.from('questions').select('id')).length, 0, 'questions must be unreadable')
  assert.equal(ok(await ana.sb.from('game_secrets').select('code')).length, 0, 'secrets must be unreadable')
  // Rejoining from the same session returns the same row (reconnect).
  const again = ok(await ana.sb.rpc('join_game', { p_code: code, p_name: 'Ana', p_avatar: '🦊', p_audience: false }))
  assert.equal(again.id, ana.id)

  let pub = null
  const engine = new HostEngine({ transport: host, code, timeScale: 0.1, onPublic: (s) => (pub = s) })
  if (process.env.SMOKE_DEBUG) {
    const name = (id) => players.find((p) => p.id === id)?.name ?? id
    const orig = engine.handleCommand.bind(engine)
    engine.handleCommand = async (row) => {
      console.log('[debug] command', row.cmd, 'from', name(row.playerId), '· vip', name(engine.vipId()),
        '· online', engine.online?.size, '· players', engine.gamePlayers().length)
      return orig(row)
    }
  }
  await engine.start()
  const until = async (pred, ms = 30000) => {
    const t0 = Date.now()
    while (!pub || !pred(pub)) {
      if (Date.now() - t0 > ms) throw new Error(`timeout in ${pub?.phase}`)
      await wait(50)
    }
    return pub
  }

  await until((s) => s.players.length === count && s.players.every((p) => p.connected))
  console.log(`all ${count} players online via presence`)

  // Mugshot selfie: saved through set_photo, reaches the host, stays out of the public state.
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(2000)
  assert.equal(ok(await ana.sb.rpc('set_photo', { p_code: code, p_photo: 'data:image/png;base64,AA' })).reason, 'badPhoto')
  assert.ok(ok(await ana.sb.rpc('set_photo', { p_code: code, p_photo: photo })).ok)
  for (let t0 = Date.now(); engine.players.find((p) => p.id === ana.id)?.photo !== photo; await wait(100)) {
    if (Date.now() - t0 > 15000) throw new Error('photo never reached the host')
  }
  assert.ok(!JSON.stringify(pub).includes('base64'), 'photos must stay out of the public state')
  console.log('mugshot reached the host')
  ok(await ana.sb.from('commands').insert({ game_code: code, player_id: ana.id, cmd: 'start', payload: {} }))
  const tStart = Date.now()
  await until((s) => s.phase === 'INTRO', 120000)
  console.log(`game started ${((Date.now() - tStart) / 1000).toFixed(1)}s after the VIP pressed start`)
  console.log('started by VIP via realtime command')

  let n = 0
  for (;;) {
    const s = await until((x) => ['CATEGORY_PICK', 'FINAL_TITLE', 'WINNER'].includes(x.phase))
    if (s.phase === 'WINNER') break
    if (s.phase === 'CATEGORY_PICK') {
      const picker = players.find((p) => p.id === s.pickerId)
      ok(await picker.sb.from('commands').insert({ game_code: code, player_id: picker.id, cmd: 'pickCategory', payload: { category: s.categoryOptions[0] } }))
    }
    // Quiz: straight from the question to four answers.
    const pick = await until((x) => x.phase === 'PICK_TRUTH')
    const qn = pick.questionNo
    assert.equal(pick.options.length, 4)
    assert.ok(!JSON.stringify(pick).includes('isTruth'), 'truth flag must not be public before reveal')
    const truthId = engine.s.current.options.find((o) => o.isTruth).id
    if (n === 0) {
      // Truth Detector: keeps the truth and one other option, once per game.
      const det = ok(await ana.sb.rpc('use_lifeline', { p_code: code, p_question_no: qn }))
      assert.ok(det.ok && det.keep.length === 2 && det.keep.includes(truthId), JSON.stringify(det))
    } else if (n === 1) {
      const again = ok(await ana.sb.rpc('use_lifeline', { p_code: code, p_question_no: qn }))
      assert.deepEqual([again.ok, again.reason], [false, 'used'])
    }
    // Ana always answers right; everyone else picks at random.
    await Promise.all(players.map(async (p) => {
      const opt = p === ana ? truthId : pick.options[Math.floor(Math.random() * 4)].id
      ok(await p.sb.rpc('submit_pick', { p_code: code, p_question_no: qn, p_option_id: opt }))
    }))
    const rev = await until((x) => x.phase === 'REVEAL')
    assert.ok(rev.reveal.correct.includes(ana.id), 'Ana found the truth')
    assert.ok(rev.reveal.deltas[ana.id] >= 500, 'Ana scored for a correct answer')
    assert.equal(rev.reveal.answered, players.length)
    n++
    console.log(`question ${n} ok: ${rev.reveal.correct.length} of ${players.length} correct`)
  }
  assert.equal(n, 11)
  console.log('winner:', pub.winners.map((id) => players.find((p) => p.id === id)?.name).join(', '))
  engine.stop()
  reportMessages()
  console.log('SMOKE TEST PASSED')
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err)
  process.exit(1)
})
