-- Subscription terms: let managers discard the unpublished draft.
--
-- Until now a saved draft could only leave the table by being published, so a manager who opened the editor (the
-- earlier "Edit as a new draft" saved a copy immediately) could not close it again. Drafts are never visible to
-- athletes; discarding one changes nothing they see and never touches published versions, consents or billing.
-- p_expected_updated_at guards against discarding a draft another manager saved after this one was loaded.

create or replace function public.discard_subscription_terms_draft(p_expected_updated_at timestamptz)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_draft public.legal_document_drafts%rowtype;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  select * into v_draft from public.legal_document_drafts where consent_type = 'subscription_terms' for update;
  if v_draft.consent_type is null then
    return json_build_object('ok', true, 'discarded', false);
  end if;
  if p_expected_updated_at is null or v_draft.updated_at <> p_expected_updated_at then
    return json_build_object('ok', false, 'error', 'draft_changed');
  end if;
  delete from public.legal_document_drafts where consent_type = 'subscription_terms';
  perform public._insert_activity_event(v_uid, 'subscription_terms_draft_discarded', 'legal_document', 'subscription_terms',
    jsonb_build_object('based_on_version', v_draft.based_on_version));
  return json_build_object('ok', true, 'discarded', true);
end;
$$;
revoke execute on function public.discard_subscription_terms_draft(timestamptz) from public, anon;
grant execute on function public.discard_subscription_terms_draft(timestamptz) to authenticated;
comment on function public.discard_subscription_terms_draft(timestamptz) is
  'Manager-only: delete the unpublished subscription-terms draft (published versions are immutable and unaffected).';

-- Self-check -----------------------------------------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.discard_subscription_terms_draft(timestamp with time zone)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.discard_subscription_terms_draft(timestamp with time zone)', 'EXECUTE') then
    raise exception 'self-check: discard_subscription_terms_draft has wrong EXECUTE privileges';
  end if;
  if has_table_privilege('authenticated', 'public.legal_document_drafts', 'DELETE') then
    raise exception 'self-check: legal_document_drafts must stay RPC-write-only';
  end if;
end $$;

notify pgrst, 'reload schema';
