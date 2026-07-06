-- Fix save error: request_address_setting_changed was missing from document_event_action enum.

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'document_event_action'
      and e.enumlabel = 'request_address_setting_changed'
  ) then
    alter type public.document_event_action add value 'request_address_setting_changed';
  end if;
end;
$$;
