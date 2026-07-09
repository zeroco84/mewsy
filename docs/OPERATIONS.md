# Mewsy — Operations Runbook

How to run Mewsy in production on the Sage box. Complements [DECISIONS.md](../DECISIONS.md) (§ ops) and the response document ([DECISIONS-RESPONSE.md](DECISIONS-RESPONSE.md)).

## Scheduling (D3 — confirmed)

Run once daily at **04:00 local**, timezone **`Europe/Dublin`** (the IANA zone — never "IST", which is summer-only; 04:00 must stay 04:00 local across DST).

- Set the Sage box system timezone to `Europe/Dublin` and keep **NTP enabled** (ledger/audit timestamps use the host clock).
- 04:00 carries no data-readiness risk — the target date is already ≥ (editable-history window + 1) days old — the constraint is machine quiet time only. **Confirm 04:00 does not collide with the AWS/Glacier backup window or Sage maintenance**: a lock on the Sage data files will fail SDO.
- Windows Task Scheduler, running under a **dedicated service account that holds a Sage user seat**:
  - *Run whether user is logged on or not*
  - *Run task as soon as possible after a scheduled start is missed*

```bat
schtasks /Create /TN "Mewsy Daily Run" ^
  /TR "\"C:\Program Files\nodejs\node.exe\" C:\mewsy\dist\cli.js run" ^
  /SC DAILY /ST 04:00 /RU DOMAIN\svc-mewsy /RP * /RL LIMITED
```

(Set the working directory to the Mewsy install dir — it resolves `./config`, `./data` and `.env` relative to it — via the task's "Start in" field.)

A concurrent manual `mewsy run` is safe: mutating commands take an exclusive lock next to the database (`<db>.lock`) and refuse to race the scheduled run.

## Heartbeat / dead-man's switch (D4a — highest-priority alerting gap)

An `UNKNOWN` outcome blocks a date and alerts — but **if the scheduled task never runs at all** (box down, task disabled, service account locked), no alert can fire. Mewsy therefore pings a monitor URL on every completed run:

- success → `POST $MEWSY_HEARTBEAT_URL`
- completed-with-problems → `POST $MEWSY_HEARTBEAT_URL/fail`
- crashed / never ran → **no ping** — the monitor's missing-ping alarm fires.

Set `MEWSY_HEARTBEAT_URL` (config `alerts.heartbeatUrlEnv`) to a check URL from healthchecks.io, UptimeRobot heartbeats, CloudWatch, or similar, with an expected period of 1 day plus grace. **Silence must never be indistinguishable from health.**

## Alert routing (D4a)

Mewsy POSTs a structured JSON payload to `MEWSY_ALERT_WEBHOOK`: `severity`, `alertType`, `propertyCode`, `businessDate`, `ledgerRowId`, `remediation` (the literal fix command), `message`, `detail`, plus a `text` convenience field.

- **Microsoft Teams:** incoming webhooks were retired in May 2026. Use the **Workflows app** (Power Automate): trigger *"When a Teams webhook request is received"* → post an Adaptive Card built from the structured fields. Messages appear under the Flow bot identity; that cannot be customised. Rendering belongs in the flow, not in Mewsy.
- **Slack:** incoming webhooks render the `text` field as-is.
- **Severity separation:** route `severity: "error"` (UNKNOWN outcomes, blocked dates, variances) to a **named on-call person** — name that owner before go-live. `warn` goes to the channel.

## Data & backups

- `./data/` (SQLite posting ledger + append-only audit log + reports) is the **idempotency memory**. It must live on backed-up disk, be included in the Glacier backup, and survive an instance rebuild. Losing it means re-verifying every date against Sage by hand (the read-back makes that possible, but slow).
- Retention: the audit log and reports hold full journal payloads — plan for Irish accounting-record retention (~6–7 years; confirm with finance).
- `better-sqlite3` is a native module: ensure prebuilt binaries for the Node version exist on Windows Server, or install the build toolchain, when provisioning.

## Routine checks

- `mewsy status` — watermarks, pending adjustments, **all** unresolved UNKNOWN/ATTEMPTING attempts, open dead letters. Exit code 2 when anything needs a human.
- `mewsy validate` — config, tokens, Mews connectivity, ledger-code completeness, HyperAccounts reachability.
- On an UNKNOWN alert: the Sage read-back normally auto-resolves these; a freeze means the read-back itself was down. Check the journal in Sage (search the `invRef`), then `mewsy resolve --id <row> --outcome posted|failed`.
