-- Session length (default 1 hour) for calendar and detail views.
alter table public.training_sessions
  add column if not exists duration_minutes int not null default 60
  check (duration_minutes > 0 and duration_minutes <= 24 * 60);
