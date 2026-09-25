-- Race 1, side A: the manager edit. Run concurrently with 112_..._race_b.sql (two separate psql
-- processes). pg_sleep(0.3) synchronizes so both sides' real work overlaps.
select pg_sleep(0.3);
do $$
declare
  v_manager uuid; v_sub uuid; v_start date := current_date - 40; v_res json;
begin
  select v into v_manager from _p4a_race_ids where k = 'manager';
  select v into v_sub from _p4a_race_ids where k = 'sub1';
  perform set_config('app.current_uid', v_manager::text, true);
  -- Price drop 300 -> 200, effective 10 days into the first period.
  v_res := public.edit_subscription_version(v_sub, v_start + 10, 200, null, false, null, true);
  raise notice 'RACE1-A edit result: %', v_res;
end $$;
