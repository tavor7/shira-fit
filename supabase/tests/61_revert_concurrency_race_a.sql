select set_config('app.current_uid', (select v::text from _revert_conc_ids where k='manager'), false);
select pg_sleep(0.3);
select public.manager_revert_activity_event((select v from _revert_conc_ids where k='ev')) as race_revert_result;
