# Mewsy — Response to Build Decisions, Gaps & Open Questions

> Received 8 July 2026 in response to [DECISIONS.md](../DECISIONS.md) (referred to below as `BUILD-DECISIONS.md`).
> Preserved verbatim as the decision record; the resulting code and doc changes are summarised in DECISIONS.md §8.
> `HyperAccounts-API-Reference.md` referenced below is the vendor API documentation (not distributed with this repository).

---

Response to `BUILD-DECISIONS.md` (v0.1 implementation).
Date: 8 July 2026 · Repo: `mewsy` · Spec: *Mewsy — Mews → Sage 50 Revenue Integration, Build Specification v0.1*

---

## 0. Critical context: go-live is February 2027

**The property does not open until Feb 2027. Nothing posts to Sage before then.** This context was missing from the spec and changes several judgements below.

**Consequence 1 — tax rates are a go-live decision, not a build decision.**
Irish VAT rates in force *today* (8 Jul 2026): accommodation **13.5%**, restaurant/catering food **9%** (reduced from 13.5% on 1 July 2026), alcohol / soft drinks / standard-rated items **23%**. These must be **re-verified and configured shortly before opening**, against whatever is in force in Feb 2027. Nothing about rates may be hardcoded — `taxCodeMap`, `exemptSageTaxCode` and the Mews accounting-category tax setup stay pure config, populated in the pre-opening window.

**Consequence 2 — no historical backfill.**
New property, no pre-opening trading history. Spec §11 Phase 3's backfill is not required. The watermark starts at the first trading day.

**Consequence 3 — Mews and Sage are both configured from scratch.**
This is an advantage. The Mews accounting categories, their ledger codes, and the Sage chart of accounts can be designed *together* rather than reconciled retrospectively (F1). Do it once, properly, before opening.

**Consequence 4 — advance deposits will exist on day one.**
Bookings for Feb 2027 will be taken, and deposits paid, during 2026. On the first trading days, revenue closes against payments received months earlier. This makes the deposits / deferred-revenue question (**F5**) **mandatory, not optional** — see §3.

**Consequence 5 — sequencing.**
Everything that does *not* depend on tax rates (G1–G9, G11–G14, and the VAT-mechanism spike G8) should be settled **now**, while the box and sandbox are quiet. The rate-dependent items (F2, G10) are deliberately deferred to the pre-opening window. See §5.

---

## 1. Decisions confirmed

### D3 — Schedule: daily at 04:00 `Europe/Dublin`

- Use the **IANA zone `Europe/Dublin`**, not "IST". Irish Standard Time is summer-only (UTC+1); winter is GMT (UTC+0). 04:00 must remain 04:00 *local* across DST — particularly given the DST window bug fixed in the adversarial review.
- Set the Sage box system timezone to `Europe/Dublin`; keep **NTP enabled** (ledger/audit timestamps use the host clock).
- **Check 04:00 does not collide with the AWS Glacier backup window** or any Sage maintenance. A lock on the Sage data files will fail SDO.
- Windows Task Scheduler: *Run whether user is logged on or not*; *Run task as soon as possible after a scheduled start is missed*; run under a **dedicated service account holding a Sage user seat**.
- Note: 04:00 carries no data-readiness risk. The target date is already ≥ (AEHW + 1) days old, so there is no race with the Mews night audit. The choice is about machine quiet time only.

### D4 — Ambiguous outcomes: accepted as built, with two changes

`UNKNOWN` freezing the date is the right money-safety default. Two amendments:

1. **Auto-resolve `UNKNOWN` using the Sage read-back** — see §2/G3. Manual `mewsy resolve` should become the rare exception, not the operational norm.
2. **Alerting to Teams — but not via an incoming webhook** (see below).

### D4a — Alerting requirements

- **Teams incoming webhooks no longer exist.** Microsoft retired Office 365 connectors in Teams and disabled them **18–22 May 2026**. The `text`-payload approach works for Slack only.
- Use the **Workflows app in Teams** (Power Automate): trigger *"When a Teams webhook request is received"* → post an **Adaptive Card** to the channel. Message Card format is still accepted by Workflows if a drop-in migration is preferred. Caveat: messages post under the **Flow bot** identity (bot name/icon cannot be customised).
- **Keep Mewsy's payload generic and structured** — `severity`, `alertType`, `property`, `businessDate`, `ledgerRowId`, and the literal remediation command (e.g. `mewsy resolve --id N --outcome posted|failed`). Rendering belongs in the Power Automate flow, not in the service. The existing channel-agnostic webhook design is correct; only the endpoint changes.
- **New requirement — heartbeat / dead-man's switch.** This is the highest-priority alerting gap, above the Teams channel itself. An `UNKNOWN` blocks a date, but **if the scheduled task never runs** (box down, task disabled, service account locked), *no alert fires at all* and revenue posting stops silently. Mewsy must emit a success ping each run, and an external monitor must alert on a **missing** ping. Silence must not be indistinguishable from health.
- **Severity separation.** `UNKNOWN` / date-blocked → high severity, must page a named person. Warnings → channel only.

