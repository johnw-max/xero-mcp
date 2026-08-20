-- Admit the closed R1 Accounting Case write families into the established
-- mutation control plane. No table, column, Case state, or user-confirmation
-- mechanism is introduced.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE xero_mutation_preparations
  DROP CONSTRAINT IF EXISTS xero_mutation_preparations_operation_check,
  DROP CONSTRAINT IF EXISTS xero_mutation_preparation_operation_check;

ALTER TABLE xero_mutation_preparations
  ADD CONSTRAINT xero_mutation_preparations_operation_check CHECK (
    operation IN ('CREATE_DRAFT', 'CREATE', 'UPDATE', 'AUTHORISE', 'POST', 'ALLOCATE', 'REFUND', 'UNALLOCATE', 'REVERSE', 'VOID', 'UPLOAD')
  ),
  ADD CONSTRAINT xero_mutation_preparation_operation_check CHECK (
    (object_type IN ('QUOTE', 'PURCHASE_ORDER') AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'CREDIT_NOTE' AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation IN ('UPDATE', 'AUTHORISE', 'ALLOCATE', 'REFUND', 'UNALLOCATE', 'VOID') AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type IN ('SUPPLIER_BILL', 'SALES_INVOICE') AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'AUTHORISE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'VOID' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'MANUAL_JOURNAL' AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'POST' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'VOID' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type IN ('CONTACT', 'ITEM') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type IN ('TRACKING_CATEGORY', 'TRACKING_OPTION') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'PAYMENT' AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'REVERSE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'BANK_TRANSACTION' AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'REVERSE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'ATTACHMENT' AND operation = 'UPLOAD' AND target_xero_object_id IS NULL)
  );

ALTER TABLE xero_mutation_requests
  DROP CONSTRAINT IF EXISTS xero_mutation_requests_operation_check,
  DROP CONSTRAINT IF EXISTS xero_mutation_request_operation_check;

ALTER TABLE xero_mutation_requests
  ADD CONSTRAINT xero_mutation_requests_operation_check CHECK (
    operation IN ('CREATE_DRAFT', 'CREATE', 'UPDATE', 'AUTHORISE', 'POST', 'ALLOCATE', 'REFUND', 'UNALLOCATE', 'REVERSE', 'VOID', 'UPLOAD')
  ),
  ADD CONSTRAINT xero_mutation_request_operation_check CHECK (
    (object_type IN ('QUOTE', 'PURCHASE_ORDER') AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'CREDIT_NOTE' AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation IN ('UPDATE', 'AUTHORISE', 'ALLOCATE', 'REFUND', 'UNALLOCATE', 'VOID') AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type IN ('SUPPLIER_BILL', 'SALES_INVOICE') AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'AUTHORISE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'VOID' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'MANUAL_JOURNAL' AND (
      (operation = 'CREATE_DRAFT' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'POST' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'VOID' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type IN ('CONTACT', 'ITEM') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type IN ('TRACKING_CATEGORY', 'TRACKING_OPTION') AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'PAYMENT' AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'REVERSE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'BANK_TRANSACTION' AND (
      (operation = 'CREATE' AND target_xero_object_id IS NULL)
      OR (operation = 'UPDATE' AND target_xero_object_id IS NOT NULL)
      OR (operation = 'REVERSE' AND target_xero_object_id IS NOT NULL)
    ))
    OR (object_type = 'ATTACHMENT' AND operation = 'UPLOAD' AND target_xero_object_id IS NULL)
  );

ALTER TABLE accounting_case_operations
  DROP CONSTRAINT IF EXISTS accounting_case_operations_action_id_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operations_native_route_check,
  DROP CONSTRAINT IF EXISTS accounting_case_operation_route_action_check;

ALTER TABLE accounting_case_operations
  ADD CONSTRAINT accounting_case_operations_action_id_check CHECK (action_id IN (
    'contact.create_basic', 'contact.update_basic',
    'item.create_basic_untracked', 'item.update_basic_untracked',
    'customer_invoice.create_draft', 'customer_invoice.authorise',
    'supplier_bill.create_draft', 'supplier_bill.authorise',
    'credit_note.create_draft', 'quote.create_draft', 'purchase_order.create_draft',
    'manual_journal.create_draft', 'manual_journal.post',
    'customer_invoice.update_draft', 'supplier_bill.update_draft',
    'quote.update_draft', 'purchase_order.update_draft',
    'credit_note.update_draft', 'manual_journal.update_draft',
    'tracking_category.create', 'tracking_category.update',
    'tracking_option.create', 'tracking_option.update',
    'customer_invoice.void', 'supplier_bill.void',
    'credit_note.authorise', 'credit_note.allocate', 'credit_note.refund', 'credit_note.void', 'credit_note.unallocate',
    'manual_journal.void',
    'payment.create', 'payment.reverse', 'bank_transaction.create', 'bank_transaction.update', 'bank_transaction.reverse'
  )),
  ADD CONSTRAINT accounting_case_operations_native_route_check CHECK (native_route IN (
    'CONTACT_CREATE', 'CONTACT_BASIC_UPDATE',
    'ITEM_BASIC_CREATE_UNTRACKED', 'ITEM_BASIC_UPDATE_UNTRACKED',
    'SALES_INVOICE', 'SUPPLIER_BILL', 'CUSTOMER_CREDIT', 'SUPPLIER_CREDIT',
    'QUOTE', 'PURCHASE_ORDER', 'MANUAL_JOURNAL', 'LEDGER_STATE_TRANSITION',
    'DRAFT_DOCUMENT_UPDATE', 'TRACKING_REFERENCE_DATA', 'LEDGER_ADJUSTMENT', 'PAYMENT_BANK_LEDGER'
  )),
  ADD CONSTRAINT accounting_case_operation_route_action_check CHECK (
    (native_route = 'CONTACT_CREATE' AND action_id = 'contact.create_basic')
    OR (native_route = 'CONTACT_BASIC_UPDATE' AND action_id = 'contact.update_basic')
    OR (native_route = 'ITEM_BASIC_CREATE_UNTRACKED' AND action_id = 'item.create_basic_untracked')
    OR (native_route = 'ITEM_BASIC_UPDATE_UNTRACKED' AND action_id = 'item.update_basic_untracked')
    OR (native_route = 'TRACKING_REFERENCE_DATA' AND action_id IN (
      'tracking_category.create', 'tracking_category.update',
      'tracking_option.create', 'tracking_option.update'
    ))
    OR (native_route = 'SALES_INVOICE' AND action_id = 'customer_invoice.create_draft')
    OR (native_route = 'SUPPLIER_BILL' AND action_id = 'supplier_bill.create_draft')
    OR (native_route IN ('CUSTOMER_CREDIT', 'SUPPLIER_CREDIT') AND action_id = 'credit_note.create_draft')
    OR (native_route = 'QUOTE' AND action_id = 'quote.create_draft')
    OR (native_route = 'PURCHASE_ORDER' AND action_id = 'purchase_order.create_draft')
    OR (native_route = 'MANUAL_JOURNAL' AND action_id = 'manual_journal.create_draft')
    OR (native_route = 'LEDGER_STATE_TRANSITION' AND action_id IN (
      'customer_invoice.authorise', 'supplier_bill.authorise', 'manual_journal.post'
    ))
    OR (native_route = 'DRAFT_DOCUMENT_UPDATE' AND action_id IN (
      'customer_invoice.update_draft', 'supplier_bill.update_draft',
      'quote.update_draft', 'purchase_order.update_draft',
      'credit_note.update_draft', 'manual_journal.update_draft'
    ))
    OR (native_route = 'LEDGER_ADJUSTMENT' AND action_id IN (
      'customer_invoice.void', 'supplier_bill.void',
      'credit_note.authorise', 'credit_note.allocate', 'credit_note.refund', 'credit_note.void', 'credit_note.unallocate',
      'manual_journal.void'
    ))
    OR (native_route = 'PAYMENT_BANK_LEDGER' AND action_id IN (
      'payment.create', 'payment.reverse', 'bank_transaction.create', 'bank_transaction.update', 'bank_transaction.reverse'
    ))
  );

CREATE OR REPLACE FUNCTION accounting_case_ledger_state_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  preparation_row xero_mutation_preparations%ROWTYPE;
  expected_object_type text;
  expected_operation text;
  expected_target_id text;
  expected_final_status text;
BEGIN
  IF NEW.native_route <> 'LEDGER_STATE_TRANSITION' THEN
    RETURN NEW;
  END IF;

  expected_object_type := CASE NEW.action_id
    WHEN 'customer_invoice.authorise' THEN 'SALES_INVOICE'
    WHEN 'supplier_bill.authorise' THEN 'SUPPLIER_BILL'
    WHEN 'manual_journal.post' THEN 'MANUAL_JOURNAL'
    ELSE NULL
  END;
  expected_operation := CASE NEW.action_id
    WHEN 'customer_invoice.authorise' THEN 'AUTHORISE'
    WHEN 'supplier_bill.authorise' THEN 'AUTHORISE'
    WHEN 'manual_journal.post' THEN 'POST'
    ELSE NULL
  END;
  expected_target_id := CASE NEW.action_id
    WHEN 'manual_journal.post' THEN NEW.canonical_payload ->> 'manualJournalId'
    ELSE NEW.canonical_payload ->> 'invoiceId'
  END;
  expected_final_status := CASE NEW.action_id
    WHEN 'manual_journal.post' THEN 'POSTED'
    ELSE 'AUTHORISED'
  END;

  IF expected_object_type IS NULL
    OR expected_target_id IS NULL
    OR expected_target_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR NEW.canonical_payload ->> 'expectedStatus' <> 'DRAFT'
    OR (NEW.action_id = 'customer_invoice.authorise'
      AND NEW.canonical_payload ->> 'invoiceType' <> 'ACCREC')
    OR (NEW.action_id = 'supplier_bill.authorise'
      AND NEW.canonical_payload ->> 'invoiceType' <> 'ACCPAY')
    OR (NEW.action_id = 'manual_journal.post' AND NEW.canonical_payload ? 'invoiceType')
  THEN
    RAISE EXCEPTION 'Accounting Case ledger-state transition is not a closed exact-target action'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.preparation_id IS NOT NULL THEN
    SELECT * INTO preparation_row
    FROM xero_mutation_preparations
    WHERE preparation_id = NEW.preparation_id;
    IF preparation_row.preparation_id IS NULL
      OR preparation_row.object_type <> expected_object_type
      OR preparation_row.operation <> expected_operation
      OR preparation_row.target_xero_object_id IS NULL
      OR lower(preparation_row.target_xero_object_id) <> lower(expected_target_id)
      OR preparation_row.canonical_payload IS DISTINCT FROM NEW.canonical_payload
    THEN
      RAISE EXCEPTION 'Accounting Case ledger-state transition preparation is mismatched'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.state = 'NO_WRITE_REQUIRED' THEN
    RAISE EXCEPTION 'Accounting Case ledger-state transition cannot be closed as no-write-required'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.state = 'READBACK_VERIFIED' AND (
    NEW.xero_object_id IS NULL
    OR lower(NEW.xero_object_id) <> lower(expected_target_id)
    OR NEW.readback_snapshot IS NULL
    OR NEW.readback_snapshot ->> 'xeroObjectId' IS DISTINCT FROM NEW.xero_object_id
    OR NEW.readback_snapshot ->> 'status' IS DISTINCT FROM expected_final_status
    OR NEW.readback_snapshot -> 'canonicalPayload' IS DISTINCT FROM NEW.canonical_payload
  ) THEN
    RAISE EXCEPTION 'Accounting Case ledger-state transition readback is not exact'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounting_case_ledger_state_transition_guard_trigger
  ON accounting_case_operations;
CREATE TRIGGER accounting_case_ledger_state_transition_guard_trigger
BEFORE INSERT OR UPDATE ON accounting_case_operations
FOR EACH ROW EXECUTE FUNCTION accounting_case_ledger_state_transition_guard();
