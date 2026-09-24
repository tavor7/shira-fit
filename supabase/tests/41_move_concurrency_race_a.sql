select set_config('app.current_uid', (select v::text from _move_conc_ids where k='manager'), false);
select pg_sleep(0.3);
select public.staff_move_session_participant(
  (select v from _move_conc_ids where k='w'),
  (select v from _move_conc_ids where k='y'),
  (select v from _move_conc_ids where k='h'),
  null
) as race_move_result;
