-- System monitoring Phase 1: fingerprinting (grouping) and redaction / allowlisting.
--
-- Drives the real ingestion code (trusted and untrusted paths) and then inspects what was STORED.
-- Self-contained: own fixtures, everything is rolled back. Requires the 3 monitoring migrations.
set client_min_messages to notice;
begin;

create temp table t137_fx (k text primary key, v uuid);

create function pg_temp.t137_ingest(p jsonb) returns jsonb language sql as
$$ select public._system_ingest('trusted', p, null) $$;

create function pg_temp.t137_issues() returns bigint language sql as
$$ select count(*) from public.system_issues $$;

do $$
declare
  v_ath uuid := gen_random_uuid();
  v_res jsonb;
  v_a uuid;
  v_b uuid;
  v_n bigint;
  v_cnt bigint;
  v_fp text;
  v_blob text;
  v_ctx jsonb;
  v_ent jsonb;
  v_msg text;
  v_stack text;
  v_route text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (v_ath, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't137-ath@test.local',
          jsonb_build_object('full_name', 't137 ath', 'phone', '0501370001', 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set approval_status = 'approved' where user_id = v_ath;
  insert into t137_fx values ('ath', v_ath);
  update public.system_monitoring_config set value = 'true'::jsonb where key = 'client_ingest_enabled';

  -- ===================== FINGERPRINTING =====================
  -- F1: same error, different UUID => ONE issue with 2 occurrences.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'subsystem', 'billing', 'operation', 'fn/f1', 'error_code', 'P0001',
    'message', 'subscription 3f38a59f-3984-4f7f-a810-8e62ec34fd51 not found'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'subsystem', 'billing', 'operation', 'fn/f1', 'error_code', 'P0001',
    'message', 'subscription 9b2c1d00-1111-4222-8333-444455556666 not found'));
  select count(*), max(occurrence_count) into v_n, v_cnt from public.system_issues where operation = 'fn/f1';
  if v_n <> 1 or v_cnt <> 2 then raise exception 'F1 FAILED: issues=% occurrences=%', v_n, v_cnt; end if;
  raise notice 'F1 PASSED: same error with different UUIDs groups into one issue';

  -- F2: different timestamp.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'subsystem', 'billing', 'operation', 'fn/f2',
    'message', 'failed at 2026-10-05T10:00:00Z while billing'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'subsystem', 'billing', 'operation', 'fn/f2',
    'message', 'failed at 2027-01-01 03:04:05 while billing'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f2';
  if v_n <> 1 then raise exception 'F2 FAILED: % issues', v_n; end if;
  raise notice 'F2 PASSED: timestamps do not fragment issues';

  -- F3: different user (trusted payload carries a user id; untrusted derives it).
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/f3', 'message', 'boom', 'user_id', gen_random_uuid()));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/f3', 'message', 'boom', 'user_id', gen_random_uuid()));
  select count(*) into v_n from public.system_issues where operation = 'fn/f3';
  if v_n <> 1 then raise exception 'F3 FAILED: % issues', v_n; end if;
  if (select count(distinct user_id) from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/f3') < 1 then
    raise exception 'F3 FAILED: user ids not recorded on events';
  end if;
  raise notice 'F3 PASSED: different users group into one issue (user ids live on events only)';

  -- F4: different app version => one issue; versions tracked.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/f4', 'message', 'boom', 'app_version', '1.0.0'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/f4', 'message', 'boom', 'app_version', '1.1.0'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f4';
  if v_n <> 1 then raise exception 'F4 FAILED: % issues', v_n; end if;
  if not exists (select 1 from public.system_issues where operation = 'fn/f4'
                 and first_seen_version = '1.0.0' and last_seen_version = '1.1.0') then
    raise exception 'F4 FAILED: first/last seen versions not tracked';
  end if;
  raise notice 'F4 PASSED: app version does not fragment issues; first/last versions tracked';

  -- F5: dynamic numbers.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f5', 'message', 'row 12 of 340 failed (attempt 1)'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f5', 'message', 'row 99 of 1500 failed (attempt 3)'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f5';
  if v_n <> 1 then raise exception 'F5 FAILED: % issues', v_n; end if;
  raise notice 'F5 PASSED: dynamic numbers collapse';

  -- F6: genuinely different errors stay separate (code, message, operation).
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f6', 'error_code', '23505', 'message', 'x failed'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f6', 'error_code', '22P02', 'message', 'x failed'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f6', 'error_code', '23505', 'message', 'y exploded'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f6b', 'error_code', '23505', 'message', 'x failed'));
  select count(*) into v_n from public.system_issues where operation in ('fn/f6', 'fn/f6b');
  if v_n <> 4 then raise exception 'F6 FAILED: expected 4 distinct issues, got %', v_n; end if;
  raise notice 'F6 PASSED: different code / message / operation are different issues';

  -- F7: PostgreSQL key-value details and constraint names.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f7', 'error_code', '23505',
    'message', 'duplicate key value violates unique constraint "regs_key" Key (user_id)=(3f38a59f-3984-4f7f-a810-8e62ec34fd51) already exists.'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f7', 'error_code', '23505',
    'message', 'duplicate key value violates unique constraint "regs_key" Key (user_id)=(9b2c1d00-1111-4222-8333-444455556666) already exists.'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f7';
  if v_n <> 1 then raise exception 'F7 FAILED: key values fragmented the issue (% issues)', v_n; end if;
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f7', 'error_code', '23505',
    'message', 'duplicate key value violates unique constraint "other_key" Key (user_id)=(9b2c1d00-1111-4222-8333-444455556666) already exists.'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f7';
  if v_n <> 2 then raise exception 'F7 FAILED: different constraint names must be different issues (% issues)', v_n; end if;
  raise notice 'F7 PASSED: Key (...)=(...) values collapse; constraint names discriminate';

  -- F8: trusted explicit fingerprint keys.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'detector', 'operation', 'detector/a', 'message', 'one', 'fingerprint_key', 'series_gap:aaaa'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'detector', 'operation', 'detector/b', 'message', 'two', 'error_code', 'X', 'fingerprint_key', 'series_gap:aaaa'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'detector', 'operation', 'detector/a', 'message', 'one', 'fingerprint_key', 'series_gap:bbbb'));
  select count(*), max(occurrence_count) into v_n, v_cnt from public.system_issues where source = 'detector' and operation in ('detector/a', 'detector/b') and fingerprint in (
    md5('key' || chr(31) || 'series_gap:aaaa'), md5('key' || chr(31) || 'series_gap:bbbb'));
  if v_n <> 2 or v_cnt <> 2 then raise exception 'F8 FAILED: issues=% max_occ=%', v_n, v_cnt; end if;
  raise notice 'F8 PASSED: the same explicit key is one issue regardless of message; a different key is a different issue';

  -- F9: a client-supplied fingerprint is never read (untrusted and trusted `fingerprint` fields ignored).
  v_fp := md5('attacker-chosen');
  v_res := public._system_ingest('client', jsonb_build_object('operation', 'rpc/f9', 'message', 'client boom', 'fingerprint', v_fp, 'fingerprint_key', 'forced:key'), v_ath);
  if not coalesce((v_res ->> 'accepted')::boolean, false) then raise exception 'F9 FAILED: client report rejected: %', v_res; end if;
  if exists (select 1 from public.system_issues where fingerprint = v_fp) then raise exception 'F9 FAILED: client fingerprint was used'; end if;
  if exists (select 1 from public.system_issues where fingerprint = md5('key' || chr(31) || 'forced:key')) then
    raise exception 'F9 FAILED: client fingerprint_key was honoured';
  end if;
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/f9', 'message', 'm', 'fingerprint', v_fp));
  if exists (select 1 from public.system_issues where fingerprint = v_fp) then raise exception 'F9 FAILED: trusted raw fingerprint field was used'; end if;
  raise notice 'F9 PASSED: client-supplied fingerprints (and keys) are ignored; the server computes the fingerprint';

  -- F10: source is part of identity.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f10', 'message', 'same'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/f10', 'message', 'same'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f10';
  if v_n <> 2 then raise exception 'F10 FAILED: % issues', v_n; end if;
  raise notice 'F10 PASSED: the same text from different sources is different issues';

  -- F11: client stack origin: same frames with different files/lines group; different frames split.
  perform public._system_ingest('client', jsonb_build_object('operation', 'ui/f11', 'error_class', 'TypeError', 'message', 'Cannot read properties of undefined (reading ''foo'')',
    'stack', E'TypeError: x\n    at renderRow (app://bundle.js:10:5)\n    at List (app://bundle.js:99:1)'), v_ath);
  perform public._system_ingest('client', jsonb_build_object('operation', 'ui/f11', 'error_class', 'TypeError', 'message', 'Cannot read properties of undefined (reading ''foo'')',
    'stack', E'TypeError: x\n    at renderRow (app://other-hash.js:777:12)\n    at List (app://other-hash.js:1:1)'), v_ath);
  select count(*) into v_n from public.system_issues where operation = 'ui/f11';
  if v_n <> 1 then raise exception 'F11 FAILED: same frames fragmented (% issues)', v_n; end if;
  perform public._system_ingest('client', jsonb_build_object('operation', 'ui/f11', 'error_class', 'TypeError', 'message', 'Cannot read properties of undefined (reading ''foo'')',
    'stack', E'TypeError: x\n    at otherThing (app://bundle.js:10:5)'), v_ath);
  select count(*) into v_n from public.system_issues where operation = 'ui/f11';
  if v_n <> 2 then raise exception 'F11 FAILED: different frames should split (% issues)', v_n; end if;
  raise notice 'F11 PASSED: client origin = function names of the top frames (no files / lines / bundle hashes)';

  -- F12: whitespace and case normalisation.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f12', 'message', 'Something   BAD happened'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f12', 'message', E'something bad\nhappened'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f12';
  if v_n <> 1 then raise exception 'F12 FAILED: % issues', v_n; end if;
  raise notice 'F12 PASSED: case and whitespace do not fragment issues';

  -- F13: the operation name itself cannot carry volatile ids.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f13/3f38a59f-3984-4f7f-a810-8e62ec34fd51', 'message', 'm'));
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'db', 'operation', 'fn/f13/9b2c1d00-1111-4222-8333-444455556666', 'message', 'm'));
  select count(*) into v_n from public.system_issues where operation = 'fn/f13/:uuid';
  if v_n <> 1 then raise exception 'F13 FAILED: operation uuid not normalised (% issues)', v_n; end if;
  raise notice 'F13 PASSED: uuids in operation names are normalised';

  -- ===================== REDACTION =====================
  v_msg := 'token=abc123secret Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk '
        || 'key ' || 'sb_' || 'secret_' || 'FAKEtestkeyFAKEtestkey0123456789abcdef' || ' mail jane.doe@example.com tel 0501234567 intl +972-52-765-4321 landline 02-1234567 '
        || 'id 123456789012 url https://x.co/p?access_token=zzzTOP&x=1 '
        || 'duplicate key value violates unique constraint "u_key" Key (email)=(victim@mail.com) already exists. '
        || '"password":"hunter2" temp_password=Abc123xyz password: letmein '
        || 'null value in column "dob" violates not-null constraint Failing row contains (1, secretvalue, 1990-01-01). DETAIL: more secretvalue';
  v_stack := E'Error: boom for jane.doe@example.com\n    at doThing (app://bundle.js:10:5)\n    at token=stackSecret99 (x)\nAuthorization: Bearer abcdef0123456789abcdef0123456789';
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/r1', 'message', v_msg, 'stack', v_stack,
    'route', '/(app)/manager/session/3f38a59f-3984-4f7f-a810-8e62ec34fd51?token=routeSecret',
    'context', jsonb_build_object('http_status', 500, 'provider', 'resend'),
    'request_body', jsonb_build_object('email', 'leak@x.com', 'password', 'bodysecret')));
  select i.id into v_a from public.system_issues i where i.operation = 'fn/r1';
  select row_to_json(i)::text || ' ' || coalesce((select string_agg(row_to_json(e)::text, ' ') from public.system_issue_events e where e.issue_id = i.id), '')
    into v_blob from public.system_issues i where i.id = v_a;
  if v_blob ~* 'eyJ' or v_blob ~ 'sb_secret' or v_blob ~* 'bearer\s+[A-Za-z0-9]' or v_blob like '%@%' then
    raise exception 'R1 FAILED: token/jwt/key/email survived: %', left(v_blob, 800);
  end if;
  if v_blob ~ '0501234567' or v_blob ~ '972-52' or v_blob ~ '765-4321' or v_blob ~ '02-1234567' then raise exception 'R1 FAILED: phone survived'; end if;
  if v_blob ~ '123456789012' then raise exception 'R1 FAILED: long number survived'; end if;
  if v_blob ~* 'zzzTOP' or v_blob ~* 'routeSecret' or v_blob ~ 'x=1' then raise exception 'R1 FAILED: URL query value survived'; end if;
  if v_blob ~* 'victim' or v_blob ~* 'secretvalue' or v_blob ~* 'Failing row contains \(1' then raise exception 'R1 FAILED: PostgreSQL key/row value survived'; end if;
  if v_blob ~* 'hunter2' or v_blob ~* 'Abc123xyz' or v_blob ~* 'letmein' or v_blob ~* 'stackSecret99' or v_blob ~* 'abcdef0123456789abcdef0123456789' then
    raise exception 'R1 FAILED: password / temp-password / secret survived';
  end if;
  if v_blob ~* 'bodysecret' or v_blob ~* 'leak@x' or v_blob ~* 'request_body' then raise exception 'R1 FAILED: unknown top-level JSON field was stored'; end if;
  if v_blob ~ '3f38a59f-3984' then raise exception 'R1 FAILED: uuid survived in free text / route'; end if;
  raise notice 'R1 PASSED: JWT, Bearer, Supabase key, email, Israeli phones, long numbers, URL queries, PG key/row values, passwords and unknown JSON fields are absent from every stored column';

  -- R2: stack keeps useful structure (newlines, function names).
  select e.stack into v_stack from public.system_issue_events e where e.issue_id = v_a limit 1;
  if v_stack not like E'%\n%' or v_stack not like '%doThing%' then raise exception 'R2 FAILED: stack lost its structure: %', v_stack; end if;
  raise notice 'R2 PASSED: sanitized stacks keep newlines and function names';

  -- R3/R4: context & entities allowlist (typed; unknown / invalid dropped).
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/r3', 'message', 'ctx',
    'context', jsonb_build_object('http_status', 502, 'provider', 'whatsapp', 'provider_code', '131030', 'rpc', 'staff_x',
      'retryable', true, 'phone', '0501234567', 'email', 'a@b.co', 'address', 'Herzl 1', 'dob', '1990-01-01',
      'health', 'asthma', 'password', 'p', 'headers', jsonb_build_object('authorization', 'Bearer abc'), 'body', 'raw',
      'duration_ms', '12', 'network_state', 'Bad Value', 'nested', jsonb_build_object('a', 1)),
    'entities', jsonb_build_object('session_id', '3F38A59F-3984-4F7F-A810-8E62EC34FD51', 'document_id', 'not-a-uuid',
      'user_id', '3f38a59f-3984-4f7f-a810-8e62ec34fd51', 'email', 'x@y.zz')));
  select e.context, e.entities into v_ctx, v_ent from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/r3';
  if v_ctx ->> 'http_status' <> '502' or v_ctx ->> 'provider' <> 'whatsapp' or v_ctx ->> 'provider_code' <> '131030'
     or v_ctx ->> 'rpc' <> 'staff_x' or (v_ctx -> 'retryable') <> 'true'::jsonb then
    raise exception 'R3 FAILED: valid allowlisted context was lost: %', v_ctx;
  end if;
  if v_ctx ?| array['phone', 'email', 'address', 'dob', 'health', 'password', 'headers', 'body', 'nested', 'duration_ms', 'network_state'] then
    raise exception 'R3 FAILED: unknown / wrongly typed context keys survived: %', v_ctx;
  end if;
  if (v_ctx ->> '_dropped')::int < 8 then raise exception 'R3 FAILED: dropped-key count missing: %', v_ctx; end if;
  if v_ent <> jsonb_build_object('session_id', '3f38a59f-3984-4f7f-a810-8e62ec34fd51') then
    raise exception 'R4 FAILED: entities not strictly allowlisted/typed: %', v_ent;
  end if;
  raise notice 'R3 PASSED: only allowlisted, correctly typed context keys are stored; unknown keys dropped (count only)';
  raise notice 'R4 PASSED: entities accept only allowlisted uuid-typed keys (uppercase uuid normalised, user_id/email/invalid dropped)';

  -- R5/R6: route template and operation.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/r5', 'message', 'r', 'route', '/(app)/manager/session/[id]'));
  select e.route into v_route from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/r5';
  if v_route <> '/(app)/manager/session/[id]' then raise exception 'R5 FAILED: route template mangled: %', v_route; end if;
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/r5b', 'message', 'r', 'route', 'has space and "quotes" <script>'));
  select e.route into v_route from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/r5b';
  if v_route is not null then raise exception 'R5 FAILED: invalid route stored: %', v_route; end if;
  raise notice 'R5 PASSED: route templates kept, invalid routes dropped';

  -- R7: truncation bounds.
  perform pg_temp.t137_ingest(jsonb_build_object('source', 'edge', 'operation', 'fn/r7', 'message', repeat('abcd efgh ', 400), 'stack', repeat(E'at f (x)\n', 800)));
end $$;

-- R7 (continued, plain SQL so the lengths can be asserted): bounded stored text.
do $$
declare
  v_m int; v_s int; v_l int;
begin
  select length(e.message), length(e.stack), length(i.latest_summary) into v_m, v_s, v_l
  from public.system_issue_events e join public.system_issues i on i.id = e.issue_id where i.operation = 'fn/r7';
  if v_m > 500 or v_s > 2000 or v_l > 300 then raise exception 'R7 FAILED: message=% stack=% summary=%', v_m, v_s, v_l; end if;
  raise notice 'R7 PASSED: message <= 500, stack <= 2000, summary <= 300 (got %, %, %)', v_m, v_s, v_l;
  raise notice 'ALL FINGERPRINT / REDACTION TESTS (F1-F13, R1-R5, R7) PASSED';
end $$;

rollback;
