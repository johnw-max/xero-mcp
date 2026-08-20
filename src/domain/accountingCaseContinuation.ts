import type {
  AccountingFact,
  AccountingSourceArtifact,
  CompiledAccountingCase,
  ContactDurableIdentity,
  NativeDocumentFact,
  LedgerStateTransitionFact,
} from "./accountingCase.js";
import { hashObject } from "../security/hash.js";

export interface AccountingCaseBusinessContinuationTemplate {
  case_id: string;
  expected_version: number;
  source_label: string;
  source_set_complete: true;
  documents: Array<Record<string, unknown>>;
  ledger_state_transitions?: Array<Record<string, unknown>>;
  new_contacts?: Array<Record<string, unknown>>;
}

const CONTACT_DEPENDENCY_REASON = "PLANNED_CONTACT_DEPENDENCY_REQUIRES_NEW_CASE_VERSION";

function publicDurableIdentity(identity: ContactDurableIdentity): Record<string, unknown> {
  return identity.kind === "LEGAL_REGISTRY"
    ? {
        kind: "LEGAL_REGISTRY",
        jurisdiction: identity.jurisdiction,
        registry_scheme: identity.registryScheme,
        number: identity.number,
      }
    : {
        kind: "PROVIDER_TENANT_ACCOUNT",
        provider: identity.providerId,
        scope: "PROVIDER_TENANT",
        namespace: identity.namespace,
        number: identity.number,
      };
}

function publicDocument(fact: NativeDocumentFact): Record<string, unknown> {
  const documentType = fact.documentKind === "INVOICE"
    ? fact.counterpartyRole === "CUSTOMER" ? "CUSTOMER_INVOICE" : "SUPPLIER_BILL"
    : fact.counterpartyRole === "CUSTOMER" ? "CUSTOMER_CREDIT_NOTE" : "SUPPLIER_CREDIT_NOTE";
  const accountingProjection = {
    lines: fact.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit_amount_excluding_tax: line.unitAmount,
      source_tax_amount: line.sourceTax,
      account_code: line.accountCode,
      tax_type: line.taxType,
    })),
  };
  return {
    document_type: documentType,
    reference: fact.reference,
    reference_kind: fact.referenceKind,
    document_date: fact.documentDate,
    ...(fact.dueDate ? { due_date: fact.dueDate } : {}),
    currency: fact.currency,
    contact: {
      name: fact.contactName,
      ...(fact.contactDurableIdentity
        ? { durable_identity: publicDurableIdentity(fact.contactDurableIdentity) }
        : {}),
    },
    ...accountingProjection,
    ...(fact.invoiceRate ? { invoice_exchange_rate: fact.invoiceRate } : {}),
    ...(fact.taxPolicyBasis ? { review_note: fact.taxPolicyBasis } : {}),
    declared_net: fact.declaredNet,
    declared_tax: fact.declaredTax,
    declared_gross: fact.declaredGross,
    document_validity: fact.documentValidity,
    ...(fact.documentKind === "CREDIT_NOTE" ? {
      original_document: {
        reference: fact.originalDocumentReference,
        reference_kind: fact.originalDocumentReferenceKind,
        document_date: fact.originalDocumentDate,
      },
    } : {}),
  };
}

function publicContact(fact: Extract<AccountingFact, { kind: "CONTACT_CANDIDATE" }>): Record<string, unknown> {
  return {
    usage_roles: [...fact.usageRoles],
    contact: {
      name: fact.name,
      ...(fact.email ? { email: fact.email } : {}),
      ...(fact.durableIdentity ? { durable_identity: publicDurableIdentity(fact.durableIdentity) } : {}),
      ...(fact.companyNumber ? { company_number: fact.companyNumber } : {}),
      ...(fact.accountNumber ? { account_number: fact.accountNumber } : {}),
    },
  };
}

function publicLedgerStateTransition(fact: LedgerStateTransitionFact): Record<string, unknown> {
  return fact.actionId === "manual_journal.post"
    ? { action: fact.actionId, manual_journal_id: fact.targetXeroObjectId }
    : { action: fact.actionId, invoice_id: fact.targetXeroObjectId };
}

