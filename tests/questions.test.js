// Sanity checks for the question bank (src/data/questions.json).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { matchesTruth, normalize, validateLie, LIE_MAX } from '../src/lib/rules.js'

const bank = JSON.parse(readFileSync(new URL('../src/data/questions.json', import.meta.url), 'utf8'))
const regular = bank.filter((q) => !q.isFinal)

test('ids are unique and every question is well-formed', () => {
  assert.equal(new Set(bank.map((q) => q.id)).size, bank.length)
  for (const q of bank) {
    assert.match(q.prompt, /_{2,}/, `${q.id}: prompt needs a ______ blank`)
    assert.ok(q.answer.length <= LIE_MAX, `${q.id}: answer too long`)
    assert.ok(q.suggestedLies.length >= 4, `${q.id}: needs 4+ suggested lies`)
    assert.ok(q.category, `${q.id}: missing category`)
  }
})

test('no suggested lie counts as the truth, and lies are distinct', () => {
  for (const q of bank) {
    for (const lie of q.suggestedLies) {
      assert.ok(!matchesTruth(lie, q), `${q.id}: suggested lie "${lie}" would be rejected as the truth`)
      assert.equal(validateLie(lie, q), null, `${q.id}: suggested lie "${lie}" fails validation`)
    }
    assert.equal(new Set(q.suggestedLies.map(normalize)).size, q.suggestedLies.length, `${q.id}: duplicate lies`)
  }
})

test('enough variety for the category picker', () => {
  const categories = new Set(regular.map((q) => q.category))
  assert.ok(categories.size >= 3, 'category pick needs at least 3 categories')
  assert.ok(bank.some((q) => q.isFinal), 'needs Final Fakeout questions')
  assert.ok(!regular.some((q) => q.category === 'Final Fakeout'))
})
