# RPC outcome registry (monitoring Phase 3A)

Classification only. Nothing in this folder reports, logs, intercepts or changes any runtime behaviour; the app does not
import it yet. It answers one question: **for operation X returning code Y, is the outcome expected business behaviour,
expected authorization/validation behaviour, a technical failure, uncertain, or unknown because nobody classified it?**

## Pieces

| File | Role |
|---|---|
| `registry.ts` | The canonical, source-controlled classification (the only file a developer edits for a new code) |
| `classify.ts` | `classifyRpcOutcome(operation, code)` - pure lookup; `classifyWith(registry, ...)` for tests |
| `types.ts` | Types. Classes: `business`, `authorization_validation`, `technical`, `uncertain`; lookup may also yield `unknown` |
| `extract.ts` | **Tooling only** (reads the filesystem): extracts the current outcome inventory from `supabase/migrations` |
| `rpcOutcomes.test.ts` | Classification semantics |
| `rpcOutcomesCompleteness.test.ts` | Registry vs. the current migrations, extractor self-tests, mutation checks |

## Resolution order

1. rule for exactly `(operation, code)`
2. rule of an operation it **relays** (`DELEGATES`, followed transitively)
3. global rule (`GLOBAL_RULES`: only `forbidden` and `not_authenticated`, whose meaning was verified identical everywhere)
4. `unknown`

There are no wildcards and no naming heuristics. `not_*`, `invalid_*`, `already_*`, `*_required` are `unknown` unless
registered. Raw database text returned as `error` (operations in `DYNAMIC_ERROR_SITES`) is looked up like any string -
`unknown` - and the result carries `dynamicErrorPossible: true`.

`operation` is the SQL function that **emits** the code. `coach_add_athlete` returns `_coach_add_athlete_core`'s codes, so
it is declared a relay of it instead of repeating the rules.

Known limitation: a code that is both `RAISE`d and `return`ed by the same operation shares one rule (thrown vs returned
is not part of the key).

## Adding or changing a code (developer workflow)

You add `jsonb_build_object('ok', false, 'error', 'new_code')` to a function. `npm test` then fails with the exact pair:

```
1 outcome(s) need classification in src/lib/rpcOutcomes/registry.ts ...
  my_rpc -> 'new_code' (returned)
```

Add it under `my_rpc` in `OPERATION_RULES` with a deliberate class. Use `technical` only for failures/invariants that
should never happen in normal operation, and give technical/uncertain entries a rationale. If a function starts returning
another function's result, or calling an outcome-emitting function, the test asks you to declare it in `DELEGATES`
(relay) or `CONSUMED_CALLS` (result swallowed/aggregated). A new `'error', <expression>` site must be declared in
`DYNAMIC_ERROR_SITES`.

## What the completeness test detects

- new `(operation, code)` pairs (returned or `RAISE EXCEPTION 'token'`) with no rule - including a known string used by a
  new operation (only the two global codes are exempt, by design)
- registry entries for codes/operations that no longer exist (stale)
- an operation rule contradicting a global rule without a rationale, and redundant duplicates of a global rule
- new calls between outcome-emitting functions that have not been reviewed as relay vs consumed
- new or removed non-literal `'error', <expr>` sites
- extraction is by replaying migrations in file order (`create/replace` and `drop function`), so only the latest live
  definition of each function counts; formatting (case, whitespace, newlines, `json_`/`jsonb_`, dollar tags) does not matter

## What it cannot detect (so it must not be trusted for these)

- codes assembled at runtime (concatenation, `format()`, values read from variables/tables) - the `'error', <expr>` site is
  reported, the values are not
- codes in `EXECUTE`d SQL or functions created inside `DO` blocks
- result shapes without an `error` key (declare the key in `CODE_BEARING_KEYS`; `manager_activity_revert_info` uses `reason`)
- overloads with the same argument count but different types (merged by name)
- functions that exist in production but not in the migrations (see follow-up 1)
- codes produced by Edge Functions or client code (this registry covers database RPCs only)

