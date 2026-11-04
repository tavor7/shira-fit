# SQL tests (`supabase/tests`)

There is no pgTAP setup. The subscription suites run in CI (`.github/workflows/subscription-db-tests.yml`, via `scripts/db-tests/run-subscription-suite.sh`) against a throwaway stack; the rest are run by
hand against a **scratch database**. Each file's header comment says what it covers and anything special it needs.

## Two kinds of files

| Kind | Examples | How to run |
|---|---|---|
| `NNN_*.sh` wrappers (self-checking, they print `PASSED`/`FAILED` lines and exit non-zero on failure) | `143`-`178` shell suites | `PSQL="docker exec -i <db-container> psql -U postgres" bash supabase/tests/<file>.sh` |
| standalone `NNN_*.sql` files (`DO` blocks that `RAISE EXCEPTION` on failure) | `136`-`144`, `154`, ... | `docker exec -i <db-container> psql -U postgres -v ON_ERROR_STOP=1 -f - < supabase/tests/<file>.sql` |

Some wrappers also need `PSQL_AUTH` (a real `authenticator` connection, see the header) or `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`
(`175`). The numbered `*_race_a` / `*_race_b` / `*_setup` / `*_verify` files are parts of concurrency tests; run them in the order given in their headers.

## Always use `ON_ERROR_STOP=1` for standalone `.sql` files

The standalone files do not set it themselves (only `143` does). Without `-v ON_ERROR_STOP=1`, `psql` prints the `ERROR:` and **still exits 0**,
so a failing test looks like a pass to anything that only checks the exit status.

## Reading the result

| Exit status | Meaning |
|---|---|
| `0` | every assertion ran and passed (look for the `... PASSED` notices; a run that prints none did not prove anything) |
| `3` | an SQL error or failed assertion stopped the script (`ON_ERROR_STOP`), the output shows which one (`... FAILED: ...`) |
| `2` | `psql` could not connect |
| `1` | other `psql` error, or a shell wrapper's own check failed (it prints `FAILED: ...`) |

The shell wrappers decide their own exit status and never rely on a `grep` over the output. `157b_*` and `151b_*` are self-tests that prove this: a
deliberately failing assertion, a failing `psql` and a silent `psql` must all make the suite exit non-zero.

## Which database

- **Local Supabase stack** (`supabase start`, migrations replayed, includes `auth`, `pg_cron`, PostgREST): almost every suite from `136` on, and all `.sh` wrappers.
- **Scratch `postgres:15` container with the stub schemas** (`00`-`04` first, then the Phase 1-4A migrations): the older suites whose header says
  "scratch container" / "NOT the real Supabase stack": `10`, `100`, `110`, `123`, `130`, `158`, `176`, and `177` (which runs `00`, `10`, `30` and `176`). Other
  older suites (`20`-`75`, `111`-`121`) carry no such note in their header, so check each header before choosing a database.
- Start from a fresh `supabase db reset` when a suite says so. `143` and `157` are written to pass on a database the real observer has already run on.

## Never run these against production

They create users and sessions (`auth.users`, profiles, registrations), some **commit** fixture rows, some temporarily change monitoring or
ingestion configuration (`173`), several take advisory locks or hold row locks while racing sessions, and `144` replays about 8,000 observer
cycles. The migration checks (`151`, `157`) execute the migration file itself. Even with a rollback, that can lock live tables, change live
configuration or leave fixtures behind, and a "pass" on production data proves nothing. Production is verified only with read-only queries.

## Suites with special needs

`186` goes through the real gateway: set `REST_URL` (the stack's API URL plus `/rest/v1`) and `APIKEY` (the anon key). It is not in CI.
`231` replaces `_studio_today_date` and `_session_has_ended` to pin the clock, and restores them on exit. Never run it anywhere but a disposable database.

## Retired suites

`71_billing_tests_freeze_stop.sql`, `72_billing_tests_retro_idem.sql`, `92_billing_segmentation_anchor_freeze.sql` and
`124_freeze_pause_semantics_tests.sql` were removed. They ran on the stub schema against the function versions of their own
phase, could not run on a real stack, and described a freeze moving the start of the cycle it falls in. Every scenario still
relevant (B5-B12, VC1, VC2, A, D, F, G-L) now lives in `228_subscription_freeze_billing_rules_tests.sh`, under the same
scenario ids, and runs in CI.

Other stub-schema suites (`70`, `76`, `80`, `81`, `90`, `91`, `101`, `123`) test superseded versions of their own phase in the same
way. They are historical: the current rules are the ones in CI.
