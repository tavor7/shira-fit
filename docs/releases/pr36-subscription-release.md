# PR #36 release plan: subscription remediation

Nothing here has been run on production. Every production step needs the owner's explicit approval.

## What ships

Six migrations, in this order, then the web app. No Edge Function changes.

| Migration | Purpose | Touches existing rows? |
|---|---|---|
| `20261104100000` | New enum values | No |
| `20261104101000` | One rule for allowance, coverage and billing dates | No |
| `20261104102000` | Delete impact review, unfreeze; new columns on `subscription_freezes` | No |
| `20261104103000` | Ledger protection, grants, Reports and family totals, utilization RPC | No |
| `20261104104000` | Error-reporting allowlist rows (4 new rows in `system_issue_rules`) | No existing row |
| `20261104105000` | Stopped-subscription payments, corrections table and workflow | No |

### What changes for existing data after deployment

The migrations change no row, but behaviour changes the next time something touches a record:

- **Reconciliation** runs when attendance, a cancellation charge, a session's date or capacity, or a subscription changes. It then applies the new rules to that week only. The read-only dry run of 2026-11-03 found nothing it would change in production: both real no-shows were charged, and no week is over allocation.
- **Ended sessions without coverage stay as they are.** Dina Gerzon (25 and 28 Oct) and Yuval Fuchs (29 Oct) keep their regular prices.
- **Numbers that change immediately, with no data change:** Reports' daily expected and collected totals; family expected and collected (outstanding is unchanged, so reminders are unaffected); the Overview labels and figures.
- **Next billing** for a scheduled subscription shows its first charge.

## Compatibility: the old app on the new database

Between steps 4 and 6 below, the previous web app runs against the new database. This was tested with the actual production bundle (65a1d62) against all six migrations.

| Old app action | Result | Risk |
|---|---|---|
| Overview, subscription list and detail, weekly usage, Reports | Work | None |
| Edit, freeze, stop, reactivate, create, record payment | Work, under the new rules | None |
| General account payments, including deleting one | Work | None |
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
- **Database:** `docs/releases/pr36_rollback.sql`, with owner approval. Tested on a disposable database after real activity: payments and charges stayed byte-identical, and the production test suites pass apart from one expecting the anon access that rollback deliberately keeps closed, and one with an existing weekday dependency.
- Rollback keeps new enum values (PostgreSQL can't drop them), the corrections table, the freeze columns and the tighter anon grants. Coverage rows written with new reasons (`no_show_released`, `paid_at_regular_price`, `subscription_deleted`) remain valid and read as not covered. Any corrections or stopped-subscription payments recorded before rollback remain as records and need review.

## Approval boundaries

| Action | Who approves |
|---|---|
| Push to the PR branch, CI, local and disposable testing | Already authorized |
| Apply migrations to production | Owner, separately |
| Merge to `main` (deploys Render) | Owner, separately |
| Any correction to a historical payment, session or charge | Owner, per record |
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
