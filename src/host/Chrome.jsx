// The TV's newspaper frame: a masthead across the top of every screen and a
// BREAKING ticker along the bottom with live gossip about the game.

import React from 'react'
import { fmt } from '../components/shared.jsx'

const gamePlayers = (pub) => pub.players.filter((p) => !p.isAudience)

function edition(pub) {
  switch (pub.phase) {
    case 'LOBBY': return 'BLACK HISTORY MONTH 2026'
    case 'INTRO': return 'HERE WE GO'
    case 'FINAL_TITLE': return 'THE FINAL ROUND'
    case 'WINNER':
    case 'AWARDS': return 'FINAL RESULTS'
    default:
      if (pub.round === 3) return 'THE FINAL ROUND · TRIPLE POINTS'
      return `ROUND ${pub.round} · QUESTION ${pub.questionIndex + 1} OF ${pub.questionsInRound}`
  }
}

export function Masthead({ pub, code }) {
  return (
    <header className="masthead">
      <span className="masthead-side">{edition(pub)}</span>
      <span className="masthead-title">Truth Be Told</span>
      <span className="masthead-side right">ROOM {code}</span>
    </header>
  )
}

// What the ticker says right now.
export function tickerItems(pub, code) {
  const players = gamePlayers(pub)
  if (pub.phase === 'LOBBY') {
    return [
      players.length ? `${players.length} player${players.length === 1 ? '' : 's'} in the room` : 'The room is empty. Grab your phones!',
      `Join with room code ${code}`,
      'Snap a selfie when you join',
      'Every question is a true story from Black history',
      'Music: Kevin MacLeod (incompetech.com), CC BY 4.0',
    ]
  }
  const items = []
  const scores = players.map((p) => p.score)
  const top = scores.length ? Math.max(...scores) : 0
  const bottom = scores.length ? Math.min(...scores) : 0
  const leaders = players.filter((p) => p.score === top)
  if (top > 0) {
    items.push(leaders.length === 1 ? `${leaders[0].name} leads with ${fmt(top)} points` : `${leaders.map((p) => p.name).join(' and ')} tied at the top`)
  } else {
    items.push('Nobody has scored yet. Sources say it is anyone\'s game.')
  }
  if (players.length >= 3 && bottom < top) {
    const last = players.filter((p) => p.score === bottom)
    items.push(`${last.map((p) => p.name).join(' and ')} ${last.length === 1 ? 'is' : 'are'} bottom of the league`)
  }
  if (pub.phase === 'LIE_ENTRY') items.push('Players are writing their fakes')
  if (pub.phase === 'PICK_TRUTH') items.push('One of these stories is real. Which one?')
  if (pub.round === 2) items.push('Round two: every point is doubled')
  if (pub.round === 3) items.push('The final round: triple points, anyone can win')
  items.push('Your first "Lie for me" is free. After that, lies cost points.')
  items.push('Truth Detector: once per game, on your phone')
  return items
}

export function Ticker({ pub, code }) {
  const items = tickerItems(pub, code)
  const row = items.flatMap((t, i) => [<span key={`t${i}`}>{t}</span>, <span key={`d${i}`} className="ticker-dot">●</span>])
  return (
    <footer className="ticker" aria-label="Game ticker">
      <span className="ticker-label">{pub.phase === 'LOBBY' ? 'WELCOME' : 'LIVE'}</span>
      <span className="ticker-window">
        <span className="ticker-run" style={{ animationDuration: `${Math.max(18, items.length * 7)}s` }}>
          {row}
          <span aria-hidden="true" className="ticker-copy">{row}</span>
        </span>
      </span>
    </footer>
  )
}
