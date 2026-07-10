# Mewsy — Build Decisions, Gaps & Open Questions

The spec (v0.1) was implemented as faithfully as possible. Where it was silent, a decision had to be made; where it depends on external systems that couldn't be reached from a build environment, there is a gap to verify. This file records all of them. Items marked **Phase 0** should be settled before any real posting.

> **Context update (8 Jul 2026) — go-live is February 2027.** A full response to this document, including answers from the HyperAccounts vendor API reference, is preserved verbatim at [docs/DECISIONS-RESPONSE.md](docs/DECISIONS-RESPONSE.md); §8 below tracks the resulting status of every item. The headline consequences: nothing posts to Sage before Feb 2027; **tax rates/codes are go-live configuration, not build configuration** (re-verify Irish VAT rates in the pre-opening window — do not assume July 2026 rates); no historical backfill is needed (the watermark starts at the first trading day); and because deposits for Feb 2027 stays are collected during 2026, **deposits/deferred revenue (F5) is mandatory before Phase 2**, not optional. Sequencing to go-live lives in the response §5. Operational setup is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## 1. Decisions made while building (review & confirm)

These are defensible defaults, all changeable — most via config, a few in code.

**D1 — Stack: TypeScript / Node.js ≥ 20, SQLite (better-sqlite3), no framework.**
The spec names no stack. Chosen for: strong typing on the financial domain, a single-process service that runs happily on the (Windows) Sage box, and zero external infrastructure — the posting ledger/audit DB is one local file. If the team standard is .NET or Python, say so before Phase 2; the design (thin clients + pure domain + SQLite ledger) ports directly.

**D2 — Money is integer euro cents everywhere inside the service.**
Decimals only at the API boundaries. Any upstream amount not representable in whole cents throws rather than rounds.

**D3 — Scheduling is external.**
`mewsy run` is a one-shot command intended for Windows Task Scheduler / cron. No daemon was built: the spec's idempotent-catch-up design (§6) makes a scheduled one-shot both simpler and safer. **Decide**: the schedule time (suggest ~06:00 local, well after any end-of-day work) and the service account.

**D4 — Ambiguous journal-post outcomes freeze the date (status `UNKNOWN`).**
The spec's retry/dead-letter requirement (§8.3) had to be reconciled with a hard money-safety fact: if the journal POST times out or returns 5xx, Sage may already hold the journal, and a blind retry could double-post revenue. Behaviour built:
- 4xx / connection-refused → definite failure → dead-letter, safe automatic retry next run;
- timeout / reset / 5xx → `UNKNOWN` → date blocked, alert tells the operator to check Sage and run `mewsy resolve --id N --outcome posted|failed`.
`journalRetries` (default 0) only ever re-sends *definitely-not-sent* failures. If HyperAccounts turns out to enforce `invRef` uniqueness server-side (see G2), this can be relaxed considerably.

**D5 — Adjustments are staged for human approval by default.**
Spec §8.1 says "content changed → raise an adjustment journal, never a silent repost", and §8.3 says "no auto-correction of figures". Read together, "raise" was implemented as: compute the delta journal, stage it `PENDING_APPROVAL`, alert, and post only on `mewsy adjustments approve`. Set `requireAdjustmentApproval: false` per property to auto-post deltas instead (still alerted, never silent). **Decide**: which behaviour finance wants once parallel-running builds trust.

**D6 — Adjustment journals are dated on the *detection* date by default.**
Spec §8.3 says "dated adjustment journals" without saying which date. Posting into the original business date D could re-open a VAT period; posting on the detection date keeps periods clean but shifts the P&L day. Config `adjustmentDating: "detection" | "source"`. **Decide (finance)** — especially the interaction with VAT3 periods.

**D7 — Day imbalance goes to the suspense nominal; journals always net to zero.**
Per §5 (overpayments), any residual between the revenue side and the payment side becomes a balancing line on `suspenseNominal`: within `roundingToleranceCents` (default 2c) it's labelled rounding, beyond that it's labelled overpayment/suspense **and alerts**, but still posts. The alternative (block the whole day on any imbalance) was rejected because the spec explicitly wants overpayments to flow to suspense and stay visible. **Decide**: whether a very large imbalance (e.g. > €X) should block instead — currently it posts + alerts.

