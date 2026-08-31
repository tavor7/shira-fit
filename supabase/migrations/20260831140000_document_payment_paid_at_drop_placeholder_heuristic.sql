-- The "placeholder date" heuristic (treat any payment dated on the last day of its month as a
-- meaningless bulk-import placeholder, and substitute created_at instead) turned out to match
-- every single athlete_account_payments row, since paid_at has only ever been set to month-end
-- values historically — including genuine, correctly-recorded payments (e.g. a payment actually
-- made on June 30). There is no way to distinguish "real month-end payment" from "placeholder"
-- by date alone, so stop guessing and trust the recorded paid_at value as-is.
create or replace function public._document_payment_paid_at(p_source_type public.document_source_type, p_source_id uuid)
returns timestamptz
language sql
stable
as $function$
  select case p_source_type
    when 'account_payment' then (
      select a.paid_at::timestamptz from public.athlete_account_payments a where a.id = p_source_id
    )
    when 'cancellation_penalty' then (select c.cancelled_at from public.cancellations c where c.id = p_source_id)
    when 'session_payment' then coalesce(
      (select (s.session_date + s.start_time) at time zone 'Asia/Jerusalem'
       from public.session_registrations r join public.training_sessions s on s.id = r.session_id
       where r.id = p_source_id),
      (select (s.session_date + s.start_time) at time zone 'Asia/Jerusalem'
       from public.session_manual_participants m join public.training_sessions s on s.id = m.session_id
       where m.id = p_source_id)
    )
    else null
  end;
$function$;
