// Plays full games through HostEngine + LocalServer with timers sped up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HostEngine } from '../src/engine/hostEngine.js'
import { LocalServer } from '../src/lib/transport/localServer.js'
import { createLocalHostTransport } from '../src/lib/transport/localTransport.js'
import { liePrice } from '../src/lib/rules.js'

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

test('rejects start with fewer than 2 players', async () => {
  const { engine } = await setup(['Ana'])
  await engine.startGame()
  assert.equal(engine.publicState.phase, 'LOBBY')
  engine.stop()
})

test('full game: phases, scoring, truth hidden until reveal, awards', async () => {
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

    await until(engine, (x) => x.phase === 'LIE_ENTRY')
    assert.equal(server.submitLie(ana.userId, code, qn, secret.answer).reason, 'isTruth')
    assert.ok(server.submitLie(ana.userId, code, qn, 'zzfake one').ok)
    assert.ok(server.submitLie(ben.userId, code, qn, 'ZZFake One!').ok) // duplicate after normalising
    // Cat buys a lie every question: the first is free, then 100, 200, ... 500.
    const bought = server.lieForMe(cat.userId, code, qn)
    assert.ok(bought.ok, `lie for me refused: ${bought.reason}`)
    assert.equal(bought.cost, liePrice(questionsPlayed))
    assert.ok(secret.suggestedLies.includes(bought.text))
    assert.ok(server.submitLie(cat.userId, code, qn, bought.text).ok)

    const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH') // advanced early
    const json = JSON.stringify(pick)
    assert.ok(!json.includes('authors') && !json.includes('isTruth'), 'no authors/truth flags before reveal')
    assert.ok(pick.options.length >= 4)
    const shared = pick.options.filter((o) => o.text.toLowerCase().includes('zzfake'))
    assert.equal(shared.length, 1, 'duplicate lie shown once')
    const truthOpt = engine.s.current.options.find((o) => o.isTruth)
    const catOpt = engine.s.current.options.find((o) => o.authors.includes(cat.id))
    const before = Object.fromEntries(players.map((p) => [p.id, engine.s.scores[p.id].score]))

    server.submitPick(ana.userId, code, qn, truthOpt.id)
    server.submitPick(ben.userId, code, qn, catOpt.id)
    server.submitPick(cat.userId, code, qn, shared[0].id)
    server.setLike(ben.userId, code, qn, ben.id, catOpt.id, true)

    const rev = await until(engine, (x) => x.phase === 'REVEAL')
    const m = rev.round
    assert.equal(rev.reveal.steps.at(-1).kind, 'truth')
    assert.equal(engine.s.scores[ana.id].score - before[ana.id], 1000 * m + 500 * m) // truth + fooled Cat
    assert.equal(engine.s.scores[ben.id].score - before[ben.id], 500 * m) // co-author of the lie Cat picked
    assert.equal(engine.s.scores[cat.id].score - before[cat.id], 500 * m - bought.cost) // fooled Ben, paid for the lie
    assert.deepEqual(rev.reveal.steps.find((x) => x.optionId === catOpt.id).bought, [cat.id])
    assert.equal(rev.players.find((p) => p.id === cat.id).lieBuys, questionsPlayed + 1)
    await until(engine, (x) => x.phase === 'SCOREBOARD')
    questionsPlayed++
  }
  assert.equal(questionsPlayed, 7)
  const final = engine.publicState
  assert.deepEqual(final.winners, [ana.id])
  const titles = final.awards.map((a) => a.title)
  assert.ok(titles.includes('Truth Seeker') && titles.includes('Crowd Favourite') && titles.includes('Biggest Liar'))
  await until(engine, (s) => s.phase === 'AWARDS')
  server.sendCommand(ana.userId, code, ana.id, 'backToLobby')
  await until(engine, (s) => s.phase === 'LOBBY')
  assert.ok(states.length > 20)
  engine.stop()
})

test('few lies are padded with house decoys; decoy pick costs points', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'])
  const [ana, ben] = players
  await engine.startGame()
  await engine.skip()
  const s = await until(engine, (x) => x.phase === 'CATEGORY_PICK')
  const picker = players.find((p) => p.id === s.pickerId)
  server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
  const q = await until(engine, (x) => x.phase === 'LIE_ENTRY')
  server.submitLie(ana.userId, code, q.questionNo, 'qqqq')
  // Ben never submits: the timer runs out
  const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH')
  assert.equal(pick.options.length, 4)
  const decoy = engine.s.current.options.find((o) => o.isDecoy)
  server.submitPick(ben.userId, code, pick.questionNo, decoy.id)
  await until(engine, (x) => x.phase === 'REVEAL')
  assert.equal(engine.s.scores[ben.id].score, -250)
  engine.stop()
})

test('real-time timers: lie entry and picking end early once everyone is in', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'], { timeScale: 1 })
  await engine.startGame()
  await engine.skip() // INTRO -> ROUND_TITLE (3 s)
  const s = await until(engine, (x) => x.phase === 'CATEGORY_PICK')
  const picker = players.find((p) => p.id === s.pickerId)
  server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
  const q = await until(engine, (x) => x.phase === 'LIE_ENTRY', 8000) // QUESTION is 5 s
  const t0 = Date.now()
  for (const p of players) server.submitLie(p.userId, code, q.questionNo, `${p.name} fib`)
  const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH', 1000) // not the 45 s timer
  for (const p of players) {
    const own = `${p.name} fib`.toLowerCase()
    server.submitPick(p.userId, code, pick.questionNo, pick.options.find((o) => o.text.toLowerCase() !== own).id)
  }
  await until(engine, (x) => x.phase === 'REVEAL', 1000) // not the 20 s timer
  assert.ok(Date.now() - t0 < 1500)
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
  const q = await until(engine, (x) => x.phase === 'LIE_ENTRY', 8000)
  server.submitLie(players[0].userId, code, q.questionNo, 'one')
  server.submitLie(players[1].userId, code, q.questionNo, 'two')
  await until(engine, (x) => x.phase === 'PICK_TRUTH', 1000)
  const cat = engine.publicState.players.find((p) => p.id === players[2].id)
  assert.equal(cat.connected, false)
  assert.equal(cat.score, 0, 'keeps score while away')
  engine.stop()
})

