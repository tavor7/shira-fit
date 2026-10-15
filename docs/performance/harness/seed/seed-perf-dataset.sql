-- Synthetic performance dataset for the ISOLATED local stack (docs/performance/README.md). Never run on production or the preview stack.
-- Shape mirrors production aggregates on 2026-10-15 (counts, capacity mix, hidden share, attendance/payment ratios); all names,
-- phones and texts are synthetic. Dates are relative to current_date so the dataset stays "live" (past history + ~5 future weeks).
--
-- Run: docker exec -i supabase_db_shirafit-perf psql -U postgres -v ON_ERROR_STOP=1 -f - < seed-perf-dataset.sql
-- Deliberately skipped (documented in README): documents, registration_history, activity events, subscriptions, session series.

\set ON_ERROR_STOP 1

do $$
begin
  if exists (select 1 from auth.users where email not like '%@perf.test') then
    raise exception 'refusing to seed: this database has users outside @perf.test (not the isolated perf stack)';
  end if;
  if (select count(*) from auth.users) <> 163 then
    raise exception 'expected the 163 @perf.test users from create-perf-users.mjs, found %', (select count(*) from auth.users);
  end if;
  if exists (select 1 from public.training_sessions) then
    raise exception 'already seeded: training_sessions is not empty (recreate the stack to reseed)';
  end if;
end $$;

begin;
-- Synthetic bulk load: skip user triggers (activity log, subscription reconcile, notifications, receipt guards).
set local session_replication_role = replica;
select setseed(0.4242);

-- ---------------------------------------------------------------- people
create temp table u on commit drop as
select au.id, au.email,
       case when au.email like 'perf-mgr-%' then 'manager' when au.email like 'perf-coach-%' then 'coach' else 'athlete' end as role,
       case when au.email like 'perf-ath-%' then substring(au.email from 'perf-ath-(\d+)')::int end as ath_n
from auth.users au;

update public.profiles p
set role = u.role::public.user_role,
    approval_status = 'approved',
    is_super_user = (u.email = 'perf-mgr-1@perf.test'),
    calendar_color = case u.email when 'perf-coach-1@perf.test' then '#E57373' when 'perf-coach-2@perf.test' then '#64B5F6'
                                  when 'perf-coach-3@perf.test' then '#81C784' when 'perf-mgr-2@perf.test' then '#FFB74D' end,
    health_declaration_confirmed_at = now()
from u where u.id = p.user_id;

create temp table mgr on commit drop as select id from u where email = 'perf-mgr-2@perf.test';
create temp table sup on commit drop as select id from u where email = 'perf-mgr-1@perf.test';
-- Four distinct session coaches, as in production (3 coaches + 1 teaching manager).
create temp table coaches on commit drop as
select id, row_number() over (order by email) as cn from u where role = 'coach' or email = 'perf-mgr-2@perf.test';
create temp table aths on commit drop as select id, ath_n from u where role = 'athlete';

-- ---------------------------------------------------------------- sessions (~807 over 221 days, ~25/week)
create temp table s on commit drop as
with cand as (
  select d::date as session_date, h, c.id as coach_id, random() as r_keep, random() as r_cap
  from generate_series(current_date - 186, current_date + 34, interval '1 day') d
  cross join generate_series(6, 21) h
  cross join coaches c
)
select gen_random_uuid() as id, session_date, make_time(h, 0, 0) as start_time, coach_id,
       case when r_cap < 0.341 then 12 when r_cap < 0.701 then 1 when r_cap < 0.867 then 2 when r_cap < 0.955 then 3
            when r_cap < 0.981 then 4 when r_cap < 0.995 then 5 when r_cap < 0.998 then 6 else 10 end as cap
from cand where r_keep < 0.0571;

insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, duration_minutes, is_hidden,
                                      is_open_for_registration, is_kickbox, created_at, updated_at)
select id, session_date, start_time, coach_id, cap, 55, cap < 12,
       cap = 12 and session_date <= current_date + 7,
       false, session_date - 14, session_date - 14
from s;

-- three kickbox group sessions, six custom slot prices, one custom coach rate (production counts)
update public.training_sessions set is_kickbox = true where id in (select id from s where cap = 12 order by id limit 3);
update public.training_sessions set custom_slot_price_ils = 90 where id in (select id from s where cap = 1 order by id limit 6);
update public.training_sessions set custom_coach_rate_ils = 150 where id in (select id from s where cap = 12 order by id desc limit 1);

