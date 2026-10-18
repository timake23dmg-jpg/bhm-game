// What the host's reveal lines need to know about the room: how many players
// could pick, and how many could have been fooled by a given lie.
export function revealContext(pub) {
  const players = pub.players.filter((p) => !p.isAudience)
  return { players: players.length, others: (authors) => players.filter((p) => !authors.includes(p.id)).length }
}
