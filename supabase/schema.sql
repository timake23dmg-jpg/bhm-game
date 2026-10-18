-- Fakeout — Supabase schema (tables, RLS, RPCs, realtime).
-- Run this once in the Supabase SQL editor, then run questions.sql.
-- Safe to re-run: everything is create-if-not-exists / create-or-replace.
--
-- Everything lives in its own `bhm` schema, so it can share a Supabase
-- project with another app (e.g. Song Wars, which has its own `games` and
-- `players` tables in `public`) without touching it. After running this,
-- add `bhm` under Project Settings → Data API → Exposed schemas.
--
-- Authority model: the host TV tab is the "server". It owns the room
-- (games.host_user_id) and is the only writer of games.state (via
-- host_set_state). Phones only write through guarded RPCs and their own
-- likes/commands rows. The truth and lie authors never reach a phone
-- before REVEAL: questions and game_secrets are host-only, and lies/picks
-- rows are readable only by their author and the host.

create extension if not exists pgcrypto;

create schema if not exists bhm;
-- Unqualified names below are created in (and resolve to) the bhm schema.
set search_path = bhm, public;

-- ---------------------------------------------------------------- tables

create table if not exists games (
  code text primary key,
  host_user_id uuid not null default auth.uid(),
  phase text not null default 'LOBBY',
  question_no int not null default 0,
  state jsonb not null default '{}'::jsonb,
  used_question_ids text[] not null default '{}',
  deadline timestamptz,
  phase_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists game_secrets (
  code text primary key references games(code) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  question jsonb,
  given_suggestions text[] not null default '{}'
);
-- "Lie for me" suggestions handed out in the current question, by player:
-- { "<player id>": ["text", ...] }. The host charges for them.
alter table game_secrets add column if not exists lie_handouts jsonb not null default '{}'::jsonb;
alter table game_secrets add column if not exists handouts_question_no int;
-- Truth Detectors used in the current question: { "<player id>": [kept option ids] }
alter table game_secrets add column if not exists lifelines jsonb not null default '{}'::jsonb;
alter table game_secrets add column if not exists lifelines_question_no int;

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  game_code text not null references games(code) on delete cascade,
  user_id uuid not null default auth.uid(),
  slot int not null check (slot >= 0),
  name text not null check (char_length(name) between 1 and 16),
  avatar text not null default '🦊',
  is_audience boolean not null default false,
  created_at timestamptz not null default now(),
  unique (game_code, slot),
  unique (game_code, user_id)
);
-- Mugshot selfie (see set_photo).
alter table players add column if not exists photo text;

create table if not exists questions (
  id text primary key,
  category text not null,
  prompt text not null,
  answer text not null,
  alternate_spellings text[] not null default '{}',
  suggested_lies text[] not null default '{}',
  is_final boolean not null default false
);

create table if not exists lies (
  game_code text not null references games(code) on delete cascade,
  question_no int not null,
  player_id uuid not null references players(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 40),
  norm text not null,
  created_at timestamptz not null default now(),
  primary key (game_code, question_no, player_id)
);

create table if not exists picks (
  game_code text not null references games(code) on delete cascade,
  question_no int not null,
  player_id uuid not null references players(id) on delete cascade,
  option_id text not null,
  created_at timestamptz not null default now(),
  primary key (game_code, question_no, player_id)
);

create table if not exists likes (
  game_code text not null references games(code) on delete cascade,
  question_no int not null,
  player_id uuid not null references players(id) on delete cascade,
  option_id text not null,
  primary key (game_code, question_no, player_id, option_id)
);

