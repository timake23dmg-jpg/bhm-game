# Ink & Lies (v2 of Fakeout)

A bluffing trivia party game (see `Fakeout — Game Spec.pdf`). One shared TV
screen hosts; everyone plays on their phone. Players write believable lies to
obscure facts, then try to spot the truth among everyone's lies.

Built with React + Vite, and Supabase for multiplayer, following the pattern in
`MULTIPLAYER-ARCHITECTURE.md`.

## Quick start (local demo, no backend)

```sh
npm install
npm run dev
```

Open <http://localhost:5173/#/host> and click **Create a room**. Then open
each player as a new tab **in the same browser** at the join link shown in the
lobby. Demo mode runs the whole game inside that browser; the host tab acts
as the server.

## Real multi-device play (Supabase)

Fakeout lives in its own `bhm` Postgres schema, so it can share an
existing Supabase project (e.g. Song Wars) without touching that app's tables.

1. In the project, make sure **Authentication → Sign In / Providers →
   Anonymous Sign-Ins** is enabled (Song Wars already needs it).
2. In the SQL editor, run `supabase/schema.sql`, then `supabase/questions.sql`.
3. **Project Settings → Data API → Exposed schemas:** add `bhm` and save.
   Without this, the app gets "Invalid schema: bhm" errors.
4. Copy `.env.example` to `.env` and fill in your project URL and anon key.
5. `npm run dev`. Open the host on the TV/laptop and scan the QR code with
   phones. Phones on the same Wi-Fi reach the dev server via its LAN address
   (Vite prints it). Open the host via that LAN address too, so the QR code
   points somewhere phones can reach.
6. `npm run smoke` plays a full game against your live database: one host and
   three anonymous players, real RPCs, RLS and realtime.

## Deploying

**GitHub Pages (current live site):** `npm run deploy:pages` builds the game
and publishes it to the `gh-pages` branch. It's served at
https://timake23dmg-jpg.github.io/fakeout/ (TV: `/#/host`). The build uses your
local `.env`, which is never committed.

**Anywhere else:** `npm run build` and upload `dist/` to any static host. The
build uses relative paths, so it works at a domain root or a sub-path.

## How it works

- **The host TV tab is the authority.** `src/engine/hostEngine.js` runs the
  spec's state machine (INTRO → … → AWARDS). It keeps the full secret state
  and publishes a filtered public state through `host_set_state`.
  Deadlines are stamped with the database clock, so every screen counts down
  together.
- **Phones only render.** They derive their screen from the published state
  plus their own rows. They act through guarded RPCs (`submit_lie`,
  `lie_for_me`, `submit_pick`) and insert-only `likes`/`commands` rows. VIP
  start/skip/play-again and category picks are commands the host validates.
- **Secrets stay secret.** RLS makes the question bank and `game_secrets`
  unreadable to players. Each lie or pick row is readable only by its author
  and the host. The truth, and which option belongs to whom, reach phones
  only at REVEAL.
- **Resilience.** If the host reloads, it resumes from `game_secrets`. A
  phone that reloads rejoins its own player row. Disconnected players keep
  their score and aren't waited for (Realtime presence).

## Content

The questions live in `src/data/questions.json`. After editing it, run
`npm run gen:questions` to regenerate `supabase/questions.sql`, then re-run
that file in Supabase. As the spec says, spot-check each fact before launch.

## Sound and voice

- **Music:** recorded tracks in `public/music/`, one per part of the game (see
  `TRACKS` in `src/lib/audio.js`), with procedural stand-ins while they load.
  Music by Kevin MacLeod (incompetech.com), licensed under
  [Creative Commons: By Attribution 4.0](https://creativecommons.org/licenses/by/4.0/);
  the credit is shown on the start screens and lobby.
- **Host voice:** the Kokoro AI voice, running in the browser. It's too slow on
  many computers to speak on the fly, so the host's lines are generated ahead
  (`src/host/narration.js`) and saved in the browser; questions are only read
  aloud on computers fast enough to voice them in time.

## Tests

`npm test` runs the lie-validation rules and several full simulated games
through the engine: scoring, decoy padding, duplicate lies, early advance,
disconnects and short games.

## Notes and deviations from the spec

- **Sounds and music are synthesized** with Web Audio (`src/lib/audio.js`).
  There are no audio files, so Howler.js isn't used. Browsers need one click
  on the host before sound can play.
- **Lobby/join is built in**, since the spec assumed an existing one.
- **Questions reachable by hosts:** anyone who hosts a room can see the
  answers for that room. That's inherent to a client-side host with no
  custom server.

## Running a 70-player event (Black History Month build, `black-history-70` branch)

This branch swaps in a Black History question bank (44 questions in 14
categories, including Black British History, plus 3 Final questions) and lifts
the player cap from 8 to 70. With more than 8 players the TV switches to
"crowd mode": the newest 8 faces plus live counts, the top 8 on the scoreboard,
and up to 12 answer cards per question (the truth plus a random selection of
lies). Every phone still shows that player's own rank.

Before the event:

1. **Apply the database changes.** Run `supabase/schema.sql`, then
   `supabase/questions.sql`, in the Supabase SQL editor. The schema raises the
   room ceiling to 80 and the player cap to 70.
2. **Raise the anonymous sign-in rate limit.** Supabase's default is 30
   anonymous sign-ins per hour per IP address, and 70 phones on the venue Wi-Fi
   share one IP. Change it in Authentication → Rate Limits.
3. **Check your Supabase plan's Realtime limits** (concurrent connections and
   messages per second), then load-test: `SMOKE_PLAYERS=70 npm run smoke`.
4. **Fact-check the questions** in `src/data/questions.json` against a reliable
   source.
5. **The QR code** on the TV lobby screen points to `#/play?code=XXXX` for that
   room. For a printed QR on tables, point it at `#/play` instead: phones then
   type the room code shown on the TV.
