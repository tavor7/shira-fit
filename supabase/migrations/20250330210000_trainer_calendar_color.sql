-- Calendar accent color per trainer (coaches/managers). Set by managers in the app; nullable = use app default palette.

alter table public.profiles
  add column if not exists calendar_color text null;

comment on column public.profiles.calendar_color is
  'Optional #RRGGBB hex for session chips in the calendar. Managers may update for any coach/manager profile.';
