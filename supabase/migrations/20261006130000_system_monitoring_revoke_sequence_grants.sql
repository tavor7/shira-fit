-- System monitoring, Phase 1 (follow-up): close the one default-privilege leak found by the post-deploy
-- schema diff.
--
-- This project's default privileges also hand ALL to anon, authenticated and service_role on every new
-- SEQUENCE in public. The identity sequence behind system_issue_transitions.id (created by
-- 20261006100000) therefore carried those grants, although the migration's self-check only covered
-- tables and functions. The sequence is not reachable through the REST API (PostgREST does not expose
-- nextval/setval) and no client role can insert into the table, so nothing was exploitable, but "no
-- default ACL may re-expose a monitoring object" is a hard requirement of this system, so the grants are
-- removed. Inserts into the table are made only by SECURITY DEFINER functions owned by postgres, which
-- never need the sequence privileges.
--
-- Forward-only fix (the earlier migrations are already applied and are not edited). Privilege change
-- only: no function body, table, policy or data is touched.

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as seq
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and c.relname like 'system\_%'
  loop
    execute format('revoke all on sequence %s from public, anon, authenticated, service_role', r.seq);
  end loop;
end $$;

-- Self-check: no API role may hold any privilege on any monitoring sequence.
do $$
declare
  r record;
  v_role text;
  v_n integer := 0;
begin
  for r in
    select c.oid, c.relname
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and c.relname like 'system\_%'
  loop
    v_n := v_n + 1;
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_sequence_privilege(v_role, r.oid, 'USAGE,SELECT,UPDATE') then
        raise exception 'self-check: % still has a privilege on sequence %', v_role, r.relname;
      end if;
    end loop;
  end loop;
  if v_n < 1 then
    raise exception 'self-check: expected at least one monitoring sequence';
  end if;
end $$;
