-- Tests for 20261101090000_session_billing_prices_batch.sql (local Supabase stack with data; read-only, no fixtures).
--   E1  for every session and every registered athlete / walk-in, the batch returns exactly session_billing_price_ils
--   E2  duplicate, null and empty inputs: one row per distinct id, nulls ignored, empty arrays return nothing
--   S1  SECURITY INVOKER + STABLE; execute granted to authenticated, not to anon or PUBLIC
-- Usage: docker exec -i <db> psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/201_session_billing_prices_batch_tests.sql
-- Needs a database with sessions and registrations (e.g. the perf seed); refuses to pass vacuously.

do $$
declare
  v_pairs int;
  v_batch int;
  v_bad int;
begin
  with rosters as (
    select s.id sid,
      array(select r.user_id from public.session_registrations r where r.session_id = s.id) uids,
      array(select m.manual_participant_id from public.session_manual_participants m where m.session_id = s.id) mids
    from public.training_sessions s
  ), batch as (
    select r.sid, b.user_id, b.manual_participant_id, b.price_ils
    from rosters r, lateral public.session_billing_prices_ils(r.sid, r.uids, r.mids) b
  ), single as (
    select distinct r.sid, u as user_id, null::uuid as manual_participant_id, public.session_billing_price_ils(r.sid, u, null) price_ils
    from rosters r, unnest(r.uids) u
    union all
    select distinct r.sid, null::uuid, m, public.session_billing_price_ils(r.sid, null, m) from rosters r, unnest(r.mids) m
  )
  select (select count(*) from single), (select count(*) from batch),
         (select count(*) from (select * from single except all select * from batch) a)
       + (select count(*) from (select * from batch except all select * from single) b)
    into v_pairs, v_batch, v_bad;
  if v_pairs < 50 then
    raise exception 'E1 FAILED: only % roster rows, need a seeded database', v_pairs;
  end if;
  if v_bad <> 0 or v_pairs <> v_batch then
    raise exception 'E1 FAILED: % mismatches (% per-row vs % batch rows)', v_bad, v_pairs, v_batch;
  end if;
  raise notice 'E1 PASSED: % roster rows identical to session_billing_price_ils', v_pairs;
end $$;

do $$
declare
  v_sid uuid;
  v_uid uuid;
  v_n int;
begin
  select r.session_id, r.user_id into v_sid, v_uid from public.session_registrations r limit 1;
  select count(*) into v_n from public.session_billing_prices_ils(v_sid, array[v_uid, v_uid, null]::uuid[], array[null]::uuid[]);
  if v_n <> 1 then raise exception 'E2 FAILED: duplicates / nulls gave % rows, expected 1', v_n; end if;
  select count(*) into v_n from public.session_billing_prices_ils(v_sid, '{}'::uuid[], null);
  if v_n <> 0 then raise exception 'E2 FAILED: empty input gave % rows', v_n; end if;
  raise notice 'E2 PASSED: duplicate, null and empty inputs';
end $$;

do $$
declare
  v_oid oid := to_regprocedure('public.session_billing_prices_ils(uuid,uuid[],uuid[])');
begin
  if v_oid is null then raise exception 'S1 FAILED: function missing'; end if;
  if (select prosecdef from pg_proc where oid = v_oid) then raise exception 'S1 FAILED: must be SECURITY INVOKER'; end if;
  if (select provolatile from pg_proc where oid = v_oid) <> 's' then raise exception 'S1 FAILED: must be STABLE'; end if;
  if not has_function_privilege('authenticated', v_oid, 'execute') then raise exception 'S1 FAILED: authenticated cannot execute'; end if;
  if has_function_privilege('anon', v_oid, 'execute') then raise exception 'S1 FAILED: anon can execute'; end if;
  raise notice 'S1 PASSED: invoker, stable, authenticated only';
end $$;
