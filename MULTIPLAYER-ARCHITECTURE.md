# Real-time multiplayer architecture — build plan

How Song Wars does live, multi-device multiplayer with a room code, and how
to reuse the same system for a different game. This is a reference document,
not something wired into Song Wars itself — nothing here changes how Song
Wars runs.

The short version: **there is no custom backend server.** The frontend talks
directly to a Supabase project (Postgres + Auth + Realtime) using the
`supabase-js` client. All of "how players connect," "who can see what," and
"how everyone's screen stays in sync" is built out of four things:

1. Anonymous auth — every browser tab gets its own identity, for free.
2. Postgres tables + Row Level Security (RLS) — the database itself decides
   who can read/write which rows.
3. Supabase Realtime — a live feed of row-change events, filtered to your
   room, that every client subscribes to.
4. A few conventions for *how* you write to shared rows so that multiple
   devices racing to write the same thing never corrupts state and never
   needs a lock.

---

## 1. Player identity: anonymous auth

Every browser tab signs in anonymously on load, before touching any table:

```js
// lib/supabase.js
export const supabase = createClient(url, anonKey)

let readyPromise = null
export function ensureSignedIn() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const { data } = await supabase.auth.getSession()
      if (data.session) return data.session.user
      const { data: signInData, error } = await supabase.auth.signInAnonymously()
      if (error) throw error
      return signInData.user
    })()
  }
  return readyPromise
}
```

This gives each tab its own `auth.uid()` — a real, stable UUID — without any
signup flow. That UUID is what Row Level Security keys off of everywhere
else. It's *not* the same as a "player row" — it's the device/session
identity; a player row is a game-specific row that references it.

Enable this once in the Supabase dashboard: **Authentication → Sign In /
Providers → Anonymous Sign-Ins → Enable.**

---

## 2. Database schema: rooms and players

Two tables are the foundation of every room-code game:

```sql
create extension if not exists pgcrypto;

-- One row per room. `code` is the short human-typed join code.
create table games (
  code text primary key,
  status text not null default 'lobby',
  -- ...whatever shared state your game needs goes here (current round,
  -- shared timestamps, host-picked settings, etc. — see section 6).
  created_at timestamptz not null default now()
);

-- Any number of players per room.
create table players (
  id uuid primary key default gen_random_uuid(),
  game_code text not null references games(code) on delete cascade,
  user_id uuid not null default auth.uid(),  -- ties this row to a browser tab's auth session
  slot int not null check (slot >= 0),
  name text not null,
  created_at timestamptz not null default now(),
  unique (game_code, slot)
);
```

`user_id` is the load-bearing column: it's what lets RLS answer "is this
request from a member of this room, and is this THEIR row" — not the shared
anon API key, which is identical for every visitor.

A generous, purely technical ceiling on room size (not your actual game's
party-size rule) is worth having as a trigger so a room can never grow
unbounded even under a race:

```sql
create or replace function enforce_max_players()
returns trigger as $$
declare v_max constant int := 16;
begin
  if (select count(*) from players where game_code = new.game_code) >= v_max then
    raise exception 'Room % is already full', new.game_code;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_enforce_max_players
  before insert on players
  for each row execute function enforce_max_players();
```

---

## 3. Row Level Security: the "my rows" pattern

Turn RLS on for every table:

```sql
alter table games enable row level security;
alter table players enable row level security;
```

