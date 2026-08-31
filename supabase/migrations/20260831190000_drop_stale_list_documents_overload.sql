-- A pre-customer_type 5-arg overload of list_documents was never dropped when the
-- 6-arg (with p_customer_type) version was introduced, leaving two functions with the
-- same name in the schema. Two overloads sharing a name can make PostgREST's RPC
-- resolution ambiguous/unreliable. Drop the dead one.
drop function if exists public.list_documents(timestamp with time zone, timestamp with time zone, document_status, integer, integer);

notify pgrst, 'reload schema';
