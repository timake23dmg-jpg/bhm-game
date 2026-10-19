// What the host says. Pure functions of the public game state, so the lines
// are easy to test and tweak. The host has a personality: warm, quick, and
// it reacts to what actually happened (who was fastest, clean sweeps, nobody
// knowing, last place...).
//
// Everything the host says is a list of short segments, and almost every
// segment is either a FIXED line or one of a few PLAYER lines per name. The
// natural AI voice is too slow on many computers to speak on the fly, so
// those are generated ahead (fixed lines when the TV opens, player lines when
// someone joins) and kept in the browser. The only on-the-fly segments are
// the question (read only if it's ready in time) and the answer word.

const pick = (lines) => lines[Math.floor(Math.random() * lines.length)]

// Same choice every time for the same seed: reveal lines are worked out
// twice (to prepare them, then to say them) and must match.
function seeded(seed) {
  let h = 2166136261
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (lines) => lines[(h >>> 0) % lines.length]
}

// ------------------------------------------------------------ fixed lines
// Ordered roughly by when they're first needed, so the earliest are ready first.

const L = {
  welcome: ['Welcome to Truth Be Told! Grab your phones and join with the room code on screen.'],
  intro: ['Welcome to Truth Be Told! Every question is a true story from Black history. Tap the right answer, and the faster you are, the more you score.'],
  roundOne: ["Round one! Let's see what you know.", 'Round one! Fingers ready.'],
  randomCategory: ['Picking a random category.'],
  lowestPicks: ['Lowest score picks.'],
  pickTruth: ['Which one is true? Quick!', 'Four answers. One truth. Go!', 'Find the true story. The clock is ticking.'],
  tenSeconds: ['Ten seconds left!', 'Ten seconds. Tick tock!'],
  truthIntro: ['And the truth is…', 'The real answer is…'],
  allFound: ['And you all knew it. Brilliant!', 'Everyone got it!'],
  detector: ['The Truth Detector strikes again!'],
  nobodyFound: ['Nobody got that one!', 'Not one of you!'],
  itWas: ['It was…'],
  noPoints: ['Nobody has any points yet!'],
  tied: ["It's neck and neck at the top!"],
  ouch: ['Ouch. Wrong answers cost points!'],
  roundTwo: ['Round two! Everything is worth double.', 'Round two! Double points. Stay sharp.'],
  final: ['The Final Round! One question, triple points. Anyone can win this.', 'The Final Round! Triple points. This is where champions are made.'],
  winnerIs: ['And the winner is…', 'Your champion is…'],
  tie: ["It's a tie!"],
  champion: ['What a performance.', 'Take a bow.'],
  awards: ['Fastest Fingers!', 'Hot Streak!', 'Truth Seeker!'],
  awardQuips: ['Lightning quick.', 'Unstoppable.', 'Knowledge is power.'],
  thanks: ['Thanks for playing Truth Be Told! Play again, or head back to the lobby.'],
}
export const THANKS_LINE = L.thanks[0]
export const FIXED_LINES = Object.values(L).flat()

// The few lines said with each player's name.
const P = {
  pickCategory: (n) => `${n}, pick a category!`,
  leads: (n) => `${n} is in the lead!`,
  fastest: (n) => `${n} was the fastest!`,
  wellDone: (n) => `Well done, ${n}!`,
  name: (n) => `${n}!`,
  detector: (n) => `${n} used the Truth Detector!`,
}
export const playerLines = (name) => Object.values(P).map((f) => f(name))

// ------------------------------------------------------------- the game

