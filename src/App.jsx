import React, { Suspense, lazy, useEffect, useState } from 'react'
import { BACKEND } from './lib/transport/index.js'
import { setLobbyMusic } from './lib/lobbyMusic.js'
import { MuteButton, Wordmark } from './components/shared.jsx'

const HostApp = lazy(() => import('./host/HostApp.jsx'))
const PhoneApp = lazy(() => import('./phone/PhoneApp.jsx'))

function parseHash() {
  const [path, query = ''] = window.location.hash.replace(/^#/, '').split('?')
  return { path: path || '/', params: new URLSearchParams(query) }
}

export function navigate(path) {
  window.location.hash = path
}

export default function App() {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const onHash = () => setRoute(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  let page
  if (route.path === '/host') page = <HostApp />
  else if (route.path === '/play') page = <PhoneApp initialCode={route.params.get('code') || ''} />
  else page = <Landing />

  return <Suspense fallback={<div className="center-fill"><div className="spinner" /></div>}>{page}</Suspense>
}

function Landing() {
  const [code, setCode] = useState('')
  // The lobby song starts as soon as the game opens (after the first tap).
  useEffect(() => {
    setLobbyMusic(true)
  }, [])
  return (
    <main className="landing">
      <MuteButton className="floating" />
      <Wordmark />
      <p className="tagline">Lie. Spot. Win.</p>
      <form
        className="landing-join"
        onSubmit={(e) => {
          e.preventDefault()
          navigate(`/play?code=${encodeURIComponent(code.trim().toUpperCase())}`)
        }}
      >
        <label htmlFor="landing-code">Playing on a phone? Enter the room code</label>
        <div className="row">
          <input
            id="landing-code"
            className="code-input"
            value={code}
            maxLength={4}
            autoCapitalize="characters"
            autoComplete="off"
            placeholder="ABCD"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button className="btn btn-pink" type="submit">Join</button>
        </div>
      </form>
      <button className="btn btn-ghost" onClick={() => navigate('/host')}>
        📺 Host a game on this screen
      </button>
      {BACKEND === 'local' && (
        <p className="demo-note">
          Local demo mode: open the host in one tab and each player in its own tab of this browser.
          Add Supabase keys to <code>.env</code> to play across devices.
        </p>
      )}
      <p className="music-credit">Music: Kevin MacLeod (incompetech.com), CC BY 4.0</p>
    </main>
  )
}
