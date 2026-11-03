-- Payment reminders: a manager reminds an athlete of what their account owes. Built on manager_direct_messages and the
-- existing app-open modal, not a separate messaging system. General messages behave exactly as before.
--
-- Account: a family account when the person belongs to one (the balance is the sum of its members), otherwise their own.
-- Amount: always calculated here from _period_merged_athlete_finance over its whole range, so payments already recorded
-- with a future date count. A client can state what it saw so a change is noticed, but never supplies the amount.
-- One unread reminder per account, whoever received it: a partial unique index, with a lock so the answer is a clean refusal.
-- Lifetime: pending until read (the athlete tapped the button), cancelled, or closed because the debt was settled.
-- Rows are kept as history. Fetching never marks one as read, so a closed app shows it again on the next open.
-- Nothing here writes to a financial table.

alter table public.manager_direct_messages
  add column message_kind text not null default 'general',
  add column amount_ils numeric(10, 2),
  add column shown_amount_ils numeric(10, 2),
  add column account_key text,
  add column is_family_account boolean,
  add column closed_at timestamptz,
  add column closed_reason text,
  add column closed_by uuid references auth.users (id) on delete set null;

alter table public.manager_direct_messages
  add constraint manager_direct_messages_kind_check check (message_kind in ('general', 'payment_reminder')),
  add constraint manager_direct_messages_closed_reason_check
    check (closed_reason is null or closed_reason in ('cancelled', 'settled', 'account_changed')),
  add constraint manager_direct_messages_kind_fields_check check (
    case message_kind
      when 'general' then amount_ils is null and shown_amount_ils is null and account_key is null
        and is_family_account is null and closed_at is null and closed_reason is null and closed_by is null
      else amount_ils > 0 and account_key is not null and is_family_account is not null
        and (closed_at is null) = (closed_reason is null)
    end
  );

create unique index manager_direct_messages_one_pending_reminder_uidx
  on public.manager_direct_messages (account_key)
  where message_kind = 'payment_reminder' and read_at is null and closed_at is null;

create index manager_direct_messages_reminder_history_idx
  on public.manager_direct_messages (account_key, created_at desc)
  where message_kind = 'payment_reminder';

-- A direct insert can only ever create a general message, so reminder validation cannot be skipped.
drop policy if exists manager_direct_messages_sender_insert on public.manager_direct_messages;
create policy manager_direct_messages_sender_insert on public.manager_direct_messages
  for insert with check (
    sender_id = auth.uid() and public.is_manager(auth.uid()) and message_kind = 'general'
  );

-- A recipient reaches a reminder only through get_pending_manager_direct_message, which rechecks the balance first.
-- Reading the table directly would show an amount that may be out of date.
drop policy if exists manager_direct_messages_recipient_select on public.manager_direct_messages;
create policy manager_direct_messages_recipient_select on public.manager_direct_messages
  for select using (recipient_id = auth.uid() and message_kind = 'general');

-- All-time balance per payee, including payments already recorded with a future date.
create or replace function public._payment_balance_rows()
returns table (kind text, pid text, balance numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select f.kind, f.pid, f.outstanding_ils
  from public._period_merged_athlete_finance('2000-01-01'::date, '2100-01-01'::date) f;
$function$;

-- 'family:<id>', 'user:<id>' or 'manual:<id>'. A person belongs to at most one family (unique indexes on the members table).
create or replace function public._payment_account_key(p_payee_id uuid, p_is_manual boolean)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (
      select 'family:' || fm.family_id::text
      from public.athlete_family_members fm
      where (not p_is_manual and fm.user_id = p_payee_id)
         or (p_is_manual and fm.manual_participant_id = p_payee_id)
         or (not p_is_manual and fm.manual_participant_id in (
               select mp.id from public.manual_participants mp where mp.linked_user_id = p_payee_id))
         or (p_is_manual and fm.user_id in (
               select mp.linked_user_id from public.manual_participants mp
               where mp.id = p_payee_id and mp.linked_user_id is not null))
      limit 1
    ),
    case when p_is_manual then 'manual:' else 'user:' end || p_payee_id::text
  );
$function$;

