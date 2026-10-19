// Plays full games through HostEngine + LocalServer with timers sped up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HostEngine } from '../src/engine/hostEngine.js'
import { LocalServer } from '../src/lib/transport/localServer.js'
import { createLocalHostTransport } from '../src/lib/transport/localTransport.js'
import { quizPoints, QUIZ_SCORES, TIMERS } from '../src/engine/constants.js'

const questions = JSON.parse(readFileSync(new URL('../src/data/questions.json', import.meta.url), 'utf8'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function setup(names, { timeScale = 0.01, settings = {} } = {}) {
  const server = new LocalServer({ questions })
  const transport = createLocalHostTransport({ userId: 'host', server, channelName: null })
  const code = await transport.createGame(settings)
  const players = names.map((name, i) => ({ userId: `u${i}`, ...server.joinGame(`u${i}`, code, name, '🦊') }))
  const states = []
  const engine = new HostEngine({ transport, code, settings, timeScale, onPublic: (s) => states.push(s) })
  await engine.start()
  return { server, engine, code, players, states }
}

async function until(engine, predicate, timeout = 5000) {
  const start = Date.now()
  while (!engine.publicState || !predicate(engine.publicState)) {
    if (Date.now() - start > timeout) throw new Error(`timed out in phase ${engine.publicState?.phase}`)
    await wait(2)
  }
  return engine.publicState
}

// Picks a category if asked, then waits for the answers to appear.
async function toAnswers(engine, server, code, players, timeout = 20000) {
  const s = await until(engine, (x) => ['CATEGORY_PICK', 'FINAL_TITLE', 'WINNER'].includes(x.phase), timeout)
  if (s.phase === 'WINNER') return null
  if (s.phase === 'CATEGORY_PICK') {
    const picker = players.find((p) => p.id === s.pickerId)
    server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
  }
  return until(engine, (x) => x.phase === 'PICK_TRUTH', timeout)
}

test('quiz points: faster correct answers score more, by round', () => {
  assert.equal(quizPoints(1, 0), 1000)
  assert.equal(quizPoints(1, TIMERS.PICK_TRUTH), 500)
  assert.equal(quizPoints(1, TIMERS.PICK_TRUTH / 2), 750)
  assert.equal(quizPoints(2, 0), 2000)
  assert.equal(quizPoints(3, TIMERS.PICK_TRUTH * 2), 1500, 'never below the slowest score')
})

test('rejects start with fewer than 2 players', async () => {
  const { engine } = await setup(['Ana'])
  await engine.startGame()
  assert.equal(engine.publicState.phase, 'LOBBY')
  engine.stop()
})

test('full game: 4 answers, speed scoring, wrong answers cost points, awards', async () => {
  const { server, engine, code, players, states } = await setup(['Ana', 'Ben', 'Cat'])
  const [ana, ben, cat] = players
  assert.equal(engine.publicState.vipId, ana.id)

  server.sendCommand(ana.userId, code, ana.id, 'start')
  await until(engine, (s) => s.phase === 'INTRO')
  server.sendCommand(ana.userId, code, ana.id, 'skipIntro')
  await until(engine, (s) => s.phase === 'ROUND_TITLE' && s.round === 1)

  let questionsPlayed = 0
  const seen = new Set()
  for (;;) {
    const s = await until(engine, (x) => ['CATEGORY_PICK', 'FINAL_TITLE', 'WINNER'].includes(x.phase), 20000)
    if (s.phase === 'WINNER') break
    if (s.phase === 'CATEGORY_PICK') {
      assert.equal(s.categoryOptions.length, 3)
      const picker = players.find((p) => p.id === s.pickerId)
      server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[1] })
    }
    const q = await until(engine, (x) => x.phase === 'QUESTION')
    const qn = q.questionNo
    const secret = engine.s.current.question
    assert.ok(!seen.has(secret.id), 'no question repeats within a game')
    seen.add(secret.id)
    if (s.phase === 'CATEGORY_PICK') assert.equal(secret.category, s.categoryOptions[1])
    assert.equal(q.question.answer, undefined, 'answer must not be in public state')

    const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH') // straight from the question: no lie writing
    const json = JSON.stringify(pick)
    assert.ok(!json.includes('isTruth') && !json.includes('isDecoy'), 'no truth flags before reveal')
    assert.equal(pick.options.length, 4)
    assert.ok(pick.options.some((o) => o.text === secret.answer))
    for (const o of pick.options) assert.ok(o.text === secret.answer || secret.suggestedLies.includes(o.text))
    const truthOpt = engine.s.current.options.find((o) => o.isTruth)
    const wrongOpt = engine.s.current.options.find((o) => !o.isTruth)
    const before = Object.fromEntries(players.map((p) => [p.id, engine.s.scores[p.id].score]))

    // Ana answers right first, Ben right a moment later, Cat wrong.
    server.submitPick(ana.userId, code, qn, truthOpt.id)
    await wait(20)
    server.submitPick(ben.userId, code, qn, truthOpt.id)
    server.submitPick(cat.userId, code, qn, wrongOpt.id)

    const rev = await until(engine, (x) => x.phase === 'REVEAL') // ends early: everyone answered
    const m = rev.round
    const gain = (p) => engine.s.scores[p.id].score - before[p.id]
    assert.equal(rev.reveal.truthId, truthOpt.id)
    assert.deepEqual(rev.reveal.correct, [ana.id, ben.id], 'fastest first')
    assert.equal(rev.reveal.counts[truthOpt.id], 2)
    assert.equal(rev.reveal.counts[wrongOpt.id], 1)
    assert.ok(gain(ana) <= 1000 * m && gain(ana) >= 500 * m)
    assert.ok(gain(ana) >= gain(ben) && gain(ben) >= 500 * m, 'faster answer, more points')
    assert.equal(gain(cat), QUIZ_SCORES.wrong[m - 1])
    assert.equal(rev.reveal.deltas[cat.id], QUIZ_SCORES.wrong[m - 1])
    await until(engine, (x) => x.phase === 'SCOREBOARD')
    questionsPlayed++
  }
  assert.equal(questionsPlayed, 11, '5 + 5 + the final')
  const final = engine.publicState
  assert.deepEqual(final.winners, [ana.id])
  const byKey = Object.fromEntries(final.awards.map((a) => [a.key, a]))
  assert.deepEqual(byKey.fastestFingers.playerIds, [ana.id])
  assert.deepEqual(byKey.hotStreak.playerIds.sort(), [ana.id, ben.id].sort())
  assert.equal(byKey.hotStreak.stat, '11 correct answers in a row')
  assert.ok(byKey.truthSeeker)
  await until(engine, (s) => s.phase === 'AWARDS')
  server.sendCommand(ana.userId, code, ana.id, 'backToLobby')
  await until(engine, (s) => s.phase === 'LOBBY')
  assert.ok(states.length > 20)
  engine.stop()
})