**The trap to know about up front:** a policy on `players` that queries
`players` to check membership (e.g. "can this user see this row if they're
also a player in the same game") causes Postgres to report *"infinite
recursion detected in policy"* — the policy is evaluated while checking
itself. The fix is a pair of `SECURITY DEFINER` helper functions that bypass
RLS internally, so policies call the function instead of querying the table
directly:

```sql
create or replace function my_player_ids()
returns setof uuid language sql security definer stable as $$
  select id from players where user_id = auth.uid();
$$;

create or replace function my_game_codes()
returns setof text language sql security definer stable as $$
  select game_code from players where user_id = auth.uid();
$$;
```

Then the actual policies are short and readable:

```sql
-- Anyone signed in can create/read a room. Room codes are short-lived and
-- not sensitive — the real access boundary is the players table below.
create policy "games readable by anyone signed in" on games
  for select using (auth.uid() is not null);
create policy "anyone signed in can host a room" on games
  for insert with check (auth.uid() is not null);
create policy "players in the game can update it" on games
  for update using (games.code in (select my_game_codes()));

-- Players in a room can see each other (names/state aren't secret —
-- only per-round hidden data like a submission or vote is; see section 7).
create policy "players in a room can see each other" on players
  for select using (players.game_code in (select my_game_codes()));
create policy "a signed-in client can join a room as itself" on players
  for insert with check (auth.uid() = user_id);
create policy "a player can update their own row" on players
  for update using (auth.uid() = user_id);
```

---

## 4. Joining by code: the chicken-and-egg problem

Naive flow: client reads existing players to compute the next open slot,
then inserts its own row. This breaks under the RLS policy above — the
`players` SELECT policy only allows seeing players in a room you're
**already** in. A joiner has no row yet, so they can't see anyone, so they
can't compute their own slot.

The fix: a `SECURITY DEFINER` RPC function does the whole "compute slot +
insert" atomically, server-side, where it can see everything regardless of
RLS:

```sql
create or replace function join_game(p_code text, p_name text)
returns players
language plpgsql security definer as $$
declare
  v_slot int;
  v_player players;
begin
  if not exists (select 1 from games where code = p_code) then
    raise exception 'Room not found';
  end if;
  if exists (select 1 from players where game_code = p_code and user_id = auth.uid()) then
    raise exception 'You already joined this room from another tab';
  end if;

  select coalesce(max(slot) + 1, 0) into v_slot from players where game_code = p_code;

  insert into players (game_code, slot, name, user_id)
  values (p_code, v_slot, p_name, auth.uid())
  returning * into v_player;

  return v_player;
end;
$$;

grant execute on function join_game(text, text) to authenticated;
```

Client side:

```js
export async function hostGame(name) {
  const user = await ensureSignedIn()
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode() // random 4-char string
    const { error } = await supabase.from('games').insert({ code })
    if (error) {
      if (error.code === '23505') continue // code collision — try another
      throw error
    }
    const { error: playerError } = await supabase
      .from('players')
      .insert({ id: uuidv4(), game_code: code, slot: 0, name, user_id: user.id })
    if (playerError) throw playerError
    return { code }
  }
  throw new Error('Could not generate a free room code — try again.')
}

export async function joinGame(rawCode, name) {
  await ensureSignedIn()
  const code = rawCode.trim().toUpperCase()
  const { data: player, error } = await supabase.rpc('join_game', { p_code: code, p_name: name })
  if (error) throw error
  return { code, player }
}
```

Room codes: a short random string over an unambiguous charset, with a
collision-retry loop rather than a uniqueness pre-check (simpler, and the
DB's primary key already guarantees correctness under a race):

```js
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
export function generateRoomCode(length = 4) {
  let code = ''
  for (let i = 0; i < length; i++) code += CHARSET[Math.floor(Math.random() * CHARSET.length)]
  return code
}
```

**Gotcha:** don't `.select()` (request the row back) on the player insert.
PostgREST re-checks the SELECT policy to build the `RETURNING` response, and
it won't yet see a row inserted earlier in the *same* statement when that
policy itself queries `players` — you get a false RLS-violation error even
though the insert succeeded. Just build the local object from what you
already know instead of asking for it back.

**Gotcha:** `crypto.randomUUID()` throws on an insecure context (plain
`http://`, which is exactly how a phone reaches a dev server on your LAN
during testing). Fall back to `crypto.getRandomValues` (available
everywhere) if you need to generate an id client-side.

---

## 5. Realtime sync: one channel per room

Every client subscribes to a single Realtime channel scoped to their room
code, listening for row changes on every table that matters:

```js
export function subscribeToRoom(code, { onPlayers, onGame, ...rest }) {
  const channel = supabase
    .channel(`room:${code}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'players', filter: `game_code=eq.${code}` },
      (payload) => onPlayers?.(payload))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'games', filter: `code=eq.${code}` },
      (payload) => onGame?.(payload))
    // ...one more .on(...) per game-specific table (submissions, moves, etc.)
  channel.subscribe()
  return () => supabase.removeChannel(channel)
}
```

Wrap that in a hook that's *purely a data mirror* — it doesn't know
anything about game rules or phases, it just keeps local state in sync with
what the database currently says:

```js
export function useRoomConnection(code) {
  const [players, setPlayers] = useState([])
  const [game, setGame] = useState(null)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    ;(async () => {
      const [initialPlayers, initialGame] = await Promise.all([fetchPlayers(code), fetchGame(code)])
      if (cancelled) return
      setPlayers(initialPlayers)
      setGame(initialGame)
    })()

    const unsubscribe = subscribeToRoom(code, {
      onPlayers: () => fetchPlayers(code).then(setPlayers),
      onGame: (payload) => { if (payload.new) setGame(payload.new) },
    })
    return () => { cancelled = true; unsubscribe() }
  }, [code])

  return { players, game }
}
```

Then — this is the important architectural choice — **every screen a player
sees is a pure function of this shared state**, not a sequence of client-
triggered transitions. A component computes "what stage am I in right now"
from `game`/`players`/round data on every render, rather than an imperative
`setPhase('next')` call driving things forward. Concretely, build one
exhaustive derived value per game-loop stage:

```js
const roundStage =
  !iSubmitted ? 'submitting'
  : !allSubmitted ? 'waiting-for-others'
  : !revealed ? 'revealing'
  : !myMoveRow ? 'my-turn'
  : !allMoved ? 'waiting-for-others'
  : 'scoring'