create or replace function public._payment_account_members(p_account_key text)
returns table (kind text, pid text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when fm.user_id is not null then 'app' else 'manual' end, coalesce(fm.user_id, fm.manual_participant_id)::text
  from public.athlete_family_members fm
  where p_account_key like 'family:%' and fm.family_id::text = substr(p_account_key, 8)
  union all
  select 'app', substr(p_account_key, 6) where p_account_key like 'user:%'
  union all
  select 'manual', substr(p_account_key, 8) where p_account_key like 'manual:%';
$function$;

create or replace function public._payment_account_balance(p_account_key text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(sum(b.balance), 0)::numeric(12, 2)
  from public._payment_account_members(p_account_key) m
  join public._payment_balance_rows() b on b.kind = m.kind and b.pid = m.pid;
$function$;

-- The finance function counts registrations hidden from an athlete, so an amount could reveal one.
create or replace function public._payment_account_has_hidden(p_account_key text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public._payment_account_members(p_account_key) m
    join public.super_user_hidden_registrations h on m.kind = 'app' and h.user_id::text = m.pid
    where h.unhidden_at is null and h.hide_from_athlete
  );
$function$;

-- Null means this person can receive a reminder.
create or replace function public._payment_recipient_ineligible_reason(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case
    when p.user_id is null then 'not_found'
    when p.role <> 'athlete' then 'not_athlete'
    when p.approval_status <> 'approved' then 'not_approved'
    when p.disabled_at is not null then 'account_disabled'
  end
  from (select 1) x
  left join public.profiles p on p.user_id = p_user_id;
$function$;

create or replace function public._payment_reminder_body(p_amount numeric, p_is_family boolean)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select 'היי! רצינו להזכיר שקיימת ' || case when p_is_family then 'בחשבון המשפחתי שלך' else 'בחשבונך' end
    || ' יתרה לתשלום בסך ₪' || rtrim(rtrim(to_char(p_amount, 'FM9999999990.00'), '0'), '.')
    || '. נשמח להסדרת התשלום מול הסטודיו. תודה!';
$function$;

-- Closes the account's pending reminder if nothing is owed any more. Returns the balance.
create or replace function public._payment_account_refresh(p_account_key text)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_balance numeric := public._payment_account_balance(p_account_key);
begin
  if v_balance <= 0 then
    update public.manager_direct_messages
    set closed_at = now(), closed_reason = 'settled'
    where account_key = p_account_key
      and message_kind = 'payment_reminder' and read_at is null and closed_at is null;
  end if;
  return v_balance;
end;
$function$;

create or replace function public.send_payment_reminder(p_recipient_id uuid, p_expected_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_balance numeric;
  v_is_family boolean;
  v_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_recipient_id is null or p_expected_amount is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;
  if public._payment_recipient_ineligible_reason(p_recipient_id) is not null then
    return jsonb_build_object('ok', false, 'error', 'recipient_not_eligible');
  end if;

  v_key := public._payment_account_key(p_recipient_id, false);
  v_is_family := v_key like 'family:%';

  -- Held to commit: double taps and two managers at once get one reminder and one clean refusal.
  perform pg_advisory_xact_lock(hashtextextended('shira.payment_reminder:' || v_key, 0));

  if public._payment_account_has_hidden(v_key) then
    return jsonb_build_object('ok', false, 'error', 'has_hidden_registrations');
  end if;

  v_balance := public._payment_account_refresh(v_key);
  if v_balance <= 0 then
    return jsonb_build_object('ok', false, 'error', 'no_debt');
  end if;
  if exists (
    select 1 from public.manager_direct_messages
    where account_key = v_key and message_kind = 'payment_reminder' and read_at is null and closed_at is null
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_pending');
  end if;
  if round(p_expected_amount, 2) <> v_balance then
    return jsonb_build_object('ok', false, 'error', 'balance_changed', 'current_amount', v_balance);
  end if;

  insert into public.manager_direct_messages
    (sender_id, recipient_id, body, message_theme, category, message_kind, amount_ils, account_key, is_family_account)
  values
    (v_uid, p_recipient_id, public._payment_reminder_body(v_balance, v_is_family), 'work', 'operational',
     'payment_reminder', v_balance, v_key, v_is_family)
  returning id into v_id;

  perform public._insert_activity_event(
    v_uid, 'payment_reminder_sent', 'manager_direct_message', v_id::text,
    jsonb_build_object('message_id', v_id::text, 'recipient_user_id', p_recipient_id::text, 'amount_ils', v_balance, 'family_account', v_is_family)
  );

  return jsonb_build_object('ok', true, 'id', v_id::text, 'amount', v_balance);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'already_pending');
end;
$function$;

-- Soft: the row stays in the history. Any manager may cancel, not only the sender.
create or replace function public.cancel_payment_reminder(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_msg public.manager_direct_messages%rowtype;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.manager_direct_messages
  set closed_at = now(), closed_reason = 'cancelled', closed_by = v_uid
  where id = p_message_id and message_kind = 'payment_reminder' and read_at is null and closed_at is null
  returning * into v_msg;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found_or_already_read');
  end if;

  perform public._insert_activity_event(
    v_uid, 'payment_reminder_cancelled', 'manager_direct_message', p_message_id::text,
    jsonb_build_object('message_id', p_message_id::text, 'recipient_user_id', v_msg.recipient_id::text, 'amount_ils', v_msg.amount_ils)
  );
  return jsonb_build_object('ok', true);
end;
$function$;

-- Current balance per person for search lists. balance is null when this manager may not see it, which is not zero.
create or replace function public.manager_account_balances()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_super boolean;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  v_super := public.is_super_user(v_uid);

  return jsonb_build_object('ok', true, 'rows', coalesce((
    with b as (
      select * from public._payment_balance_rows()
    ),
    fam as (
      select fm.family_id,
        case when fm.user_id is not null then 'app' else 'manual' end as kind,
        coalesce(fm.user_id, fm.manual_participant_id)::text as pid
      from public.athlete_family_members fm
    ),
    fam_total as (
      select fam.family_id, coalesce(sum(b.balance), 0)::numeric(12, 2) as total
      from fam left join b on b.kind = fam.kind and b.pid = fam.pid
      group by fam.family_id
    ),
    payees as (
      select kind, pid from b
      union
      select kind, pid from fam
    ),
    hidden as (
      select distinct h.user_id::text as pid
      from public.super_user_hidden_registrations h
      where h.unhidden_at is null and h.hide_from_athlete
    ),
    hidden_family as (
      select distinct fam.family_id from fam join hidden on fam.kind = 'app' and hidden.pid = fam.pid
    ),
    pending as (
      select distinct account_key from public.manager_direct_messages
      where message_kind = 'payment_reminder' and read_at is null and closed_at is null
    )
    select jsonb_agg(jsonb_build_object(
      'kind', p.kind,
      'id', p.pid,
      'is_family', fam.family_id is not null,
      'balance', case
        when not v_super and (hf.family_id is not null or (fam.family_id is null and p.kind = 'app' and hd.pid is not null)) then null
        when fam.family_id is not null then ft.total
        else coalesce(own.balance, 0)
      end,
      'has_pending', pe.account_key is not null
    ))
    from payees p
    left join fam on fam.kind = p.kind and fam.pid = p.pid
    left join fam_total ft on ft.family_id = fam.family_id
    left join b own on own.kind = p.kind and own.pid = p.pid
    left join hidden hd on hd.pid = p.pid
    left join hidden_family hf on hf.family_id = fam.family_id
    left join pending pe on pe.account_key = coalesce(
      'family:' || fam.family_id::text,
      case when p.kind = 'manual' then 'manual:' else 'user:' end || p.pid
    )
  ), '[]'::jsonb));
end;
$function$;

-- Everything the current balance card shows for one person's account.
create or replace function public.manager_payment_reminder_status(p_payee_id uuid, p_payee_is_manual boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_balance numeric;
  v_hidden boolean;
  v_family_id uuid;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_payee_id is null then return jsonb_build_object('ok', false, 'error', 'invalid_request'); end if;

  v_key := public._payment_account_key(p_payee_id, coalesce(p_payee_is_manual, false));
  v_balance := public._payment_account_refresh(v_key);
  v_hidden := public._payment_account_has_hidden(v_key);
  if v_key like 'family:%' then v_family_id := substr(v_key, 8)::uuid; end if;

  return jsonb_build_object(
    'ok', true,
    'account_key', v_key,
    'is_family', v_family_id is not null,
    'family_name', (select f.name from public.athlete_families f where f.id = v_family_id),
    -- Null when this manager may not see it. A super user sees the number, but nobody can send while it is hidden.
    'balance', case when v_hidden and not public.is_super_user(v_uid) then null else v_balance end,
    'has_hidden', v_hidden,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', m.kind,
        'id', m.pid,
        'name', case when m.kind = 'app'
          then (select p.full_name from public.profiles p where p.user_id::text = m.pid)
          else (select mp.full_name from public.manual_participants mp where mp.id::text = m.pid) end,
        'own_balance', case when v_hidden and not public.is_super_user(v_uid) then null else coalesce(b.balance, 0) end,
        'ineligible_reason', case when m.kind = 'manual' then 'no_login'
          else public._payment_recipient_ineligible_reason(m.pid::uuid) end
      ) order by m.kind, m.pid)
      from public._payment_account_members(v_key) m
      left join public._payment_balance_rows() b on b.kind = m.kind and b.pid = m.pid
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id::text,
        'recipient_id', d.recipient_id::text,
        'recipient_name', (select p.full_name from public.profiles p where p.user_id = d.recipient_id),
        'sender_name', (select p.full_name from public.profiles p where p.user_id = d.sender_id),
        'amount', d.amount_ils,
        'shown_amount', d.shown_amount_ils,
        'status', case
          when d.read_at is not null then 'read'
          when d.closed_reason is not null then d.closed_reason
          else 'pending'
        end,
        'sent_at', d.created_at,
        'read_at', d.read_at,
        'closed_at', d.closed_at
      ) order by d.created_at desc)
      from public.manager_direct_messages d
      where d.account_key = v_key and d.message_kind = 'payment_reminder'
    ), '[]'::jsonb)
  );