export function accountingCaseRecoveryBusinessContinuationTemplate(input: Readonly<{
  caseId: string;
  sources: readonly AccountingSourceArtifact[];
  facts: readonly AccountingFact[];
}>): AccountingCaseBusinessContinuationTemplate {
  const documents = input.facts
    .filter((fact): fact is NativeDocumentFact => fact.kind === "NATIVE_DOCUMENT")
    .map(publicDocument)
    .sort((left, right) => hashObject(left).localeCompare(hashObject(right)));
  const contacts = input.facts
    .filter((fact): fact is Extract<AccountingFact, { kind: "CONTACT_CANDIDATE" }> =>
      fact.kind === "CONTACT_CANDIDATE")
    .map(publicContact)
    .sort((left, right) => hashObject(left).localeCompare(hashObject(right)));
  const ledgerStateTransitions = input.facts
    .filter((fact): fact is LedgerStateTransitionFact => fact.kind === "LEDGER_STATE_TRANSITION")
    .map(publicLedgerStateTransition)
    .sort((left, right) => hashObject(left).localeCompare(hashObject(right)));
  if (documents.length + contacts.length + ledgerStateTransitions.length === 0) {
    throw new Error("Accounting Case recovery continuation has no public business intent.");
  }
  // A recovery successor may combine a residual contact source and the
  // documents that depend on that contact. Public intake accepts one label,
  // so derive a new public label instead of dropping either source or leaking
  // an internal preparation/provider identifier.
  const sourceLabel = `Recovery residual from ${input.caseId}`;
  return {
    case_id: input.caseId,
    expected_version: 0,
    source_label: sourceLabel,
    source_set_complete: true,
    documents,
    ...(ledgerStateTransitions.length > 0 ? { ledger_state_transitions: ledgerStateTransitions } : {}),
    ...(contacts.length > 0 ? { new_contacts: contacts } : {}),
  };
}

export function accountingCaseBusinessContinuationTemplate(input: Readonly<{
  caseId: string;
  expectedVersion: number;
  sources: readonly AccountingSourceArtifact[];
  facts: readonly AccountingFact[];
}>): AccountingCaseBusinessContinuationTemplate {
  const documents = input.facts
    .filter((fact): fact is NativeDocumentFact => fact.kind === "NATIVE_DOCUMENT")
    .map(publicDocument)
    .sort((left, right) => hashObject(left).localeCompare(hashObject(right)));
  if (documents.length === 0) throw new Error("Accounting Case continuation has no dependent documents.");
  const documentUnits = new Set(input.facts
    .filter((fact): fact is NativeDocumentFact => fact.kind === "NATIVE_DOCUMENT")
    .flatMap((fact) => fact.sourceUnitIds));
  const labels = [...new Set(input.sources
    .filter((source) => source.units.some((unit) => documentUnits.has(unit.unitId)))
    .map((source) => source.label))];
  if (labels.length !== 1) {
    throw new Error("Accounting Case continuation must project one public source label.");
  }
  return {
    case_id: input.caseId,
    expected_version: input.expectedVersion,
    source_label: labels[0]!,
    source_set_complete: true,
    documents,
  };
}

export function accountingCaseDependentContinuationTemplate(
  compiled: CompiledAccountingCase,
): AccountingCaseBusinessContinuationTemplate {
  const dependentFactIds = new Set(compiled.events
    .filter((event) => event.reasonCodes.includes(CONTACT_DEPENDENCY_REASON))
    .flatMap((event) => event.primaryFactId ? [event.primaryFactId] : []));
  return accountingCaseBusinessContinuationTemplate({
    caseId: compiled.caseId,
    expectedVersion: compiled.version,
    sources: compiled.sources,
    facts: compiled.activeFacts.filter((fact) => dependentFactIds.has(fact.factId)),
  });
}

/**
 * Projects only business facts for residual operations that never acquired a
 * mutation request. Provider IDs, preparation IDs and the expired Case target
 * are deliberately absent so a successor Case must compile and preflight from
 * scratch under its own live target.
 */
