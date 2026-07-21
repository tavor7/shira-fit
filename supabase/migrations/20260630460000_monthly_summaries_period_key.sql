-- Key monthly summaries by calendar month (derived from period_start) so regenerating
-- a summary for the same month replaces the previous one instead of piling up duplicates.

alter table public.monthly_summaries
  add column if not exists period_month date;

update public.monthly_summaries
  set period_month = date_trunc('month', period_start)::date
  where period_month is null;

alter table public.monthly_summaries
  alter column period_month set not null;

create unique index if not exists monthly_summaries_period_month_idx
  on public.monthly_summaries (period_month);
