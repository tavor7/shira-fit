set client_min_messages to notice;

-- Concurrency setup: a subscription with an already-due-but-not-yet-billed first period. Two
-- concurrent processes both run generate_due_subscription_charges() -- exactly one billing
-- period row and one original charge must result, never two.
drop table if exists _billing_conc_ids;
create table _billing_conc_ids (k text primary key, v uuid);

do $$
declare
  v_p uuid; v_sub uuid; v_ver uuid; v_start date;
begin
  v_p := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_p, 'athlete_bconc', 'Athlete BConc', '0500001099', 'athlete', 'approved');

  v_start := current_date - 2;
  insert into public.subscriptions (payee_id, payee_is_manual) values (v_p, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_start, 300, extract(day from v_start)::int, v_start) returning id into v_ver;

  insert into _billing_conc_ids values ('p', v_p), ('sub', v_sub), ('ver', v_ver);
end $$;
