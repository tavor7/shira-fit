-- Staff-only session notes (visible on session detail screens).
-- Write/read: coaches (only for their own sessions) and managers (any session).
-- Delete: managers or the note author.

create table if not exists public.session_notes (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  author_id uuid not null references public.profiles (user_id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists session_notes_session_idx on public.session_notes (session_id);
create index if not exists session_notes_author_idx on public.session_notes (author_id);

alter table public.session_notes enable row level security;

drop policy if exists session_notes_select_staff on public.session_notes;
create policy session_notes_select_staff on public.session_notes for select using (
  public.is_coach_or_manager(auth.uid())
  and (
    public.is_manager(auth.uid())
    or exists (
      select 1 from public.training_sessions s
      where s.id = session_notes.session_id and s.coach_id = auth.uid()
    )
  )
);

drop policy if exists session_notes_insert_staff on public.session_notes;
create policy session_notes_insert_staff on public.session_notes for insert with check (
  public.is_coach_or_manager(auth.uid())
  and author_id = auth.uid()
  and (
    public.is_manager(auth.uid())
    or exists (
      select 1 from public.training_sessions s
      where s.id = session_id and s.coach_id = auth.uid()
    )
  )
);

drop policy if exists session_notes_delete_author_or_manager on public.session_notes;
create policy session_notes_delete_author_or_manager on public.session_notes for delete using (
  public.is_manager(auth.uid()) or author_id = auth.uid()
);

-- RPC helpers (nicer errors + consistent permission checks)
create or replace function public.add_session_note(p_session_id uuid, p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_body is null or length(trim(p_body)) < 1 then return json_build_object('ok', false, 'error', 'empty'); end if;
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if not (public.is_manager(v_uid) or v_sess.coach_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  insert into public.session_notes (session_id, author_id, body)
  values (p_session_id, v_uid, trim(p_body));

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.add_session_note(uuid, text) to authenticated;

create or replace function public.delete_session_note(p_note_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_note public.session_notes%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_note from public.session_notes where id = p_note_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  if not (public.is_manager(v_uid) or v_note.author_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  delete from public.session_notes where id = p_note_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.delete_session_note(uuid) to authenticated;

