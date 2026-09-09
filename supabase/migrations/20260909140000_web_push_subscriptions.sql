-- Web Push (browser/PWA) subscriptions, alongside the existing native Expo push tokens.
-- One row per subscribed browser/device; a user can have several (multiple browsers/devices).

create table if not exists public.web_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists web_push_subscriptions_user_id_idx
  on public.web_push_subscriptions (user_id);

comment on table public.web_push_subscriptions is
  'Browser Push API subscriptions (endpoint + keys) for web/PWA push, separate from profiles.expo_push_token used by native apps.';

alter table public.web_push_subscriptions enable row level security;

create policy "own subscriptions select"
  on public.web_push_subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

create policy "own subscriptions insert"
  on public.web_push_subscriptions for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Needed for upsert()'s ON CONFLICT DO UPDATE path when a browser re-subscribes with an
-- endpoint already on file.
create policy "own subscriptions update"
  on public.web_push_subscriptions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own subscriptions delete"
  on public.web_push_subscriptions for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.web_push_subscriptions to authenticated;

-- Postgres-side trigger functions (e.g. session-updated notifications) call the
-- send-web-push Edge Function the same way public.invoke_notify_waitlist_edge calls
-- notify-waitlist: via pg_net, authenticated with a Vault-stored shared secret.
-- Setup (run once in Supabase SQL Editor, using the SAME value as Edge secret WEB_PUSH_INVOKE_SECRET):
--
--   select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-web-push', 'send_web_push_url');
--   select vault.create_secret('YOUR_WEB_PUSH_INVOKE_SECRET', 'send_web_push_secret');
--
-- If secrets are missing, this no-ops safely (same as the waitlist helper).
create extension if not exists pg_net;

create or replace function public.invoke_send_web_push_edge(p_user_id uuid, p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  if p_user_id is null then
    return;
  end if;

  select ds.decrypted_secret into v_url
  from vault.decrypted_secrets ds
  where ds.name = 'send_web_push_url'
  limit 1;

  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'send_web_push_secret'
  limit 1;

  if v_url is null or v_secret is null
     or length(trim(v_url)) < 10
     or length(trim(v_secret)) < 4
  then
    return;
  end if;

  perform net.http_post(
    url := trim(v_url),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || trim(v_secret)
    ),
    body := jsonb_build_object(
      'user_id', p_user_id::text,
      'title', p_title,
      'body', p_body,
      'data', coalesce(p_data, '{}'::jsonb)
    )
  );
end;
$$;

comment on function public.invoke_send_web_push_edge(uuid, text, text, jsonb) is
  'POSTs to send-web-push Edge Function if vault secrets send_web_push_url + send_web_push_secret are set. Fans out to every web_push_subscriptions row for the user.';

-- Internal use only (called via `perform` from other security definer trigger functions,
-- which run as this function's owner regardless of this revoke). Without this, any
-- authenticated/anonymous client could call it directly over PostgREST and spam arbitrary
-- users with push notifications.
revoke execute on function public.invoke_send_web_push_edge(uuid, text, text, jsonb) from public, anon, authenticated;
