-- Recovery of the duplicate recurring series and the one roster corrupted by the historical roster-copy bugs.
--
-- Context (see the audit): ten groups of duplicate active "ongoing" series (same coach, weekday and start
-- time) made the occurrence-identity protection refuse to generate their future occurrences
-- (series_unresolved_ownership), leaving three Sunday 2026-11-08 sessions missing and the weekly generation
-- of those slots blocked. Separately, the capacity-4 Sunday 18:00 occurrence of 2026-11-08 was created empty
-- by the earlier roster-source regression.
--
-- This is ONE atomic statement (a single DO block): any failed assertion raises and rolls back everything.
--   A. lock the occurrence ledger, the affected series and sessions; verify the reviewed structural
--      fingerprint of production, the series counts (29 active / 21 ended) and every precondition;
--   B. re-point the 14 reviewed future, legacy, non-detached sessions of the redundant series to the surviving
--      series, and retire the 11 redundant series (status 'ended', ended_from_date = day after their last
--      remaining session). Nothing is deleted; no registration, manual participant, attendance, price, note
--      or cancellation is touched;
--   C. restore the empty S39 2026-11-08 roster (3 athletes + 1 manual participant) from its exact 2026-11-01
--      source through the trusted roster-copy path (_copy_session_roster) BEFORE any generation;
--   D. run the normal horizon generator once (the exact function cron runs) and require that the set of
--      sessions it creates equals the reviewed expected set exactly;
--   E. run it again: it must create nothing;
--   F. assert the final invariants (18 active / 32 ended series, one active series per affected slot, zero
--      unresolved dates, zero duplicate slots, zero missing dates, preserved sessions and rosters, ...).
-- The activity log is suppressed for the transaction so the manager's activity feed gets no entries.
-- On any database that does not contain the reviewed production series (fresh replay) it is a no-op.
-- FINAL PROPOSED PRODUCTION RECOVERY (scratch draft; production version = identical logic with literal ids)
-- One statement => one atomic transaction. Any failed assertion raises and rolls EVERYTHING back.
do $recovery$
declare
  c_pairs constant text[][] := array[array['df74284d-add2-4c46-913b-4ad6cbfd1c48','bf756f0b-b4e7-435d-8a05-3cda60d3e021','2'],array['194db8c6-9733-43a3-b944-d6d504ec610a','a8928386-7b0d-48c9-be77-2af3e0355f0e','2'],array['8a6c9d3f-9adb-44a6-bbf3-1454d24e7838','ead14374-a7ea-4ac0-b874-f84f1f6f51ba','2'],array['f5c2c55a-4da4-411c-9541-e0d8155d1e29','00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2','2'],array['d889634f-5d05-488c-8f42-1ce703104a44','bd535cac-0b53-495b-b3a1-33005d6d00ba','1'],array['37ea7bce-01e7-4a07-825c-1bfa63f86c2f','d9d19473-29f1-4501-9edb-f57b3ea890a8','1'],array['30208b0d-a870-48e8-a3a4-d435de13f03b','afc49504-e2d0-4e53-8b03-555763974b70','2'],array['55d291e1-4f1c-492b-aa60-699ea42b408e','afc49504-e2d0-4e53-8b03-555763974b70','0'],array['c6a208b5-7f22-4757-8ec9-fdbe36b6ee40','18b50099-f164-4003-a98a-9ce70e9c634f','2'],array['b52db63b-93f7-491d-953e-97e907270980','34eb4cae-3b61-4607-a55f-8a8bc21ac938','0'],array['f87738b8-dd0d-4be0-a765-aceaa35121b3','8714c05d-bf0f-44f6-ad42-2454b6cad92b','0']];          -- {retired_id, keep_id, expected_repoint_count}
  c_s39_ser constant uuid := '422823f4-e46d-4ff3-8978-84df4a9e19fd'; c_s39_src constant uuid := 'c8951143-6f68-4dbe-a030-8f784a339abf'; c_s39_dst constant uuid := '07198580-41d1-4e3f-ac20-c0f3c2b43f5e';
  c_sess_ids constant uuid[] := array['0c7ca6a1-09e4-4d5a-a783-3c6387877197'::uuid,'20308e6f-757b-4dbb-ab49-6d90672c9438'::uuid,'265e1e83-b8b2-416a-b503-501a2f4adeef'::uuid,'38fb0ccb-24c8-4efb-90dc-8cbde6b7df8f'::uuid,'3ef83ea7-f148-483e-b233-094f8bde7504'::uuid,'5a59f3c0-da88-455c-b188-37b8a6b664ec'::uuid,'5a790ab7-3e4e-47de-81df-c62073f960c2'::uuid,'7789e16f-a9ea-43d0-be29-50cbf18d16bb'::uuid,'8e6bbdea-5b51-4f26-add5-9cd8f3fb0e1e'::uuid,'9152935d-aa1a-4783-bde7-ac5a8f9b65e0'::uuid,'ac793df2-c268-4d0c-bd43-ea232be2235b'::uuid,'db4d7f94-9ad4-439f-be0f-f92504487119'::uuid,'f0f4cbbc-6fde-44a3-a520-ebdc32b52c00'::uuid,'f3b62c96-3046-4728-b552-fad3297426c8'::uuid,'c8951143-6f68-4dbe-a030-8f784a339abf'::uuid,'07198580-41d1-4e3f-ac20-c0f3c2b43f5e'::uuid];      -- the sessions locked + fingerprinted (the 14 re-point candidates + S39 11-01/11-08)
  c_ser_ids  constant uuid[] := array['df74284d-add2-4c46-913b-4ad6cbfd1c48'::uuid,'bf756f0b-b4e7-435d-8a05-3cda60d3e021'::uuid,'194db8c6-9733-43a3-b944-d6d504ec610a'::uuid,'a8928386-7b0d-48c9-be77-2af3e0355f0e'::uuid,'8a6c9d3f-9adb-44a6-bbf3-1454d24e7838'::uuid,'ead14374-a7ea-4ac0-b874-f84f1f6f51ba'::uuid,'f5c2c55a-4da4-411c-9541-e0d8155d1e29'::uuid,'00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2'::uuid,'d889634f-5d05-488c-8f42-1ce703104a44'::uuid,'bd535cac-0b53-495b-b3a1-33005d6d00ba'::uuid,'37ea7bce-01e7-4a07-825c-1bfa63f86c2f'::uuid,'d9d19473-29f1-4501-9edb-f57b3ea890a8'::uuid,'30208b0d-a870-48e8-a3a4-d435de13f03b'::uuid,'afc49504-e2d0-4e53-8b03-555763974b70'::uuid,'55d291e1-4f1c-492b-aa60-699ea42b408e'::uuid,'c6a208b5-7f22-4757-8ec9-fdbe36b6ee40'::uuid,'18b50099-f164-4003-a98a-9ce70e9c634f'::uuid,'b52db63b-93f7-491d-953e-97e907270980'::uuid,'34eb4cae-3b61-4607-a55f-8a8bc21ac938'::uuid,'f87738b8-dd0d-4be0-a765-aceaa35121b3'::uuid,'8714c05d-bf0f-44f6-ad42-2454b6cad92b'::uuid,'422823f4-e46d-4ff3-8978-84df4a9e19fd'::uuid];       -- the 22 series + S39
  c_fp constant text := '451902a96246c925f9b8899b1286bf38';                  -- fingerprint of the pre-flight structural state
  v_today date := public._studio_today_date(); v_hend date := public._series_horizon_end();
  v_fp text; i int; v_ret uuid; v_keep uuid; v_exp int; v_n int; v_total int := 0; v_ids uuid[]; v_last date;
  rs session_series%rowtype; ks session_series%rowtype;
  v_pre_active int; v_pre_sessions uuid[]; v_pre_fam_md5 text; v_fam_ids uuid[];
  c_expected constant text := '358d14ba-9971-4a6b-b317-1a435001ea83|09:00:00|2026-11-08,358d14ba-9971-4a6b-b317-1a435001ea83|10:00:00|2026-11-08,6c142117-438d-402d-be9e-8407900836b0|19:00:00|2026-11-08';        -- exact set the generator must create (coach|start|date), computed read-only immediately before deployment
  v_repointed uuid[] := '{}'; v_repointed_keep uuid[] := '{}'; v_pre_ev text; v_post_ev text; v_pre_aux text; v_pre_ended int; v_ev_n int;
  c_retired constant uuid[] := array['df74284d-add2-4c46-913b-4ad6cbfd1c48'::uuid,'194db8c6-9733-43a3-b944-d6d504ec610a'::uuid,'8a6c9d3f-9adb-44a6-bbf3-1454d24e7838'::uuid,'f5c2c55a-4da4-411c-9541-e0d8155d1e29'::uuid,'d889634f-5d05-488c-8f42-1ce703104a44'::uuid,'37ea7bce-01e7-4a07-825c-1bfa63f86c2f'::uuid,'30208b0d-a870-48e8-a3a4-d435de13f03b'::uuid,'55d291e1-4f1c-492b-aa60-699ea42b408e'::uuid,'c6a208b5-7f22-4757-8ec9-fdbe36b6ee40'::uuid,'b52db63b-93f7-491d-953e-97e907270980'::uuid,'f87738b8-dd0d-4be0-a765-aceaa35121b3'::uuid];
  v_expected text; v_created text; v_conf int; v_missing int; v_dups int;
  r record; v_src uuid; v_ath_n int; v_man_n int; h0 int; h1 int; v_new_n int;
