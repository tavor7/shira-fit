-- Allow authenticated clients to run the idempotent weekly opener as a backup when Edge cron
-- is delayed or not configured. Matches prior behavior before 20260409121000_weekly_open_permissions.
grant execute on function public.open_next_week_sessions_if_due() to authenticated;
