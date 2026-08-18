# Candidate deployment runbook

Derived from the live host, not from the repo's documentation — the formal
`admit-and-compose.sh` path is not in force here (`/srv/xero-accounting-mcp/release/`
does not exist). The real pattern is one directory per release under
`/srv/xero-accounting-mcp/releases/`, a container on its own loopback port, and an
nginx upstream flip.

Host `178.156.234.230`, SSH on port 2222, firewall allow-lists this workstation's
egress IP only.

## Current live state

- nginx `upstream xero_accounting_mcp_demo → 127.0.0.1:18013`
- 18013 = `xero-accounting-mcp-uat-042-work-manual`, image `ec78d6030447…`
- Database `xero_mcp` in `xero-accounting-mcp-demo-postgres-1`, shared
- `XERO_WRITE_ENABLED=false`, `XERO_STANDING_DELEGATIONS_JSON=[]`,
  `XERO_ALLOWED_TENANT_ID=7c3cc738…` (`zcloak`)

## Database decision: share `xero_mcp`, do not fork

`missingRequiredMigrations` is a **subset** check, not an exact-head check, so the
old 042 build keeps running against a database migrated past its requirement. The
new migrations are additive. Sharing therefore preserves every existing OAuth
authorization — including the Work client's — and keeps rollback to a pure nginx
flip. A forked database would have forced every client to re-authorise and would
have made rollback lossy. An `xero_mcp_043` database was created during planning
and dropped once this was settled.

## Configuration required to enable a write

Discovered by reading `src/config.ts`; each is a hard startup validation.

| Variable | Value | Why |
|---|---|---|
| `XERO_ALLOWED_TENANT_ID` | `0f4c99fe-212f-436d-aa3b-bdad11b6197f` | `Demo Company (Global)` — the tenant Agent2 actually holds. The live value pins `zcloak`, which Agent2 cannot reach, and which is the company's own organisation. |
| `XERO_STANDING_DELEGATIONS_JSON` | one ACTIVE delegation: the Agent2 installation, that tenant, `action_ids: ["customer_invoice.create_draft"]` | The build's execution authority is `STANDING_DELEGATION`; an empty set fails closed. |
| `XERO_STANDING_DELEGATIONS_CONFIG_SHA256` | sha256 of that exact JSON string | Config integrity check. |
| `XERO_TENANT_COA_PROFILES_JSON` | a profile for that tenant | **Startup refuses** with "missing active write tenant profiles" if a write tenant has no profile. |
| `XERO_WRITE_ENABLED` | `false` until identity is verified, then `true` | Write gate. |
| `XERO_BUILD_IDENTITY_JSON`, `XERO_APPROVED_CONTROL_CATALOG_SHA256` | from the candidate's `build-identity.json` | Build identity is env-supplied and surfaces on `/healthz`. |
| `DATABASE_URL` | unchanged | Shared database. |

### The chart-of-accounts profile is the non-obvious prerequisite

`XERO_TENANT_COA_PROFILES_JSON` needs, for the tenant, all three semantic
categories — `CONSULTING_REVENUE`, `OFFICE_SUPPLIES`, `CLOUD_SUBSCRIPTIONS` — each
with a real `account_id` (UUID), `account_code`, `expected_type` and
`expected_class`, with unique ids and codes across categories, and
`jurisdiction: "SG"`.

Those are real accounts in Demo Company (Global) and must be read from Xero, not
invented. The candidate's own read tools (`xero_list_accounts`,
`xero_list_tax_rates`) are the right way to obtain them, in read-only mode, after
authorisation and before the write gate opens.

**This is worse than friction — it is a blocker.** The Accounting Case path is
Singapore-only by construction: `xeroTaxRateResolver.ts` accepts only SG tax types
(`OUTPUTY24`/`INPUTY24` at 9%, plus the SG zero-rated and exempt codes) and
requires each to resolve to exactly one ACTIVE Xero TaxRate at exactly the policy
rate; `xeroSingaporeAccountingPolicy.ts` raises `UNSUPPORTED_TAX_JURISDICTION`
otherwise; and the CoA profile schema hardcodes `jurisdiction: "SG"`.

`Demo Company (Global)` will not carry SG GST tax types, so it cannot be the write
target. The earlier recommendation to use it was made on tenant-binding grounds
before the tax constraint was traced, and is withdrawn. The write target must be a
**Singapore** Xero organisation, identified empirically — see step 8a.

## Sequence

1. Build the candidate image after the source-case binding change lands; run the
   release bundle, OCI build and runtime smoke locally. All three are known
   runnable on this workstation.
2. Upload to `/srv/xero-accounting-mcp/releases/043-uat-<buildIdentityPrefix>/`,
   `docker load`, and immediately retag away from the mutable `:accepted` tag,
   which the live 042 container also claims.
3. Copy `042-uat-254491cd/candidate-work-final.env` to the new release directory
   and override only the variables above, host-side, without reading secrets.
4. Run migrations against `xero_mcp` using the candidate image.
5. Start the container on **18014**, write disabled.
6. Verify `/healthz` on 18014 reports the candidate's `acceptanceSourceSha256`,
   `attestationHash` and `requiredMigration`. Do not proceed on any mismatch.
7. Flip nginx to 18014, `nginx -t`, reload. 042 keeps running on 18013.
8. Re-authorise Agent2 through the browser and capture the actual granted scopes —
   this is also the outstanding closure evidence for the narrowed scope set.
8a. **Identify a Singapore organisation.** With write still disabled, call
   `xero_get_organisation` and `xero_list_tax_rates` for each reachable tenant and
   select the one whose `countryCode` is SG and which carries `OUTPUTY24` at 9%.
   Candidates are `zcloak`, `Trial`, or a purpose-created SG trial organisation.
   Country code is not in the local database, so this can only be settled by
   reading Xero. Do not open the write gate until one qualifies.
9. Read Demo Company's accounts and tax rates, build the CoA profile, set it plus
   the standing delegation, restart the container.
10. Open the write gate for exactly that installation and tenant.
11. Run one natural-language customer-invoice DRAFT with a **round net figure**, so
    the zero-tolerance readback cannot be confounded by a rounding divergence.
12. Then a second with a cents-rounded net, deliberately probing that boundary.
13. Duplicate check: restate the same document, prove no second object.

## Rollback

At any point: restore the nginx upstream to `127.0.0.1:18013` and reload. 042 runs
untouched throughout. Previous nginx configs are retained on the host as
`mcp.jiayuanwang.xyz.pre-*`. Close the write gate first if it is open.
