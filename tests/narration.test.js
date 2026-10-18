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
const ctx = { players: 3, others: (authors) => players.filter((p) => !authors.includes(p.id)).length }

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
  const base = { players, round: 1, questionIndex: 0, pickerId: 'b', question: { category: 'Animals', prompt: 'A ____ can sleep for 3 years.' } }
  for (const phase of ['INTRO', 'ROUND_TITLE', 'FINAL_TITLE', 'CATEGORY_PICK', 'LIE_ENTRY', 'PICK_TRUTH', 'SCOREBOARD']) {
    const line = phaseLine({ ...base, phase })
    assert.ok(line.length, phase)
    assert.ok(allPrepared(line), `${phase}: ${line}`)
  }
  assert.match(phaseLine({ ...base, phase: 'CATEGORY_PICK' }).join(' '), /Ben/)
  assert.match(phaseLine({ ...base, phase: 'CATEGORY_PICK', pickerId: 'c' }).join(' '), /Lowest score.*Cat/)
  assert.equal(questionLine({ ...base, phase: 'QUESTION' }), 'Animals. A ____ can sleep for 3 years.')
  assert.match(phaseLine({ ...base, phase: 'ROUND_TITLE', round: 2 })[0], /double/i)
  assert.match(phaseLine({ ...base, phase: 'SCOREBOARD' }).join(' '), /Ana/)
  assert.ok(phaseLine({ ...base, players: [], phase: 'LOBBY' }).length)
  assert.deepEqual(phaseLine({ ...base, phase: 'REVEAL' }), [])
})

test('reveal lines react to what happened', () => {
  const lie = (pickers, extra = {}) => revealLines({ kind: 'lie', text: 'x', authors: ['a'], pickers, ...extra }, byId, false, ctx)
  assert.deepEqual(lie(['b']).verdict, ['Gotcha, Ben!', 'Nice lie, Ana!'])
  assert.match(lie(['b', 'c']).verdict[0], /Everyone|whole room/, 'fooled everyone who could be fooled')
  assert.match(lie(['b'], { bought: ['a'] }).verdict[0], /bought/i)
  assert.match(revealLines({ kind: 'lie', text: 'x', authors: ['a', 'b'], pickers: ['c'] }, byId, false, ctx).verdict[0], /same lie/)
  assert.match(revealLines({ kind: 'decoy', text: 'y', authors: [], pickers: ['b'] }, byId, false, ctx).verdict[0], /house lie/i)

  const truth = revealLines({ kind: 'truth', text: 'snail', authors: [], pickers: ['a'] }, byId, false, ctx)
  assert.deepEqual(truth.verdict, ['snail!', 'Well done, Ana!'])
  const detected = revealLines({ kind: 'truth', text: 'snail', authors: [], pickers: ['a', 'b'], detected: ['b'] }, byId, false, ctx)
  assert.match(detected.verdict.join(' '), /Truth Detector/)
  const nobody = revealLines({ kind: 'truth', text: 'snail', authors: [], pickers: [] }, byId, true, ctx)
  assert.match(nobody.verdict.join(' '), /snail/)

  // Same step, same line: prepared lines must match what's said later.
  assert.deepEqual(lie(['b', 'c']), lie(['b', 'c']))
  for (const r of [lie(['b']), lie(['b', 'c']), truth, detected, nobody]) {
    assert.ok(allPrepared([...r.start, ...r.verdict], 'snail'), JSON.stringify(r))
  }
})

test('winner, award and Truth Detector lines', () => {
  assert.equal(winnerLines([players[0]]).verdict[0], 'Ana!')
  assert.match(winnerLines(players.slice(0, 2)).start[0], /tie/i)
  const award = awardLine({ key: 'biggestLiar', title: 'Biggest Liar', playerIds: ['a'], stat: 'Fooled 3 players' }, byId)
  assert.deepEqual(award.slice(0, 2), ['Biggest Liar!', 'Ana!'])
  assert.ok(allPrepared([...award, ...winnerLines([players[0]]).start, ...lifelineLine('Ben')]))
})
