-- Race 3, side B: the athlete registers for the contested session. Run concurrently with
-- 119_..._race_a.sql (stop).
select pg_sleep(0.3);
do $$
declare
  v_athlete uuid; v_sess uuid; v_res json;
begin
  select v into v_athlete from _p4a_race_ids where k = 'r3_athlete';
  select v into v_sess from _p4a_race_ids where k = 'r3_sess';
  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.register_for_session(v_sess, true);
  raise notice 'RACE3-B register result: %', v_res;
end $$;
