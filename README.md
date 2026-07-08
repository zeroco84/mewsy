# Mewsy

**Mews → Sage 50 Revenue Integration Service** — *"Mews Entries, Wired to Sage for You"*

Implements an internal build specification (v0.1, 8 July 2026 — not distributed with this repository): each day, once a business date has aged past the Mews editable-history window, Mewsy pulls the finalised **Closed** accounting figures for each property, builds **one balanced journal** (revenue + payments + Irish VAT, by nominal), posts it to Sage 50 via the HyperAccounts `POST /api/journal` endpoint, and reconciles the result back against Mews — with idempotency, adjustment handling, an append-only audit log and alerting.

> **Read [DECISIONS.md](DECISIONS.md) before Phase 0.** It lists every assumption made while building this, and the gaps that need a decision from finance or verification against the real Mews/HyperAccounts APIs.

## How it maps to the spec

| Spec section | Where |
|---|---|
| §4 daily loop | [src/pipeline/run.ts](src/pipeline/run.ts), [src/pipeline/processDate.ts](src/pipeline/processDate.ts) |
| §5 journal building, VAT, refunds, overpayments→suspense | [src/domain/journal.ts](src/domain/journal.ts) |
| §6 timing (window + 1, end-of-day boundary) | [src/util/dates.ts](src/util/dates.ts), [src/util/duration.ts](src/util/duration.ts) |
| §7 HyperAccounts `/api/journal` | [src/hyperaccounts/client.ts](src/hyperaccounts/client.ts) |
| §8 idempotency / reconciliation / audit / dead-letter | [src/store/](src/store/), [src/pipeline/processDate.ts](src/pipeline/processDate.ts) |
| §9 VAT-return spike (Phase 0) | `mewsy vat-spike` — [src/pipeline/vatSpike.ts](src/pipeline/vatSpike.ts) |
| §10 finance-owned configuration | [config/mewsy.example.json](config/mewsy.example.json), [src/config.ts](src/config.ts) |
| §11 phases | CLI commands, see below |

## Setup

Requires Node.js ≥ 20. On the Sage box (Windows) or anywhere for Phase 1.

```bash
npm install
npm run build          # compiles to dist/
npm test               # 58 unit tests

cp .env.example .env                       # fill in tokens
cp config/mewsy.example.json config/mewsy.json   # finance-owned config
node dist/cli.js validate                  # Phase 0 checks
```

Secrets live only in the environment (or `.env`); `config/mewsy.json` refers to env-var *names*, never values.

## Commands by phase

**Phase 0 — de-risk & set up**

```bash
mewsy validate                    # config, tokens, Mews connectivity, ledger-code completeness (§10), HA reachability
mewsy vat-spike --property PROP1 --revenue-nominal 9998 --yes    # §9: post one journal at every VAT rate…
#   …then run the Sage 50 (Ireland) VAT3 return and confirm each rate lands in the right box.
mewsy vat-spike --property PROP1 --revenue-nominal 9998 --reverse --yes  # back the test out
```

**Phase 1 — read & reconcile (no posting)**

```bash
mewsy run --dry-run               # builds every eligible date, writes reconciliation reports, writes nothing to Sage
mewsy report --property PROP1 --date 2026-07-01    # detailed would-be journal for one date
```

**Phase 2/3 — post daily**

```bash
mewsy run                         # the §4 daily loop across all configured properties
mewsy run --property PROP1        # pilot property only (Phase 2)
mewsy status                      # watermarks, pending adjustments, unresolved attempts, dead letters
```

Schedule `mewsy run` once daily (Windows Task Scheduler / cron). Runs are idempotent: a missed day is caught up automatically on the next execution (§6), bounded by `maxCatchupDays`.

**When things need a human**

```bash
mewsy adjustments list                     # deltas staged because Mews figures changed after posting (§8.1/8.3)
mewsy adjustments show --id 12
mewsy adjustments approve --id 12 --yes    # posts the delta journal
mewsy adjustments reject --id 12 --note "…"
mewsy resolve --id 7 --outcome posted --sage-ref 12345   # after manually checking Sage for an UNKNOWN attempt
```

## Financial safety model

- **Money is integer cents** internally; decimals exist only at the API boundaries. Sub-cent input fails loudly.
- **Idempotency** (§8.1): deterministic `invRef` per property+date (`MEWSY-REV-PROP1-20260701`), a posting ledger mapping each Mews day to its Sage transaction, and a content hash of the journal's *financial substance*. Same content → skip; changed content → a **delta adjustment journal** is staged for approval (never a repost, never an edit of a posted entry).
- **Ambiguous writes are frozen, not retried**: if the journal POST times out or 5xxs, the outcome is recorded as `UNKNOWN` and the date is blocked until a human confirms in Sage (`mewsy resolve`). A blind retry could double-post revenue; Mewsy never does that. Definite failures (4xx, connection refused) are safe and retried on the next run.
- **Reconciliation** (§8.2): after every post, Mewsy re-fetches the day from Mews and verifies Sage-held content matches exactly; journals are asserted to net to zero before posting. Variance → alert, dead-letter, watermark held.
- **Watermark per property** advances only on verified success; a property stops at its first failed date so postings always land in order.
- **Audit log is append-only**, enforced by SQLite triggers (§8.3). Every attempt, payload, response, outcome and alert is recorded.
- **Overpayments/imbalance** go to the configured suspense nominal so the journal still balances and the residual is visible for follow-up (§5); imbalances ≤ `roundingToleranceCents` are treated as rounding.

## Configuration reference

See [config/mewsy.example.json](config/mewsy.example.json). Everything under `defaults` can be overridden per property. Highlights (all finance-owned, §10):

| Key | Meaning | Default |
|---|---|---|
| `taxCodeMap` | Mews tax code (`TaxValues[].Code`) → Sage 50 (Ireland) tax code + expected rate | **must be verified in Phase 0** |
| `exemptSageTaxCode` | Sage tax code for non-VATable lines (payments, suspense) | — |
| `clearing.accountRef` / `defaultNominal` / `byTender` | payment clearing account(s) per tender | — |
| `suspenseNominal` | overpayment/suspense home | — |
| `postingDelayDays` | override; `null` derives (Mews editable window + 1) at runtime | `null` |
| `endOfDay` | property end-of-day boundary, e.g. `"02:00"` | `"00:00"` |
| `requireAdjustmentApproval` | stage deltas for human approval vs auto-post | `true` |
| `adjustmentDating` | adjustment journal date: `detection` or `source` | `detection` |
| `ledgerCodeField` | Mews category field carrying the Sage nominal | `LedgerAccountCode` |
| `maxCatchupDays` | safety valve on catch-up after downtime | `31` |

Data lives in `./data/` (SQLite DB + reports) — override with `MEWSY_DB` / `MEWSY_REPORT_DIR`.

## Development

```bash
npm run dev -- report --property PROP1 --date 2026-07-01   # run from source (tsx)
npm test                                                    # vitest
```

Tests cover the spec's worked example (§5) line-for-line, refund/overpayment/rounding behaviour, DST-safe business-date windows, the §6 timing table, idempotency/adjustment/UNKNOWN state machine, and API client behaviour. An end-to-end smoke test against mock Mews/HyperAccounts servers is in the repo history; the real Phase 0 verification steps are in [DECISIONS.md](DECISIONS.md).