---

## 2. Gaps answered from the HyperAccounts API reference

Source: `HyperAccounts-API-Reference.md` (reconstructed from the vendor documentation). These were listed as unknowns; they are answerable now.

### G3 — A read-back endpoint exists. This is the significant one.

- **`POST /api/search/auditHeaders`** searches Sage's `AUDIT_HEADER` table. Response objects include **`invRef`**, `tranNumber`, `headerNumber`, `date`, `accountRef`, `details`, `netAmount`, `taxAmount`, `grossAmount`, `outstanding`.
- **`POST /api/searchSplit`** searches `AUDIT_SPLIT` for line-level detail.
- Request shape is the standard filter array: `[{ "field": "...", "type": "eq|gte|lte|like|in|...", "value": "..." }]`.

Actions:

1. Implement `hyperAccounts.findJournalByInvRef(invRef)` against `auditHeaders`. *Verify the searchable column name* — the response is camelCase `invRef`; the underlying Sage column is likely `INV_REF`. Confirm on the instance.
2. **D4:** on timeout / reset / 5xx → search for the `invRef`. **Found** ⇒ treat as `POSTED`, capture `tranNumber`. **Not found** ⇒ safe automatic retry. Freeze only if the search itself is unavailable.
3. **D8:** upgrade reconciliation to **true Sage-side** — compare `searchSplit` rows for the business date against the journal Mewsy built, instead of trusting the local posting ledger as a proxy for "what's in Sage".
4. **G2** (duplicate `invRef` behaviour) drops from *"the single answer that most affects operational smoothness"* to a footnote: you can check-then-post rather than guess. Still worth observing once.

### G1 — Response schema, answered

`/api/journal` returns:

```json
{ "success": true, "code": 200, "response": 0, "message": "Journal entried posted succesfully" }
```

- **No transaction number is returned.** `extractTransactionRef()` will never resolve — remove the guesswork and source `tranNumber` from the `auditHeaders` search instead.
- Match on `success` / `code`. **Do not string-match the message** — note the vendor's typos (`entried`, `succesfully`), preserved verbatim in the reference.
- `"response": 0` semantics are undocumented. Capture it; do not interpret it.

### G6 — Field semantics: two concrete bugs

| Field | Documented | As built | Action |
|---|---|---|---|
| `splits[].details` | **max 30 chars** | assumed ~60, truncates at 60 | **Fix: truncate at 30** |
| `splits[].deptNumber` | **max 2 chars** | flagged as suspicious | **Confirmed** — Sage departments > 99 cannot be set via journal. Constrains **F12** |
| `splits[].extraRef` | max 30 chars | — | ok |
| `invRef` | max 30 chars | 30 enforced (D16) | ok |
| `splits[].nominalCode` | string, max 8 | — | ok |
| `splits[].type` | `JD = 15`, `JC = 16` | — | ok |

Also: `AUDIT_HEADER` carries `currency` and `foreignNetAmount` / `foreignTaxAmount` / `foreignGrossAmount`. Sage supports FX — so **D11's non-EUR block is a policy choice, not a technical limit**. Keep the block.

### G4 — Auth

The documentation shows collection-level **API Key** auth with `Content-Type: application/json`; the observed request header in the vendor's own examples is **`AuthToken: <token>`**. Confirm header name, localhost port and http/https against the real instance, but `AuthToken` is very likely correct.

### G5 — One HyperAccounts per Sage company

Not answered by the documentation. Keep the per-property `baseUrl` + token config as built. Confirm with Hyperext whether a single installation can address multiple company datasets. **Not blocking** — only one property exists at go-live.

---

## 3. Recommendations that change built behaviour

### D7 — Add a materiality block

Posting a journal carrying a large suspense line because something upstream broke is worse than not posting at all. Introduce a materiality threshold (absolute € and/or % of day revenue):

- within `roundingToleranceCents` ⇒ rounding line (as built);
- above tolerance, below materiality ⇒ post + alert (as built);
- **above materiality ⇒ block the date + alert.**

### D15 — Block on material VAT-rate mismatch through Phase 1/2

A wrong rate in Mews becomes a wrong VAT3 in Sage. Warning-only is defensible once the mapping is trusted; it is not while the mapping is being established — which, given §0, is exactly the pre-opening period. Make a **material** rate deviation blocking through parallel run, then relax to warning. Keep the existing tolerance for rounding and for legitimate mid-window rate changes.

### G12 / F5 — Deposits are not an edge case here

Because deposits for Feb 2027 stays are collected during 2026, the **first trading days will close revenue against payments received in a prior period**. Payments ≠ revenue is therefore **structural from day one**, not an occasional rounding artefact. A single suspense bucket would fill with legitimate deferred revenue and hide genuine errors.