test('short game with 5 players: 2 + 2 + 1 questions', async () => {
  const { engine } = await setup(['A', 'B', 'C', 'D', 'E'], { settings: { shortGame: true }, timeScale: 0.002 })
  await engine.startGame()
  const seen = new Set()
  await until(engine, (s) => {
    if (s.phase === 'QUESTION') seen.add(s.questionNo)
    return s.phase === 'WINNER'
  }, 20000)
  assert.equal(seen.size, 5)
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

test('"Lie for me": first is free, then it costs points you must have', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben'])
  const [ana, ben] = players
  server.sendCommand(ana.userId, code, ana.id, 'start')
  await until(engine, (s) => s.phase === 'INTRO')
  server.sendCommand(ana.userId, code, ana.id, 'skipIntro')
  const s = await until(engine, (x) => x.phase === 'CATEGORY_PICK')
  const picker = players.find((p) => p.id === s.pickerId)
  server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
  const { questionNo: qn } = await until(engine, (x) => x.phase === 'LIE_ENTRY')

  const first = server.lieForMe(ana.userId, code, qn)
  assert.deepEqual([first.ok, first.cost], [true, 0])
  const second = server.lieForMe(ana.userId, code, qn) // 100 pts, but Ana has 0
  assert.deepEqual([second.ok, second.reason, second.cost], [false, 'broke', 100])
  assert.notEqual(server.lieForMe(ben.userId, code, qn).text, undefined, 'Ben still gets his free one')
  engine.stop()
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

test('Truth Detector: once per game, keeps the truth and one lie', async () => {
  const { server, engine, code, players } = await setup(['Ana', 'Ben', 'Cat'])
  const [ana, ben, cat] = players
  server.sendCommand(ana.userId, code, ana.id, 'start')
  await until(engine, (s) => s.phase === 'INTRO')
  server.sendCommand(ana.userId, code, ana.id, 'skipIntro')
  for (let q = 0; q < 2; q++) {
    const s = await until(engine, (x) => x.phase === 'CATEGORY_PICK', 20000)
    const picker = players.find((p) => p.id === s.pickerId)
    server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
    const { questionNo: qn } = await until(engine, (x) => x.phase === 'LIE_ENTRY')
    for (const p of players) server.submitLie(p.userId, code, qn, `zz ${p.name} ${q}`)
    await until(engine, (x) => x.phase === 'PICK_TRUTH')
    const truth = engine.s.current.options.find((o) => o.isTruth)
    const res = server.useLifeline(ana.userId, code, qn)
    if (q === 0) {
      assert.ok(res.ok, JSON.stringify(res))
      assert.equal(res.keep.length, 2)
      assert.ok(res.keep.includes(truth.id))
      const own = engine.s.current.options.find((o) => o.authors.includes(ana.id))
      assert.ok(!res.keep.includes(own.id), 'never keeps your own lie')
      assert.deepEqual(server.useLifeline(ana.userId, code, qn).keep, res.keep, 'asking again gives the same two')
      server.submitPick(ana.userId, code, qn, truth.id)
      server.submitPick(ben.userId, code, qn, truth.id)
      server.submitPick(cat.userId, code, qn, truth.id)
      const rev = await until(engine, (x) => x.phase === 'REVEAL')
      assert.deepEqual(rev.reveal.steps.at(-1).detected, [ana.id])
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

test('70 players: everyone joins as a player, options are capped, game finishes', async () => {
  const names = Array.from({ length: 70 }, (_, i) => `P${i + 1}`)
  const { server, engine, code, players } = await setup(names)
  assert.equal(engine.publicState.players.filter((p) => !p.isAudience).length, 70, 'all 70 are players, not audience')
  const vip = players[0]
  server.sendCommand(vip.userId, code, vip.id, 'start')
  await until(engine, (s) => s.phase === 'INTRO')
  server.sendCommand(vip.userId, code, vip.id, 'skipIntro')
  for (;;) {
    const s = await until(engine, (x) => ['CATEGORY_PICK', 'FINAL_TITLE', 'WINNER'].includes(x.phase), 30000)
    if (s.phase === 'WINNER') break
    if (s.phase === 'CATEGORY_PICK') {
      const picker = players.find((p) => p.id === s.pickerId)
      server.sendCommand(picker.userId, code, picker.id, 'pickCategory', { category: s.categoryOptions[0] })
    }
    const q = await until(engine, (x) => x.phase === 'LIE_ENTRY', 30000)
    for (const p of players) server.submitLie(p.userId, code, q.questionNo, `made up answer ${p.name}`)
    const pick = await until(engine, (x) => x.phase === 'PICK_TRUTH', 30000)
    assert.ok(pick.options.length <= 12, `too many options on screen: ${pick.options.length}`)
    const truth = engine.s.current.options.find((o) => o.isTruth)
    assert.ok(truth, 'the truth is always among the options')
    for (const p of players) {
      const choices = pick.options.filter((o) => o.text !== `made up answer ${p.name}`)
      server.submitPick(p.userId, code, q.questionNo, choices[Math.floor(Math.random() * choices.length)].id)
    }
    await until(engine, (x) => x.phase === 'SCOREBOARD', 60000)
  }
  assert.ok(engine.publicState.winners.length >= 1)
  engine.stop()
})