test('no answer scores nothing and breaks a streak', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'])
  const [ana, ben] = players
  await engine.startGame()
  await engine.skip()
  const pick = await toAnswers(engine, server, code, players)
  const truth = engine.s.current.options.find((o) => o.isTruth)
  server.submitPick(ana.userId, code, pick.questionNo, truth.id)
  // Ben never answers: the timer runs out
  const rev = await until(engine, (x) => x.phase === 'REVEAL')
  assert.equal(engine.s.scores[ben.id].score, 0)
  assert.equal(rev.reveal.deltas[ben.id], undefined)
  assert.equal(engine.s.scores[ana.id].stats.streak, 1)
  assert.equal(engine.s.scores[ben.id].stats.streak, 0)
  engine.stop()
})

test('real-time timers: answering ends early once everyone is in', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'], { timeScale: 1 })
  await engine.startGame()
  await engine.skip() // INTRO -> ROUND_TITLE (3 s)
  const s = await until(engine, (x) => x.phase === 'CATEGORY_PICK')
  const picker = players.find((p) => p.id === s.pickerId)
  server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
  const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH', 8000) // QUESTION is 4 s
  const t0 = Date.now()
  for (const p of players) server.submitPick(p.userId, code, pick.questionNo, pick.options[0].id)
  await until(engine, (x) => x.phase === 'REVEAL', 1500) // not the 15 s timer
  assert.ok(Date.now() - t0 < 1500)
  const correct = engine.s.current.reveal.correct
  if (correct.length) assert.ok(engine.s.current.reveal.fastest[0].points > 900, 'an instant answer is worth nearly full points')
  engine.stop()
})

