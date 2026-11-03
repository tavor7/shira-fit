# Shared fixture helpers for the remediation suites. Sourced, never run. Drives the REAL RPCs over an
# `authenticator` connection as `authenticated` with JWT claims. SCRATCH DATABASES ONLY.
set -u
PSQL=${PSQL:?set PSQL}
PSQL_AUTH=${PSQL_AUTH:?set PSQL_AUTH}
FAILED=0; PASSED=0
# Queries go over stdin: results embedded in a query can exceed the command-line limit of `docker exec`.
su() { if [ "$1" = "-c" ]; then printf '%s\n' "$2" | $PSQL -qAt -v ON_ERROR_STOP=1; else $PSQL -qAt -v ON_ERROR_STOP=1 "$@"; fi; }
ok()   { PASSED=$((PASSED+1)); echo "  PASSED: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAILED: $1"; }
expect() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else fail "$1: expected '$2' got '$3'"; fi; }
contains() { case "$3" in *"$2"*) ok "$1";; *) fail "$1: expected to contain '$2' got '$3'";; esac; }
finish() { echo "passed: $PASSED, failed: $FAILED"; [ "$FAILED" -eq 0 ]; exit $?; }
api_as() { local role=$1 uid=$2; shift 2
  { echo "begin; set local role $role;"
    [ -n "$uid" ] && echo "set local request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"$role\"}';"
    printf '%s\n' "$1"; echo "commit;"; } | $PSQL_AUTH -qAt -v ON_ERROR_STOP=1 -f - 2>&1; }
api() { api_as authenticated "$@"; }
jf() { su -c "select ('$1'::jsonb) #>> '{$2}'"; }
TODAY=$(su -c "select public._studio_today_date()")
d() { su -c "select (date '$TODAY' + $1)::date"; }
NEXT_SUN=$(su -c "select (date '$TODAY' + ((7 - extract(dow from date '$TODAY')::int) % 7) + 7)::date")
wk() { su -c "select (date '$NEXT_SUN' + $1*7 + $2)::date"; }   # week_index, day (0=Sun..6=Sat)
lastsun() { su -c "select (date '$TODAY' - extract(dow from date '$TODAY')::int - 7*$1)::date"; } # N weeks back
mkuser() { # role -> U
  local n; n=$(date +%s%N | tail -c 10)
  U=$(su -c "select gen_random_uuid()")
  su -c "insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    ('$U','00000000-0000-0000-0000-000000000000','authenticated','authenticated','h-$n@t.local', jsonb_build_object('full_name','h$n','phone','07$n','gender','female','address','A','zip_code','1'), now(), now());
    update public.profiles set approval_status='approved', role='$1' where user_id='$U'" >/dev/null
}
mkuser manager; M=$U; mkuser coach; CO=$U
mkmanual() { # -> MP
  local n; n=$(date +%s%N | tail -c 10)
  MP=$(su -c "insert into public.manual_participants(full_name, phone, gender) values ('m$n','06$n','female') returning id" | head -1)
}
mksub() { # athlete start limit [price] [end] -> SUB VER
  local end=${5:-null}; [ "$end" != null ] && end="'$end'"
  R=$(api "$M" "select public.create_subscription('$1', false, ${4:-360}, '$2', $end, null, jsonb_build_array(jsonb_build_object('tier','group','weekly_limit',$3)))::text;")
  case "$R" in *'"ok" : true'*) :;; *) fail "mksub: $R"; finish;; esac
  SUB=$(jf "$R" subscription_id)
  VER=$(su -c "select id from public.subscription_versions where subscription_id='$SUB' and effective_to is null")
}
_slot=0
mksession() { # date [cap] [time] -> SX. Unique time per session so (coach, date, time) never collides.
  _slot=$((_slot+1))
  local t; t=${3:-$(su -c "select ('06:00'::time + ($_slot || ' minutes')::interval)::time")}
  SX=$(su -c "insert into public.training_sessions (session_date, start_time, duration_minutes, coach_id, max_participants, is_open_for_registration) values ('$1', '$t', 60, '$CO', ${2:-8}, true) returning id" | head -1)
}
register() { # athlete session -> R, REG
  R=$(api "$1" "select public.register_for_session('$2', true)::text;")
  REG=$(su -c "select id from public.session_registrations where session_id='$2' and user_id='$1' limit 1")
}
past_reg() { # athlete session [attended] -> REG; a past session cannot be booked through the RPC
  REG=$(su -c "insert into public.session_registrations (session_id, user_id, status, attended) values ('$2','$1','active',${3:-null}) returning id" | head -1)
}
mark() { su -c "update public.session_registrations set attended=$2, charge_no_show=${3:-false} where id='$1'" >/dev/null; }
cov() { su -c "select coalesce((select covered::text || ':' || coalesce(non_coverage_reason::text,'') from public.subscription_registration_coverage where registration_id='$1'),'none')"; }
covm() { su -c "select coalesce((select covered::text || ':' || coalesce(non_coverage_reason::text,'') from public.subscription_registration_coverage where manual_participant_id='$1'),'none')"; }
charges() { su -c "select coalesce(sum(amount_ils),0) from public.subscription_charges where subscription_id='$1'"; }
