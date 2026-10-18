import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, levenshtein, matchesTruth, validateLie } from '../src/lib/rules.js'

const flamingo = { answer: 'flamboyance', alternateSpellings: ['flamboyancy'], suggestedLies: [] }

test('normalize strips case, punctuation, articles and extra spaces', () => {
  assert.equal(normalize('  The   Flamboyance!! '), 'flamboyance')
  assert.equal(normalize('Dr. Seuss'), 'dr seuss')
  assert.equal(normalize('An owl'), 'owl')
  assert.equal(normalize('theatre'), 'theatre')
})

test('levenshtein', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3)
  assert.equal(levenshtein('', 'abc'), 3)
  assert.equal(levenshtein('same', 'same'), 0)
})

test('truth matching: exact, alternates, one typo for 5+ char answers', () => {
  assert.ok(matchesTruth('A Flamboyance', flamingo))
  assert.ok(matchesTruth('flamboyancy', flamingo))
  assert.ok(matchesTruth('flamboyence', flamingo))
  assert.ok(!matchesTruth('pinkery', flamingo))
  const q = { answer: 'Q', alternateSpellings: [] }
  assert.ok(matchesTruth('q', q))
  assert.ok(!matchesTruth('x', q)) // short answers need an exact match
})

test('validateLie reasons', () => {
  assert.equal(validateLie('   ', flamingo), 'empty')
  assert.equal(validateLie('!!!', flamingo), 'empty')
  assert.equal(validateLie('x'.repeat(41), flamingo), 'tooLong')
  assert.equal(validateLie('the flamboyance', flamingo), 'isTruth')
  assert.equal(validateLie('shitstorm', flamingo), 'profanity')
  assert.equal(validateLie('shitstorm', flamingo, { profanityFilter: false }), null)
  assert.equal(validateLie('a pinkery', flamingo), null)
})