Verified once against production catalog definitions (Phase 3A run): after replaying the migrations, 137 of 139
code-emitting functions yield exactly the same codes as `pg_proc`; the 2 differences are follow-up 1.

## Decisions on previously uncertain codes

Evidence = the function text, the callers, FK/trigger structure and production data (read-only).

| Operation -> code | Class | Evidence |
|---|---|---|
| any `*_not_found` / `not_found` on a row id taken from a list the user was looking at (documents, notes, cancellations, families, messages, `system_issue_*`, sessions in register/cancel/attendance/staff flows, users in `staff_*`, manual participants, payments, registrations, source subscription) | business | stale reference: row deleted/changed since the list was loaded |
| `get_current_legal_document -> not_found` | technical | production has a current document for all 4 consent types; absence is a data/deployment fault |
| `update_session_note`, `manager_set_cancellation_charge -> session_not_found` | technical | `session_notes`/`cancellations` reference the session `ON DELETE CASCADE`: unreachable unless an invariant is violated |
| `subscription_reserve_or_reject -> session_not_found` (RAISE) | technical | callers lock/check the session first: unreachable |
| `subscription_generate_or_correct_billing_period -> subscription_not_found`, `version_not_found`, `version_subscription_mismatch` | technical | internal helper called with ids its callers just validated |
| `register_for_session -> no_profile` | technical | `on_auth_user_created` creates profiles; 0 auth users without one in production |
| `no_current_version` (4 operations) | technical | `stop_subscription` only sets `stopped_effective_date`, so every subscription keeps an open version; 0 violations in production |
| `reactivate_subscription -> source_has_no_version` | technical | a subscription always has a version |
| `manager_revert_activity_event -> remove_failed / restore_failed` | technical | fallback used only when the callee failed without its own code |
| `manager_activity_revert_info -> missing_*_context` (6) | technical | activity-event metadata lacks keys its writer must record |
| `staff_update_profile_text -> user_not_found` | authorization_validation | raised for an empty id text: input validation |
| `account_disabled` | operation-specific | caller disabled (`register_for_session`, `request_waitlist`) = authorization_validation; target participant disabled (staff add/move) = business |
| **`edit_subscription_version -> concurrent_modification`** | **uncertain** | update guarded by the admin advisory lock found 0 rows: a writer bypasses the lock, or the branch is purely defensive |
| **`cancel_registration`, `set_registration_attendance`, `set_manual_participant_attendance -> update_failed`** | **uncertain** | row existed at the previous check, then the UPDATE touched 0 rows: benign race (double tap) or invariant; the code cannot tell which |
| **`_try_sync_signup_consent_for_user -> user_not_found`** | **uncertain** | auth.users lookup; impossible inside the trigger, reachable from the client sync RPC only with a live token of a deleted account |

Unresolved (5 pairs) need a product/implementation decision: the three `update_failed` pairs, `concurrent_modification`,
and `_try_sync_signup_consent_for_user -> user_not_found`.

## Open follow-ups discovered, deliberately NOT fixed in Phase 3A

1. **Repository/production drift**: production `request_waitlist` and `cancel_registration` are older definitions than the
   latest repo migrations (`20260408...`, `20260628230000_account_disabled`, `20260531...`): production lacks the
   disabled-account / session-ended / session-started checks. Needs a reviewed reconciliation.
2. `register_for_session`: function-wide `EXCEPTION WHEN unique_violation` maps ANY unique violation (including from
   coverage/history inserts) to `already_registered`.
3. Ten functions return raw `SQLERRM` as `error` (see `DYNAMIC_ERROR_SITES`).
4. `PERFORM subscription_generate_or_correct_billing_period(...)` discards its `ok:false` in create/edit/freeze/stop/
   reactivate/compute_impact (`CONSUMED_CALLS`).
5. Swallowed partial failures: `staff_create_session_series` / `_copy_session_roster` (`WHEN OTHERS THEN NULL`),
   push helpers, signup consent triggers.
6. About 9 client direct-write calls ignore their result (pricing deletes, push-token sync, signup profile update).
7. Silent-invariant failures need purpose-built detectors (Phase 3G).
