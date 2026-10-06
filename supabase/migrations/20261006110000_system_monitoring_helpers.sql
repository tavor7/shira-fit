-- System monitoring, Phase 1 (2/3): helpers (redaction, normalization, fingerprinting, allowlist,
-- rule matching, configuration access).
--
-- All functions here are INTERNAL: SECURITY INVOKER, search_path pinned to (public, pg_temp), and every
-- API role (PUBLIC, anon, authenticated, service_role) has EXECUTE revoked. They are only ever called by
-- the SECURITY DEFINER ingestion / lifecycle functions of migration 3, which run as the table owner.
-- No dynamic SQL is used anywhere in these helpers.

-- ---------------------------------------------------------------------------------------------
-- Severity ordering.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_sev_rank(p_sev text)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_sev when 'info' then 1 when 'warning' then 2 when 'error' then 3 when 'critical' then 4 else 0 end;
$$;

create or replace function public._system_rank_sev(p_rank integer)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_rank when 1 then 'info' when 2 then 'warning' when 3 then 'error' when 4 then 'critical' else null end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Configuration access. Plain SQL (no exception sub-blocks, so a call costs one primary-key lookup).
-- Never raises: a missing / wrongly typed / out-of-range value yields NULL or the supplied default.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_cfg(p_key text)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select c.value from public.system_monitoring_config c where c.key = p_key;
$$;

-- Non-negative integer limit from config.limits (digits only, 1-10 digits, within [p_min, p_max]).
create or replace function public._system_limit(p_name text, p_default integer, p_min integer default 0, p_max integer default 2000000000)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when jsonb_typeof(c.value) = 'object' then
             case when jsonb_typeof(c.value -> p_name) = 'number' then
               case when (c.value ->> p_name) ~ '^[0-9]{1,10}$' then
                 case when (c.value ->> p_name)::numeric between p_min and p_max then (c.value ->> p_name)::integer end
               end
             end
           end
    from public.system_monitoring_config c
    where c.key = 'limits'
  ), p_default);
$$;

-- Boolean flag from config; anything that is not a JSON boolean falls back to the default.
create or replace function public._system_flag(p_key text, p_default boolean)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when jsonb_typeof(c.value) = 'boolean' then (c.value #>> '{}')::boolean end
    from public.system_monitoring_config c
    where c.key = p_key
  ), p_default);
$$;

