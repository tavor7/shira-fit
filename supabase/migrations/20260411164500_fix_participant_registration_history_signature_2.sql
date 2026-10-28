-- Fix clean-reset replay: same issue as 20250330190000, needed again
-- because 20260411165000 changes this function's RETURNS TABLE again
-- (removes a column). No-op against any already-migrated environment for
-- the same reason: the 3-argument signature does not exist in production.
drop function if exists public.participant_registration_history(date, date, text);