**D8 — Reconciliation = post-hoc re-fetch + exact content comparison.**
"Compare the journal total to the Mews Accounting Report (Closed) total" (§8.2) was implemented programmatically as: after posting, re-fetch the day's Closed items/payments from Mews, rebuild, and require a zero delta against everything the ledger says is in Sage — a stronger, line-level version of the total check (plus the pre-post net-to-zero assertion). The human-readable comparison against the actual Accounting Report screen remains part of the Phase 2 parallel-run sign-off. See also G3 (no Sage read-back).

**D9 — A property stops at its first failed date.**
Not stated in the spec, but implied by the watermark: later dates are deferred so postings always land in Sage in business-date order. Other properties continue independently.

**D10 — Payment → clearing-nominal mapping precedence.**
1. The payment's own Mews accounting category ledger code (keeps "mapping lives in Mews");
2. else `clearing.byTender[<Mews payment Data.Discriminator or Type>]`;
3. else `clearing.defaultNominal`.
Payments post as one aggregated debit line per tender, tax code = `exemptSageTaxCode`. **Confirm (finance)**: per-tender clearing accounts (§10) and that the exempt code is right for money movements.

**D11 — Non-EUR items block the date.**
Spec says EUR-only jurisdiction. Rather than silently excluding foreign-currency items (which would break the balance), any non-EUR item blocks that property+date with an alert. **Decide**: if a property can genuinely take non-EUR bookings, this needs a policy (convert? exclude + suspense?).

**D12 — An order item carrying more than one tax value blocks the date.**
One journal split carries one tax code; a multi-tax item can't be split without an apportionment rule. Believed not to occur in Irish hotel setups (B&B apportionment is done in Mews revenue setup per §5). If it ever fires, finance defines the rule.

**D13 — Category renames don't trigger adjustments.**
The idempotency hash covers financial substance only (nominal, tax code, dept, amounts) — not display names. A renamed Mews category or relabelled line changes nothing in Sage, so it's treated as identical content.

**D14 — `validate` treats an *active* Mews category without a ledger code as an error** (§10 "or nothing posts"), even if no items currently use it. At run time only categories actually referenced by the day's items can block.

**D15 — VAT sanity is a warning, not a block.**
If a line's tax ≠ mapped rate × net (beyond `vatWarnToleranceCents`), Mewsy warns but posts Mews's figures as-is — Mews is the source of truth (§5 "faithfully posts each day's net finalised movements"). Blocking here would stall revenue on legitimate edge cases (historic rate changes mid-window, manual tax edits in Mews).

**D16 — Property codes are ≤ 8 chars, A–Z/0–9** — enforced at config load so every generated `invRef` (`MEWSY-ADJ-<CODE>-<yyyymmdd>-<seq>`) fits HyperAccounts' 30-char limit.

---

## 2. Gaps to verify in Phase 0 — HyperAccounts (owner: Dev)

The spec documents the request fields of `POST /api/journal` but not the rest of the API surface. The client was built defensively; each item below should be confirmed against the real HyperAccounts instance and the code tightened.

**G1 — Response schema.** What does a successful `/api/journal` return, and where is the Sage transaction number? `extractTransactionRef()` currently tries `transactionNumber`, `tranNumber`, `number`, `id` (and nested `data`/`result`), and stores the raw response in the ledger regardless. Pin this down and simplify.

**G2 — Duplicate `invRef` behaviour.** Does HyperAccounts/Sage reject a second journal with the same `invRef`, or accept it? If it rejects, that's a server-side idempotency backstop and the `UNKNOWN`-freeze flow (D4) can auto-resolve by re-posting and treating "duplicate" as success. If it accepts, D4 stands as built. **This single answer most affects operational smoothness.**

**G3 — Read-back endpoint.** Is there a GET to fetch a journal/transaction by `invRef` or number? If yes, two big wins: automatic resolution of `UNKNOWN` outcomes, and true Sage-side reconciliation (§8.2) instead of ledger-based (D8). Not built — needs the endpoint to exist.

**G4 — Auth header name & port.** Spec says "AuthToken header"; the client sends literally `AuthToken: <token>`. Confirm exact header name, the localhost port (example config uses `:5000`), and whether it's HTTP or HTTPS on localhost.

**G5 — One HyperAccounts per Sage company?** One Mews property = one Sage company (§ spec header). How does one HyperAccounts installation address multiple company datasets — one instance/port per company, or a company parameter? Config currently supports a distinct `hyperAccounts.baseUrl` + token per property; adjust if there's a company selector field instead.

