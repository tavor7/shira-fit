-- Recognize "mom" / Hebrew אמא as a stable payment_method key for reporting.

create or replace function public.normalize_payment_method_key(p text)
returns text
language plpgsql
immutable
set search_path to public, pg_temp
as $$
declare
  t text := btrim(p);
  tl text;
begin
  if t is null or t = '' then
    return '(none)';
  end if;

  tl := lower(t);

  if tl in ('(none)', 'none', 'n/a', 'na', 'unspecified', 'unpaid', '-', '—') then
    return '(none)';
  end if;

  if tl = 'cash' or t in ('Cash', 'CASH', 'מזומן') then
    return 'cash';
  end if;

  if tl in ('paybox', 'pay box', 'pay-box') or t in ('PayBox', 'PAYBOX', 'פייבוקס') then
    return 'paybox';
  end if;

  if tl in ('mom', 'mother') or t in ('Mom', 'MOM', 'אמא', 'לאמא') then
    return 'mom';
  end if;

  if tl = 'other' or t in ('Other', 'OTHER', 'אחר') then
    return 'other';
  end if;

  return t;
end;
$$;

comment on function public.normalize_payment_method_key(text) is
  'Maps payment_method raw values to stable keys (cash, paybox, mom, other, (none)) for reporting.';
