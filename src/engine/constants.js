// Timings and scoring from the Fakeout spec.

export const TIMERS = {
  INTRO: 8000,
  ROUND_TITLE: 3000,
  CATEGORY_PICK: 15000,
  QUESTION: 5000,
  LIE_ENTRY: 45000,
  LIE_ENTRY_FINAL: 60000,
  PICK_TRUTH: 20000,
  SCOREBOARD: 6000,
  FINAL_TITLE: 4000,
  WINNER: 8000,
  AWARD_CARD: 3000,
  WANTED_CARD: 8000, // the Biggest Liar's WANTED poster stays up longer
}

// How long each award card stays on screen, and all of them together.
export const awardDuration = (award) => (award?.key === 'biggestLiar' ? TIMERS.WANTED_CARD : TIMERS.AWARD_CARD)
export const awardsDuration = (awards) => (awards || []).reduce((t, a) => t + awardDuration(a), 0)

export const REVEAL_TIMING = { LEAD_IN: 600, LIE: 3500, PER_FOOL: 400, TRUTH: 4000, NOBODY: 3000, TAIL: 800 }

// index = round - 1 (round 3 is the Final)
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
  return shortGame ? 2 : 3
}

export const AWARDS = [
  { key: 'biggestLiar', title: 'Biggest Liar', stat: 'fooled', label: (n) => `Fooled ${n} player${n === 1 ? '' : 's'}` },
  { key: 'truthSeeker', title: 'Truth Seeker', stat: 'truths', label: (n) => `Found the truth ${n} time${n === 1 ? '' : 's'}` },
  { key: 'crowdFavourite', title: 'Crowd Favourite', stat: 'likes', label: (n) => `${n} like${n === 1 ? '' : 's'}` },
  { key: 'mostGullible', title: 'Most Gullible', stat: 'gotFooled', label: (n) => `Fooled ${n} time${n === 1 ? '' : 's'}` },
]