```

Why this matters: if a client reconnects mid-round, or was a few hundred ms
behind on a realtime event, it doesn't need to replay a sequence of
transitions to catch up — it just re-derives the right screen from current
state on its next render. This single design choice eliminates an entire
class of "client got stuck on the wrong screen" bugs.

---

## 6. Guarded writes: the concurrency model

There's no locking anywhere in this system. Instead, every write that could
race against another device's write is a **conditional UPDATE**: it only
succeeds if the row is still in the state the writer expects.

```js
// Only the FIRST client to notice the round is complete gets to advance it.
// Every other (redundant) call matches zero rows and is a harmless no-op.
await supabase
  .from('games')
  .update({ round_index: fromRoundIndex + 1, /* ... */ })
  .eq('code', gameCode)
  .eq('round_index', fromRoundIndex)  // <- the guard
```

Every device that's watching the room eventually converges on the same
state via the realtime subscription, regardless of which device's write
actually "won." This is simpler and more robust than picking one client as
authoritative or building a lock — it works the same whether 2 devices race
or 8 do.

Some writes don't need a guard at all, because they're naturally idempotent
— e.g. "mark this player eliminated" can be called twice safely if the
second call is a no-op (`where eliminated_at is null`).

---

## 7. Hidden information: reveal-when-everyone's-in

For anything that should stay secret until everyone's committed (a
submission, a vote, a move), use a `revealed boolean` column plus a
database trigger, not client-side hiding:

```sql
create table submissions (
  id uuid primary key default gen_random_uuid(),
  game_code text not null references games(code) on delete cascade,
  round_index int not null,
  player_id uuid not null references players(id) on delete cascade,
  payload jsonb not null,
  revealed boolean not null default false,
  unique (game_code, round_index, player_id)
);

create or replace function reveal_when_everyone_in()
returns trigger as $$
declare v_player_count int; v_submission_count int;
begin
  select count(*) into v_player_count from players where game_code = new.game_code;
  select count(*) into v_submission_count from submissions
    where game_code = new.game_code and round_index = new.round_index;
  if v_submission_count >= v_player_count then
    update submissions set revealed = true
    where game_code = new.game_code and round_index = new.round_index;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_reveal after insert on submissions
  for each row execute function reveal_when_everyone_in();
```

```sql
create policy "read own submission always, others once revealed" on submissions
  for select using (revealed = true or submissions.player_id in (select my_player_ids()));
create policy "a player can submit for themself" on submissions
  for insert with check (submissions.player_id in (select my_player_ids()));
```

This means an opponent's row is **structurally unreadable** (RLS blocks the
SELECT, not just the UI hiding it) until the trigger flips `revealed`. A
client can't cheat by inspecting network traffic or the DB directly through
the anon key.

---

## 8. Shared timers and synced sequences

For anything time-based that every screen needs to agree on (a countdown,
an auto-playing sequence, a reveal animation) — **don't** try to push
per-frame updates over the network. Instead, write one shared timestamp
once, and let every client independently schedule its own local timers
relative to that absolute point in time:

```js
// Client: schedule locally off a shared timestamp
const revealAt = new Date(game.reveal_started_at).getTime()
const msUntilNextStage = revealAt + STAGE_DURATION_MS - Date.now()
setTimeout(runNextStage, Math.max(0, msUntilNextStage))
```

The write that sets the timestamp is guarded so only the first client to
notice the trigger condition sets it — everyone else's write is a no-op,
and everyone schedules off the one value that actually landed.

### The lesson learned the hard way: use the database's clock, not the client's

The natural first version of this writes `new Date().toISOString()` from
whichever client happens to trigger the transition. **Don't do this.** Any
clock skew between two players' devices becomes a constant offset baked
directly into a timestamp that every device — including the one that wrote
it — then schedules its own countdown against. At a generous 60-second
timer this is invisible. At a tight 10-25 second timer (e.g. a "speed
round" variant) it becomes a very noticeable "one player's screen is ahead
of everyone else's."

The fix: never write a shared timestamp from client-side `Date.now()`. Wrap
the write in a `SECURITY DEFINER` function that uses Postgres's own `now()`:

```sql
create or replace function start_round(p_game_code text)
returns void language plpgsql security definer as $$
begin
  update games set status = 'playing', round_started_at = now()
  where code = p_game_code and status = 'lobby';  -- still guarded