test('disconnected players are not waited for', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben', 'Cat'], { timeScale: 1 })
  engine.online = new Set([players[0].id, players[1].id]) // Cat's phone dropped
  await engine.startGame()
  await engine.skip()
  const s = await until(engine, (x) => x.phase === 'CATEGORY_PICK')
  assert.notEqual(s.pickerId, players[2].id, 'offline players are not chosen to pick')
  const picker = players.find((p) => p.id === s.pickerId)
  server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
  const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH', 8000)
  server.submitPick(players[0].userId, code, pick.questionNo, pick.options[0].id)
  server.submitPick(players[1].userId, code, pick.questionNo, pick.options[1].id)
  await until(engine, (x) => x.phase === 'REVEAL', 1500)
  const cat = engine.publicState.players.find((p) => p.id === players[2].id)
  assert.equal(cat.connected, false)
  assert.equal(cat.score, 0, 'keeps score while away')
  engine.stop()
})

test('short game with 5 players: 3 + 3 + 1 questions', async () => {
  const { engine } = await setup(['A', 'B', 'C', 'D', 'E'], { settings: { shortGame: true }, timeScale: 0.002 })
  await engine.startGame()
  const seen = new Set()
  await until(engine, (s) => {
    if (s.phase === 'QUESTION') seen.add(s.questionNo)
    return s.phase === 'WINNER'
  }, 20000)
  assert.equal(seen.size, 7)
  engine.stop()
})

test('end game mid-round: phones see ENDED + the new code, players can join the new room as players', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'])
  await engine.startGame()
  await until(engine, (s) => s.phase === 'INTRO')
  const newCode = server.createGame('host', {})
  await engine.endGame(newCode)
  assert.equal(server.game(code).state.phase, 'ENDED')
  assert.equal(server.game(code).state.nextCode, newCode)
  assert.equal(engine.stopped, true)
  await wait(50)
  assert.equal(server.game(code).state.phase, 'ENDED', 'no timers fire after ending')
  const rejoined = server.joinGame(players[0].userId, newCode, 'Ana', '🦊')
  assert.equal(rejoined.gameCode, newCode)
  assert.equal(rejoined.isAudience, false, 'joins the new lobby as a player, not audience')
})

test('a TV avoids questions it played recently, even in a new room', () => {
  const server = new LocalServer({ questions })
  const code = server.createGame('host')
  const regular = questions.filter((q) => !q.isFinal)
  const exclude = regular.slice(0, -5).map((q) => q.id)
  for (let i = 0; i < 5; i++) {
    const q = server.drawQuestion('host', code, null, false, exclude)
    assert.ok(!exclude.includes(q.id))
  }
  // Everything excluded or used: still returns a question rather than failing.
  assert.ok(server.drawQuestion('host', code, null, false, regular.map((q) => q.id)))
  const cats = server.drawCategories('host', code, exclude)
  assert.equal(cats.length, 3)
})

