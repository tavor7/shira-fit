select set_config('app.current_uid', (select v::text from _revert_conc_ids where k='j'), false);
select pg_sleep(0.3);
select public.register_for_session((select v from _revert_conc_ids where k='q')) as race_register_result;
