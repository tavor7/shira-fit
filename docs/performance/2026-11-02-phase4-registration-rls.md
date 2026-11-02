# Phase 4 — Registration access rule (`reg_select`): role checks once per query

Branch `perf/registration-rls-initplan`. **Not applied anywhere except rolled-back tests; production migration needs your
explicit approval.** Labels: [M-local] perf stack · [M-prod] production read-only.

## Current behaviour

`reg_select` = `is_super_user(auth.uid()) OR (user_id = auth.uid() AND NOT is_registration_hidden(…)) OR
(is_coach(auth.uid()) AND NOT is_registration_hidden_from_coach(…)) OR (is_manager(auth.uid()) AND NOT
is_registration_hidden_from_manager(…))`. The six helpers are SECURITY DEFINER SQL (not inlinable), so for every row the
policy runs three `profiles` role lookups (same answer on every row) plus a hidden-registration lookup.

## Change — migration `20261103090000_session_registrations_select_policy_initplan.sql`

The three role checks and `auth.uid()` become init-plans (evaluated once per query); the per-row hidden checks are
unchanged. Same functions and arguments, all STABLE → same rows. Only `reg_select` changes.
- Precondition: `reg_select` expression md5 `79f246da…` and the six helper bodies equal the reviewed ones (all checked
  equal on production, read-only, 2026-11-02). Post-check `1599907c…` (Postgres deparse). Re-run = no-op.
- Rollback: `docs/performance/rollback/20261103090000_…_ROLLBACK.sql` (pre / post-checked); round trip tested.

## Equivalence — suite `supabase/tests/204` (one rolled-back transaction)

Fixtures: pending, rejected and disabled athletes, a disabled coach; hidden registrations for athlete-only, coach-only,
manager-only and all audiences, plus an un-hidden one. Callers: every profile, a no-profile caller, anon. Query shapes:
all registrations, a session with hidden rows, own active registrations, upcoming sessions, and the athlete calendar on
`training_sessions` (whose policy reads registrations).
**V1** identical visible rows for every caller kind on every shape · **V2** hiding demonstrably applies (super user 2,658
rows, coach / manager 2,651) · **P1** InitPlan present.

## Performance [M-local, rolled back; production runs ≈2-3.5× slower]

| Query | Current | New |
|---|---|---|
| Staff reading all registrations (manager / coach) | 68.5 / 41.9 ms | 12.9 / 15.0 ms |
| Registrations of upcoming sessions | 2.2-2.9 ms | 0.85-1.85 ms |
| Own registrations; roster of one session | 0.02-0.3 ms | unchanged |

## Release

Apply with `supabase db push --linked` after approval; post-checks: policy md5 `1599907c…`, read-only visibility
spot checks per role (as done for 20261101091000), Postgres error logs. App code unchanged.
