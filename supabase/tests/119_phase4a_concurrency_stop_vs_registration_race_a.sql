-- Race 3, side A: manager stops the subscription effective exactly on the contested session date.
-- Run concurrently with 120_..._race_b.sql (registration).
select pg_sleep(0.3);
do $$
declare
  v_manager uuid; v_sub uuid; v_date date; v_res json;
begin
  select v into v_manager from _p4a_race_ids where k = 'r3_manager';
  select v into v_sub from _p4a_race_ids where k = 'r3_sub';
  select v into v_date from _p4a_race_dates where k = 'r3_stop_date';
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.stop_subscription(v_sub, v_date, true);
  raise notice 'RACE3-A stop result: %', v_res;
end $$;
