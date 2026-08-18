# XF-003 remediation evidence

Status: `FIXED_PENDING_REVIEW`

The public 28-tool profile has one stateful Accounting Case execution entry. Its released write actions require Invoice/Bill/CreditNote DRAFT and basic Contact create. The Broker mapping now selects:

- `accounting.invoices` (or the retained broad transactions compatibility equivalent);
- `accounting.contacts`;
- the independent read scopes required by the 28 read/prepare tools when `xero.read` is requested.

It no longer requests `accounting.manualjournals` or `accounting.settings` merely because `xero.draft.write` is present.

Independent verification:

```text
npm run typecheck
npx vitest run tests/xero-broker-scopes.test.ts tests/broker-xero-authorization-service.test.ts tests/xero-oauth-principal.test.ts tests/mcp-oauth-broker-provider.test.ts tests/xero-effective-capability.test.ts tests/xero-tool-policy-contract.test.ts tests/mcp-oauth-config.test.ts tests/xero-client-manager.test.ts
git diff --check
```

Result: typecheck PASS; 8 files / 108 tests PASS; diff check PASS.

Remaining closure gate: an existing Xero OAuth authorization does not lose previously granted scopes automatically. Agent2 must re-authorize with the accepted candidate and capture the actual returned granted scopes before this finding can be closed.
