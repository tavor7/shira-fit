-- Fix clean-reset replay: the next migration (20250330200000) appends a
-- column to this function's RETURNS TABLE, which CREATE OR REPLACE FUNCTION
-- does not allow for any OUT-parameter change. Drop first so it can be
-- redefined. No-op against any already-migrated environment: production's
-- only live overload is participant_registration_history/5 (date, date,
-- text, uuid, uuid); the 3-argument signature below does not exist there.
drop function if exists public.participant_registration_history(date, date, text);
