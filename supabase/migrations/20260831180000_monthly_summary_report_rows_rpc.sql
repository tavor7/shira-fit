-- Single filtered/sorted query for generate-monthly-summary-pdf, replacing the N+1
-- fetch-all-then-resolve-paid_at-per-row loop the edge function used as a stopgap.
-- Service-role only (no auth.uid() check) — the edge function already authenticates
-- and role-checks the caller itself before invoking this.
create or replace function public.monthly_summary_report_rows(
  p_date_start timestamp with time zone,
  p_date_end timestamp with time zone
)
returns table (
  document_number text,
  created_at timestamptz,
  paid_at timestamptz,
  customer_name text,
  gross_amount numeric,
  net_amount numeric,
  vat_amount numeric,
  payment_method text,
  status document_status
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    d.document_number,
    d.created_at,
    coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) as paid_at,
    d.customer_name,
    d.gross_amount,
    d.net_amount,
    d.vat_amount,
    d.payment_method,
    d.status
  from public.documents d
  where coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) >= p_date_start
    and coalesce(public._document_payment_paid_at(d.source_type, d.source_id), d.created_at) <= p_date_end
  order by paid_at asc;
$function$;

revoke all on function public.monthly_summary_report_rows(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.monthly_summary_report_rows(timestamptz, timestamptz) to service_role;