**G6 — Field semantics.** Top-level `accountRef` meaning (currently: the property's clearing account ref, per the §7 example), max length of `details` (assumed ~60, truncated), `deptNumber` semantics (max 2 chars per spec — Sage departments can exceed 99, so confirm), and whether negative `netAmount` values are accepted (Mewsy never sends them — signs are expressed via JD/JC type — but good to know).

**G7 — Error semantics.** Distinguishable validation errors (unknown nominal, bad tax code, closed period)? Currently any 4xx = definite rejection with the body stored. Mapping specific errors to actionable alerts would improve operability.

**G8 — VAT on journals feeds VAT3** — the spec's own headline risk (§9). `mewsy vat-spike` exists precisely for this. If journals do **not** populate the VAT return, the fallback (§9: post the receipt side via a VAT-aware mechanism such as bank receipts or sales invoices) is a **significant rework** of `toHyperAccountsJournal` and the posting flow — settle before Phase 1 ends.

## 3. Gaps to verify in Phase 0 — Mews Connector API (owner: Dev, with a demo enterprise)

Built against the documented Connector API shapes from general knowledge; the spec doesn't pin API details. Verify with the Mews demo/sandbox enterprise (§11 Phase 0):

**G9 — Exact endpoints/filters for the Closed flow.** Mewsy calls `orderItems/getAll` and `payments/getAll` with `ClosedUtc: {StartUtc, EndUtc}` + `AccountingStates: ["Closed"]`, and `accountingCategories/getAll` / `configuration/get`. Confirm these operations and filter names against the current API version (Mews has deprecated/renamed accounting endpoints over time), and that cursor pagination behaves as implemented.

**G10 — The real Mews tax-rate codes for Ireland.** `taxCodeMap` keys must match `TaxValues[].Code` exactly. The example config guesses `IE-R1`/`IE-R2`/`IE-S`/`IE-Z`/`IE-E` — **placeholders**. Run `mewsy report` on a real day; any unmapped code blocks with an alert listing the codes seen, so the map can be completed empirically. Also confirm the 9% food rate appears under a distinct code after the 1 July 2026 change.

**G11 — `EditableHistoryInterval` presence & format.** Posting delay derives from `configuration/get → Enterprise.EditableHistoryInterval` (ISO duration) + 1 day. If the field is missing/renamed, set `postingDelayDays` per property (validate fails loudly either way).

**G12 — Does the day's Closed set always balance?** The §5 balanced-journal premise assumes closed bills bring their payments with them. Deposits held across the boundary, city-ledger/invoice settlements and unassigned payments may make payments ≠ revenue on a given day — that residual currently lands in suspense (D7). Phase 1 dry-runs will show how big and how frequent this is; if it's structural (e.g. deposits), finance may want dedicated nominals instead of one suspense bucket (see F5).

**G13 — Accounting date vs `ClosedUtc`.** Mewsy defines "day D's figures" as items whose `ClosedUtc` falls in D's business-day window (property timezone + `endOfDay` offset). Confirm this matches how the Mews Accounting Report (Closed type) buckets dates — otherwise reconciliation against the report will show boundary strays.

**G14 — Payment tender identification.** Tender grouping uses `Data.Discriminator` (fallback `Type`). Verify the real values (e.g. `CreditCard`, `Cash`, `Invoice`, `External`) and fill `clearing.byTender` accordingly — `mewsy report` output shows the observed tender names.

## 4. Decisions needed from Finance (spec §12, extended)

| # | Question | Where it lands in Mewsy |
|---|---|---|
| F1 | Ledger-code mapping complete on every active accounting category (and payment categories if used) | Mews itself; `mewsy validate` audits it |
| F2 | Mews tax code → Sage tax code map, incl. zero/exempt, after verifying G10 | `taxCodeMap`, `exemptSageTaxCode` |
| F3 | Clearing account(s) per tender + top-level `accountRef` | `clearing.*` |
| F4 | Overpayment/suspense nominal (one per property?) | `suspenseNominal` |
| F5 | Deposits / advance payments policy — liability nominal until consumed? (spec §12 flags it; current behaviour: whatever Mews closes on the day, residual → suspense) | possibly new mapping + code change |
| F6 | Closed vs Consumed recognition (spec allows swapping later; only Closed is built) | new fetch/build path if ever needed |
| F7 | End-of-day boundary per property (e.g. 02:00) | `endOfDay` |
| F8 | Rounding tolerance (default €0.02/day) and a max acceptable suspense per day (see D7) | `roundingToleranceCents` (+ new setting if blocking is wanted) |
| F9 | Adjustment approval mode + dating (D5/D6) and who approves | `requireAdjustmentApproval`, `adjustmentDating` |
| F10 | Receivable tracking: A/R in Mews or pushed to Sage (spec §10 toggle — if pushed to Sage, that's the Bills & Invoices flow, **not built**) | out of scope per §2 unless decided otherwise |
| F11 | `LedgerAccountCode` vs `PostingAccountCode` — which Mews field carries the Sage nominal | `ledgerCodeField` |
| F12 | Cost centres: should Mews `CostCenterCode` flow to Sage `deptNumber`? | `deptFromCostCenter` |

## 5. Ops decisions

- **O1 — Alert channel (updated 8 Jul).** Structured logs + JSON webhook (`MEWSY_ALERT_WEBHOOK`) carrying `severity`, `alertType`, `propertyCode`, `businessDate`, `ledgerRowId` and the literal `remediation` command, plus a `text` field (renders in Slack as-is). **Teams incoming webhooks were retired May 2026** — use the Teams Workflows app (Power Automate) triggered by "When a Teams webhook request is received"; rendering belongs in the flow. A **heartbeat/dead-man's switch** is built: every completed run pings `MEWSY_HEARTBEAT_URL` (`…/fail` on a problem run); pair it with an external missing-ping monitor so a dead box can never look healthy. Route `error` severity to a named on-call person (to be named before go-live). See [docs/OPERATIONS.md](docs/OPERATIONS.md).
- **O2 — Where exactly it runs** (spec §3: on/alongside the Sage box in AWS), the service account, and that `data/` (SQLite ledger + audit + reports) is on **backed-up** disk — it is the idempotency memory; losing it means every date re-checks against Sage by hand.
- **O3 — Data retention** for audit log and reports (holds full journal payloads; likely 7 years for Irish accounting records).
- **O4 — Repo/CI.** Published at github.com/zeroco84/mewsy; GitHub Actions CI (`.github/workflows/ci.yml`) builds and runs the test suite on every push and pull request (Node 20, the minimum supported version).

## 6. Adversarial review round (pre-publication, 8 Jul 2026)

A multi-agent adversarial review (6 parallel finders over functional dimensions, 3 independent refuters per finding) was run before publication. It confirmed and led to fixes for seven functional bugs, each now covered by a regression test:

1. **DST gap/overlap in business-day windows** — with a non-zero `endOfDay`, windows around each DST transition had a one-hour gap (items never fetched) and a one-hour overlap (items double-posted). Windows are now contiguous by construction (each window's end *is* the next window's start), and `currentBusinessDate` derives from the same boundaries.
2. **Explicit `--date`/`--from` runs advanced the watermark over never-posted dates**, silently dropping them from all future runs. The watermark now only advances contiguously; out-of-order posts succeed but hold it (with an alert), and the scheduled run catches the gap up.
3. **Stale pending adjustments survived a Mews revert** and stayed approvable — approving one would post a delta that no longer exists. The zero-delta path now withdraws (REJECTs) pending adjustments for the date, with an alert.
4. **POSTED VAT-spike rows counted as the day's posted revenue**, derailing that date's real posting into a bogus adjustment. `postedRows()` now excludes `VAT_SPIKE` rows from idempotency/reconciliation.
5. **Opposite-signed adjustment deltas** (net up, tax down — possible because VAT deviations are warning-only by design) could be staged but never posted, crashing approve / stalling auto-post. Such deltas are now split into postable net-only and tax-only lines, and `approve` fails gracefully if a staged payload cannot build.
6. **Webhook alert failures were invisible** — non-2xx responses were treated as delivered, and the payload wasn't renderable by Slack/Teams. The response status is now checked and logged, and the payload carries a `text` field.
7. **`mewsy status` derived its "uncertain Sage state" warning from only the 12 most recent ledger rows**, so an old unresolved UNKNOWN attempt eventually disappeared from monitoring. It now queries all UNKNOWN/ATTEMPTING rows.

## 7. Known simplifications (acceptable for Phase 0/1, revisit later)

- ~~`mewsy validate` can't yet verify nominal codes exist in the Sage chart of accounts~~ **Closed:** `validate` now reads `/api/status`, `/api/nominal/` and `/api/taxCode` and errors when a configured/mapped nominal is missing or inactive, a Sage tax code doesn't exist, or a Sage rate differs from the configured `ratePercent`.
- The Mews `Currency` filter is not sent on getAll calls (EUR is asserted per item instead).
- Sage-side split comparison uses per-nominal sums of absolute net/tax (sign conventions of `AUDIT_SPLIT` unverified); rows without the expected fields degrade to header-presence verification.
- Timestamps in ledger/audit use the host clock (`new Date()`); the Sage box should run NTP (see docs/OPERATIONS.md).

## 8. Status after the 8 Jul 2026 response ([docs/DECISIONS-RESPONSE.md](docs/DECISIONS-RESPONSE.md))

**Implemented in code from the response:**

- **G1 CLOSED** — `/api/journal` returns `{success, code, response, message}` with **no transaction number**; the client matches on `success`/`code` (never the message — vendor typos are load-bearing), treats 2xx+`success:false` as a definite rejection, and `tranNumber` is sourced from the audit-header read-back.
- **G3 CLOSED** — `findJournalByInvRef` / `searchAuditHeaders` / `searchSplits` implemented. Ambiguous post outcomes now auto-resolve (found ⇒ POSTED with `tranNumber`; absent ⇒ safe retry; **freeze only if the search itself is unavailable**), and reconciliation verifies presence + split totals **in Sage**, not just the local ledger. One residual check: confirm the searchable column name on the instance (`hyperAccounts.readback.invRefField`, default `invRef`, possibly `INV_REF`).
- **G6 CLOSED** — `splits[].details` truncates at the documented **30** chars (was 60). `deptNumber` max 2 confirmed → **F12 constraint: Sage departments > 99 cannot be set via journal**.
- **D4 amended** — UNKNOWN freezing is now the fallback, not the norm, per the read-back above.
- **D7 amended** — materiality block added: `suspenseMaterialityCents` / `suspenseMaterialityPercent` (either breached ⇒ the date blocks instead of posting suspense). Values are finance's F8 call.
- **D15 amended** — `vatMismatchPolicy` defaults to **`block`** while the tax mapping is being established (exactly the pre-opening period); relax to `warn` per property once trusted.
- **D8 upgraded** — reconciliation is now Sage-verifying (see G3).
- **O-items** — lockfile added on mutating commands (`<db>.lock`, stale-safe); heartbeat + Teams Workflows alert payload (see O1); retention target ~6–7 years, confirm with finance.

**Confirmed as built (no change):** D1, D2, D5 (keep approval through parallel run), D6 (detection-dating; finance to confirm VAT treatment of prior-period adjustments on the next VAT3), D9, D10, D11 (non-EUR block is policy — Sage itself supports FX), D12, D13, D14, D16, and D3 with the schedule fixed at **04:00 `Europe/Dublin`** (see docs/OPERATIONS.md).

**Downgraded:** G2 (duplicate `invRef` behaviour) is a footnote now that check-then-post exists — still worth observing once on the real instance.

**Still open, in sequence order:**

> **Instance verification is automated:** `npm run test:live` empirically answers G1, G2, the G3 column name, G4 and G6 and prints a report. Two valid targets: **Hyperext's free shared sandbox** (provided by support on request — the host in their public docs answers; credentials arrive by email; being shared, run only this suite against it) or your own HyperAccounts install with a test Sage company. The `AuthToken` header name is additionally confirmed by the public Postman collection's auth config (G4). The Irish specifics — VAT3 behaviour (G8) and rate checks — still require your own instance: the shared sandbox is another company's dataset and its Sage VAT return isn't accessible. See README → "Live sandbox verification".

| Item | What | When |
|---|---|---|
| G8 | VAT-return mechanism spike (`mewsy vat-spike`) — **do this first**; a failure forces a posting-path redesign | Now |
| G4 | Confirm AuthToken header (very likely), port, http/https on the instance — `npm run test:live` answers this | Now |
| G5 | One HyperAccounts per Sage company? Ask the vendor; not blocking (single property at go-live) | Now |
| G9/G11/G13/G14 | Mews endpoint/filter/tax-code/tender verification against a demo enterprise | Now |
| G12/F5/F10 | Deposits: deferred-revenue + debtors nominals so suspense only holds the unexplained — **decide before Phase 2**; size via deposit-heavy Phase 1 dry-runs | Urgent |
| D4a | Stand up the Teams Workflows endpoint + external heartbeat monitor | Now |
| F1–F4, F7–F9, F11 | Finance configuration incl. **re-verified** Irish VAT rates, COA designed together with Mews categories | Pre-opening (Dec 2026 → Feb 2027) |
| G10/F2 | Populate `taxCodeMap` empirically via `mewsy report`; re-run the VAT spike against the production company | Pre-opening |
