-- Task 3 follow-up: persist web-push delivery OUTCOMES so a silently-failing subscription (the
-- confirmed/likely cause of "only one manager receives the group-spot-available push" -- recipient
-- selection itself was verified correct against production data and is NOT changed by this
-- migration) is diagnosable instead of invisible. Previously send-web-push / sendWebPushToUser only
-- console.error'd a non-404/410 failure; nothing queryable recorded whether a given user's push
-- actually went out. This is purely additive logging infrastructure -- no recipient-selection,
-- idempotency, or kill-switch behavior changes anywhere.

create table if not exists public.web_push_delivery_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  subscription_id uuid references public.web_push_subscriptions (id) on delete set null,
  notification_kind text,
  outcome text not null check (outcome in ('sent', 'failed', 'pruned')),
  http_status int,
  error_detail text,
  created_at timestamptz not null default now()
);

create index if not exists web_push_delivery_log_user_idx
  on public.web_push_delivery_log (user_id, created_at desc);

alter table public.web_push_delivery_log enable row level security;

drop policy if exists web_push_delivery_log_manager_select on public.web_push_delivery_log;
create policy web_push_delivery_log_manager_select on public.web_push_delivery_log
  for select
  using (public.is_manager(auth.uid()));

comment on table public.web_push_delivery_log is
  'Per-subscription delivery outcome for every web-push send attempt (sent/failed/pruned), written '
  'by the send-web-push Edge Function''s service-role connection (RLS has no client-write policy -- '
  'only a manager can SELECT, for diagnosing delivery problems like one manager silently not '
  'receiving a notification another manager does). notification_kind is free-text, threaded through '
  'from whatever caller invoked invoke_send_web_push_edge -- not an enum, so new notification types '
  'never need a migration here.';