test('Truth Detector: once per game, keeps the truth and one wrong answer', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben', 'Cat'])
  const [ana, ben, cat] = players
  server.sendCommand(ana.userId, code, ana.id, 'start')
  await until(engine, (s) => s.phase === 'INTRO')
  server.sendCommand(ana.userId, code, ana.id, 'skipIntro')
  for (let q = 0; q < 2; q++) {
    const { questionNo: qn } = await toAnswers(engine, server, code, players)
    const truth = engine.s.current.options.find((o) => o.isTruth)
    const res = server.useLifeline(ana.userId, code, qn)
    if (q === 0) {
      assert.ok(res.ok, JSON.stringify(res))
      assert.equal(res.keep.length, 2)
      assert.ok(res.keep.includes(truth.id))
      assert.deepEqual(server.useLifeline(ana.userId, code, qn).keep, res.keep, 'asking again gives the same two')
      for (const p of [ana, ben, cat]) server.submitPick(p.userId, code, qn, truth.id)
      const rev = await until(engine, (x) => x.phase === 'REVEAL')
      assert.deepEqual(rev.reveal.detected, [ana.id])
      assert.equal(rev.players.find((p) => p.id === ana.id).lifelineUsed, true)
    } else {
      assert.deepEqual([res.ok, res.reason], [false, 'used'], 'only once per game')
      assert.ok(server.useLifeline(ben.userId, code, qn).ok, 'Ben still has his')
    }
  }
  engine.stop()
})

test('every phone transport method is reachable through the demo channel', async () => {
  const { PHONE_METHODS } = await import('../src/lib/transport/localServer.js')
  const src = readFileSync(new URL('../src/lib/transport/localTransport.js', import.meta.url), 'utf8')
  const called = [...src.matchAll(/call\('(\w+)'/g)].map((m) => m[1])
  assert.ok(called.includes('useLifeline'))
  for (const m of called) assert.ok(PHONE_METHODS.includes(m), `${m} is missing from PHONE_METHODS`)
})

test('mugshot selfies: saved on the player, given to the TV, never in the public state', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'])
  const [ana] = players
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(2000)
  assert.deepEqual(server.setPhoto(ana.userId, code, photo), { ok: true })
  assert.equal(server.setPhoto(ana.userId, code, 'data:image/png;base64,AAAA').reason, 'badPhoto')
  assert.equal(server.setPhoto(ana.userId, code, 'data:image/jpeg;base64,' + 'A'.repeat(70000)).reason, 'badPhoto')
  await until(engine, () => engine.players.find((p) => p.id === ana.id)?.photo === photo)
  assert.ok(!JSON.stringify(engine.publicState).includes('base64'), 'photos stay out of the published state')
  assert.deepEqual(server.setPhoto(ana.userId, code, null), { ok: true })
  await until(engine, () => engine.players.find((p) => p.id === ana.id)?.photo === null)
  engine.stop()
})

test('70 players: everyone joins as a player, 4 answers each time, game finishes', async () => {
  const names = Array.from({ length: 70 }, (_, i) => `P${i + 1}`)
  const { server, engine, code, players } = await setup(names)
  assert.equal(engine.publicState.players.filter((p) => !p.isAudience).length, 70, 'all 70 are players, not audience')
  const vip = players[0]
  server.sendCommand(vip.userId, code, vip.id, 'start')
  await until(engine, (s) => s.phase === 'INTRO')
  server.sendCommand(vip.userId, code, vip.id, 'skipIntro')
  for (;;) {
    const pick = await toAnswers(engine, server, code, players, 30000)
    if (!pick) break
    assert.equal(pick.options.length, 4)
    for (const p of players) {
      server.submitPick(p.userId, code, pick.questionNo, pick.options[Math.floor(Math.random() * 4)].id)
    }
    const rev = await until(engine, (x) => x.phase === 'REVEAL', 30000)
    assert.equal(rev.reveal.answered, 70)
    assert.ok(rev.reveal.fastest.length <= 5)
    await until(engine, (x) => x.phase === 'SCOREBOARD', 60000)
  }
  assert.ok(engine.publicState.winners.length >= 1)
  engine.stop()
})
