-- Race 2, side A: manager freezes the exact session date. Run concurrently with
-- 116_..._race_b.sql (registration).
select pg_sleep(0.3);
do $$
declare
  v_manager uuid; v_sub uuid; v_date date; v_res json;
begin
  select v into v_manager from _p4a_race_ids where k = 'r2_manager';
  select v into v_sub from _p4a_race_ids where k = 'r2_sub';
  select v into v_date from _p4a_race_dates where k = 'r2_freeze_date';
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.freeze_subscription(v_sub, v_date, v_date, true);
  raise notice 'RACE2-A freeze result: %', v_res;
end $$;
