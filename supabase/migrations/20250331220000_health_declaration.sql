-- Health declaration confirmation (required on signup).

alter table public.profiles
  add column if not exists health_declaration_confirmed_at timestamptz null;

comment on column public.profiles.health_declaration_confirmed_at is
  'Timestamp when the user confirmed they completed the required health declaration form during signup.';

 