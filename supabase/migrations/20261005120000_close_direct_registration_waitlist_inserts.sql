-- Security: close the direct-INSERT bypass on session_registrations and waitlist_requests.
--
-- 20260409120000_security_hardening.sql already dropped these two policies so that registrations
-- and waitlist entries can only be created through the SECURITY DEFINER RPCs (register_for_session,
-- request_waitlist). Production nevertheless still has both: they were recreated when the policy
-- section of 20250314000000_initial.sql was re-executed on the production database after the
-- hardening migration had run. With the policies present, any authenticated user could insert a
-- row for themselves directly through the REST API, skipping every RPC rule -- the session-row
-- capacity lock added in 20261003120000, the capacity check, registration-open / ended / hidden
-- checks, account and approval checks, and subscription accounting.
--
-- Dropping the permissive INSERT policies is sufficient: RLS is enabled on both tables and no other
-- INSERT policy exists, so direct client INSERTs are denied by default. The RPCs are SECURITY DEFINER
-- and are not affected. Idempotent: a no-op wherever the policies are already gone (e.g. a replay
-- of the full migration history). Schema-only; no data is touched.

drop policy if exists "reg_insert_self" on public.session_registrations;
drop policy if exists "waitlist_insert_self" on public.waitlist_requests;