-- ---------------------------------------------------------------- registrations (active ≈ 3.8/session)
-- Athlete choice is skewed so low numbers are heavy users (perf-ath-001 ≈ 100 registrations, like production's max of 99).
create temp table reg_cand on commit drop as
select s.id as session_id, s.session_date, s.cap, k.k,
       1 + floor(157 * power(random(), 2.2))::int as ath_n, random() as r
from s
cross join lateral generate_series(1, 24) k(k);

create temp table reg_active on commit drop as
with dedup as (
  select distinct on (session_id, ath_n) session_id, session_date, cap, ath_n, r
  from reg_cand order by session_id, ath_n, r
), ranked as (
  select *, row_number() over (partition by session_id order by r) as rn from dedup
), target as (
  select id as session_id,
         case when cap = 12 then floor(random() * 8)::int when cap = 1 then 1 else greatest(1, cap - (random() < 0.3)::int) end as k
  from s
)
select r.session_id, r.session_date, r.ath_n
from ranked r join target t on t.session_id = r.session_id
where r.rn <= t.k;

insert into public.session_registrations (session_id, user_id, registered_at, status, attended, payment_method, amount_paid,
                                          charge_no_show, payment_recorded_by, payment_recorded_at)
select ra.session_id, a.id, ra.session_date - (1 + floor(random() * 10))::int, 'active',
       case when ra.session_date < current_date then (x.r_att < 0.922) end,
       case when ra.session_date < current_date and x.r_pay < 0.36
            then (array['cash','paybox','other','mom'])[1 + floor(x.r_pm * 4)::int] end,
       case when ra.session_date < current_date and x.r_pay < 0.36 then (60 + floor(x.r_amt * 7) * 10)::numeric end,
       (ra.session_date < current_date and x.r_att >= 0.922 and x.r_ns < 0.69),
       case when ra.session_date < current_date and x.r_pay < 0.36 then (select id from mgr) end,
       case when ra.session_date < current_date and x.r_pay < 0.36 then ra.session_date + time '20:00' end
from reg_active ra
join aths a on a.ath_n = ra.ath_n
cross join lateral (select random() as r_att, random() as r_pay, random() as r_pm, random() as r_amt, random() as r_ns) x;

-- cancelled registrations (~729) on other athletes
create temp table reg_cancel on commit drop as
with c as (
  select distinct on (rc.session_id, rc.ath_n) rc.session_id, rc.session_date, rc.ath_n
  from reg_cand rc
  where not exists (select 1 from reg_active ra where ra.session_id = rc.session_id and ra.ath_n = rc.ath_n)
  order by rc.session_id, rc.ath_n, rc.r
)
select * from c order by md5(session_id::text || ath_n::text) limit 729;

insert into public.session_registrations (session_id, user_id, registered_at, status)
select rc.session_id, a.id, rc.session_date - 5, 'cancelled'
from reg_cancel rc join aths a on a.ath_n = rc.ath_n;

-- cancellations rows (510, 68 charged)
insert into public.cancellations (session_id, user_id, cancelled_at, reason, charged_full_price, penalty_collected_ils, payment_method)
select x.session_id, a.id, x.session_date - 1 + time '18:00', 'Synthetic reason', x.rn <= 68,
       case when x.rn <= 30 then 80 else 0 end, case when x.rn <= 30 then 'paybox' end
from (select rc.*, row_number() over (order by md5(rc.session_id::text)) rn from reg_cancel rc) x
join aths a on a.ath_n = x.ath_n
where x.rn <= 510;

-- ---------------------------------------------------------------- manual participants (43 people, ~497 links)
insert into public.manual_participants (full_name, phone, gender, created_by, created_at)
select 'Perf Walk-in ' || lpad(g::text, 2, '0'), '0520' || lpad(g::text, 6, '0'), 'female', (select id from mgr), now() - interval '150 days'
from generate_series(1, 43) g;

create temp table mp on commit drop as select id, row_number() over (order by full_name) as mn from public.manual_participants;

insert into public.session_manual_participants (session_id, manual_participant_id, added_at, attended, payment_method, amount_paid,
                                                charge_no_show, payment_recorded_by, payment_recorded_at)
select distinct on (x.session_id, x.mn) x.session_id, mp.id, x.session_date - 1,
       case when x.session_date < current_date then x.r < 0.93 end,
       case when x.session_date < current_date and x.r < 0.4 then 'cash' end,
       case when x.session_date < current_date and x.r < 0.4 then 70::numeric end,
       false,
       case when x.session_date < current_date and x.r < 0.4 then (select id from mgr) end,
       case when x.session_date < current_date and x.r < 0.4 then x.session_date + time '20:00' end
from (
  select s.id as session_id, s.session_date, 1 + floor(43 * power(random(), 1.5))::int as mn, random() as r
  from s cross join generate_series(1, 2) k
  where s.cap = 12
) x join mp on mp.mn = x.mn
order by x.session_id, x.mn
limit 497;

-- ---------------------------------------------------------------- waitlist (9), notes (36 + 10)
insert into public.waitlist_requests (session_id, user_id, requested_at)
select distinct on (s.id) s.id, a.id, now() - interval '1 day'
from s join aths a on a.ath_n = 140 + (abs(hashtext(s.id::text)) % 15)
where s.cap = 12 and s.session_date between current_date and current_date + 7
  and not exists (select 1 from public.session_registrations r where r.session_id = s.id and r.user_id = a.id)
limit 9;

insert into public.session_notes (session_id, author_id, body, created_at)
select id, (select id from mgr), 'Synthetic session note', session_date - 1
from s order by md5(id::text) limit 36;

insert into public.studio_calendar_notes (start_date, end_date, title, detail, kind, audience, created_by)
select current_date - 180 + g * 20, current_date - 180 + g * 20 + (g % 2), 'Synthetic holiday ' || g, null,
       case when g = 10 then 'info' else 'holiday' end, 'all', (select id from mgr)
from generate_series(1, 10) g;

-- ---------------------------------------------------------------- account payments (229), families (8 / 18)
insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, note, paid_at, created_by, created_at)
select a.id, false, (100 + (g % 8) * 50)::numeric, (array['paybox','other','cash','mom','discount'])[1 + (g % 5)], null,
       current_date - (g % 180), (select id from mgr), current_date - (g % 180)
