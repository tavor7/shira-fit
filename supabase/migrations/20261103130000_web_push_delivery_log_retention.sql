-- Keep web_push_delivery_log for 90 days. It is diagnostic only: one row per push attempt, read by nothing but a manager
-- policy, and nothing references it. This job can only delete from this one table.

create or replace function public._web_push_delivery_log_prune()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_deleted integer;
begin
  delete from public.web_push_delivery_log where created_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public._web_push_delivery_log_prune() from public, anon, authenticated;

select cron.schedule('web-push-delivery-log-retention', '20 3 * * *', 'select public._web_push_delivery_log_prune();');
