select set_config('app.current_uid', (select v::text from _move_conc_ids where k='h'), false);
select pg_sleep(0.3);
select public.register_for_session((select v from _move_conc_ids where k='z')) as race_register_result;
