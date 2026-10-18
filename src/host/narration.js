// What the host says. Pure functions of the public game state, so the lines
// are easy to test and tweak. The host has a personality: cheeky, quick, and
// it reacts to what actually happened (who fooled whom, sweeps, duplicate
// lies, bought lies, last place...).
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
  welcome: ['Welcome to Ink and Lies! Grab your phones and join with the room code on screen.'],
  intro: ['Welcome to Ink and Lies! Write a lie that sounds true, spot the real story, and fool your friends for points.'],
  roundOne: ['Round one! Let the lying begin.', "Round one! Let's see who's a natural liar."],
  randomCategory: ['Picking a random category.'],
  lowestPicks: ['Lowest score picks.'],
  lieEntry: ['Now write a believable lie!', 'Time to lie. Make it convincing!', 'Get typing, you beautiful liars.', 'Make it boring. Boring lies win.'],
  pickTruth: ["Pens down! Now, which one's the truth?", 'One of these is real. Which one?', 'Somewhere in there is the truth. Good luck.'],
  tenSeconds: ['Ten seconds left!', 'Ten seconds. Tick tock!'],
  gotchaTwo: ['You both fell for it!'],
  gotchaMany: ['So many of you fell for that!', 'What a pile-up!'],
  everyoneFooled: ['Everyone fell for that one! Diabolical.', 'The whole room got fooled!'],
  bought: ['A bought lie, and it worked! Money well spent.'],
  dupes: ['Two of you wrote the same lie! Great minds lie alike.'],
  house: ['That one was our house lie! Gotcha.', 'A house lie! I wrote that one myself.'],
  truthIntro: ['And the truth is…', 'The real answer is…'],
  allFound: ['And you all knew it. Too easy!', 'Everyone found it!'],
  detector: ['The Truth Detector strikes again!'],
  nobodyFound: ['Nobody found the truth!', 'Not one of you!'],
  itWas: ['It was…'],
  noPoints: ['Nobody has any points yet!'],
  tied: ["It's neck and neck at the top!"],
  ouch: ['Ouch. Somebody went backwards.'],
  roundTwo: ['Round two! Everything is worth double.', 'Round two! Double points. Time to get sneaky.'],
  final: ['The Final Edition! One question, triple points. Anyone can win this.', 'The Final Edition! Triple points. This is where legends lie.'],
  winnerIs: ['And the winner is…', 'Your champion liar is…'],
  tie: ["It's a tie!"],
  neverTrust: ['Never trust them again.', 'What a liar.'],
  awards: ['Biggest Liar!', 'Truth Seeker!', 'Crowd Favourite!', 'Most Gullible!'],
  awardQuips: ['Never lend them money.', 'Impossible to fool.', 'The people have spoken.', 'Bless.'],
  thanks: ['Thanks for playing Ink and Lies! Play again, or head back to the lobby.'],
}
export const THANKS_LINE = L.thanks[0]
export const FIXED_LINES = Object.values(L).flat()

// The few lines said with each player's name.
const P = {
  pickCategory: (n) => `${n}, pick a category!`,
  leads: (n) => `${n} is in the lead!`,
  gotcha: (n) => `Gotcha, ${n}!`,
  niceLie: (n) => `Nice lie, ${n}!`,
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
    case 'LIE_ENTRY':
      return [pick(L.lieEntry)]
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
export const questionLine = (pub) => `${pub.question.category === 'Final Fakeout' ? 'The Final Edition' : pub.question.category}. ${pub.question.prompt}`
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

// Two beats per reveal step: `start` when the card appears, `verdict` when
// it's stamped. `ctx`: { players: how many could pick, others(authors): how
// many could have been fooled by a lie }.
export function revealLines(step, players, nobodyFound, ctx = {}) {
  const pick = seeded(`${step.kind}|${step.text}|${step.pickers.join()}`)
  const name = (id) => players[id]?.name
  const count = step.pickers.length
  if (step.kind === 'truth') {
    if (nobodyFound) return { start: [], verdict: [pick(L.nobodyFound), L.itWas[0], answerLine(step.text)] }
    const everyone = ctx.players && count >= ctx.players
    const detected = (step.detected || []).filter((id) => step.pickers.includes(id))
    const reaction = everyone
      ? [pick(L.allFound)]
      : detected.length
        ? [L.detector[0]]
        : count === 1 && name(step.pickers[0])
          ? [P.wellDone(name(step.pickers[0]))]
          : []
    return { start: [pick(L.truthIntro)], verdict: [answerLine(step.text), ...reaction] }
  }
  if (step.kind === 'decoy') return { start: [], verdict: [pick(L.house)] }

  const author = step.authors.length === 1 ? name(step.authors[0]) : null
  const credit = author ? [P.niceLie(author)] : []
  if (step.authors.length > 1) return { start: [], verdict: [L.dupes[0]] }
  if (!count) return { start: [], verdict: credit }
  if (step.bought?.length) return { start: [], verdict: [L.bought[0]] }
  const possible = ctx.others ? ctx.others(step.authors) : 0
  if (possible > 1 && count >= possible) return { start: [], verdict: [pick(L.everyoneFooled), ...credit] }
  if (count >= 3) return { start: [], verdict: [pick(L.gotchaMany), ...credit] }
  if (count === 2) return { start: [], verdict: [L.gotchaTwo[0], ...credit] }
  const fooled = name(step.pickers[0])
  return { start: [], verdict: [...(fooled ? [P.gotcha(fooled)] : []), ...credit] }
}

export function winnerLines(winners) {
  if (winners.length > 1) return { start: [L.tie[0]], verdict: winners.map((w) => P.name(w.name)) }
  const pick = seeded(winners[0]?.name)
  return { start: [pick(L.winnerIs)], verdict: [P.name(winners[0].name), pick(L.neverTrust)] }
}

const AWARD_KEYS = ['biggestLiar', 'truthSeeker', 'crowdFavourite', 'mostGullible']

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
