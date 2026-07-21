-- Enable Realtime (Postgres Changes) on the tables that drive "is something happening
-- right now" screens: sessions being created/edited/cancelled, registrations, cancellations,
-- waitlist joins, and manual/walk-in participant management. RLS still applies — a client only
-- receives change events for rows it could already SELECT.
alter publication supabase_realtime add table public.training_sessions;
alter publication supabase_realtime add table public.session_registrations;
alter publication supabase_realtime add table public.cancellations;
alter publication supabase_realtime add table public.waitlist_requests;
alter publication supabase_realtime add table public.manual_participants;
alter publication supabase_realtime add table public.session_manual_participants;
