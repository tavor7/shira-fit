-- App inserts omitted effective_from after date-effective pricing was enabled.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'athlete_session_capacity_pricing'
      and column_name = 'effective_from'
  ) then
    alter table public.athlete_session_capacity_pricing
      alter column effective_from set default current_date;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'session_capacity_pricing'
      and column_name = 'effective_from'
  ) then
    alter table public.session_capacity_pricing
      alter column effective_from set default current_date;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'coach_capacity_pricing'
      and column_name = 'effective_from'
  ) then
    alter table public.coach_capacity_pricing
      alter column effective_from set default current_date;
  end if;
end $$;
