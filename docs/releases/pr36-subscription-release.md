# PR #36 release plan: subscription remediation

Nothing here has been run on production. Every production step needs the owner's explicit approval.

## What ships

Six migrations, in this order, then the web app. No Edge Function changes. The repo then holds 385 migrations; production has the other 379, and its list matched the repo exactly when last checked (2026-11-04).

| Migration | Purpose | Touches existing rows? |
|---|---|---|
| `20261104100000` | New enum values | No |
| `20261104101000` | One rule for allowance, coverage and billing dates; what each session was entitled to | No |
| `20261104102000` | Delete impact review, unfreeze; new columns on `subscription_freezes` | No |
| `20261104103000` | Ledger protection, grants, Reports and family totals, utilization RPC | No |
| `20261104104000` | Error-reporting allowlist rows (4 new rows in `system_issue_rules`) | No existing row |
| `20261104105000` | Payments on stopped and ended subscriptions, corrections table and workflow, coverage kept on completed sessions; new `released_from_covered` column on coverage | No value changes; the new column defaults to false |

### What changes for existing data after deployment

The migrations change no row, but behaviour changes the next time something touches a record:

- **Reconciliation** runs when attendance, a cancellation charge, a session's date or capacity, or a subscription changes. It then applies the new rules to that week only. The read-only dry run of 2026-11-03 found nothing it would change in production: both real no-shows were charged, and no week is over allocation.
- **Ended sessions without coverage stay as they are.** Dina Gerzon (25 and 28 Oct) and Yuval Fuchs (29 Oct) keep their regular prices.
- **Numbers that change immediately, with no data change:** Reports' daily expected and collected totals; family expected and collected (outstanding is unchanged, so reminders are unaffected); the Overview labels and figures.
- **Next billing** for a scheduled subscription shows its first charge.

## Owner decisions in this release

- **Completed sessions:** a stop, freeze, lowered allowance or shortened period does not take coverage from a session completed before the change took effect. See below.
- **Over-quota sessions:** an unpaid session may become covered when allowance frees up. A session already paid at the regular price keeps that price, with no automatic credit. Only money recorded on the session itself counts as paid: general account payments and subscription payments do not pin a session.
- **Stopped and ended subscriptions:** a payment is accepted only up to the outstanding subscription debt, and never for a future date. It does not reactivate the subscription, create a charge or restore coverage. Production has no ended subscription and no stopped subscription with debt today.
- **Receipt-locked sessions:** the manager's review and audit trail ship, but moving a receipted session to the regular price does not run until the accounting treatment is confirmed. See below.

## Coverage on completed sessions

A session that held coverage and is over is measured against what the week allowed on its own date, not against the limit a later change reduced. Completed sessions count first, so future bookings still face the reduced limit. Example: with a limit of 2, Sunday and Monday attended, a stop, freeze or lowered limit on Wednesday leaves both covered, and a new booking that week is not covered.

| Case | Result |
|---|---|
| Change effective after the session | Coverage stays |
| Session on the day the change takes effect, already over | Coverage stays |
| Session later that day, or still to come | Follows the change |
| Change backdated to before the session | Follows the change: the rule protects only what came first |
| Session running across midnight, begun on an earlier date | Coverage stays |
| Marked absent, then corrected to attended | Coverage it held is restored; an extra session stays extra |
| Three covered sessions against a limit of two | The third is corrected at the next reconcile |
| Deletion, unpenalized no-show, charged penalty, paid at regular price, receipt lock | Unchanged |

**Decision to confirm:** once a change has reduced the week's limit, a no-show freed up afterwards does not make an extra session free. If the same no-show was released before the change, the extra session is promoted as usual and stays covered. This is the conservative reading of "a change must not create additional covered sessions". The athlete may pay for a session that would have been free had the attendance been corrected earlier.

Reported allowance: the Overview, weekly usage and the athlete's view report the higher of the effective limit and the coverage kept, capped at what the week allowed, so kept sessions do not read as over-allocated. Booking always uses the effective limit.

## Open item: accounting confirmation for receipt-locked corrections

Moving a receipted session to the regular price may require a new tax document. Until this is confirmed:

- A manager's request is recorded as `awaiting_accounting`, with who, when and why. No price, balance, payment, receipt or document changes.
- The Overview, the corrections dialog and the delete dialog show the session as pending accounting review.
- The session stays covered. A manager can still choose to keep it covered, which changes no amount.

The gate is the `subscription_correction_accounting_confirmed` key in `system_monitoring_config`. It is absent, so off, after release. No client can read or write it. Turning it on is a separate owner decision, made after the accountant confirms the treatment, and may need follow-up work if a tax document is required:

```sql
insert into public.system_monitoring_config (key, value) values ('subscription_correction_accounting_confirmed', 'true'::jsonb)
on conflict (key) do update set value = excluded.value;
```

## Compatibility: the old app on the new database

Between steps 4 and 6 below, the previous web app runs against the new database. This was tested with the bundle served by production (built from 65a1d62) against the final six migrations at commit `79e1dd1`: 31 of 31 checks. The browser could reach only the disposable database.

| Old app action | Result | Risk |
|---|---|---|
| Overview, subscription list and detail, weekly usage, Reports | Work | None |
| Edit, freeze, stop, reactivate, create, record payment | Work, under the new rules | None |
| General account payments, including deleting one | Work | None |
| Payment on an ended subscription | Accepted up to the debt; more is refused | None |
| Delete a subscription with no history | Works | None |
| Delete a subscription with past covered sessions | **Refused with an error; nothing is deleted** | Confusing message only |
| Delete a subscription payment | **Refused with a raw error; the payment is kept** | Confusing message only |

**Mitigation:** release outside studio hours and avoid deleting subscriptions or subscription payments during the window. Neither failure can change money.

