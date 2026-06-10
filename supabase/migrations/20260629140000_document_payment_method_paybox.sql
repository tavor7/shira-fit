-- Support PayBox and Mom as document payment methods (match session/account recording).

do $$ begin
  alter type public.document_payment_method add value 'paybox';
exception when duplicate_object then null;
end $$;

do $$ begin
  alter type public.document_payment_method add value 'mom';
exception when duplicate_object then null;
end $$;

create or replace function public._map_session_payment_to_document_method(p_method text)
returns public.document_payment_method
language plpgsql
immutable
as $$
declare
  v_key text := public.normalize_payment_method_key(p_method);
begin
  if v_key = 'cash' then return 'cash';
  elsif v_key = 'paybox' then return 'paybox';
  elsif v_key = 'mom' then return 'mom';
  elsif v_key = 'other' then return 'other';
  else return null;
  end if;
end;
$$;
