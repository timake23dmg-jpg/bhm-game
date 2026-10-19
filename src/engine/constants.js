// Timings and scoring. Truth Be Told is a speed quiz: read the question, then
// tap the true answer out of four. Faster correct answers score more.

export const TIMERS = {
  INTRO: 8000,
  ROUND_TITLE: 3000,
  CATEGORY_PICK: 10000,
  QUESTION: 4000, // time to read the question before the answers appear
  LIE_ENTRY: 45000,
  LIE_ENTRY_FINAL: 60000,
  PICK_TRUTH: 15000,
  SCOREBOARD: 6000,
  FINAL_TITLE: 4000,
  WINNER: 8000,
  AWARD_CARD: 3000,
  WANTED_CARD: 8000, // the Biggest Liar's WANTED poster stays up longer (lie mode only)
  QUIZ_REVEAL: 7000, // answer counts, then the truth, then the fastest fingers
}

// How long each award card stays on screen, and all of them together.
export const awardDuration = (award) => (award?.key === 'biggestLiar' ? TIMERS.WANTED_CARD : TIMERS.AWARD_CARD)
export const awardsDuration = (awards) => (awards || []).reduce((t, a) => t + awardDuration(a), 0)

export const REVEAL_TIMING = { LEAD_IN: 600, LIE: 3500, PER_FOOL: 400, TRUTH: 4000, NOBODY: 3000, TAIL: 800 }

// Quiz scoring, index = round - 1 (round 3 is the Final). A correct answer is
// worth between `slowest` and `fastest` points, depending on how quickly it
// came in; a wrong answer costs `wrong`; no answer scores nothing.
export const QUIZ_SCORES = {
  fastest: [1000, 2000, 3000],
  slowest: [500, 1000, 1500],
  wrong: [-100, -200, -300],
}
export const OPTIONS_PER_QUESTION = 4 // the truth + 3 wrong answers
export const LETTERS = ['A', 'B', 'C', 'D'] // answer labels, the same on the TV and phones
// Points for a correct answer given `ms` after the answers appeared.
export function quizPoints(round, ms, windowMs = TIMERS.PICK_TRUTH) {
  const m = Math.min(2, Math.max(0, round - 1))
  const late = Math.min(1, Math.max(0, ms / windowMs))
  return Math.round(QUIZ_SCORES.fastest[m] - (QUIZ_SCORES.fastest[m] - QUIZ_SCORES.slowest[m]) * late)
}

// Lie-mode scoring (Option A, kept on the option-a-lies branch).
export const SCORES = {
  truth: [1000, 2000, 3000],
  fool: [500, 1000, 1500],
  decoy: [-250, -500, -750],
}

export const MIN_PLAYERS = 2
export const MAX_PLAYERS = 70 // Black History Month build: room for 70 players
// Cap on answer cards on the TV and phones. With 70 lies, the full set would
// be unreadable and the reveal would take far too long, so each question shows
// the truth plus a random selection of lies (lies bought with "Lie for me" always show).
export const MAX_OPTIONS = 12
export const SHORT_GAME_MIN_PLAYERS = 5
export const MIN_OPTIONS = 4 // truth + at least 3 lies (padded with house decoys)

export function questionsInRound(round, shortGame) {
  if (round === 3) return 1
  return shortGame ? 3 : 5
}

// Prizes beyond the overall winner. `best` picks the winning value from the
// players' stats (higher is better unless `lowest`); `min` is the least a
// player needs to qualify.
export const AWARDS = [
  {
    key: 'fastestFingers', title: 'Fastest Fingers', stat: 'avgCorrectMs', lowest: true, minCorrect: 3,
    label: (ms) => `Average ${(ms / 1000).toFixed(1)} seconds per correct answer`,
  },
  { key: 'hotStreak', title: 'Hot Streak', stat: 'bestStreak', min: 3, label: (n) => `${n} correct answers in a row` },
  { key: 'truthSeeker', title: 'Truth Seeker', stat: 'truths', min: 1, label: (n) => `Found the truth ${n} time${n === 1 ? '' : 's'}` },
]
