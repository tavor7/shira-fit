-- Weekly open: avoid broad side-effect permissions.
-- Use Edge Function cron (service role) or manager manual open RPC.

revoke execute on function public.open_next_week_sessions_if_due() from authenticated;
revoke execute on function public.open_next_week_sessions_if_due() from anon;

