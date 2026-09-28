-- Security follow-up: evaluate_manager_operational_departure and the two trigger functions were
-- created without an explicit REVOKE, so they inherited the default PUBLIC EXECUTE grant Postgres
-- gives every new function -- unlike the other internal helpers added in the same migration
-- (get_manager_notification_prefs/set_manager_notification_prefs, which are deliberately callable
-- and self-check auth.uid()/is_manager()), evaluate_manager_operational_departure has a WRITE
-- side effect (inserts a real manager_operational_notifications row and sends real pushes to real
-- managers) and accepts a fully caller-controlled p_departed_label that is embedded directly into
-- the push body -- exploitable by any authenticated (or anon) caller to spam managers with fake
-- "participant cancelled" alerts for an arbitrary real session, with attacker-chosen text, and no
-- actual departure ever having occurred. Locking this down to internal-trigger-only use, matching
-- the established convention for _push_notifications_enabled()/generate_due_subscription_charges().

revoke all on function public.evaluate_manager_operational_departure(uuid, text, text) from public, anon, authenticated;
revoke all on function public.tg_manager_notify_on_registration_departure() from public, anon, authenticated;
revoke all on function public.tg_manager_notify_on_manual_departure() from public, anon, authenticated;
