// Lie validation rules shared by the local demo server and the UI.
// supabase/schema.sql mirrors these in SQL (fakeout_normalize, fakeout_is_truth, ...).

export const LIE_MAX = 40

// lowercase, strip punctuation, collapse spaces, trim, drop a leading article
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the) /, '')
}

export function levenshtein(a, b) {
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

export function matchesTruth(text, question) {
  const n = normalize(text)
  const truths = [question.answer, ...(question.alternateSpellings || [])].map(normalize)
  return truths.some((t) => n === t || (t.length >= 5 && levenshtein(n, t) <= 1))
}

const PROFANITY = new Set([
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'bastard',
  'asshole', 'arsehole', 'dick', 'dickhead', 'cock', 'pussy', 'whore', 'slut', 'twat', 'wanker',
  'prick', 'fag', 'faggot', 'nigger', 'nigga', 'retard', 'spastic',
])

export function isProfane(text) {
  return normalize(text)
    .split(' ')
    .some((w) => PROFANITY.has(w) || w.startsWith('fuck') || w.startsWith('shit'))
}

// Returns a lieRejected reason ('empty' | 'tooLong' | 'isTruth' | 'profanity') or null if OK.
export function validateLie(text, question, { profanityFilter = true } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean || !normalize(clean)) return 'empty'
  if (clean.length > LIE_MAX) return 'tooLong'
  if (matchesTruth(clean, question)) return 'isTruth'
  if (profanityFilter && isProfane(clean)) return 'profanity'
  return null
}

// "Lie for me": each player's first one per game is free, then each one costs
// more (100, 200, 300, 400, then 500 points). `bought` = how many this player
// has already had this game. Mirrored in SQL by fakeout_lie_price().
export const LIE_PRICE_STEP = 100
export const LIE_PRICE_MAX = 500
export const liePrice = (bought) => (bought <= 0 ? 0 : Math.min(LIE_PRICE_MAX, LIE_PRICE_STEP * bought))

// Total cost of the next `count` lies for a player who has already had `bought`.
export function lieCost(bought, count) {
  let total = 0
  for (let i = 0; i < count; i++) total += liePrice(bought + i)
  return total
}

// Mugshot selfies: small black-and-white JPEGs made on the phone, stored on
// the player's row for the room's lifetime. Mirrored in SQL (set_photo).
export const PHOTO_PREFIX = 'data:image/jpeg;base64,'
export const PHOTO_MAX = 60000 // characters of data URL (about 44 KB of image)
export const isValidPhoto = (p) => typeof p === 'string' && p.startsWith(PHOTO_PREFIX) && p.length <= PHOTO_MAX

export const REJECT_MESSAGES = {
  isTruth: "That's actually the truth! Try another lie.",
  tooLong: `Keep it under ${LIE_MAX} characters.`,
  profanity: 'Keep it clean! Try another lie.',
  empty: 'Type a lie first.',
}