create table if not exists commands (
  id bigint generated always as identity primary key,
  game_code text not null references games(code) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  cmd text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Technical ceiling on room size (players + audience); the player cap
-- (70 for the Black History build) is enforced in join_game.
create or replace function enforce_max_players()
returns trigger language plpgsql security definer set search_path = bhm, public as $$
declare v_max constant int := 80;
begin
  if (select count(*) from players where game_code = new.game_code) >= v_max then
    raise exception 'Room % is already full', new.game_code;
  end if;
  return new;
end; $$;

drop trigger if exists trg_enforce_max_players on players;
create trigger trg_enforce_max_players before insert on players
  for each row execute function enforce_max_players();

-- ------------------------------------------------------ RLS helper funcs

create or replace function my_player_ids()
returns setof uuid language sql security definer stable set search_path = bhm, public as $$
  select id from players where user_id = auth.uid();
$$;

create or replace function my_game_codes()
returns setof text language sql security definer stable set search_path = bhm, public as $$
  select game_code from players where user_id = auth.uid();
$$;

create or replace function my_hosted_codes()
returns setof text language sql security definer stable set search_path = bhm, public as $$
  select code from games where host_user_id = auth.uid();
$$;

-- ------------------------------------------------------------------ RLS

alter table games enable row level security;
alter table game_secrets enable row level security;
alter table players enable row level security;
alter table questions enable row level security;  -- no policies: RPC-only
alter table lies enable row level security;
alter table picks enable row level security;
alter table likes enable row level security;
alter table commands enable row level security;

drop policy if exists "games readable by anyone signed in" on games;
create policy "games readable by anyone signed in" on games
  for select using (auth.uid() is not null);

drop policy if exists "host owns secrets" on game_secrets;
create policy "host owns secrets" on game_secrets
  for all using (code in (select my_hosted_codes()))
  with check (code in (select my_hosted_codes()));

drop policy if exists "room members and host see players" on players;
create policy "room members and host see players" on players
  for select using (game_code in (select my_game_codes()) or game_code in (select my_hosted_codes()));

drop policy if exists "own lie or host" on lies;
create policy "own lie or host" on lies
  for select using (player_id in (select my_player_ids()) or game_code in (select my_hosted_codes()));

drop policy if exists "own pick or host" on picks;
create policy "own pick or host" on picks
  for select using (player_id in (select my_player_ids()) or game_code in (select my_hosted_codes()));

drop policy if exists "own likes or host" on likes;
create policy "own likes or host" on likes
  for select using (player_id in (select my_player_ids()) or game_code in (select my_hosted_codes()));
drop policy if exists "like as yourself" on likes;
create policy "like as yourself" on likes
  for insert with check (player_id in (select my_player_ids()) and game_code in (select my_game_codes()));
drop policy if exists "unlike as yourself" on likes;
create policy "unlike as yourself" on likes
  for delete using (player_id in (select my_player_ids()));

drop policy if exists "own commands or host" on commands;
create policy "own commands or host" on commands
  for select using (player_id in (select my_player_ids()) or game_code in (select my_hosted_codes()));
drop policy if exists "command as yourself" on commands;
create policy "command as yourself" on commands
  for insert with check (player_id in (select my_player_ids()) and game_code in (select my_game_codes()));

-- ------------------------------------------------------ lie rule helpers
-- Mirrors src/lib/rules.js.

create or replace function fakeout_normalize(t text)
returns text language sql immutable set search_path = bhm, public as $$
  select regexp_replace(
    btrim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[[:punct:]]', '', 'g'), '\s+', ' ', 'g')),
    '^(a|an|the) ', '')
$$;

-- "Lie for me" price for a player who has already had n this game: the
-- first is free, then 100, 200, 300, 400, then 500 points each.
create or replace function fakeout_lie_price(n int)
returns int language sql immutable set search_path = bhm, public as $$
  select case when n <= 0 then 0 else least(500, 100 * n) end
$$;

create or replace function fakeout_levenshtein(a text, b text)
returns int language plpgsql immutable set search_path = bhm, public as $$
declare
  la int := char_length(a);
  lb int := char_length(b);
  prev int[];
  cur int[];
  cost int;
begin
  if la = 0 then return lb; end if;
  if lb = 0 then return la; end if;
  prev := array(select generate_series(0, lb));   -- prev[j+1] = distance at column j
  for i in 1..la loop
    cur := array[i];
    for j in 1..lb loop
      cost := case when substr(a, i, 1) = substr(b, j, 1) then 0 else 1 end;
      cur := cur || least(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    end loop;
    prev := cur;
  end loop;
  return prev[lb + 1];
end; $$;

create or replace function fakeout_is_truth(p_text text, p_question jsonb)
returns boolean language plpgsql immutable set search_path = bhm, public as $$
declare
  n text := fakeout_normalize(p_text);
  t text;
begin
  for t in
    select fakeout_normalize(x)
    from jsonb_array_elements_text(
      jsonb_build_array(p_question->>'answer') || coalesce(p_question->'alternateSpellings', '[]'::jsonb)) x
  loop
    if n = t or (char_length(t) >= 5 and fakeout_levenshtein(n, t) <= 1) then
      return true;
    end if;
  end loop;
  return false;
end; $$;

create or replace function fakeout_is_profane(p_text text)
returns boolean language sql immutable set search_path = bhm, public as $$
  select exists (
    select 1 from unnest(string_to_array(fakeout_normalize(p_text), ' ')) w
    where w = any (array['fuck','fucking','fucker','motherfucker','shit','bullshit','cunt','bitch',
      'bastard','asshole','arsehole','dick','dickhead','cock','pussy','whore','slut','twat','wanker',
      'prick','fag','faggot','nigger','nigga','retard','spastic'])
      or w like 'fuck%' or w like 'shit%')
$$;

create or replace function fakeout_ms(t timestamptz)
returns bigint language sql immutable set search_path = bhm, public as $$
  select (extract(epoch from t) * 1000)::bigint
$$;

-- ------------------------------------------------------------------ RPCs

create or replace function server_now()
returns bigint language sql stable set search_path = bhm, public as $$
  select fakeout_ms(clock_timestamp())
$$;

create or replace function create_game(p_settings jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path = bhm, public as $$
declare
  v_charset constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  delete from games where created_at < now() - interval '1 day';
  for attempt in 1..20 loop
    v_code := '';
    for i in 1..4 loop
      v_code := v_code || substr(v_charset, 1 + floor(random() * length(v_charset))::int, 1);
    end loop;
    begin
      insert into games (code, host_user_id, state)
      values (v_code, auth.uid(),
              jsonb_build_object('phase', 'LOBBY', 'settings', coalesce(p_settings, '{}'::jsonb)));
      insert into game_secrets (code) values (v_code);
      return v_code;
    exception when unique_violation then
      -- code collision: try another
    end;
  end loop;
  raise exception 'Could not generate a free room code - try again.';
end; $$;

create or replace function join_game(p_code text, p_name text, p_avatar text, p_audience boolean default false)
returns players language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  v players;
  v_name text := btrim(coalesce(p_name, ''));
  v_count int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into g from games where code = upper(btrim(p_code));
  if not found then raise exception 'Room not found'; end if;

  perform pg_advisory_xact_lock(hashtext('bhm:' || g.code));

  -- Reconnect: same browser session gets its existing row back.
  select * into v from players where game_code = g.code and user_id = auth.uid();
  if found then
    if v_name <> '' then
      update players set name = left(v_name, 16), avatar = coalesce(p_avatar, avatar)
      where id = v.id returning * into v;
    end if;
    return v;
  end if;

  if char_length(v_name) not between 1 and 16 then
    raise exception 'Name must be 1-16 characters';
  end if;

  select count(*) into v_count from players where game_code = g.code and not is_audience;

  insert into players (game_code, user_id, slot, name, avatar, is_audience)
  values (g.code, auth.uid(),
          (select coalesce(max(slot) + 1, 0) from players where game_code = g.code),
          v_name, coalesce(p_avatar, '🦊'),
          coalesce(p_audience, false) or g.phase <> 'LOBBY' or v_count >= 70)
  returning * into v;
  return v;
end; $$;

-- The host publishes the public (filtered) state. Deadlines are stamped
-- with the database clock so every device counts down to the same moment.
create or replace function host_set_state(
  p_code text, p_phase text, p_question_no int, p_state jsonb,
  p_duration_ms int default null, p_keep_timer boolean default false)
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  v_deadline timestamptz;
  v_started timestamptz;
begin
  select * into g from games where code = p_code for update;
  if not found or g.host_user_id is distinct from auth.uid() then
    raise exception 'Only the host can do that';
  end if;
  if p_keep_timer then
    v_deadline := g.deadline;
    v_started := g.phase_started_at;
  else
    v_started := now();
    v_deadline := case when p_duration_ms is null then null
                       else now() + make_interval(secs => p_duration_ms / 1000.0) end;
  end if;
  update games set
    phase = p_phase,
    question_no = p_question_no,
    deadline = v_deadline,
    phase_started_at = v_started,
    updated_at = now(),
    state = p_state || jsonb_build_object('deadline', fakeout_ms(v_deadline), 'startedAt', fakeout_ms(v_started))
  where code = p_code;
  return jsonb_build_object('deadline', fakeout_ms(v_deadline), 'startedAt', fakeout_ms(v_started));
end; $$;

-- p_exclude: questions this TV played recently (in earlier rooms). They're
-- avoided while fresher ones remain. The older signatures are dropped.
drop function if exists host_draw_categories(text);
create or replace function host_draw_categories(p_code text, p_exclude text[] default '{}')
returns text[] language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  v_cats text[];
begin
  select * into g from games where code = p_code;
  if not found or g.host_user_id is distinct from auth.uid() then
    raise exception 'Only the host can do that';
  end if;
  select array_agg(category) into v_cats from (
    select category from questions
    where not is_final and not (id = any (g.used_question_ids)) and not (id = any (coalesce(p_exclude, '{}')))
    group by category order by random() limit 3) c;
  if coalesce(array_length(v_cats, 1), 0) < 3 then
    select array_agg(category) into v_cats from (
      select category from questions
      where not is_final and not (id = any (g.used_question_ids))
      group by category order by random() limit 3) c;
  end if;
  if coalesce(array_length(v_cats, 1), 0) < 3 then
    -- Bank running low: forget which regular questions were used.
    update games set used_question_ids = array(
      select u from unnest(used_question_ids) u
      where u in (select id from questions where is_final))
    where code = p_code;
    select array_agg(category) into v_cats from (
      select category from questions where not is_final
      group by category order by random() limit 3) c;
  end if;
  return v_cats;
end; $$;

drop function if exists host_draw_question(text, text, boolean);
create or replace function host_draw_question(p_code text, p_category text, p_final boolean default false,
  p_exclude text[] default '{}')
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  q questions;
  v_json jsonb;
begin
  select * into g from games where code = p_code;
  if not found or g.host_user_id is distinct from auth.uid() then
    raise exception 'Only the host can do that';
  end if;
  -- Freshest first: not played in this room, then not recently on this TV.
  select * into q from questions
  where is_final = p_final and (p_final or p_category is null or category = p_category)
  order by (id = any (g.used_question_ids)), (id = any (coalesce(p_exclude, '{}'))), random()
  limit 1;
  if not found then raise exception 'No questions available'; end if;

  update games set used_question_ids = array_append(array_remove(used_question_ids, q.id), q.id)
  where code = p_code;

  v_json := jsonb_build_object(
    'id', q.id, 'category', q.category, 'prompt', q.prompt, 'answer', q.answer,
    'alternateSpellings', to_jsonb(q.alternate_spellings),
    'suggestedLies', to_jsonb(q.suggested_lies), 'isFinal', q.is_final);
  update game_secrets set question = v_json, given_suggestions = '{}' where code = p_code;
  return v_json;
end; $$;

create or replace function submit_lie(p_code text, p_question_no int, p_text text)
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  p players;
  v_q jsonb;
  v_text text := btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g'));
begin
  select * into g from games where code = p_code;
  if not found then raise exception 'Room not found'; end if;
  select * into p from players where game_code = p_code and user_id = auth.uid();
  if not found then raise exception 'You are not in this room'; end if;
  if p.is_audience then return jsonb_build_object('ok', false, 'reason', 'audience'); end if;
  if g.phase <> 'LIE_ENTRY' or g.question_no <> p_question_no then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if v_text = '' or fakeout_normalize(v_text) = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if char_length(v_text) > 40 then
    return jsonb_build_object('ok', false, 'reason', 'tooLong');
  end if;
  select question into v_q from game_secrets where code = p_code;
  if v_q is not null and fakeout_is_truth(v_text, v_q) then
    return jsonb_build_object('ok', false, 'reason', 'isTruth');
  end if;
  if coalesce((g.state->'settings'->>'profanityFilter')::boolean, true) and fakeout_is_profane(v_text) then
    return jsonb_build_object('ok', false, 'reason', 'profanity');
  end if;
  insert into lies (game_code, question_no, player_id, text, norm)
  values (p_code, p_question_no, p.id, v_text, fakeout_normalize(v_text))
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end; $$;

-- Hands out a suggested lie: { ok, text, cost } or { ok: false, reason[, cost] }.
-- The first per game is free; after that it costs points, checked against
-- the score and purchase count the host published (state.players). The host
-- charges for every handout when lie entry closes.
drop function if exists lie_for_me(text, int);
create or replace function lie_for_me(p_code text, p_question_no int)
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  p players;
  s game_secrets;
  v_pick text;
  v_mine jsonb;
  v_had int;
  v_bought int;
  v_score int;
  v_spent int := 0;
  v_cost int;
begin
  select * into g from games where code = p_code;
  if not found then raise exception 'Room not found'; end if;
  select * into p from players where game_code = p_code and user_id = auth.uid() and not is_audience;
  if not found then raise exception 'You are not a player in this room'; end if;
  if g.phase <> 'LIE_ENTRY' or g.question_no <> p_question_no then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  select * into s from game_secrets where code = p_code for update;
  if s.question is null then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if s.handouts_question_no is distinct from p_question_no then
    s.lie_handouts := '{}'::jsonb;
  end if;

  v_mine := coalesce(s.lie_handouts -> (p.id::text), '[]'::jsonb);
  v_had := jsonb_array_length(v_mine);
  select coalesce((x ->> 'lieBuys')::int, 0), coalesce((x ->> 'score')::int, 0) into v_bought, v_score
  from jsonb_array_elements(coalesce(g.state -> 'players', '[]'::jsonb)) x
  where x ->> 'id' = p.id::text;
  v_bought := coalesce(v_bought, 0);
  v_score := coalesce(v_score, 0);
  for i in 0 .. v_had - 1 loop
    v_spent := v_spent + fakeout_lie_price(v_bought + i);
  end loop;
  v_cost := fakeout_lie_price(v_bought + v_had);
  if v_score - v_spent < v_cost then
    return jsonb_build_object('ok', false, 'reason', 'broke', 'cost', v_cost);
  end if;

  -- Prefer a suggestion nobody has submitted or been handed yet.
  select x into v_pick from jsonb_array_elements_text(s.question->'suggestedLies') x
  where fakeout_normalize(x) not in (select norm from lies where game_code = p_code and question_no = p_question_no)
    and not (x = any (s.given_suggestions)) and not (v_mine ? x)
  order by random() limit 1;
  if v_pick is null then
    select x into v_pick from jsonb_array_elements_text(s.question->'suggestedLies') x
    where fakeout_normalize(x) not in (select norm from lies where game_code = p_code and question_no = p_question_no)
      and not (v_mine ? x)
    order by random() limit 1;
  end if;
  if v_pick is null then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;

  update game_secrets set
    given_suggestions = array_append(given_suggestions, v_pick),
    lie_handouts = jsonb_set(s.lie_handouts, array[p.id::text], v_mine || to_jsonb(v_pick)),
    handouts_question_no = p_question_no
  where code = p_code;
  return jsonb_build_object('ok', true, 'text', v_pick, 'cost', v_cost);
end; $$;

-- Truth Detector: once per game, before picking, narrows a player's options to
-- the truth and one lie: { ok, keep: [option id, option id] } or
-- { ok: false, reason }. "Once per game" is checked against the flag the host
-- publishes (state.players[].lifelineUsed); the host learns about uses from
-- game_secrets.lifelines.
create or replace function use_lifeline(p_code text, p_question_no int)
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  p players;
  s game_secrets;
  v_truth text;
  v_lie text;
  v_own text;
  v_keep jsonb;
begin
  select * into g from games where code = p_code;
  if not found then raise exception 'Room not found'; end if;
  select * into p from players where game_code = p_code and user_id = auth.uid() and not is_audience;
  if not found then raise exception 'You are not a player in this room'; end if;
  if g.phase <> 'PICK_TRUTH' or g.question_no <> p_question_no then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(g.state -> 'players', '[]'::jsonb)) x
             where x ->> 'id' = p.id::text and coalesce((x ->> 'lifelineUsed')::boolean, false)) then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  select * into s from game_secrets where code = p_code for update;
  if s.lifelines_question_no is distinct from p_question_no then
    s.lifelines := '{}'::jsonb;
  end if;
  if s.lifelines ? (p.id::text) then
    return jsonb_build_object('ok', true, 'keep', s.lifelines -> (p.id::text));
  end if;
  if exists (select 1 from picks where game_code = p_code and question_no = p_question_no and player_id = p.id) then
    return jsonb_build_object('ok', false, 'reason', 'picked');
  end if;

  select norm into v_own from lies where game_code = p_code and question_no = p_question_no and player_id = p.id;
  select o ->> 'id' into v_truth from jsonb_array_elements(coalesce(g.state -> 'options', '[]'::jsonb)) o
  where fakeout_normalize(o ->> 'text') = fakeout_normalize(s.question ->> 'answer') limit 1;
  select o ->> 'id' into v_lie from jsonb_array_elements(coalesce(g.state -> 'options', '[]'::jsonb)) o
  where o ->> 'id' is distinct from v_truth and fakeout_normalize(o ->> 'text') is distinct from v_own
  order by random() limit 1;
  if v_truth is null or v_lie is null then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;

  v_keep := case when random() < 0.5 then jsonb_build_array(v_truth, v_lie) else jsonb_build_array(v_lie, v_truth) end;
  update game_secrets set
    lifelines = jsonb_set(s.lifelines, array[p.id::text], v_keep),
    lifelines_question_no = p_question_no
  where code = p_code;
  return jsonb_build_object('ok', true, 'keep', v_keep);
end; $$;

-- Mugshot selfie: a small JPEG data URL made on the phone, stored on the
-- player's own row (deleted with the room). Mirrors isValidPhoto in rules.js.
create or replace function set_photo(p_code text, p_photo text)
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  p players;
begin
  select * into p from players where game_code = upper(btrim(p_code)) and user_id = auth.uid();
  if not found then raise exception 'You are not in this room'; end if;
  if p_photo is not null and (left(p_photo, 23) <> 'data:image/jpeg;base64,' or char_length(p_photo) > 60000) then
    return jsonb_build_object('ok', false, 'reason', 'badPhoto');
  end if;
  update players set photo = p_photo where id = p.id;
  return jsonb_build_object('ok', true);
end; $$;

create or replace function submit_pick(p_code text, p_question_no int, p_option_id text)
returns jsonb language plpgsql security definer set search_path = bhm, public as $$
declare
  g games;
  p players;
begin
  select * into g from games where code = p_code;
  if not found then raise exception 'Room not found'; end if;
  select * into p from players where game_code = p_code and user_id = auth.uid();
  if not found then raise exception 'You are not in this room'; end if;
  if g.phase <> 'PICK_TRUTH' or g.question_no <> p_question_no then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  if not exists (select 1 from jsonb_array_elements(coalesce(g.state->'options', '[]'::jsonb)) o
                 where o->>'id' = p_option_id) then
    return jsonb_build_object('ok', false, 'reason', 'badOption');
  end if;
  insert into picks (game_code, question_no, player_id, option_id)
  values (p_code, p_question_no, p.id, p_option_id)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end; $$;

-- ------------------------------------------------------------ heartbeats
-- Who's online. Phones check in every few seconds and the host polls for the
-- recent ones. Realtime presence would send every phone's status to every other
-- phone: thousands of messages in a 70-player room, far over Supabase's quotas.
-- RPC-only (RLS on, no policies) and deliberately not in the realtime publication.
create table if not exists heartbeats (
  player_id uuid primary key references players(id) on delete cascade,
  game_code text not null references games(code) on delete cascade,
  seen_at timestamptz not null default now()
);
create index if not exists heartbeats_game_code on heartbeats (game_code);
alter table heartbeats enable row level security;

create or replace function heartbeat(p_code text)
returns void language plpgsql security definer set search_path = bhm, public as $$
begin
  insert into heartbeats (player_id, game_code, seen_at)
  select id, game_code, now() from players where game_code = upper(btrim(p_code)) and user_id = auth.uid()
  on conflict (player_id) do update set seen_at = now();
end; $$;

create or replace function host_online(p_code text)
returns setof uuid language sql security definer stable set search_path = bhm, public as $$
  select h.player_id from heartbeats h join games g on g.code = h.game_code
  where h.game_code = p_code and g.host_user_id = auth.uid() and h.seen_at > now() - interval '20 seconds';
$$;

revoke execute on function create_game(jsonb), join_game(text, text, text, boolean),
  host_set_state(text, text, int, jsonb, int, boolean), host_draw_categories(text, text[]),
  host_draw_question(text, text, boolean, text[]), submit_lie(text, int, text), lie_for_me(text, int),
  use_lifeline(text, int), set_photo(text, text), submit_pick(text, int, text),
  heartbeat(text), host_online(text) from public, anon;
grant execute on function server_now(), create_game(jsonb), join_game(text, text, text, boolean),
  host_set_state(text, text, int, jsonb, int, boolean), host_draw_categories(text, text[]),
  host_draw_question(text, text, boolean, text[]), submit_lie(text, int, text), lie_for_me(text, int),
  use_lifeline(text, int), set_photo(text, text), submit_pick(text, int, text),
  heartbeat(text), host_online(text) to authenticated;

-- ------------------------------------------------------------- realtime

do $$
declare t text;
begin
  foreach t in array array['games', 'players', 'lies', 'picks', 'commands'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'bhm' and tablename = t) then
      execute format('alter publication supabase_realtime add table bhm.%I', t);
    end if;
  end loop;
end $$;

-- --------------------------------------------------- API access to schema
-- `public` gets these grants automatically in Supabase; a custom schema
-- needs them spelled out. RLS policies above still decide row access.

grant usage on schema bhm to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema bhm to authenticated, service_role;
grant usage, select on all sequences in schema bhm to authenticated, service_role;
alter default privileges in schema bhm grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema bhm grant usage, select on sequences to authenticated, service_role;
