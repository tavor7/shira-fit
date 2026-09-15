-- Terms of Use / Privacy Policy / Accessibility rollout (Phase 3, step 5).
-- Marketing consent stays fully separate from Terms/Privacy: it is optional, never
-- blocks signup or app use, and is recorded via the existing generic
-- record_user_consent RPC (consent_type = 'marketing_communications', already usable
-- with no change — it only special-cases electronic_receipts internally).
--
-- This migration adds:
--   1. A read RPC for the marketing toggle in notification settings.
--   2. Category enforcement on the two send paths that can carry promotional content:
--      manager direct messages (in-app inbox) and the manager push broadcast. Both now
--      take an explicit operational/marketing category; 'marketing' sends are filtered
--      to recipients with a current, accepted marketing_communications consent.
--   3. System-generated sends (session reminders, waitlist, weekly-open, birthday, etc.)
--      are untouched — they never set a category, so they keep defaulting to
--      'operational' per the column default added in the schema migration.

create or replace function public.get_marketing_consent_status()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.legal_documents%rowtype;
  v_accepted boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;

  select * into v_doc from public.legal_documents
  where consent_type = 'marketing_communications' and is_current limit 1;

  if v_doc.id is null then
    return json_build_object('ok', true, 'available', false);
  end if;

  select public.has_current_marketing_consent(v_uid) into v_accepted;

  return json_build_object(
    'ok', true,
    'available', true,
    'accepted', coalesce(v_accepted, false),
    'version', v_doc.version,
    'title', v_doc.title, 'body_text', v_doc.body_text,
    'title_en', v_doc.title_en, 'body_text_en', v_doc.body_text_en
  );
end; $$;

grant execute on function public.get_marketing_consent_status() to authenticated;

-- send_manager_direct_message: add explicit category. Marketing sends require the
-- recipient to already have accepted current marketing consent, or the send is refused
-- (so the manager UI can show why, rather than silently dropping the message).
drop function if exists public.send_manager_direct_message(uuid, text, text);

create or replace function public.send_manager_direct_message(
  p_recipient_id uuid,
  p_body text,
  p_theme text default 'love',
  p_category public.communication_category default 'operational'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_body text := trim(coalesce(p_body, ''));
  v_theme text := lower(trim(coalesce(p_theme, 'love')));
  v_category public.communication_category := coalesce(p_category, 'operational');
  v_id uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_recipient_id is null or p_recipient_id = v_uid then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;
  if v_body = '' or char_length(v_body) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_body');
  end if;
  if v_theme not in ('love', 'happy', 'work') then
    return jsonb_build_object('ok', false, 'error', 'invalid_theme');
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_recipient_id
      and p.role in ('athlete', 'coach', 'manager')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_recipient');
  end if;
  if v_category = 'marketing' and not public.has_current_marketing_consent(p_recipient_id) then
    return jsonb_build_object('ok', false, 'error', 'recipient_marketing_consent_missing');
  end if;

  insert into public.manager_direct_messages (sender_id, recipient_id, body, message_theme, category)
  values (v_uid, p_recipient_id, v_body, v_theme, v_category)
  returning id into v_id;

  perform public._insert_activity_event(
    v_uid,
    'manager_direct_message_sent',
    'manager_direct_message',
    v_id::text,
    jsonb_build_object(
      'message_id', v_id::text,
      'recipient_user_id', p_recipient_id::text,
      'theme', v_theme,
      'category', v_category::text,
      'body_preview', left(v_body, 200)
    )
  );

  return jsonb_build_object('ok', true, 'id', v_id::text);
end;
$$;

grant execute on function public.send_manager_direct_message(uuid, text, text, public.communication_category) to authenticated;

-- send_custom_push_notification: same category gate, applied to the recipient loop
-- (skips anyone without current marketing consent instead of refusing the whole send,
-- since this is a broadcast to many users at once).
drop function if exists public.send_custom_push_notification(text);

create or replace function public.send_custom_push_notification(
  p_body text,
  p_category public.communication_category default 'operational'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_title text := 'הודעה מהסטודיו';
  v_body text := trim(coalesce(p_body, ''));
  v_category public.communication_category := coalesce(p_category, 'operational');
  v_row record;
  v_count int := 0;
  v_skipped_no_consent int := 0;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if v_body = '' then
    return json_build_object('ok', false, 'error', 'body_required');
  end if;
  if not public._push_notifications_enabled() then
    return json_build_object('ok', false, 'error', 'push_disabled');
  end if;

  for v_row in
    select p.user_id, p.expo_push_token
    from public.profiles p
    where p.disabled_at is null
      and (p.role != 'athlete' or p.approval_status = 'approved')
  loop
    if v_category = 'marketing' and not public.has_current_marketing_consent(v_row.user_id) then
      v_skipped_no_consent := v_skipped_no_consent + 1;
      continue;
    end if;

    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('to', v_row.expo_push_token, 'title', v_title, 'body', v_body)
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(v_row.user_id, v_title, v_body, '{}'::jsonb);
    exception when others then
      null;
    end;

    v_count := v_count + 1;
  end loop;

  return json_build_object('ok', true, 'notified', v_count, 'skipped_no_marketing_consent', v_skipped_no_consent);
end;
$$;

grant execute on function public.send_custom_push_notification(text, public.communication_category) to authenticated;