from generate_series(1, 229) g join aths a on a.ath_n = 1 + (g * 7) % 60;

insert into public.athlete_families (name) select 'Perf Family ' || g from generate_series(1, 8) g;
insert into public.athlete_family_members (family_id, user_id)
select f.id, a.id
from (select id, row_number() over (order by name) fn from public.athlete_families) f
join aths a on a.ath_n in (60 + f.fn * 3, 61 + f.fn * 3, case when f.fn <= 2 then 62 + f.fn * 3 end);

-- ---------------------------------------------------------------- pricing (15 global tiers, 28 coach rates, 13 personal, 25 roster)
insert into public.session_capacity_pricing (max_participants, price_ils, is_kickbox, effective_from, effective_to)
select cap, p_old, false, date '2026-01-01', date '2026-06-30' from (values (1,250),(2,180),(3,140),(4,120),(5,110),(12,70)) v(cap,p_old)
union all
select cap, p_new, false, date '2026-07-01', null from (values (1,260),(2,190),(3,145),(4,125),(5,115),(12,75)) v(cap,p_new)
union all select 12, 60, true, date '2026-01-01', date '2026-06-30'
union all select 12, 65, true, date '2026-07-01', null
union all select 6, 100, false, date '2026-01-01', null;

insert into public.coach_capacity_pricing (coach_id, max_participants, price_ils, effective_from)
select c.id, cap, 100 + cap * 15, date '2026-01-01'
from coaches c cross join (values (1),(2),(3),(4),(5),(6),(12)) v(cap);

insert into public.athlete_session_capacity_pricing (user_id, max_participants, price_ils, effective_from)
select a.id, case when a.ath_n % 2 = 0 then 12 else 1 end, 65, date '2026-01-01'
from aths a where a.ath_n between 1 and 13;

insert into public.session_roster_slot_prices (session_id, user_id, price_ils)
select r.session_id, r.user_id, 55
from public.session_registrations r where r.status = 'active' order by md5(r.id::text) limit 25;

-- ---------------------------------------------------------------- super-user hidden registrations (5)
insert into public.super_user_hidden_registrations (session_id, user_id, hidden_at, hidden_by, hide_from_athlete, hide_from_coach, hide_from_manager)
select r.session_id, r.user_id, now() - interval '10 days', (select id from sup), false, true, true
from public.session_registrations r join public.training_sessions t on t.id = r.session_id
where r.status = 'active' and t.max_participants = 1 order by md5(r.id::text) limit 5;

commit;

-- Repeatable measurements: no background jobs mutating data mid-run in this isolated stack.
select cron.unschedule(jobname) from cron.job;

analyze;

select 'sessions' k, count(*) n from public.training_sessions
union all select 'sessions_hidden', count(*) from public.training_sessions where is_hidden
union all select 'regs', count(*) from public.session_registrations
union all select 'regs_active', count(*) from public.session_registrations where status = 'active'
union all select 'regs_athlete_001', count(*) from public.session_registrations r join auth.users u on u.id = r.user_id where u.email = 'perf-ath-001@perf.test'
union all select 'manual_links', count(*) from public.session_manual_participants
union all select 'cancellations', count(*) from public.cancellations
union all select 'acct_payments', count(*) from public.athlete_account_payments;