export function listNames(names) {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const nameOf = (pub, id) => pub.players.find((p) => p.id === id)?.name
const gamePlayers = (pub) => pub.players.filter((p) => !p.isAudience)

// Segments for the start of a phase, or [] for phases narrated by their
// screen (REVEAL, WINNER, AWARDS speak in step with their animations).
export function phaseLine(pub) {
  switch (pub.phase) {
    case 'LOBBY':
      return gamePlayers(pub).length === 0 ? L.welcome : []
    case 'INTRO':
      return [pick(L.intro)]
    case 'ROUND_TITLE':
      return [pick(pub.round === 2 ? L.roundTwo : L.roundOne)]
    case 'FINAL_TITLE':
      return [pick(L.final)]
    case 'CATEGORY_PICK':
      return categoryPickLine(pub)
    case 'PICK_TRUTH':
      return [pick(L.pickTruth)]
    case 'SCOREBOARD':
      return scoreboardLine(pub)
    default:
      return []
  }
}

function categoryPickLine(pub) {
  const picker = nameOf(pub, pub.pickerId)
  if (!picker) return L.randomCategory
  const players = gamePlayers(pub)
  const me = players.find((p) => p.id === pub.pickerId)
  const lowest = players.length > 2 && players.some((p) => p.score > 0) && players.every((p) => p.score >= (me?.score ?? 0))
  return lowest ? [L.lowestPicks[0], P.pickCategory(picker)] : [P.pickCategory(picker)]
}

// The question, read aloud only if the voice gets it ready in time.
export const questionLine = (pub) => `${pub.question.category === 'Final Fakeout' ? 'The Final Round' : pub.question.category}. ${pub.question.prompt}`
// The answer word, prepared as soon as the question is drawn.
export const answerLine = (answer) => `${answer}!`
export const tenSecondsLine = () => [pick(L.tenSeconds)]

export function scoreboardLine(pub) {
  const players = gamePlayers(pub)
  if (!players.length) return []
  const top = Math.max(...players.map((p) => p.score))
  if (top <= 0) return L.noPoints
  const leaders = players.filter((p) => p.score === top)
  const lines = [leaders.length > 1 ? L.tied[0] : P.leads(leaders[0].name)]
  const deltas = pub.scoreboard?.deltas || {}
  if (players.some((p) => (deltas[p.id] ?? 0) < 0) && Math.random() < 0.5) lines.push(L.ouch[0])
  return lines
}

// Two beats for the reveal: `start` as the answer counts come up, `verdict`
// when the truth is shown. `reveal` is the engine's public reveal.
export function revealLines(reveal, players) {
  const name = (id) => players[id]?.name
  const total = Object.values(players).filter((p) => !p.isAudience).length
  if (reveal.nobodyFound) return { start: [], verdict: [L.nobodyFound[0], L.itWas[0], answerLine(reveal.truthText)] }
  const pick = seeded(`${reveal.truthText}|${reveal.correct.join()}`)
  const fastest = name(reveal.correct[0])
  const reaction = total > 1 && reveal.correct.length >= total
    ? [pick(L.allFound)]
    : reveal.detected?.includes(reveal.correct[0])
      ? [L.detector[0]]
      : reveal.correct.length === 1 && fastest
        ? [P.wellDone(fastest)]
        : fastest
          ? [P.fastest(fastest)]
          : []
  return { start: [pick(L.truthIntro)], verdict: [answerLine(reveal.truthText), ...reaction] }
}

export function winnerLines(winners) {
  if (winners.length > 1) return { start: [L.tie[0]], verdict: winners.map((w) => P.name(w.name)) }
  const pick = seeded(winners[0]?.name)
  return { start: [pick(L.winnerIs)], verdict: [P.name(winners[0].name), pick(L.champion)] }
}

const AWARD_KEYS = ['fastestFingers', 'hotStreak', 'truthSeeker']

export function awardLine(award, players) {
  const i = AWARD_KEYS.indexOf(award.key)
  const names = award.playerIds.map((id) => players[id]?.name).filter(Boolean)
  return [
    i >= 0 ? L.awards[i] : `${award.title}!`,
    ...names.map(P.name),
    ...(i >= 0 ? [L.awardQuips[i]] : []),
  ]
}

// When a player uses their once-per-game Truth Detector.
export const lifelineLine = (name) => [P.detector(name)]
