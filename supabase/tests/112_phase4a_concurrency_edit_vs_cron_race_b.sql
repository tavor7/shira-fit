-- Race 1, side B: the daily cron. Run concurrently with 111_..._race_a.sql (two separate psql
-- processes). pg_sleep(0.3) synchronizes so both sides' real work overlaps.
select pg_sleep(0.3);
do $$
declare
  v_res json;
begin
  v_res := public.generate_due_subscription_charges();
  raise notice 'RACE1-B cron result: %', v_res;
end $$;
