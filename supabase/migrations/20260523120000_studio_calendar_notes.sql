-- Studio-wide calendar notes (holidays, closures, announcements) visible on athlete/coach/manager week views.

create table if not exists public.studio_calendar_notes (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  title text not null,
  detail text,
  kind text not null default 'holiday'
    constraint studio_calendar_notes_kind_chk check (kind in ('holiday', 'closure', 'info')),
  audience text not null default 'all'
    constraint studio_calendar_notes_audience_chk check (audience in ('all', 'athletes', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  constraint studio_calendar_notes_date_range check (end_date >= start_date)
);

create index if not exists studio_calendar_notes_start_idx on public.studio_calendar_notes (start_date);
create index if not exists studio_calendar_notes_end_idx on public.studio_calendar_notes (end_date);

drop trigger if exists studio_calendar_notes_updated on public.studio_calendar_notes;
create trigger studio_calendar_notes_updated
  before update on public.studio_calendar_notes
  for each row execute function public.set_updated_at();

alter table public.studio_calendar_notes enable row level security;

drop policy if exists "studio_calendar_notes_select" on public.studio_calendar_notes;
create policy "studio_calendar_notes_select" on public.studio_calendar_notes
  for select to authenticated
  using (
    audience = 'all'
    or (
      audience = 'athletes'
      and exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'athlete')
    )
    or (audience = 'staff' and public.is_coach_or_manager(auth.uid()))
  );

drop policy if exists "studio_calendar_notes_manager_insert" on public.studio_calendar_notes;
create policy "studio_calendar_notes_manager_insert" on public.studio_calendar_notes
  for insert to authenticated
  with check (public.is_manager(auth.uid()));

drop policy if exists "studio_calendar_notes_manager_update" on public.studio_calendar_notes;
create policy "studio_calendar_notes_manager_update" on public.studio_calendar_notes
  for update to authenticated
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

drop policy if exists "studio_calendar_notes_manager_delete" on public.studio_calendar_notes;
create policy "studio_calendar_notes_manager_delete" on public.studio_calendar_notes
  for delete to authenticated
  using (public.is_manager(auth.uid()));

grant select on public.studio_calendar_notes to authenticated;
grant insert, update, delete on public.studio_calendar_notes to authenticated;