begin
  if not exists (select 1 from public.session_series where id = any(c_ser_ids)) then
    raise notice 'recovery skipped: this database does not contain the reviewed production series (fresh replay)'; return;
  end if;
  perform set_config('shira.skip_activity_log', 'on', true);       -- no manager-visible activity entries from the recovery
  -- ===== A. serialize and lock =====
  lock table public.session_series_occurrences in share row exclusive mode;   -- generator / edit RPCs wait; plain readers do not
  perform 1 from public.session_series where id = any(c_ser_ids) order by id for update;
  perform 1 from public.training_sessions where id = any(c_sess_ids) order by id for update;
  v_today := public._studio_today_date(); v_hend := public._series_horizon_end();  -- re-read after locks
  -- ===== A. pre-flight guard: structural fingerprint must equal the reviewed one =====
  select md5(string_agg(x, E'\n' order by x)) into v_fp from (
    select 'S|'||id||'|'||series_id||'|'||session_date||'|'||start_time||'|'||series_detached||'|'||coalesce(series_occurrence_id::text,'-')||'|'||max_participants from public.training_sessions where id = any(c_sess_ids)
    union all select 'R|'||id||'|'||status||'|'||coalesce(ended_from_date::text,'-')||'|'||roster_policy||'|'||max_participants||'|'||anchor_date||'|'||array_to_string(skip_dates,',')||'|'||(select count(*) from public.session_series_occurrences o where o.series_id=session_series.id) from public.session_series where id = any(c_ser_ids)
    union all select 'X|sunday-slots-on-1108|'||count(*) from public.training_sessions where session_date = date '2026-11-08' and (coach_id, start_time) in (select coach_id, start_time from public.session_series where id = any(c_ser_ids) and extract(dow from anchor_date)=0 and id <> c_s39_ser)
    union all select 'X|s39-sessions-after-1108|'||count(*) from public.training_sessions where series_id = c_s39_ser and session_date > date '2026-11-08'
    union all select 'X|s39-dst-roster|'||(select count(*) from public.session_registrations where session_id=c_s39_dst)||'/'||(select count(*) from public.session_manual_participants where session_id=c_s39_dst)
    union all select 'X|s39-src-roster|'||(select count(*) from public.session_registrations where session_id=c_s39_src and status='active')||'/'||(select count(*) from public.session_manual_participants where session_id=c_s39_src)
  ) q(x);
  if c_fp = 'COMPUTE' then raise notice 'FP=%', v_fp; return; end if;
  if v_fp is distinct from c_fp then raise exception 'STOP A: production structure changed since pre-flight (fingerprint % <> %)', v_fp, c_fp; end if;
  select count(*) filter (where status = 'active'), count(*) filter (where status = 'ended') into v_pre_active, v_pre_ended from public.session_series;
  if v_pre_active <> 29 or v_pre_ended <> 21 then raise exception 'STOP A: series counts are %/% not 29/21', v_pre_active, v_pre_ended; end if;
  select md5(coalesce(string_agg(x, E'\n' order by x), '')) into v_pre_aux from (
    select 'R|'||id||'|'||session_id||'|'||user_id||'|'||status||'|'||coalesce(attended::text,'-')||'|'||coalesce(payment_method::text,'-')||'|'||coalesce(amount_paid::text,'-')||'|'||charge_no_show from public.session_registrations where session_id = any(c_sess_ids) and session_id <> c_s39_dst
    union all select 'M|'||session_id||'|'||manual_participant_id from public.session_manual_participants where session_id = any(c_sess_ids) and session_id <> c_s39_dst
    union all select 'H|'||session_id||'|'||user_id||'|'||event_type from public.registration_history where session_id = any(c_sess_ids) and session_id <> c_s39_dst
    union all select 'N|'||id||'|'||session_id from public.session_notes where session_id = any(c_sess_ids)
    union all select 'P|'||id||'|'||session_id from public.session_roster_slot_prices where session_id = any(c_sess_ids)
    union all select 'C|'||id||'|'||session_id from public.cancellations where session_id = any(c_sess_ids)
    union all select 'W|'||id||'|'||session_id from public.waitlist_requests where session_id = any(c_sess_ids)
  ) q(x);
  select array_agg(id) into v_fam_ids from public.training_sessions t where (t.coach_id, t.start_time, extract(dow from t.session_date)) in
    (select coach_id, start_time, extract(dow from anchor_date) from public.session_series where id = any(c_ser_ids)) and t.session_date >= v_today - 60;
  select md5(string_agg(id||'|'||session_date||'|'||start_time||'|'||coach_id||'|'||max_participants||'|'||is_hidden||'|'||is_open_for_registration||'|'||duration_minutes||'|'||series_detached||'|'||coalesce(custom_slot_price_ils::text,'')||'|'||coalesce(custom_coach_rate_ils::text,''), ',' order by id)) into v_pre_fam_md5 from public.training_sessions where id = any(v_fam_ids);
  v_pre_sessions := v_fam_ids;
  -- ===== B. duplicate-series repair: re-point future legacy sessions, retire the redundant series =====
  for i in 1 .. array_length(c_pairs, 1) loop
    v_ret := c_pairs[i][1]::uuid; v_keep := c_pairs[i][2]::uuid; v_exp := c_pairs[i][3]::int;
    select * into rs from public.session_series where id = v_ret; select * into ks from public.session_series where id = v_keep;
    if rs.status <> 'active' or ks.status <> 'active' or rs.repeat_mode <> 'ongoing' or ks.repeat_mode <> 'ongoing' then raise exception 'STOP B: pair % not active/ongoing', i; end if;
    if (rs.coach_id, rs.start_time, rs.duration_minutes, rs.max_participants, rs.is_hidden, rs.is_open_for_registration, rs.is_kickbox, rs.custom_slot_price_ils)
       is distinct from (ks.coach_id, ks.start_time, ks.duration_minutes, ks.max_participants, ks.is_hidden, ks.is_open_for_registration, ks.is_kickbox, ks.custom_slot_price_ils) then raise exception 'STOP B: pair % templates differ', i; end if;
    if mod(rs.anchor_date - ks.anchor_date, 7) <> 0 then raise exception 'STOP B: pair % weekday phase differs', i; end if;
    if exists (select 1 from unnest(rs.skip_dates) d where d >= v_today and not (d = any(ks.skip_dates))) then raise exception 'STOP B: pair % future skip date missing in survivor', i; end if;
    if rs.roster_policy is distinct from ks.roster_policy and not (rs.roster_policy = 'copy_on_generate' and ks.roster_policy = 'none') then raise exception 'STOP B: pair % unexpected roster-policy difference', i; end if;
    select coalesce(array_agg(id order by session_date), '{}') into v_ids from public.training_sessions
      where series_id = v_ret and session_date >= v_today and series_detached = false and series_occurrence_id is null;
    if exists (select 1 from public.training_sessions where series_id = v_ret and session_date >= v_today and (series_detached or series_occurrence_id is not null)) then raise exception 'STOP B: pair % has detached/ledger-linked future sessions', i; end if;
    if exists (select 1 from public.training_sessions t join public.session_series_occurrences o on o.template_coach_id=t.coach_id and o.template_start_time=t.start_time and o.template_occurrence_date=t.session_date where t.id = any(v_ids)) then raise exception 'STOP B: pair % a candidate session has a ledger identity', i; end if;
    if coalesce(array_length(v_ids,1),0) <> v_exp then raise exception 'STOP B: pair %: expected % sessions to re-point, found %', i, v_exp, coalesce(array_length(v_ids,1),0); end if;
    if exists (select 1 from public.training_sessions k where k.series_id = v_keep and k.session_date in (select session_date from public.training_sessions where id = any(v_ids))) then raise exception 'STOP B: pair % survivor already owns a session on a re-pointed date (unique index)', i; end if;
    update public.training_sessions set series_id = v_keep where id = any(v_ids);
    get diagnostics v_n = row_count; if v_n <> v_exp then raise exception 'STOP B: pair % re-pointed % rows', i, v_n; end if;
    v_total := v_total + v_n;
    v_repointed := v_repointed || v_ids; v_repointed_keep := v_repointed_keep || coalesce((select array_agg(v_keep) from unnest(v_ids)), '{}');
    select max(session_date) into v_last from public.training_sessions where series_id = v_ret;
    update public.session_series set status = 'ended', ended_from_date = coalesce(v_last + 1, v_today) where id = v_ret;
    get diagnostics v_n = row_count; if v_n <> 1 then raise exception 'STOP B: pair % retire updated % rows', i, v_n; end if;
  end loop;
  if v_total <> 14 then raise exception 'STOP B: re-pointed % <> 14', v_total; end if;
  if (select count(*) from public.session_series where status='active') <> 18 or (select count(*) from public.session_series where status='ended') <> 32 then raise exception 'STOP B: active/ended series are not 18/32'; end if;
  select count(*) into v_conf from (
    select f.coach_id, f.start_time, d::date from (select distinct coach_id, start_time from public.session_series where status='active' and repeat_mode='ongoing') f
    cross join generate_series(v_today, v_hend, interval '1 day') d
    where (select count(*) from public.session_series s where s.coach_id=f.coach_id and s.start_time=f.start_time and s.status='active' and s.repeat_mode='ongoing' and d::date >= s.anchor_date and mod(d::date - s.anchor_date, 7) = 0 and not (d::date = any(s.skip_dates)) and (s.ended_from_date is null or d::date < s.ended_from_date)) >= 2
      and not exists (select 1 from public.session_series_occurrences o where o.template_coach_id=f.coach_id and o.template_start_time=f.start_time and o.template_occurrence_date=d::date)) x;
  if v_conf <> 0 then raise exception 'STOP B: % unresolved-ownership dates remain', v_conf; end if;
  -- ===== C. restore the capacity-4 series' empty 2026-11-08 roster BEFORE any generation =====
  if (select max_participants from public.training_sessions where id = c_s39_dst) <> 4 or (select session_date from public.training_sessions where id = c_s39_dst) <> date '2026-11-08'
     or (select session_date from public.training_sessions where id = c_s39_src) <> date '2026-11-01' then raise exception 'STOP C: S39 session identity/capacity mismatch'; end if;
  select count(*) into v_ath_n from public.session_registrations where session_id = c_s39_src and status = 'active';
  select count(*) into v_man_n from public.session_manual_participants where session_id = c_s39_src;
  if v_ath_n <> 3 or v_man_n <> 1 then raise exception 'STOP C: source roster is %/% not 3/1', v_ath_n, v_man_n; end if;
  if (select count(*) from public.session_registrations where session_id=c_s39_dst) <> 0 or (select count(*) from public.session_manual_participants where session_id=c_s39_dst) <> 0 then raise exception 'STOP C: destination is not empty'; end if;
  if exists (select 1 from public.session_registrations sr join public.profiles pp on pp.user_id=sr.user_id where sr.session_id=c_s39_src and sr.status='active'
             and (pp.approval_status <> 'approved' or pp.role not in ('athlete','coach') or public.athlete_disabled_on_date(sr.user_id, date '2026-11-08') or sr.user_id = (select coach_id from public.training_sessions where id=c_s39_dst))) then raise exception 'STOP C: a source athlete is no longer eligible'; end if;
  if exists (select 1 from public.subscriptions sb join public.session_registrations sr on sr.user_id=sb.payee_id where sr.session_id=c_s39_src and sb.deleted_at is null) then raise exception 'STOP C: a source athlete has an active subscription'; end if;
  if auth.uid() is not null then raise exception 'STOP C: expected a no-identity (migration) context'; end if;
  select count(*) into h0 from public.registration_history where session_id = c_s39_dst;
  perform public._copy_session_roster(c_s39_src, c_s39_dst);
  select count(*) into h1 from public.registration_history where session_id = c_s39_dst;
  if (select count(*) from public.session_registrations where session_id=c_s39_dst and status='active') <> 3 or (select count(*) from public.session_manual_participants where session_id=c_s39_dst) <> 1
     or h1 - h0 <> 3 or public.active_registration_count(c_s39_dst) > 4 then raise exception 'STOP C: restore did not produce exactly 3 athletes + 1 manual (+3 history)'; end if;
  -- ===== D. one controlled run of the normal generator (the exact function cron runs) =====
  
  select string_agg(s.coach_id||'|'||s.start_time||'|'||d::date, ',' order by s.coach_id, s.start_time, d::date) into v_expected
  from public.session_series s cross join generate_series(v_today, v_hend, interval '1 day') d
  where s.status='active' and s.repeat_mode='ongoing' and d::date >= s.anchor_date and mod(d::date - s.anchor_date, 7) = 0 and not (d::date = any(s.skip_dates)) and (s.ended_from_date is null or d::date < s.ended_from_date)
    and not exists (select 1 from public.training_sessions t where t.coach_id=s.coach_id and t.start_time=s.start_time and t.session_date=d::date)
    and not exists (select 1 from public.session_series_occurrences o where o.template_coach_id=s.coach_id and o.template_start_time=s.start_time and o.template_occurrence_date=d::date);
  raise notice 'D: predicted generation set: %', coalesce(v_expected, '(none)');
  if v_expected is distinct from c_expected then raise exception 'STOP D: predicted generation set % differs from the reviewed expected set %', v_expected, c_expected; end if;
  perform public.cron_maintain_session_series_horizon();
  select string_agg(t.coach_id||'|'||t.start_time||'|'||t.session_date, ',' order by t.coach_id, t.start_time, t.session_date) into v_created
  from public.training_sessions t where t.series_occurrence_id is not null and t.created_at >= transaction_timestamp();
  if v_created is distinct from c_expected then raise exception 'STOP D: generated set % differs from the reviewed expected set %', v_created, c_expected; end if;
  -- E. second run must be a no-op
  select count(*) into v_n from public.training_sessions; select count(*) into v_ev_n from public.session_series_occurrences;
  perform public.cron_maintain_session_series_horizon();
  if (select count(*) from public.training_sessions) <> v_n or (select count(*) from public.session_series_occurrences) <> v_ev_n then raise exception 'STOP E: second generator run was not a no-op'; end if;
  -- ===== F. final invariants =====
  select count(*) into v_dups from (select coach_id, session_date, start_time from public.training_sessions group by 1,2,3 having count(*)>1) z;
  if v_dups <> 0 then raise exception 'STOP F: duplicate physical slots'; end if;
  select count(*) into v_missing from public.session_series s cross join generate_series(v_today, v_hend, interval '1 day') d
   where s.status='active' and s.repeat_mode='ongoing' and d::date >= s.anchor_date and mod(d::date - s.anchor_date, 7) = 0 and not (d::date = any(s.skip_dates)) and (s.ended_from_date is null or d::date < s.ended_from_date)
     and not exists (select 1 from public.training_sessions t where t.coach_id=s.coach_id and t.start_time=s.start_time and t.session_date=d::date)
     and not exists (select 1 from public.session_series_occurrences o where o.template_coach_id=s.coach_id and o.template_start_time=s.start_time and o.template_occurrence_date=d::date);
  if v_missing <> 0 then raise exception 'STOP F: % scheduled dates still have no session', v_missing; end if;
  if exists (select 1 from unnest(v_pre_sessions) x where not exists (select 1 from public.training_sessions t where t.id = x)) then raise exception 'STOP F: a pre-existing session disappeared'; end if;
  if (select md5(string_agg(id||'|'||session_date||'|'||start_time||'|'||coach_id||'|'||max_participants||'|'||is_hidden||'|'||is_open_for_registration||'|'||duration_minutes||'|'||series_detached||'|'||coalesce(custom_slot_price_ils::text,'')||'|'||coalesce(custom_coach_rate_ils::text,''), ',' order by id)) from public.training_sessions where id = any(v_pre_sessions)) is distinct from v_pre_fam_md5 then
    raise exception 'STOP F: a pre-existing session changed (date/time/coach/capacity/flags/prices)'; end if;
  -- every generated session: roster == what its source dictates (copy) or empty (none); history exactly one event per copied athlete
  for r in select t.id, t.series_id, t.session_date, s.roster_policy from public.training_sessions t join public.session_series s on s.id=t.series_id
           where t.series_occurrence_id is not null and t.created_at >= transaction_timestamp() loop
    v_src := case when r.roster_policy = 'copy_on_generate' then public._series_roster_source_session(r.series_id, r.session_date) end;
    select count(*) into v_ath_n from public.session_registrations where session_id = r.id and status='active';
    select count(*) into v_man_n from public.session_manual_participants where session_id = r.id;
    if v_src is null then
      if v_ath_n <> 0 or v_man_n <> 0 then raise exception 'STOP F: non-copy generated session has a roster'; end if;
    else
      if (select coalesce(string_agg(manual_participant_id::text, ',' order by manual_participant_id), '') from public.session_manual_participants where session_id = r.id)
         is distinct from (select coalesce(string_agg(manual_participant_id::text, ',' order by manual_participant_id), '') from public.session_manual_participants where session_id = v_src) then raise exception 'STOP F: manual roster of generated session differs from its source'; end if;
      if v_ath_n <> (select count(*) from public.session_registrations s2 join public.profiles p on p.user_id=s2.user_id where s2.session_id=v_src and s2.status='active' and p.approval_status='approved' and p.role in ('athlete','coach') and not public.athlete_disabled_on_date(s2.user_id, r.session_date)) then raise exception 'STOP F: athlete roster of generated session differs from its eligible source'; end if;
    end if;
    if (select count(*) from public.registration_history where session_id = r.id) <> v_ath_n then raise exception 'STOP F: registration history mismatch'; end if;
    v_new_n := coalesce(v_new_n, 0) + 1;
  end loop;
  if (select count(*) from public.session_registrations where session_id = c_s39_dst and status='active') <> 3 or (select count(*) from public.session_manual_participants where session_id = c_s39_dst) <> 1 then raise exception 'STOP F: S39 11-08 roster lost'; end if;
  if public._series_roster_source_session(c_s39_ser, date '2026-11-15') is distinct from c_s39_dst then raise exception 'STOP F: the repaired 11-08 is not the roster source for S39 11-15'; end if;
  if (select count(*) from public.session_series where status='active') <> 18 or (select count(*) from public.session_series where status='ended') <> 32 then raise exception 'STOP F: active/ended series are not 18/32'; end if;
  if (select count(*) from public.session_series where id = any(c_retired) and status = 'ended') <> 11 then raise exception 'STOP F: not all 11 redundant series are retired'; end if;
  if exists (select 1 from public.training_sessions t where t.series_id = any(c_retired) and t.session_date >= v_today and not t.series_detached) then raise exception 'STOP F: a future non-detached session is still attached to a retired series'; end if;
  if exists (select 1 from unnest(v_repointed, v_repointed_keep) u(sid, kid) where not exists (select 1 from public.training_sessions t where t.id = u.sid and t.series_id = u.kid)) then raise exception 'STOP F: a re-pointed session does not belong to its survivor'; end if;
  if cardinality(v_repointed) <> 14 then raise exception 'STOP F: re-point list size'; end if;
  if exists (select 1 from (select s.coach_id, s.start_time, extract(dow from s.anchor_date) dw from public.session_series s where s.id = any(c_ser_ids) group by 1,2,3) f
             where (select count(*) from public.session_series s2 where s2.status='active' and s2.repeat_mode='ongoing' and s2.coach_id=f.coach_id and s2.start_time=f.start_time and extract(dow from s2.anchor_date)=f.dw) <> 1) then raise exception 'STOP F: an affected slot does not have exactly one active series'; end if;
  if (select md5(coalesce(string_agg(x, E'\n' order by x), '')) from (
    select 'R|'||id||'|'||session_id||'|'||user_id||'|'||status||'|'||coalesce(attended::text,'-')||'|'||coalesce(payment_method::text,'-')||'|'||coalesce(amount_paid::text,'-')||'|'||charge_no_show from public.session_registrations where session_id = any(c_sess_ids) and session_id <> c_s39_dst
    union all select 'M|'||session_id||'|'||manual_participant_id from public.session_manual_participants where session_id = any(c_sess_ids) and session_id <> c_s39_dst
    union all select 'H|'||session_id||'|'||user_id||'|'||event_type from public.registration_history where session_id = any(c_sess_ids) and session_id <> c_s39_dst
    union all select 'N|'||id||'|'||session_id from public.session_notes where session_id = any(c_sess_ids)
    union all select 'P|'||id||'|'||session_id from public.session_roster_slot_prices where session_id = any(c_sess_ids)
    union all select 'C|'||id||'|'||session_id from public.cancellations where session_id = any(c_sess_ids)
    union all select 'W|'||id||'|'||session_id from public.waitlist_requests where session_id = any(c_sess_ids)
  ) q(x)) is distinct from v_pre_aux then raise exception 'STOP F: registrations/manual/history/notes/prices/cancellations of the re-pointed sessions changed'; end if;
  -- Only rows written BY THIS TRANSACTION count (events already on these sessions, e.g. the 2026-10-04 session_created of S39 11-08, are legitimate
  -- history). user_activity_events.created_at defaults to now(), i.e. the transaction start, so anything this transaction inserts is >= transaction_timestamp().
  if exists (select 1 from public.user_activity_events e where e.created_at >= transaction_timestamp()
             and (e.target_id = any(select id::text from public.training_sessions where created_at >= transaction_timestamp() union select c_s39_dst::text)
                  or e.metadata->>'session_id' = any(select id::text from public.training_sessions where created_at >= transaction_timestamp() union select c_s39_dst::text))) then raise exception 'STOP F: the recovery wrote activity-log entries'; end if;
  if exists (select 1 from public.session_series_occurrences o where o.training_session_id is null and o.state in ('generated','edited')) then raise exception 'STOP F: occurrence ledger inconsistent'; end if;
  raise notice 'RECOVERY OK: re-pointed % sessions, retired % series, generated % session(s), S39 11-08 restored, 0 unresolved, 0 missing, 0 duplicates', v_total, array_length(c_pairs,1), coalesce(v_new_n,0);
end $recovery$;
