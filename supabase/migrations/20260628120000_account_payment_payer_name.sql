-- Optional payer name for family account payments (who physically gave the money).
alter table public.athlete_account_payments
  add column if not exists payer_name text;

comment on column public.athlete_account_payments.payer_name is
  'Optional free-text name of who paid (e.g. parent), used mainly for family billing.';
