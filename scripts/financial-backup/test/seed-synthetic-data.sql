-- Synthetic test data for the financial backup/restore pipeline. No real customer data.
-- Covers: a manager, a customer, an ACTIVE receipt, a CANCELLED receipt (with reversal), an
-- account payment, a subscription with a billing period and charge, and PDF version history --
-- exercising every table in scope.sys and every check in verify.js.

do $$
declare
  v_manager_id uuid := '00000000-0000-0000-0000-0000000f1001';
  v_athlete_id uuid := '00000000-0000-0000-0000-0000000f1002';
  v_customer_id uuid;
  v_payment_id uuid;
  v_doc_active_id uuid;
  v_doc_cancelled_id uuid;
  v_sub_id uuid;
  v_version_id uuid;
  v_period_id uuid;
  v_reversal_payment_id uuid;
  v_doc_reversal_id uuid;
begin
  insert into auth.users (id, email) values (v_manager_id, 'fin-backup-test-manager@example.com')
  on conflict (id) do nothing;
  insert into public.profiles (user_id, username, full_name, phone, gender, role, approval_status)
  values (v_manager_id, 'fin_backup_test_mgr', 'Fin Backup Test Manager', '0500000002', 'male', 'manager', 'approved')
  on conflict (user_id) do update set role = 'manager', approval_status = 'approved';

  insert into auth.users (id, email) values (v_athlete_id, 'fin-backup-test-athlete@example.com')
  on conflict (id) do nothing;
  insert into public.profiles (user_id, username, full_name, phone, gender, role, approval_status)
  values (v_athlete_id, 'fin_backup_test_athlete', 'Fin Backup Test Athlete', '0500000003', 'female', 'athlete', 'approved')
  on conflict (user_id) do update set role = 'athlete', approval_status = 'approved';

  perform set_config('request.jwt.claims', json_build_object('sub', v_manager_id)::text, false);

  insert into public.customers (name) values ('Fin Backup Test Customer') returning id into v_customer_id;

  -- Account payment + receipt.
  insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by)
  values (v_athlete_id, false, 250.00, 'cash', current_date, v_manager_id)
  returning id into v_payment_id;

  insert into public.documents
    (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, service_type, payment_method,
     customer_name, business_name, business_id, business_address, business_phone, business_email,
     source_type, source_id)
  values
    ('FINTEST-001', v_customer_id, 250, 213.68, 36.32, 0.17, 'personal', 'cash',
     'Fin Backup Test Customer', 'Test Studio', '000000000', 'Test Address', '0500000000', 'studio@example.com',
     'account_payment', v_payment_id)
  returning id into v_doc_active_id;

  perform public.finalize_document_pdf(v_doc_active_id, 'documents/' || v_doc_active_id || '/FINTEST-001.pdf', 'test-hash-active-v1');

  -- A second document, issued then cancelled (exercises cancellation history + document_events).
  insert into public.documents
    (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, service_type, payment_method,
     customer_name, business_name, business_id, business_address, business_phone, business_email)
  values
    ('FINTEST-002', v_customer_id, 100, 85.47, 14.53, 0.17, 'personal', 'cash',
     'Fin Backup Test Customer', 'Test Studio', '000000000', 'Test Address', '0500000000', 'studio@example.com')
  returning id into v_doc_cancelled_id;

  perform public.finalize_document_pdf(v_doc_cancelled_id, 'documents/' || v_doc_cancelled_id || '/FINTEST-002.pdf', 'test-hash-cancelled-v1');
  perform public.cancel_document(v_doc_cancelled_id, 'synthetic test cancellation', false);

  -- Subscription + billing period + charge.
  insert into public.subscriptions (payee_id, payee_is_manual, created_by) values (v_athlete_id, false, v_manager_id)
  returning id into v_sub_id;
  insert into public.subscription_versions (id, subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date, created_by)
  values (gen_random_uuid(), v_sub_id, 1, current_date, 400, 1, current_date, v_manager_id)
  returning id into v_version_id;
  insert into public.subscription_billing_periods (subscription_id, version_id, period_start, period_end, raw_period_start, raw_period_end)
  values (v_sub_id, v_version_id, current_date, current_date + interval '1 month', current_date, current_date + interval '1 month')
  returning id into v_period_id;
  insert into public.subscription_charges (billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, created_by)
  values (v_period_id, v_sub_id, v_athlete_id, false, 400, 'recurring', v_manager_id);

  -- Billing adjustment (a correction charge against the same period).
  insert into public.subscription_charges (billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, created_by)
  values (v_period_id, v_sub_id, v_athlete_id, false, -50, 'edit_correction', v_manager_id);

  -- Subscription freeze.
  insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until, created_by)
  values (v_sub_id, current_date + 7, current_date + 14, v_manager_id);

  -- Multiple PDF versions: regenerate the active document (prepare + finalize -> version 2).
  perform public.prepare_document_pdf_regeneration(v_doc_active_id);
  perform public.finalize_document_pdf(v_doc_active_id, 'documents/' || v_doc_active_id || '/FINTEST-001-v2.pdf', 'test-hash-active-v2');

  -- Payment reversal: cancel a THIRD document, this time reverting the payment (reversed_at set).
  insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at, created_by)
  values (v_athlete_id, false, 90.00, 'bit', current_date, v_manager_id)
  returning id into v_reversal_payment_id;

  insert into public.documents
    (document_number, customer_id, gross_amount, net_amount, vat_amount, vat_rate, service_type, payment_method,
     customer_name, business_name, business_id, business_address, business_phone, business_email,
     source_type, source_id)
  values
    ('FINTEST-003', v_customer_id, 90, 76.92, 13.08, 0.17, 'personal', 'bit',
     'Fin Backup Test Customer', 'Test Studio', '000000000', 'Test Address', '0500000000', 'studio@example.com',
     'account_payment', v_reversal_payment_id)
  returning id into v_doc_reversal_id;

  perform public.finalize_document_pdf(v_doc_reversal_id, 'documents/' || v_doc_reversal_id || '/FINTEST-003.pdf', 'test-hash-reversal-v1');
  perform public.cancel_document(v_doc_reversal_id, 'synthetic reversal test', true);

  raise notice 'Synthetic data seeded: customer=%, active_doc=%, cancelled_doc=%, reversal_doc=%, payment=%, reversal_payment=%, subscription=%',
    v_customer_id, v_doc_active_id, v_doc_cancelled_id, v_doc_reversal_id, v_payment_id, v_reversal_payment_id, v_sub_id;
end $$;