end;
$function$;

-- The app-open fetch. No longer read-only: a reminder is rechecked here, and closed if the debt was settled.
-- Other messages behave as before, oldest first, and pay nothing for the recheck.
create or replace function public.get_pending_manager_direct_message()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row record;
  v_balance numeric;
  v_body text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  for v_row in
    select m.id, m.body, m.message_theme, m.created_at, m.message_kind, m.account_key, m.is_family_account,
      s.full_name as sender_name
    from public.manager_direct_messages m
    join public.profiles s on s.user_id = m.sender_id
    where m.recipient_id = v_uid
      and m.read_at is null
      and m.closed_at is null
    order by m.created_at asc
  loop
    if v_row.message_kind = 'payment_reminder' then
      begin
        if v_row.account_key is distinct from public._payment_account_key(v_uid, false) then
          -- The person moved into or out of a family, so this amount is not about their account any more.
          update public.manager_direct_messages
          set closed_at = now(), closed_reason = 'account_changed'
          where id = v_row.id;
          continue;
        end if;

        v_balance := public._payment_account_refresh(v_row.account_key);
        if v_balance <= 0 then
          continue;
        end if;

        update public.manager_direct_messages set shown_amount_ils = v_balance where id = v_row.id;
        v_body := public._payment_reminder_body(v_balance, v_row.is_family_account);

        return jsonb_build_object(
          'ok', true,
          'message', jsonb_build_object(
            'id', v_row.id::text,
            'body', v_body,
            'message_theme', 'work',
            'created_at', to_char(v_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'sender_name', 'Shira Fit Studio',
            'message_kind', 'payment_reminder',
            'amount_ils', v_balance,
            'is_family', v_row.is_family_account
          )
        );
      exception when others then
        -- Never show an amount that could not be rechecked. It stays pending for the next open.
        raise warning 'payment reminder: recheck failed (sqlstate %)', sqlstate;
        continue;
      end;
    end if;

    return jsonb_build_object(
      'ok', true,
      'message', jsonb_build_object(
        'id', v_row.id::text,
        'body', v_row.body,
        'message_theme', coalesce(v_row.message_theme, 'love'),
        'created_at', to_char(v_row.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'sender_name', coalesce(v_row.sender_name, ''),
        'message_kind', 'general'
      )
    );
  end loop;

  return jsonb_build_object('ok', true, 'message', null);
end;
$function$;

-- A closed reminder cannot be acknowledged.
create or replace function public.mark_manager_direct_message_read(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_n int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_message_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_message');
  end if;

  update public.manager_direct_messages m
  set read_at = now()
  where m.id = p_message_id
    and m.recipient_id = v_uid
    and m.read_at is null
    and m.closed_at is null;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true);
end;
$function$;

-- The general cancel deletes, so it must leave reminders alone. They have cancel_payment_reminder.
create or replace function public.cancel_manager_direct_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_msg public.manager_direct_messages%rowtype;
  v_n int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_message_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_message');
  end if;

  select * into v_msg from public.manager_direct_messages where id = p_message_id;

  delete from public.manager_direct_messages m
  where m.id = p_message_id
    and m.sender_id = v_uid
    and m.read_at is null
    and m.message_kind = 'general';

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found_or_already_read');
  end if;

  perform public._insert_activity_event(
    v_uid,
    'manager_direct_message_cancelled',
    'manager_direct_message',
    p_message_id::text,
    jsonb_build_object(
      'message_id', p_message_id::text,
      'recipient_user_id', v_msg.recipient_id::text,
      'body_preview', left(coalesce(v_msg.body, ''), 200)
    )
  );

  return jsonb_build_object('ok', true);
end;
$function$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public._payment_balance_rows()',
    'public._payment_account_key(uuid, boolean)',
    'public._payment_account_members(text)',
    'public._payment_account_balance(text)',
    'public._payment_account_has_hidden(text)',
    'public._payment_recipient_ineligible_reason(uuid)',
    'public._payment_reminder_body(numeric, boolean)',
    'public._payment_account_refresh(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.send_payment_reminder(uuid, numeric)',
    'public.cancel_payment_reminder(uuid)',
    'public.manager_account_balances()',
    'public.manager_payment_reminder_status(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

comment on column public.manager_direct_messages.message_kind is
  'general, or payment_reminder (created only by send_payment_reminder; amount and account are set by the server).';
comment on column public.manager_direct_messages.amount_ils is 'Payment reminder: the balance when it was sent.';
comment on column public.manager_direct_messages.shown_amount_ils is 'Payment reminder: the rechecked balance last shown to the athlete.';