-- ---------------------------------------------------------------------------------------------
-- Text redaction for STORED diagnostic text (messages, stacks, summaries, routes).
-- Removes secrets, credentials, contact data, UUIDs, long tokens/numbers, URL query strings and
-- PostgreSQL value details; collapses whitespace; truncates. Input is first cut to 20k chars so the
-- cost of the regular expressions is bounded.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_redact(p_text text, p_max integer default 500, p_keep_newlines boolean default false)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t text;
begin
  if p_text is null then
    return null;
  end if;
  t := left(p_text, 20000);

  -- URL query strings first (the whole "?a=b&c=d" run goes, so no parameter value can survive).
  t := regexp_replace(t, '\?[A-Za-z0-9_%.-]+=[^\s"'')]*', '?<q>', 'g');
  -- JSON-style and key=value credentials.
  t := regexp_replace(t,
    '"(password|passwd|pwd|secret|token|access_token|refresh_token|id_token|api_?key|authorization|temp_password|temporary_password|service_role_key)"\s*:\s*"[^"]*"',
    '"\1":"<redacted>"', 'gi');
  -- JWTs, bearer tokens, Supabase keys.
  t := regexp_replace(t, 'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*', '<jwt>', 'g');
  t := regexp_replace(t, '\ybearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer <token>', 'gi');
  t := regexp_replace(t, '\ysb_(publishable|secret)_[A-Za-z0-9_-]+', '<key>', 'g');
  t := regexp_replace(t, '\ysbp_[A-Za-z0-9]+', '<key>', 'g');
  t := regexp_replace(t,
    '\y(password|passwd|pwd|secret|token|access_token|refresh_token|id_token|api_?key|authorization|temp_password|temporary_password)\s*[:=]\s*[^\s,;&"'']+',
    '\1=<redacted>', 'gi');

  -- Contact data.
  t := regexp_replace(t, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<email>', 'g');
  t := regexp_replace(t, '(\+?972[\s.-]?|\y0)(5\d|[23489]|7\d)[\s.-]?\d{3}[\s.-]?\d{4}', '<phone>', 'g');
  t := regexp_replace(t, '\+\d[\d\s.-]{8,16}\d', '<phone>', 'g');

  -- Identifiers and dynamic values.
  t := regexp_replace(t, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>', 'g');
  t := regexp_replace(t, 'Key \([^)]*\)=\([^)]*\)', 'Key (<k>)=(<v>)', 'gi');
  t := regexp_replace(t, 'Failing row contains \(.*\)', 'Failing row contains (<row>)', 'gi');
  t := regexp_replace(t, '\yDETAIL:.*', 'DETAIL: <removed>', 'g');
  t := regexp_replace(t, '\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?', '<ts>', 'g');
  t := regexp_replace(t, '\y\d{7,}\y', '<n>', 'g');
  t := regexp_replace(t, '[A-Za-z0-9_-]{32,}', '<token>', 'g');
  t := regexp_replace(t, '[A-Za-z0-9+/]{40,}={1,2}', '<token>', 'g');

  -- Quoted values. Quoted names that are code/database identifiers are kept (they distinguish real
  -- causes); every other quoted string is replaced.
  t := regexp_replace(t,
    '(constraint|column|relation|table|function|trigger|index|schema|type|policy|extension)(\s+)"([a-z_][a-z0-9_]{0,62})"',
    '\1\2' || chr(1) || '\3' || chr(2), 'gi');
  t := regexp_replace(t,
    '(reading|setting|property|method|function|attribute|module)(\s+)''([A-Za-z_$][A-Za-z0-9_$]{0,60})''',
    '\1\2' || chr(3) || '\3' || chr(4), 'gi');
  t := regexp_replace(t, '"[^"]{0,250}"', '<str>', 'g');
  t := regexp_replace(t, '''[^'']{0,250}''', '<str>', 'g');
  t := regexp_replace(t, chr(1) || '([^' || chr(2) || ']*)' || chr(2), '"\1"', 'g');
  t := regexp_replace(t, chr(3) || '([^' || chr(4) || ']*)' || chr(4), '''\1''', 'g');

  if p_keep_newlines then
    t := regexp_replace(t, '[ \t]+', ' ', 'g');
    t := regexp_replace(t, '\n{3,}', E'\n\n', 'g');
  else
    t := regexp_replace(t, '\s+', ' ', 'g');
  end if;
  t := btrim(t);
  t := left(t, greatest(coalesce(p_max, 500), 1));
  return nullif(t, '');
end;
$$;

-- Normalization used ONLY for fingerprints (the result is hashed, never stored): lower-cased, every
-- volatile token (timestamps, uuids, tokens, emails, quoted values, numbers) collapsed to <v>, quoted
-- code/database identifiers kept, PostgreSQL detail leaks removed. Deliberately uses very few distinct
-- regular expressions (PostgreSQL caches only 32 compiled patterns per backend; a cache miss costs
-- far more than the match itself, and this runs on every report, including flooded ones).
create or replace function public._system_normalize_template(p_text text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  t text;
begin
  if p_text is null then
    return '';
  end if;
  t := lower(left(p_text, 1000));
  t := regexp_replace(t,
    '(constraint|column|relation|table|function|trigger|index|schema|type|policy|extension)(\s+)"([a-z_][a-z0-9_]{0,62})"',
    '\1\2' || chr(1) || '\3' || chr(2), 'g');
  t := regexp_replace(t,
    '(reading|setting|property|method|function|attribute|module)(\s+)''([a-z_$][a-z0-9_$]{0,60})''',
    '\1\2' || chr(3) || '\3' || chr(4), 'g');
  t := regexp_replace(t, 'key \([^)]*\)=\([^)]*\)|failing row contains \(.*\)|detail:.*', '<v>', 'g');
  t := regexp_replace(t,
    '\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})?)?'
    || '|eyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]*|bearer\s+[a-z0-9._~+/=-]+'
    || '|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
    || '|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    || '|"[^"]{0,250}"|''[^'']{0,250}''|[a-z0-9_-]{32,}|[0-9]+(\.[0-9]+)?',
    '<v>', 'g');
  t := regexp_replace(t, chr(1) || '([^' || chr(2) || ']*)' || chr(2), '"\1"', 'g');
  t := regexp_replace(t, chr(3) || '([^' || chr(4) || ']*)' || chr(4), '''\1''', 'g');
  t := regexp_replace(t, '\s+', ' ', 'g');
  return left(btrim(t), 200);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Strict, typed allowlist for entities / context maps. Unknown keys and invalid values are DROPPED
-- (only a count of dropped context keys is kept). The allowlist comes from system_monitoring_config
-- ('context_allowed_keys'); if that value is missing or malformed a baked-in default is used.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_sanitize_map(p_input jsonb, p_kind text, p_allowed jsonb default null)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_allowed jsonb;
  v_out jsonb := '{}'::jsonb;
  v_default jsonb;
  k text;
  v jsonb;
  v_type text;
  v_text text;
  v_n integer := 0;
  v_dropped integer := 0;
  v_max integer := case when p_kind = 'entities' then 8 else 16 end;
begin
  if p_input is null or jsonb_typeof(p_input) <> 'object' or p_kind not in ('entities', 'context') then
    return '{}'::jsonb;
  end if;

  v_default := case p_kind
    when 'entities' then jsonb_build_object(
      'session_id', 'uuid', 'series_id', 'uuid', 'occurrence_id', 'uuid', 'subscription_id', 'uuid',
      'billing_period_id', 'uuid', 'document_id', 'uuid', 'registration_id', 'uuid',
      'manual_participant_id', 'uuid', 'delivery_id', 'uuid')
    else jsonb_build_object(
      'http_status', 'int', 'provider', 'enum', 'provider_code', 'code', 'rpc', 'name', 'fn', 'name',
      'edge_function', 'name', 'job', 'name', 'attempt', 'int', 'duration_ms', 'int', 'count', 'int',
      'retryable', 'bool', 'network_state', 'enum', 'phase', 'enum', 'outcome', 'enum', 'sqlstate', 'code',
      'constraint', 'name', 'table', 'name', 'reason', 'enum')
  end;

  v_allowed := coalesce(p_allowed, public._system_cfg('context_allowed_keys') -> p_kind);
  if v_allowed is null or jsonb_typeof(v_allowed) <> 'object' then
    v_allowed := v_default;
  end if;

  for k, v in select e.key, e.value from jsonb_each(p_input) e limit 64 loop
    v_type := case when jsonb_typeof(v_allowed -> k) = 'string' then v_allowed ->> k else null end;
    if v_type is null or v_n >= v_max then
      v_dropped := v_dropped + 1;
      continue;
    end if;

    if v_type = 'uuid' then
      v_text := case when jsonb_typeof(v) = 'string' then v #>> '{}' else null end;
      if v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_out := v_out || jsonb_build_object(k, lower(v_text)); v_n := v_n + 1;
      else
        v_dropped := v_dropped + 1;
      end if;
    elsif v_type = 'int' then
      if jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,10}$'
         and (v #>> '{}')::numeric between -2147483648 and 2147483647 then
        v_out := v_out || jsonb_build_object(k, (v #>> '{}')::bigint); v_n := v_n + 1;
      else
        v_dropped := v_dropped + 1;
      end if;
    elsif v_type = 'bool' then
      if jsonb_typeof(v) = 'boolean' then
        v_out := v_out || jsonb_build_object(k, (v #>> '{}')::boolean); v_n := v_n + 1;
      else
        v_dropped := v_dropped + 1;
      end if;
    elsif v_type in ('enum', 'name', 'code') then
      v_text := case when jsonb_typeof(v) = 'string' then v #>> '{}' else null end;
      if v_text is not null and (
           (v_type = 'enum' and v_text ~ '^[a-z0-9_.-]{1,40}$')
        or (v_type = 'name' and v_text ~ '^[A-Za-z0-9_./:-]{1,80}$')
        or (v_type = 'code' and v_text ~ '^[A-Za-z0-9_.-]{1,40}$')) then
        v_out := v_out || jsonb_build_object(k, v_text); v_n := v_n + 1;
      else
        v_dropped := v_dropped + 1;
      end if;
    else
      v_dropped := v_dropped + 1;
    end if;
  end loop;

  if p_kind = 'context' and v_dropped > 0 then
    v_out := v_out || jsonb_build_object('_dropped', v_dropped);
  end if;
  if octet_length(v_out::text) > 2048 then
    return jsonb_build_object('_oversize', true);
  end if;
  return v_out;
exception when others then
  return '{}'::jsonb;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Fingerprint: deterministic, computed server-side from normalized parts. An explicit detector key
-- (trusted callers only) replaces the derived identity entirely. Volatile data (users, versions,
-- timestamps, entity ids) is never an input of the derived form.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_fingerprint(
  p_source text,
  p_subsystem text,
  p_operation text,
  p_error_class text,
  p_error_code text,
  p_template text,
  p_origin text,
  p_key text default null
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key is not null then md5('key' || chr(31) || p_key)
    else md5(concat_ws(chr(31),
      coalesce(p_source, ''), coalesce(p_subsystem, ''), coalesce(p_operation, ''),
      coalesce(p_error_class, ''), coalesce(p_error_code, ''), coalesce(p_template, ''), coalesce(p_origin, '')))
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Rule selection: exactly one enabled rule wins. Order: priority desc, number of non-null match
-- fields desc, longer operation match desc, id asc. Operation matching is exact or trailing-'*'
-- prefix via starts_with() (no LIKE metacharacters, no regex, no dynamic SQL). Returns an all-NULL row
-- when nothing matches or on any error (callers fall back to defaults).
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_pick_rule(
  p_source text,
  p_operation text,
  p_error_class text,
  p_error_code text
)
returns public.system_issue_rules
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  r public.system_issue_rules;
begin
  select * into r
  from public.system_issue_rules x
  where x.enabled
    and (x.match_source is null or x.match_source = p_source)
    and (x.match_error_class is null or x.match_error_class = p_error_class)
    and (x.match_error_code is null or x.match_error_code = p_error_code)
    and (
      x.match_operation is null
      or (case
            when right(x.match_operation, 1) = '*'
              then starts_with(p_operation, left(x.match_operation, char_length(x.match_operation) - 1))
            else x.match_operation = p_operation
          end)
    )
  order by
    x.priority desc,
    ((x.match_source is not null)::int + (x.match_error_class is not null)::int
     + (x.match_error_code is not null)::int + (x.match_operation is not null)::int) desc,
    coalesce(char_length(x.match_operation), 0) desc,
    x.id asc
  limit 1;
  if not found then
    return null;
  end if;
  return r;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Small validators used by ingestion.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_pick_text(p_value jsonb, p_pattern text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ p_pattern then p_value #>> '{}'
    else null
  end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Stack origin: up to three application function names from the top frames of a JS stack (frames from
-- node_modules are skipped; file names, line numbers and bundle hashes are never used), joined with '>'.
-- Used only as a fingerprint input for client exceptions.
-- ---------------------------------------------------------------------------------------------
create or replace function public._system_stack_origin(p_stack text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_line text;
  v_m text[];
  v_out text[] := '{}';
begin
  if p_stack is null then
    return '';
  end if;
  for v_line in select unnest(string_to_array(left(p_stack, 4000), E'\n')) loop
    continue when v_line like '%node_modules%';
    v_m := regexp_match(v_line, '^\s*(?:at\s+([A-Za-z_$][A-Za-z0-9_$.<>]*)\s*\(|([A-Za-z_$][A-Za-z0-9_$.<>]*)@)');
    if v_m is not null then
      v_out := v_out || coalesce(v_m[1], v_m[2]);
      exit when cardinality(v_out) >= 3;
    end if;
  end loop;
  return array_to_string(v_out, '>');
exception when others then
  return '';
end;
$$;

-- Retention value from config.retention at a JSON path (e.g. {events_days,error}); integer, bounded.
create or replace function public._system_ret(p_path text[], p_default integer, p_min integer default 1, p_max integer default 36500)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select case when jsonb_typeof(c.value #> p_path) = 'number' then
             case when (c.value #>> p_path) ~ '^[0-9]{1,6}$' then
               case when (c.value #>> p_path)::numeric between p_min and p_max then (c.value #>> p_path)::integer end
             end
           end
    from public.system_monitoring_config c
    where c.key = 'retention'
  ), p_default);
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: every helper is internal. Revoke every default grant.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        '_system_sev_rank', '_system_rank_sev', '_system_cfg', '_system_limit', '_system_flag',
        '_system_redact', '_system_normalize_template', '_system_sanitize_map', '_system_fingerprint',
        '_system_pick_rule', '_system_pick_text', '_system_stack_origin', '_system_ret')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;

-- Self-check.
do $$
declare
  r record;
  v_role text;
  v_n integer := 0;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname like '\_system\_%'
  loop
    v_n := v_n + 1;
    if r.owner <> 'postgres' then
      raise exception 'self-check: % is not owned by postgres', r.sig;
    end if;
    if r.prosecdef then
      raise exception 'self-check: helper % must be SECURITY INVOKER', r.sig;
    end if;
    if r.proconfig is null or not ('search_path=public, pg_temp' = any (r.proconfig)) then
      raise exception 'self-check: % does not pin search_path', r.sig;
    end if;
    foreach v_role in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then
        raise exception 'self-check: % is executable by %', r.sig, v_role;
      end if;
    end loop;
  end loop;
  if v_n <> 13 then
    raise exception 'self-check: expected 13 internal helpers, found %', v_n;
  end if;
end $$;