export function accountingCaseRecoveryResidualContinuationTemplate(input: Readonly<{
  source: CompiledAccountingCase;
  successorCaseId: string;
  residualOperationIds: readonly string[];
}>): AccountingCaseBusinessContinuationTemplate {
  if (input.residualOperationIds.length === 0 ||
      new Set(input.residualOperationIds).size !== input.residualOperationIds.length) {
    throw new Error("Accounting Case recovery continuation has no exact residual operation set.");
  }
  const residualIds = new Set(input.residualOperationIds);
  const residualOperations = input.source.operations.filter((operation) => residualIds.has(operation.operationId));
  if (residualOperations.length !== residualIds.size) {
    throw new Error("Accounting Case recovery continuation contains an unsupported residual operation.");
  }
  const eventIds = new Set(residualOperations.map((operation) => operation.eventId));
  const factIds = new Set(input.source.events
    .filter((event) => eventIds.has(event.eventId))
    .flatMap((event) => event.primaryFactId ? [event.primaryFactId] : []));
  const directFacts = input.source.activeFacts.filter((fact) => factIds.has(fact.factId));
  if (directFacts.length !== residualOperations.length || directFacts.some((fact) =>
    fact.kind !== "NATIVE_DOCUMENT" && fact.kind !== "CONTACT_CANDIDATE" &&
    fact.kind !== "LEDGER_STATE_TRANSITION")) {
    throw new Error("Accounting Case recovery residual intent is not representable as public business documents.");
  }
  const residualContacts = directFacts.filter((fact): fact is Extract<AccountingFact, {
    kind: "CONTACT_CANDIDATE";
  }> => fact.kind === "CONTACT_CANDIDATE");
  const dependentDocumentFactIds = new Set(input.source.events
    .filter((event) => event.reasonCodes.includes(CONTACT_DEPENDENCY_REASON))
    .flatMap((event) => event.primaryFactId ? [event.primaryFactId] : []));
  const dependentDocuments = input.source.activeFacts.filter((fact): fact is NativeDocumentFact => {
    if (fact.kind !== "NATIVE_DOCUMENT" || !dependentDocumentFactIds.has(fact.factId)) return false;
    return residualContacts.some((contact) =>
      contact.usageRoles.includes(fact.counterpartyRole) &&
      contact.name.trim().toLocaleLowerCase("en-US") === fact.contactName.trim().toLocaleLowerCase("en-US") &&
      (
        contact.durableIdentity === undefined && fact.contactDurableIdentity === undefined ||
        contact.durableIdentity !== undefined && fact.contactDurableIdentity !== undefined &&
        hashObject(contact.durableIdentity) === hashObject(fact.contactDurableIdentity)
      ));
  });
  const facts = [...directFacts, ...dependentDocuments.filter((fact) => !factIds.has(fact.factId))];
  const residualDocumentEventKeys = new Set(facts
    .filter((fact): fact is NativeDocumentFact => fact.kind === "NATIVE_DOCUMENT")
    .map((fact) => fact.eventKey));
  if (facts.some((fact) =>
    fact.kind === "NATIVE_DOCUMENT" && fact.documentKind === "CREDIT_NOTE" &&
    (!fact.originalDocumentEventKey || !residualDocumentEventKeys.has(fact.originalDocumentEventKey)))) {
    throw new Error("A recovery residual credit cannot safely omit its already-written original document.");
  }
  return accountingCaseRecoveryBusinessContinuationTemplate({
    caseId: input.successorCaseId,
    sources: input.source.sources,
    facts,
  });
}

export function accountingCaseContinuationTemplateHash(
  template: AccountingCaseBusinessContinuationTemplate,
): string {
  return hashObject(template);
}

export function hasAccountingCaseDependentContinuation(compiled: CompiledAccountingCase): boolean {
  return compiled.events.some((event) => event.reasonCodes.includes(CONTACT_DEPENDENCY_REASON));
}

export function matchesAccountingCaseContinuationAuthorization(input: Readonly<{
  source: CompiledAccountingCase;
  candidate: CompiledAccountingCase;
  authorization?: { sourceVersion: number; templateHash: string };
}>): boolean {
  try {
    const expectedTemplateHash = accountingCaseContinuationTemplateHash(
      accountingCaseDependentContinuationTemplate(input.source),
    );
    const candidateTemplateHash = accountingCaseContinuationTemplateHash(
      accountingCaseBusinessContinuationTemplate({
        caseId: input.candidate.caseId,
        expectedVersion: input.source.version,
        sources: input.candidate.sources,
        facts: input.candidate.activeFacts,
      }),
    );
    return input.authorization?.sourceVersion === input.source.version &&
      input.authorization.templateHash === expectedTemplateHash &&
      candidateTemplateHash === expectedTemplateHash &&
      input.candidate.activeFacts.every((fact) => fact.kind === "NATIVE_DOCUMENT") &&
      input.candidate.operations.every((operation) => operation.actionId !== "contact.create_basic");
  } catch {
    return false;
  }
}

export function matchesAccountingCaseRecoveryResidualAuthorization(input: Readonly<{
  candidate: CompiledAccountingCase;
  successorCaseId: string;
  templateHash: string;
}>): boolean {
  try {
    return input.candidate.caseId === input.successorCaseId &&
      input.candidate.version === 1 &&
      input.candidate.activeFacts.every((fact) =>
        fact.kind === "NATIVE_DOCUMENT" || fact.kind === "CONTACT_CANDIDATE") &&
      accountingCaseContinuationTemplateHash(accountingCaseRecoveryBusinessContinuationTemplate({
        caseId: input.candidate.caseId,
        sources: input.candidate.sources,
        facts: input.candidate.activeFacts,
      })) === input.templateHash;
  } catch {
    return false;
  }
}
