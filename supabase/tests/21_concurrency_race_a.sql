select set_config('app.current_uid', (select v::text from _conc_ids where k='d'), false);
select pg_sleep(0.3);
select public.register_for_session((select v from _conc_ids where k='sess')) as race_a_result;
