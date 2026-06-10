-- Hebrew digital receipts/invoices: documents, VAT, consent, audit trail.
-- Testing mode: is_operational=false allows PDF regeneration and overwrites until go-live.

create type public.document_status as enum ('ACTIVE', 'CANCELLED', 'NEEDS_PAYMENT_METHOD');
create type public.document_payment_method as enum (
  'cash', 'bit', 'bank_transfer', 'credit_card', 'check', 'other'
);
create type public.document_service_type as enum (
  'kickboxing', 'personal', 'pair', 'trio', 'quartet',
  'quintet', 'sextet', 'group_over_6', 'other'
);
create type public.document_event_action as enum (
  'document_created', 'document_sent', 'document_downloaded',
  'document_cancelled', 'document_viewed',
  'consent_accepted', 'consent_declined',
  'vat_rate_updated', 'business_details_updated',
  'document_pdf_regenerated', 'operational_mode_changed'
);
create type public.legal_consent_type as enum (
  'terms_of_service', 'privacy_policy', 'electronic_receipts'
);
create type public.consent_status as enum ('accepted', 'declined');
create type public.document_source_type as enum (
  'account_payment', 'session_payment', 'cancellation_penalty', 'manual'
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  profile_user_id uuid references public.profiles (user_id) on delete set null,
  manual_participant_id uuid references public.manual_participants (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customers_profile_user_id_idx on public.customers (profile_user_id)
  where profile_user_id is not null;
create index customers_manual_participant_id_idx on public.customers (manual_participant_id)
  where manual_participant_id is not null;

create table public.receipt_settings (
  id uuid primary key default '00000000-0000-4000-8000-000000000001'::uuid,
  business_id text not null default '',
  business_name text not null default 'Shira Fit Studio',
  address text not null default '',
  phone text not null default '052-959-3297',
  email text not null default '',
  digital_receipts_enabled boolean not null default false,
  vat_rate numeric(5, 4) not null default 0.1800
    check (vat_rate >= 0 and vat_rate <= 1),
  document_prefix text not null default 'SF-',
  next_document_number bigint not null default 1 check (next_document_number >= 1),
  staff_can_cancel_documents boolean not null default false,
  is_operational boolean not null default false,
  updated_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint receipt_settings_singleton check (id = '00000000-0000-4000-8000-000000000001'::uuid)
);

insert into public.receipt_settings (id) values ('00000000-0000-4000-8000-000000000001'::uuid)
on conflict (id) do nothing;

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  customer_id uuid not null references public.customers (id) on delete restrict,
  gross_amount numeric(12, 2) not null check (gross_amount > 0),
  net_amount numeric(12, 2) not null check (net_amount >= 0),
  vat_amount numeric(12, 2) not null check (vat_amount >= 0),
  vat_rate numeric(5, 4) not null check (vat_rate >= 0 and vat_rate <= 1),
  currency text not null default 'ILS',
  payment_method public.document_payment_method,
  service_type public.document_service_type not null,
  service_description text,
  notes text,
  status public.document_status not null default 'ACTIVE',
  pdf_url text,
  signature_hash text,
  signature_provider text,
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (user_id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (user_id) on delete set null,
  cancellation_reason text,
  customer_name text not null,
  customer_email text,
  customer_phone text,
  business_name text not null,
  business_id text not null,
  business_address text not null,
  business_phone text not null,
  business_email text not null,
  source_type public.document_source_type,
  source_id uuid,
  sent_at timestamptz,
  delivery_status text,
  recipient_email text,
  send_count int not null default 0,
  constraint documents_service_other_description check (
    service_type <> 'other' or nullif(trim(coalesce(service_description, '')), '') is not null
  ),
  constraint documents_needs_payment_method check (
    status <> 'NEEDS_PAYMENT_METHOD' or payment_method is null
  ),
  constraint documents_active_has_payment_method check (
    status = 'NEEDS_PAYMENT_METHOD' or payment_method is not null
  )
);

create index documents_created_at_idx on public.documents (created_at desc);
create index documents_status_idx on public.documents (status);
create index documents_customer_id_idx on public.documents (customer_id);
create index documents_source_idx on public.documents (source_type, source_id)
  where source_id is not null;

create table public.document_events (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents (id) on delete restrict,
  action public.document_event_action not null,
  user_id uuid references public.profiles (user_id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index document_events_document_id_idx on public.document_events (document_id, created_at desc);

create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  consent_type public.legal_consent_type not null,
  version int not null check (version >= 1),
  title text not null,
  body_text text not null,
  effective_at timestamptz not null default now(),
  is_current boolean not null default false,
  created_by uuid references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (consent_type, version)
);

create unique index legal_documents_one_current_per_type
  on public.legal_documents (consent_type)
  where is_current;

create table public.user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (user_id) on delete restrict,
  consent_type public.legal_consent_type not null,
  consent_version int not null check (consent_version >= 1),
  status public.consent_status not null,
  accepted_at timestamptz not null default now(),
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index user_consents_user_id_idx on public.user_consents (user_id, consent_type, created_at desc);

alter table public.profiles
  add column if not exists electronic_receipts_consent_version int,
  add column if not exists electronic_receipts_consented_at timestamptz;

insert into public.legal_documents (consent_type, version, title, body_text, is_current)
values (
  'electronic_receipts',
  1,
  'הסכמה לקבלת קבלות ומסמכים אלקטרוניים',
  'אני מסכים/ה לקבל קבלות, חשבוניות ומסמכים עסקיים מהסטודיו באופן אלקטרוני, לרבות שליחה לכתובת הדוא"ל שלי.',
  true
)
on conflict (consent_type, version) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('document-pdfs', 'document-pdfs', false, 10485760, array['application/pdf']::text[])
on conflict (id) do nothing;

create or replace function public._document_vat_breakdown(p_gross numeric, p_vat_rate numeric)
returns table (net_amount numeric, vat_amount numeric)
language sql
immutable
as $$
  select
    round(p_gross / (1 + p_vat_rate), 2) as net_amount,
    round(p_gross - round(p_gross / (1 + p_vat_rate), 2), 2) as vat_amount;
$$;

create or replace function public._map_session_payment_to_document_method(p_method text)
returns public.document_payment_method
language plpgsql
immutable
as $$
declare
  v_key text := public.normalize_payment_method_key(p_method);
begin
  if v_key = 'cash' then return 'cash';
  elsif v_key = 'other' then return 'other';
  else return null;
  end if;
end;
$$;

create or replace function public._log_document_event(
  p_document_id uuid,
  p_action public.document_event_action,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.document_events (document_id, action, user_id, metadata)
  values (p_document_id, p_action, auth.uid(), coalesce(p_metadata, '{}'::jsonb));
end;
$$;

create or replace function public._upsert_customer_from_payee(
  p_name text,
  p_email text,
  p_phone text,
  p_profile_user_id uuid,
  p_manual_participant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_profile_user_id is not null then
    select c.id into v_id from public.customers c where c.profile_user_id = p_profile_user_id limit 1;
  elsif p_manual_participant_id is not null then
    select c.id into v_id from public.customers c where c.manual_participant_id = p_manual_participant_id limit 1;
  end if;

  if v_id is not null then
    update public.customers
    set
      name = coalesce(nullif(trim(p_name), ''), name),
      email = coalesce(nullif(trim(p_email), ''), email),
      phone = coalesce(nullif(trim(p_phone), ''), phone),
      updated_at = now()
    where id = v_id;
    return v_id;
  end if;

  insert into public.customers (name, email, phone, profile_user_id, manual_participant_id)
  values (
    coalesce(nullif(trim(p_name), ''), 'לקוח'),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    p_profile_user_id,
    p_manual_participant_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public._allocate_document_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.receipt_settings%rowtype;
  v_num bigint;
begin
  select * into v_settings from public.receipt_settings where id = '00000000-0000-4000-8000-000000000001'::uuid for update;
  v_num := v_settings.next_document_number;
  update public.receipt_settings
  set next_document_number = next_document_number + 1, updated_at = now()
  where id = v_settings.id;
  return coalesce(v_settings.document_prefix, '') || lpad(v_num::text, 6, '0');
end;
$$;

create or replace function public.get_receipt_settings()
returns json
language plpgsql stable security definer set search_path = public
as $$
declare v_row public.receipt_settings%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_row from public.receipt_settings limit 1;
  return json_build_object('ok', true, 'settings', row_to_json(v_row));
end;
$$;

create or replace function public.update_receipt_settings(
  p_business_id text default null,
  p_business_name text default null,
  p_address text default null,
  p_phone text default null,
  p_email text default null,
  p_digital_receipts_enabled boolean default null,
  p_vat_rate numeric default null,
  p_document_prefix text default null,
  p_staff_can_cancel_documents boolean default null,
  p_is_operational boolean default null
)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_old public.receipt_settings%rowtype; v_new public.receipt_settings%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_old from public.receipt_settings where id = '00000000-0000-4000-8000-000000000001'::uuid for update;
  update public.receipt_settings set
    business_id = coalesce(nullif(trim(p_business_id), ''), business_id),
    business_name = coalesce(nullif(trim(p_business_name), ''), business_name),
    address = coalesce(nullif(trim(p_address), ''), address),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    email = coalesce(nullif(trim(p_email), ''), email),
    digital_receipts_enabled = coalesce(p_digital_receipts_enabled, digital_receipts_enabled),
    vat_rate = coalesce(p_vat_rate, vat_rate),
    document_prefix = coalesce(p_document_prefix, document_prefix),
    staff_can_cancel_documents = coalesce(p_staff_can_cancel_documents, staff_can_cancel_documents),
    is_operational = coalesce(p_is_operational, is_operational),
    updated_by = auth.uid(), updated_at = now()
  where id = v_old.id returning * into v_new;
  if v_old.vat_rate is distinct from v_new.vat_rate then
    perform public._log_document_event(null, 'vat_rate_updated', jsonb_build_object('old_rate', v_old.vat_rate, 'new_rate', v_new.vat_rate));
  end if;
  if v_old.is_operational is distinct from v_new.is_operational then
    perform public._log_document_event(null, 'operational_mode_changed', jsonb_build_object('is_operational', v_new.is_operational));
  end if;
  return json_build_object('ok', true, 'settings', row_to_json(v_new));
end;
$$;

create or replace function public.create_document(
  p_gross_amount numeric,
  p_service_type public.document_service_type,
  p_customer_name text,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_payment_method public.document_payment_method default null,
  p_service_description text default null,
  p_notes text default null,
  p_profile_user_id uuid default null,
  p_manual_participant_id uuid default null,
  p_source_type public.document_source_type default 'manual',
  p_source_id uuid default null,
  p_source_payment_method text default null
)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_settings public.receipt_settings%rowtype;
  v_customer_id uuid; v_doc_id uuid; v_doc_number text;
  v_net numeric(12,2); v_vat numeric(12,2);
  v_method public.document_payment_method;
  v_status public.document_status;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  if not v_settings.digital_receipts_enabled then return json_build_object('ok', false, 'error', 'digital_receipts_disabled'); end if;
  if nullif(trim(coalesce(v_settings.business_id, '')), '') is null then return json_build_object('ok', false, 'error', 'business_id_required'); end if;
  if p_gross_amount is null or p_gross_amount <= 0 then return json_build_object('ok', false, 'error', 'invalid_amount'); end if;
  v_method := p_payment_method;
  if v_method is null and p_source_payment_method is not null then
    v_method := public._map_session_payment_to_document_method(p_source_payment_method);
  end if;
  v_status := case when v_method is null then 'NEEDS_PAYMENT_METHOD'::public.document_status else 'ACTIVE'::public.document_status end;
  select net_amount, vat_amount into v_net, v_vat from public._document_vat_breakdown(p_gross_amount, v_settings.vat_rate);
  v_customer_id := public._upsert_customer_from_payee(p_customer_name, p_customer_email, p_customer_phone, p_profile_user_id, p_manual_participant_id);
  v_doc_number := public._allocate_document_number();
  insert into public.documents (
    document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate,
    payment_method, service_type, service_description, notes, status,
    customer_name, customer_email, customer_phone,
    business_name, business_id, business_address, business_phone, business_email,
    source_type, source_id, created_by
  ) values (
    v_doc_number, v_customer_id, p_gross_amount, v_net, v_vat, v_settings.vat_rate,
    v_method, p_service_type, nullif(trim(coalesce(p_service_description, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    v_status, coalesce(nullif(trim(p_customer_name), ''), 'לקוח'),
    nullif(trim(coalesce(p_customer_email, '')), ''), nullif(trim(coalesce(p_customer_phone, '')), ''),
    v_settings.business_name, v_settings.business_id, v_settings.address, v_settings.phone, v_settings.email,
    p_source_type, p_source_id, auth.uid()
  ) returning id into v_doc_id;
  perform public._log_document_event(v_doc_id, 'document_created', jsonb_build_object('document_number', v_doc_number, 'gross_amount', p_gross_amount));
  return json_build_object('ok', true, 'document_id', v_doc_id, 'document_number', v_doc_number, 'status', v_status, 'needs_pdf', true);
end;
$$;

create or replace function public.set_document_payment_method(p_document_id uuid, p_payment_method public.document_payment_method)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.status <> 'NEEDS_PAYMENT_METHOD' then return json_build_object('ok', false, 'error', 'invalid_status'); end if;
  update public.documents set payment_method = p_payment_method, status = 'ACTIVE' where id = p_document_id;
  return json_build_object('ok', true, 'document_id', p_document_id, 'needs_pdf', v_doc.pdf_url is null);
end;
$$;

create or replace function public.cancel_document(p_document_id uuid, p_reason text)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents%rowtype; v_settings public.receipt_settings%rowtype; v_can_cancel boolean;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  v_can_cancel := public.is_manager(auth.uid()) or (public.is_coach_or_manager(auth.uid()) and v_settings.staff_can_cancel_documents);
  if not v_can_cancel then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.status = 'CANCELLED' then return json_build_object('ok', false, 'error', 'already_cancelled'); end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then return json_build_object('ok', false, 'error', 'reason_required'); end if;
  update public.documents set status = 'CANCELLED', cancelled_at = now(), cancelled_by = auth.uid(), cancellation_reason = trim(p_reason) where id = p_document_id;
  perform public._log_document_event(p_document_id, 'document_cancelled', jsonb_build_object('reason', trim(p_reason)));
  return json_build_object('ok', true, 'document_id', p_document_id);
end;
$$;

create or replace function public.prepare_document_pdf_regeneration(p_document_id uuid)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents%rowtype; v_settings public.receipt_settings%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into v_settings from public.receipt_settings limit 1;
  if v_settings.is_operational then return json_build_object('ok', false, 'error', 'operational_mode_locked'); end if;
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.status = 'NEEDS_PAYMENT_METHOD' then return json_build_object('ok', false, 'error', 'needs_payment_method'); end if;
  update public.documents set pdf_url = null, signature_hash = null, signature_provider = null, signed_at = null where id = p_document_id;
  perform public._log_document_event(p_document_id, 'document_pdf_regenerated', '{}'::jsonb);
  return json_build_object('ok', true, 'document_id', p_document_id, 'allow_overwrite', true);
end;
$$;

create or replace function public.finalize_document_pdf(
  p_document_id uuid, p_pdf_path text, p_signature_hash text,
  p_signature_provider text default null, p_allow_overwrite boolean default false
)
returns json
language plpgsql security definer set search_path = public
as $$
declare v_doc public.documents%rowtype; v_settings public.receipt_settings%rowtype;
begin
  select * into v_settings from public.receipt_settings limit 1;
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if v_doc.pdf_url is not null and not (p_allow_overwrite or not v_settings.is_operational) then
    return json_build_object('ok', false, 'error', 'pdf_already_exists');
  end if;
  update public.documents set pdf_url = p_pdf_path, signature_hash = p_signature_hash,
    signature_provider = p_signature_provider,
    signed_at = case when p_signature_provider is not null then now() else signed_at end
  where id = p_document_id;
  return json_build_object('ok', true, 'document_id', p_document_id, 'pdf_url', p_pdf_path);
end;
$$;

create or replace function public.log_document_event(p_document_id uuid, p_action public.document_event_action, p_metadata jsonb default '{}'::jsonb)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  perform public._log_document_event(p_document_id, p_action, p_metadata);
  return json_build_object('ok', true);
end; $$;

create or replace function public.record_document_email_sent(p_document_id uuid, p_recipient_email text, p_delivery_status text)
returns json language plpgsql security definer set search_path = public as $$
begin
  update public.documents set sent_at = now(), delivery_status = p_delivery_status,
    recipient_email = p_recipient_email, send_count = send_count + 1 where id = p_document_id;
  perform public._log_document_event(p_document_id, 'document_sent', jsonb_build_object('recipient_email', p_recipient_email, 'delivery_status', p_delivery_status));
  return json_build_object('ok', true);
end; $$;

create or replace function public.get_required_consents()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_profile public.profiles%rowtype; v_doc public.legal_documents%rowtype; v_required jsonb := '[]'::jsonb;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from public.profiles where user_id = v_uid;
  select * into v_doc from public.legal_documents where consent_type = 'electronic_receipts' and is_current limit 1;
  if v_doc.id is not null and (v_profile.electronic_receipts_consent_version is null or v_profile.electronic_receipts_consent_version < v_doc.version) then
    v_required := v_required || jsonb_build_array(jsonb_build_object('consent_type', v_doc.consent_type, 'version', v_doc.version, 'title', v_doc.title, 'body_text', v_doc.body_text));
  end if;
  return json_build_object('ok', true, 'required', v_required);
end; $$;

create or replace function public.record_user_consent(
  p_consent_type public.legal_consent_type, p_status public.consent_status, p_consent_version int,
  p_ip_address text default null, p_user_agent text default null
)
returns json language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  insert into public.user_consents (user_id, consent_type, consent_version, status, ip_address, user_agent)
  values (v_uid, p_consent_type, p_consent_version, p_status, p_ip_address, p_user_agent);
  if p_consent_type = 'electronic_receipts' and p_status = 'accepted' then
    update public.profiles set electronic_receipts_consent_version = p_consent_version, electronic_receipts_consented_at = now() where user_id = v_uid;
    perform public._log_document_event(null, 'consent_accepted', jsonb_build_object('consent_type', p_consent_type, 'version', p_consent_version));
  elsif p_consent_type = 'electronic_receipts' and p_status = 'declined' then
    perform public._log_document_event(null, 'consent_declined', jsonb_build_object('consent_type', p_consent_type, 'version', p_consent_version));
  end if;
  return json_build_object('ok', true);
end; $$;

create or replace function public.publish_legal_document(p_consent_type public.legal_consent_type, p_title text, p_body_text text)
returns json language plpgsql security definer set search_path = public as $$
declare v_version int; v_id uuid;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(max(version), 0) + 1 into v_version from public.legal_documents where consent_type = p_consent_type;
  update public.legal_documents set is_current = false where consent_type = p_consent_type and is_current;
  insert into public.legal_documents (consent_type, version, title, body_text, is_current, created_by)
  values (p_consent_type, v_version, trim(p_title), trim(p_body_text), true, auth.uid()) returning id into v_id;
  return json_build_object('ok', true, 'id', v_id, 'version', v_version);
end; $$;

create or replace function public.list_documents(
  p_date_start timestamptz default null, p_date_end timestamptz default null,
  p_status public.document_status default null, p_limit int default 200, p_offset int default 0
)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_rows json; v_total bigint;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select count(*) into v_total from public.documents d
  where (p_date_start is null or d.created_at >= p_date_start) and (p_date_end is null or d.created_at <= p_date_end) and (p_status is null or d.status = p_status);
  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json) into v_rows from (
    select d.* from public.documents d
    where (p_date_start is null or d.created_at >= p_date_start) and (p_date_end is null or d.created_at <= p_date_end) and (p_status is null or d.status = p_status)
    order by d.created_at desc limit greatest(1, least(coalesce(p_limit, 200), 500)) offset greatest(0, coalesce(p_offset, 0))
  ) t;
  return json_build_object('ok', true, 'rows', v_rows, 'total', v_total);
end; $$;

create or replace function public.document_report(p_date_start timestamptz default null, p_date_end timestamptz default null)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_rows json;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(auth.uid()) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(json_agg(row_to_json(t) order by t.created_at desc), '[]'::json) into v_rows from (
    select d.document_number, d.created_at, d.customer_name, d.gross_amount, d.net_amount, d.vat_amount, d.vat_rate,
      d.payment_method, d.service_type, d.service_description, d.status
    from public.documents d
    where (p_date_start is null or d.created_at >= p_date_start) and (p_date_end is null or d.created_at <= p_date_end)
    order by d.created_at desc
  ) t;
  return json_build_object('ok', true, 'rows', v_rows);
end; $$;

create or replace function public.get_current_legal_document(p_consent_type public.legal_consent_type)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_doc public.legal_documents%rowtype;
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_doc from public.legal_documents where consent_type = p_consent_type and is_current limit 1;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true, 'document', row_to_json(v_doc));
end; $$;

alter table public.customers enable row level security;
alter table public.receipt_settings enable row level security;
alter table public.documents enable row level security;
alter table public.document_events enable row level security;
alter table public.legal_documents enable row level security;
alter table public.user_consents enable row level security;

create policy "customers_staff_select" on public.customers for select using (public.is_coach_or_manager(auth.uid()));
create policy "receipt_settings_staff_select" on public.receipt_settings for select using (public.is_coach_or_manager(auth.uid()));
create policy "documents_staff_select" on public.documents for select using (public.is_coach_or_manager(auth.uid()));
create policy "document_events_staff_select" on public.document_events for select using (public.is_coach_or_manager(auth.uid()));
create policy "legal_documents_authenticated_select" on public.legal_documents for select using (auth.uid() is not null);
create policy "user_consents_own_select" on public.user_consents for select using (auth.uid() = user_id or public.is_manager(auth.uid()));

create policy "document_pdfs_staff_read" on storage.objects for select
  using (bucket_id = 'document-pdfs' and public.is_coach_or_manager(auth.uid()));

grant execute on function public.get_receipt_settings() to authenticated;
grant execute on function public.update_receipt_settings(text, text, text, text, text, boolean, numeric, text, boolean, boolean) to authenticated;
grant execute on function public.create_document(numeric, public.document_service_type, text, text, text, public.document_payment_method, text, text, uuid, uuid, public.document_source_type, uuid, text) to authenticated;
grant execute on function public.set_document_payment_method(uuid, public.document_payment_method) to authenticated;
grant execute on function public.cancel_document(uuid, text) to authenticated;
grant execute on function public.prepare_document_pdf_regeneration(uuid) to authenticated;
grant execute on function public.finalize_document_pdf(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.log_document_event(uuid, public.document_event_action, jsonb) to authenticated;
grant execute on function public.get_required_consents() to authenticated;
grant execute on function public.record_user_consent(public.legal_consent_type, public.consent_status, int, text, text) to authenticated;
grant execute on function public.publish_legal_document(public.legal_consent_type, text, text) to authenticated;
grant execute on function public.list_documents(timestamptz, timestamptz, public.document_status, int, int) to authenticated;
grant execute on function public.document_report(timestamptz, timestamptz) to authenticated;
grant execute on function public.get_current_legal_document(public.legal_consent_type) to authenticated;
grant execute on function public.finalize_document_pdf(uuid, text, text, text, boolean) to service_role;
grant execute on function public.record_document_email_sent(uuid, text, text) to service_role;