## Release steps

1. **Pre-checks (read-only):** CI green on the PR head; `origin/main` still at the PR's base, or merge it and re-run CI; latest production migration is `20261103150000`; no cron run in progress (billing runs at 03:00 UTC); record the fingerprints below.
2. **Backup:** confirm a recent financial backup exists.
3. **Approval:** owner approves production migrations.
4. **Apply migrations:** `supabase db push --linked --include-all` from a clean folder holding exactly the intended files. Each migration is transactional.
5. **Verify the database (read-only):** the checks below.
6. **Merge the PR.** This deploys the web app through Render. Requires its own approval.
7. **Verify the app:** the new bundle is served, then the Overview loads for a manager. Then repeat the fingerprints.
8. **Physical iPhone check**, by the owner.

## Post-deployment checks (read-only)

```sql
-- Financial rows are untouched: compare with the values recorded in step 1.
select md5(string_agg(id::text||amount_ils::text,',' order by id)) from subscription_charges;
select md5(string_agg(id::text||amount_ils::text||coalesce(reversed_at::text,''),',' order by id)) from athlete_account_payments;
select md5(string_agg(id::text||covered::text||coalesce(non_coverage_reason::text,''),',' order by id)) from subscription_registration_coverage;

-- No duplicate charges, reversals that mirror their charge, no corrections yet.
select count(*) from (select billing_period_id from subscription_charges where charge_type in ('recurring','proration') group by 1 having count(*)>1) x;
select count(*) from subscription_charges r join subscription_charges o on o.id=r.reverses where r.amount_ils<>-o.amount_ils;
select count(*) from subscription_deletion_corrections;

-- Clients cannot write the ledger.
select has_table_privilege('authenticated','subscription_charges','update'), has_table_privilege('anon','subscription_charges','select');

-- The integrity check reports nothing.
select public._subscription_integrity_check();
```

Note: `_subscription_integrity_check` writes to `system_issues` if it finds a problem. The daily billing run calls it too. After deployment, watch the 03:00 UTC run and `system_issues` for subsystem `subscriptions`.

## Rollback and forward fix

**Forward fix is the default.** The functions can be replaced without touching data.

- **Web app only:** roll back in the Render dashboard, or revert and push. The old app works on the new database, as shown above.
- **Database:** `docs/releases/pr36_rollback.sql`, with owner approval. Tested at `79e1dd1` on a disposable database after all 33 suites had run: 14 financial tables stayed byte-identical, including corrections pending accounting review and payments on stopped and ended subscriptions, and every function body returned to its `65a1d62` version.
- **Production's own suites after rollback:** 25 of 31 pass. Suites 186, 193 and 168 expect anonymous access that rollback keeps closed. Suites 161, 164, 168 and 200 fail the same way on clean `65a1d62`: an old function signature, dates that cross a week boundary midweek, an outdated cancellation expectation, and a fixture that assumes this week's Sunday is still ahead. Suite 163 fails only on an empty database, where nothing has yet enabled receipts. The PR's own copies of 161, 168, 186 and 200 are corrected. None of these is a release risk.
- Rollback keeps new enum values (PostgreSQL can't drop them), the corrections table and its guard, the freeze columns, `released_from_covered`, and tighter permissions: anon on the subscription and account payment tables, TRUNCATE, REFERENCES and TRIGGER for authenticated, and execute on internal helpers. It reopens manager write access to the ledger tables, as on production today, and removes the protection for completed sessions. Coverage rows written with new reasons (`no_show_released`, `paid_at_regular_price`, `subscription_deleted`) remain valid and read as not covered. Any corrections, including those pending accounting review, and any payments on stopped or ended subscriptions recorded before rollback remain as records and need review.

## Verification at `79e1dd1`

Later commits on the branch change only tests and documents; the six migrations are identical.

| Check | Result |
|---|---|
| Subscription suites on a new database, including CI | 33 of 33 |
| Suite 231 on the code before this fix (`3952db6`) | 43 failures, including the original report |
| Suite 231 on the fix | 336 of 336, covering each weekday with a pinned clock |
| Coverage and lifecycle suites with the clock on each other weekday | 54 of 54 runs |
| Suite 186, through the real gateway | Passes with `REST_URL` and `APIKEY` set; not part of CI |
| Browser, one run on a new database | Overview 64 of 64, workflows 60 of 60 |
| Jest, TypeScript, lint | 925 pass and 8 skipped; no errors |

Not verified: a physical iPhone.

## Approval boundaries

| Action | Who approves |
|---|---|
| Push to the PR branch, CI, local and disposable testing | Already authorized |
| Apply migrations to production | Owner, separately |
| Merge to `main` (deploys Render) | Owner, separately |
| Any correction to a historical payment, session or charge | Owner, per record |
| Turning on applied corrections after accounting confirms | Owner, separately |
| Running the rollback script | Owner, separately |

## Historical records awaiting manual review

No production record has been changed. None of these are changed by this release.

| Record | Decision |
|---|---|
| Talia Levav, ₪400, 30 Oct | Do not change. Purpose unconfirmed; manual review. |
| Shiran Ben Shitrit, ₪165, 1 Nov | Stays a general account payment. |
| Efrat El Hadad, ₪50, 30 Oct | Stays as account credit pending clarification. |
| Shiran Ben Shitrit, ₪100, 26 Oct | Needs clarification from Lotem Meltzer. Not contacted. |
| Dina Gerzon, 25 and 28 Oct; Yuval Fuchs, 29 Oct | Stay at regular price unless separately approved. |

**Question for Lotem Meltzer:** What was the ₪100 cash payment recorded on October 26 intended to cover, and did it include any previous outstanding sessions?
