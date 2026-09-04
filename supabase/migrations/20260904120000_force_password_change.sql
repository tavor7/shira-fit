-- Staff-issued temporary passwords: force the user to set a new password on next login.

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'When true, user must set a new password before using the app (set after staff issues a temporary password).';

create or replace function public.clear_must_change_password()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  update public.profiles set must_change_password = false where user_id = v_uid;
  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.clear_must_change_password() to authenticated;
