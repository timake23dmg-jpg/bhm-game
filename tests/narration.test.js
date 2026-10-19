import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  phaseLine, questionLine, revealLines, winnerLines, awardLine, lifelineLine, listNames, playerLines, FIXED_LINES,
} from '../src/host/narration.js'

const players = [
  { id: 'a', name: 'Ana', score: 1500, isAudience: false },
  { id: 'b', name: 'Ben', score: 500, isAudience: false },
  { id: 'c', name: 'Cat', score: 0, isAudience: false },
]
const byId = Object.fromEntries(players.map((p) => [p.id, p]))

// Every segment the host says must be one that can be prepared ahead: a fixed
// line, a player line, or the answer.
const preparable = new Set([...FIXED_LINES, ...players.flatMap((p) => playerLines(p.name))])
const allPrepared = (segments, answer) => segments.every((s) => preparable.has(s) || s === `${answer}!`)

test('listNames', () => {
  assert.equal(listNames(['Ana']), 'Ana')
  assert.equal(listNames(['Ana', 'Ben']), 'Ana and Ben')
  assert.equal(listNames(['Ana', 'Ben', 'Cat']), 'Ana, Ben and Cat')
})

test('a line for every round phase, all prepared ahead', () => {
  const base = { players, round: 1, questionIndex: 0, question: { category: 'Animals', prompt: 'A ____ can sleep for 3 years.' } }
  for (const phase of ['INTRO', 'ROUND_TITLE', 'FINAL_TITLE', 'CATEGORY_PICK', 'PICK_TRUTH', 'SCOREBOARD']) {
    const line = phaseLine({ ...base, phase })
    assert.ok(line.length, phase)
    assert.ok(allPrepared(line), `${phase}: ${line}`)
  }
  assert.equal(questionLine({ ...base, phase: 'QUESTION' }), 'Animals. A ____ can sleep for 3 years.')
  assert.match(phaseLine({ ...base, phase: 'ROUND_TITLE', round: 2 })[0], /double/i)
  assert.match(phaseLine({ ...base, phase: 'SCOREBOARD' }).join(' '), /Ana/)
  assert.ok(phaseLine({ ...base, players: [], phase: 'LOBBY' }).length)
  assert.deepEqual(phaseLine({ ...base, phase: 'REVEAL' }), [])
})

test('reveal lines react to what happened', () => {
  const reveal = (correct, extra = {}) => revealLines({ truthText: 'snail', correct, detected: [], nobodyFound: !correct.length, ...extra }, byId)
  const fastest = reveal(['b', 'a'])
  assert.deepEqual(fastest.verdict, ['snail!', 'Ben was the fastest!'])
  assert.deepEqual(reveal(['a']).verdict, ['snail!', 'Well done, Ana!'])
  assert.match(reveal(['a', 'b', 'c']).verdict[1], /all knew|Everyone/)
  assert.match(reveal(['b', 'a'], { detected: ['b'] }).verdict.join(' '), /Truth Detector/)
  const nobody = reveal([])
  assert.match(nobody.verdict.join(' '), /snail/)

  // Same reveal, same line: prepared lines must match what's said later.
  assert.deepEqual(reveal(['b', 'a']), reveal(['b', 'a']))
  for (const r of [fastest, reveal(['a']), reveal(['a', 'b', 'c']), nobody]) {
    assert.ok(allPrepared([...r.start, ...r.verdict], 'snail'), JSON.stringify(r))
  }
})

test('winner, award and Truth Detector lines', () => {
  assert.equal(winnerLines([players[0]]).verdict[0], 'Ana!')
  assert.match(winnerLines(players.slice(0, 2)).start[0], /tie/i)
  const award = awardLine({ key: 'hotStreak', title: 'Hot Streak', playerIds: ['a'], stat: '4 correct answers in a row' }, byId)
  assert.deepEqual(award.slice(0, 2), ['Hot Streak!', 'Ana!'])
  assert.ok(allPrepared([...award, ...winnerLines([players[0]]).start, ...lifelineLine('Ben')]))
})