Decide **before Phase 2**:

- a **deferred revenue / advance deposits liability** nominal; and
- a **debtors / city-ledger control** nominal (tied to **F10** — receivable tracking on or off in Mews),

so that suspense only ever holds genuinely unexplained residual. Phase 1 dry-runs will size this; run them across deposit-heavy dates.

### D6 — Adjustment dating

`adjustmentDating: "detection"` is the correct default for Ireland — VAT3 periods are bi-monthly and posting into a closed period is painful. **Finance to confirm** how the VAT element of a prior-period adjustment is treated on the next return.

### D5 — Adjustment approval

Keep `requireAdjustmentApproval: true` through parallel run. Revisit once trust is established.

### D11 / D12 — Keep as built

Blocking is right. Neither should fire in an Irish, EUR-only property; if one does, something is wrong and stopping is the correct behaviour.

### D1 / D2 / D9 / D10 / D13 / D14 / D16 — Accepted as built

Integer cents (D2) and financial-substance-only hashing (D13) are both correct. D9 (stop at first failed date, per property) is right.

---

## 4. Ops

- **`data/` (SQLite ledger + audit) is the idempotency memory.** It must sit on **backed-up disk**, be **included in the Glacier backup**, and **survive an instance rebuild**. Losing it means re-checking every date against Sage by hand.
- **Add a lockfile.** "Single scheduled run" holds right up until someone runs `mewsy run` by hand while investigating an alert. Cheap insurance against a check-then-post race.
- **`better-sqlite3` is a native module.** Ensure prebuilt binaries or a build toolchain are available on Windows Server.
- **Retention.** The audit log and reports hold full journal payloads. Plan for Irish accounting-record retention (~6–7 years); confirm with finance.
- **Name the on-call owner** for high-severity alerts before go-live.

---

## 5. Sequencing to Feb 2027

**Now — while the box and sandbox are quiet (rate-independent):**

1. **G8 — VAT-return mechanism spike** (`mewsy vat-spike`). Does a journal with `taxCode` + `taxAmount` populate the VAT3, at each rate? This is the headline risk; if it fails, the fallback is a significant rework of `toHyperAccountsJournal`. **Do this first.**
2. G1 / G3 / G6 code changes (§2).
3. G4 / G5 — confirm with Hyperext.
4. G9 / G11 / G13 / G14 — against a Mews demo enterprise.
5. Phase 1 read-and-reconcile dry runs, including deposit-heavy dates (G12).
6. Teams Workflows endpoint + heartbeat monitor (§1/D4a).

**Pre-opening — Dec 2026 → Feb 2027 (rate-dependent):**

1. **Re-verify the Irish VAT rates in force.** Do not assume July 2026 rates still apply.
2. Design Mews accounting categories + ledger codes **together with** the Sage chart of accounts (F1).
3. Populate `taxCodeMap` empirically via `mewsy report` (G10), including the food rate code.
4. Finance sign-off: F3, F4, F5, F7, F8, F9.
5. **Re-run the VAT spike against the production Sage company.**
6. Phase 2 pilot from opening day. **No historical backfill required.**

---

## 6. Finance items — status

| # | Question | Status |
|---|---|---|
| F1 | Ledger codes on every active accounting category | **Pre-opening** — design with the Sage COA |
| F2 | Mews tax code → Sage tax code map | **Pre-opening** — rate-dependent (§0) |
| F3 | Clearing account(s) per tender + top-level `accountRef` | Pre-opening |
| F4 | Overpayment / suspense nominal | Pre-opening |
| F5 | **Deposits / advance payments policy** | **Urgent — decide before Phase 2** (§3) |
| F6 | Closed vs Consumed recognition | Closed confirmed; no action |
| F7 | End-of-day boundary per property | Pre-opening |
| F8 | Rounding tolerance + max acceptable suspense | Decide with D7 materiality block |
| F9 | Adjustment approval mode + dating | Default accepted; confirm before go-live |
| F10 | Receivable tracking: A/R in Mews or Sage | **Decide with F5** — drives whether Bills & Invoices flow is ever needed |
| F11 | `LedgerAccountCode` vs `PostingAccountCode` | Pre-opening; `mewsy validate` audits |
| F12 | Cost centres → `deptNumber` | **Constrained**: max 2 chars, so departments > 99 are impossible via journal (§2/G6) |

---

## 7. Summary — the three things that matter most

1. **Run the VAT spike (G8) now.** Everything else is recoverable; a VAT mechanism that doesn't feed the VAT3 forces a redesign of the posting path.
2. **Wire up the Sage read-back (G3).** It converts `UNKNOWN` from an operational burden into an automatic resolution, and turns reconciliation from ledger-trusting into Sage-verifying.
3. **Settle deposits / deferred revenue (F5 + F10) before Phase 2.** With a Feb 2027 opening and deposits taken through 2026, payments will not equal revenue on day one, and one suspense bucket will not be enough.