end;
$$;
grant execute on function start_round(text) to authenticated;
```

This removes per-device clock skew as a factor entirely, since every
device is scheduling against the same server-stamped moment rather than
whichever device's local clock happened to write it.

**Related gotcha:** if you also have a server-side "force this along even
if a player never acts" timeout check (e.g. "reveal partial results if
someone doesn't submit in time"), make sure that check's window actually
matches whatever the client-side timer shows the player. A hardcoded
60-second server check next to a 25-second client-side timer means the
client shows "time's up" while the server quietly refuses to do anything
for another 35 seconds — the round appears to hang. Keep both numbers
driven from the same source of truth (or have the server look up a
per-room setting) rather than hardcoding the window in two places.

---

## 9. Deterministic shared randomness (no round trip needed)

When every device needs to agree on some "random" ordering (e.g. whose
submission plays first) without an extra network round trip to agree on
it, seed a PRNG from data every client already has — the room code plus the
round number — so every device computes the identical result independently:

```js
function seededRandom(seed) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return function next() {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

export function deterministicOrder(gameCode, roundIndex, count) {
  const str = `${gameCode}:${roundIndex}`
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0
  const rand = seededRandom(hash || 1)

  const order = Array.from({ length: count }, (_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}
```

Every device runs this pure function locally and gets the same array —
no "who won the coin flip" write needed at all.

---

## 10. Other pitfalls worth knowing about up front

- **Stale round data after a round changes.** A shared `round_index`
  updates instantly via realtime, but if per-round data (submissions,
  votes, moves) is fetched separately and asynchronously, there's a real
  window where the round number has moved on but your local array still
  holds the *previous* round's rows. Don't trust component-state timing to
  have caught up — filter every round-scoped array by its own
  `round_index` column, not by "whatever's currently in local state."

- **Deriving the UI phase, not driving it.** Compute which screen to show
  purely from current shared state (see section 5) rather than comparing
  against the previous local phase and deciding whether to transition. A
  derivation that references its own previous output can oscillate between
  two screens when state updates land in an unlucky order.

- **iOS Safari won't let you `.play()` an audio element unless it was
  already played during a real user gesture.** If your game plays audio at
  a moment that isn't itself a tap (e.g. an auto-starting synced sequence),
  "prime" a persistent `<audio>` element with a muted play/pause during an
  earlier real gesture (like a Submit button tap), so the later scripted
  play works.

- **Test against the real database, not mocks.** A meaningful chunk of the
  bugs above (the RLS recursion, the RETURNING-vs-RLS timing issue, the
  reveal-window mismatch) only show up when two separate authenticated
  sessions actually race against Postgres — write small Node scripts that
  sign in two-plus anonymous sessions and exercise the real flow against
  your live Supabase project, rather than trusting unit tests of pure
  logic alone.

---

## 11. Suggested build order for a new game

1. Create the Supabase project; enable Anonymous Sign-Ins.
2. Write `games` + `players` tables and the max-players trigger.
3. Enable RLS; write the `my_player_ids()` / `my_game_codes()` helper
   functions and the basic games/players policies.
4. Write the `join_game` RPC and the host/join client functions.
5. Build the realtime subscription hook (`useRoomConnection` equivalent) —
   get players showing up live in a waiting room across two browser tabs
   before writing any game logic.
6. Add your game-specific round-data table(s) (moves, submissions,
   whatever your game's unit of "a player's turn" is), with the
   reveal-when-everyone's-in trigger pattern if anything should stay
   hidden.
7. Build the derived `roundStage`-style state machine — one exhaustive
   value computed from shared state, driving which component renders.
8. Add guarded-write functions for every player-triggered transition
   (submit, vote, advance round, etc.).
9. For anything with a shared timer, add a `SECURITY DEFINER` RPC that
   stamps the timestamp with `now()`, not client `Date.now()`.
10. Write a couple of Node smoke-test scripts that sign in 2+ real
    anonymous sessions and play through the room-join and round flow
    against the live database, and re-run them after every schema change.

---

## Appendix: where to find the real code in this repo

This document paraphrases and generalizes the pattern — the actual working
implementation (with all the game-specific pieces) lives at:

- `supabase/schema.sql` — the full, current schema (tables, RLS, triggers,
  RPCs) in one file.
- `src/lib/supabase.js` — client setup + `ensureSignedIn`.
- `src/lib/room.js` — `hostGame`/`joinGame`/`subscribeToRoom`.
- `src/lib/roomCode.js`, `src/lib/uuid.js` — room code generation, the
  `crypto.randomUUID()` insecure-context fallback.
- `src/hooks/useRoomConnection.js` — the realtime data-mirror hook.
- `src/hooks/useRoundState.js` — the derived round-stage state machine.
- `src/hooks/useAudioPriming.js` — the iOS Safari audio-priming pattern.
- `src/lib/game.js` — guarded-write functions and the deterministic
  shuffle.
- `supabase/migrations/012_server_time_and_lightning_expiry.sql` — the
  server-clock fix described in section 8, as a real applied example.
