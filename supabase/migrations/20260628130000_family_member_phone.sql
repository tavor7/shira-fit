-- Include phone on family members for athlete activity reports.
create or replace function public.get_athlete_family(p_payee_id uuid, p_payee_is_manual boolean default false)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_family_id uuid;
  v_name text;
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_payee_id is null then
    return json_build_object('ok', true, 'family', null);
  end if;

  select fm.family_id, f.name
  into v_family_id, v_name
  from public.athlete_family_members fm
  join public.athlete_families f on f.id = fm.family_id
  where (
    (not p_payee_is_manual and fm.user_id = p_payee_id)
    or (p_payee_is_manual and fm.manual_participant_id = p_payee_id)
  )
  limit 1;

  if v_family_id is null then
    return json_build_object('ok', true, 'family', null);
  end if;

  return json_build_object(
    'ok', true,
    'family', json_build_object(
      'id', v_family_id,
      'name', v_name,
      'members', coalesce((
        select json_agg(
          json_build_object(
            'kind', case when fm.user_id is not null then 'app' else 'manual' end,
            'id', coalesce(fm.user_id, fm.manual_participant_id),
            'name', case
              when fm.user_id is not null then (select pr.full_name from public.profiles pr where pr.user_id = fm.user_id)
              else (select mp.full_name from public.manual_participants mp where mp.id = fm.manual_participant_id)
            end,
            'phone', case
              when fm.user_id is not null then (select pr.phone from public.profiles pr where pr.user_id = fm.user_id)
              else (select mp.phone from public.manual_participants mp where mp.id = fm.manual_participant_id)
            end,
            'payee_is_manual', fm.manual_participant_id is not null
          )
          order by 4 nulls last
        )
        from public.athlete_family_members fm
        where fm.family_id = v_family_id
      ), '[]'::json)
    )
  );
end;
$$;
