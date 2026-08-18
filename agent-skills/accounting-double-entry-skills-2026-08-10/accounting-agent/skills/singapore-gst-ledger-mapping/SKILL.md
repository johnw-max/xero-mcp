---
name: singapore-gst-ledger-mapping
description: Map a reviewed Singapore accounting proposal onto the exact account codes and tax codes of the connected ledger before execution. Use whenever a balanced proposal for a Singapore entity is about to be executed against a formal ledger connector, or whenever GST treatment, account selection, or a GST-inclusive amount must be resolved. Always read the ledger's live accounts and tax rates first and propose only values that exist there; never invent a code, never assume a rate.
---

# Singapore GST ledger mapping

Turn a reviewed accounting proposal into the exact `account_code` and `tax_type`
values the connected ledger will accept, for a Singapore-registered entity.

This Skill owns the **accounting judgment**. The ledger connector owns
**verification**: it will independently check that every code you declare exists
in that organisation, that the tax amount equals the ledger's own rate applied to
the net, and that what was written reads back identically. It will refuse
anything it cannot confirm. Your job is to propose values that are correct and
real — not to reassure yourself that they are.

## Procedure

1. **Read before proposing.** Call the accounts and tax-rate reads for the pinned
   organisation. Never propose an account code or tax code you have not seen in
   that organisation's live data in this conversation. A code that worked for
   another client does not exist here until you have read it here.
2. **Confirm the entity is Singapore-registered for GST** from the organisation
   read. If it is not GST-registered, no standard-rated output tax applies;
   route to no-tax treatment and say so.
3. **Classify the economic event**, then select tax treatment, then select the
   account. In that order — the account never determines the tax treatment.
4. **Resolve amounts** before writing anything down (see below).
5. **Declare explicitly**: per line, the account code, the tax code, quantity,
   unit amount excluding tax, and the line tax amount; per document, the declared
   net, tax and gross.
6. **Stop rather than guess.** If the right account or tax code is genuinely
   ambiguous, present the candidates and ask. An unresolved item is a normal
   accounting outcome; a confidently wrong code is not.

## Establish the document direction first

Before any tax decision, settle whose books you are in and which side of the
document that entity is on. Output tax and input tax are opposite answers to this
one question, and getting it wrong makes every later step wrong in a way that
still looks internally consistent.

The pinned organisation **is** the client whose books you are writing. So:

- If that organisation **issued** the document, it is a customer invoice — the
  counterparty is the customer, and any GST is **output** tax.
- If that organisation **received** the document, it is a supplier bill — the
  counterparty is the supplier, and any GST is **input** tax.

Colleagues rarely say this explicitly. A phrase like "put X's invoice into their
books, made out to Y" names two companies and leaves the direction implicit.
Resolve it against the organisation read rather than by word order:

- If X is the pinned organisation, X issued it → customer invoice, Y is the customer.
- If Y is the pinned organisation, X billed them → supplier bill, X is the supplier.
- **If neither name matches the pinned organisation, stop and ask.** The
  organisation's display name may legitimately differ from the client's trading
  name — say what organisation you are actually connected to and have the
  colleague confirm it before continuing. Never assume you are in the right books
  because the request sounded confident.

A useful cross-check: the tax codes available in the organisation often reveal
the direction you can actually support. If only output-direction codes are
active, an expense line has no valid code — say so rather than forcing one.

## GST treatment

Singapore GST is **9%** for supplies made on or after 2024-01-01. Verify the rate
from the ledger's tax-rate read rather than trusting this number — if the
organisation's rate differs, the organisation is right and this Skill is stale.

| Situation | Treatment |
|---|---|
| Ordinary local sale by a GST-registered entity | Standard-rated output |
| Ordinary local purchase with a valid tax invoice | Standard-rated input |
| Export of goods, international services | Zero-rated |
| Financial services, sale/lease of residential property | Exempt |
| Supply outside GST scope, non-business receipts | Out of scope |
| Entity not GST-registered, or no GST on the document | No tax |

Two Singapore-specific points that are easy to get wrong:

- **Exempt supplies split by Regulation 33.** Regulation 33 exempt supplies
  (certain incidental financial services) are treated separately from ordinary
  exempt supplies because they do not restrict input tax recovery the same way.
  If a document involves exempt output, determine which it is; do not merge them.
- **Zero-rated is not exempt.** Both carry 0% tax, but they report differently
  and affect input-tax recovery differently. Export → zero-rated. Residential
  property or financial services → exempt.

Typical Xero tax codes in a Singapore organisation are `OUTPUTY24` (standard
output), `INPUTY24` (standard input), `ZERORATEDOUTPUT` / `ZERORATEDINPUT`,
`ES33OUTPUT` (Regulation 33 exempt output), `ESN33OUTPUT` (non-Regulation-33
exempt output), `OPINPUT` / `OSOUTPUT2` (out of scope), and `NONE`. **Treat this
list as a hint for what to look for, not as truth** — organisations rename and
customise tax codes, and the connector matches on the code, never the display
name. Always take the actual code from the tax-rate read.

## Amount resolution

The ledger verifies `line tax == round(net × the ledger's own rate for that tax
code)` to the currency's minor unit, with **zero tolerance**. So resolve amounts
exactly:

- **Tax-exclusive document**: net is given. Tax = net × rate, rounded to the
  minor unit. Gross = net + tax.
- **GST-inclusive document** (common on Singapore retail invoices and receipts):
  net = gross ÷ (1 + rate), rounded to the minor unit; tax = gross − net.
  Worked example at 9%: gross S$1,200.00 → net 1,100.92, tax 99.08.
  Verify net + tax = gross exactly before declaring.
- **Multi-line**: tax is computed and rounded **per line**, then summed. Do not
  compute tax on the document total and distribute it — that produces cent
  differences the connector will reject.
- **Never plug.** If declared totals do not reconcile, that is a finding about
  the source document, not something to force.

## Account selection

Select from the organisation's live chart of accounts, matching the economic
nature of the item. The account must be one that accepts direct posting.

Sanity checks worth making every time: revenue accounts for customer invoices and
expense accounts for supplier bills, not the reverse; the tax code's direction
must match the document direction (output tax on sales, input tax on purchases);
and the tax code must be applicable to that account's class — the ledger exposes
this and will refuse a mismatch.

## Boundary

This Skill proposes. It does not:

- assert that the source document is genuine, complete, or belongs to this client;
- claim anything was written — only the connector's receipt and exact read-back
  establish that;
- treat a provider `DRAFT` as posted;
- decide authorization. Execution authority comes from the platform binding.

Every proposal remains an accountant-reviewable draft. Use
[references/singapore-gst-cases.md](references/singapore-gst-cases.md) for worked
cases and the situations that most often need a human decision.
