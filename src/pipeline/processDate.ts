import type { Alerter } from '../alerts.js';
import type { PropertyConfig } from '../config.js';
import {
  adjustmentInvRef,
  buildAdjustmentLines,
  buildDayJournal,
  journalContentHash,
  revenueInvRef,
  toHyperAccountsJournal,
  type BuiltJournal,
  type JournalLine,
  type JournalTotals,
} from '../domain/journal.js';
import type { HyperAccountsJournal, JournalPostResult } from '../hyperaccounts/client.js';
import type {
  MewsAccountingCategory,
  MewsConfigurationResponse,
  MewsOrderItem,
  MewsPayment,
} from '../mews/types.js';
import type { LedgerKind } from '../store/db.js';
import type { Store } from '../store/store.js';
import { businessDateWindowUtc } from '../util/dates.js';
import { AmbiguousWriteError } from '../util/http.js';
import { logger } from '../util/logger.js';
import { formatEur } from '../util/money.js';

/**
 * The per-date state machine — spec §4 steps 2–7 for one property+date.
 *
 * Clients are injected as narrow interfaces so the idempotency/adjustment
 * paths are testable without the network.
 */

export interface MewsDataSource {
  getConfiguration(): Promise<MewsConfigurationResponse>;
  getAccountingCategories(): Promise<MewsAccountingCategory[]>;
  getClosedOrderItems(interval: { startUtc: string; endUtc: string }): Promise<MewsOrderItem[]>;
  getClosedPayments(interval: { startUtc: string; endUtc: string }): Promise<MewsPayment[]>;
}

export interface JournalPoster {
  postJournal(journal: HyperAccountsJournal): Promise<JournalPostResult>;
}

export type DateOutcomeKind =
  | 'POSTED' // posted and reconciled clean
  | 'POSTED_UNVERIFIED' // posted, but the post-hoc reconcile fetch failed
  | 'SKIPPED_SAME' // already in Sage with identical content — reconciled
  | 'ADJUSTMENT_PENDING' // delta staged, awaiting approval
  | 'ADJUSTMENT_POSTED' // delta auto-posted (requireAdjustmentApproval=false)
  | 'DRY_RUN' // Phase 1 — built and reconciled, nothing written
  | 'BLOCKED' // data problems (missing codes etc.) — nothing posted
  | 'BLOCKED_UNRESOLVED' // an earlier attempt has UNKNOWN outcome — human must resolve
  | 'POST_FAILED' // definite failure (rejected / never sent)
  | 'POST_UNKNOWN' // ambiguous outcome — recorded, needs `mewsy resolve`
  | 'VARIANCE'; // post-hoc reconcile found Mews ≠ Sage

export interface DateReport {
  propertyCode: string;
  businessDate: string;
  outcome: DateOutcomeKind;
  invRef?: string;
  sageTransactionRef?: string | null;
  totals?: JournalTotals;
  lines?: JournalLine[];
  blockers: string[];
  warnings: string[];
  reconciliation?: {
    verified: boolean;
    deltaLineCount: number;
    detail: string;
  };
}

export interface DateOutcome {
  kind: DateOutcomeKind;
  advanceWatermark: boolean;
  report: DateReport;
}

export interface ProcessDateDeps {
  mews: MewsDataSource;
  ha: JournalPoster | null; // null in dry-run mode
  store: Store;
  alert: Alerter;
  runId: string;
  categoriesById: Map<string, MewsAccountingCategory>;
  /** Business "today" at the property — journal date for detection-dated adjustments. */
  detectionDate: string;
}

async function fetchDay(
  mews: MewsDataSource,
  property: PropertyConfig,
  businessDate: string,
): Promise<{ orderItems: MewsOrderItem[]; payments: MewsPayment[] }> {
  const window = businessDateWindowUtc(businessDate, property.timezone, property.endOfDayMinutes);
  const [orderItems, payments] = await Promise.all([
    mews.getClosedOrderItems(window),
    mews.getClosedPayments(window),
  ]);
  return { orderItems, payments };
}

function buildFor(
  property: PropertyConfig,
  businessDate: string,
  data: { orderItems: MewsOrderItem[]; payments: MewsPayment[] },
  categoriesById: Map<string, MewsAccountingCategory>,
) {
  return buildDayJournal({
    property,
    businessDate,
    orderItems: data.orderItems,
    payments: data.payments,
    categoriesById,
  });
}

interface PostResult {
  ok: boolean;
  kind: Extract<DateOutcomeKind, 'POSTED' | 'POST_FAILED' | 'POST_UNKNOWN'>;
  invRef: string;
  sageTransactionRef: string | null;
}

/** Record-then-post with definite/ambiguous outcome bookkeeping (spec §8.1/8.3). */
async function postWithLedger(
  deps: ProcessDateDeps,
  property: PropertyConfig,
  businessDate: string,
  kind: LedgerKind,
  seq: number,
  lines: JournalLine[],
  journalDate: string,
  contentHash: string,
  totals: JournalTotals | null,
  invRef: string,
): Promise<PostResult> {
  const { store, alert, runId } = deps;
  if (!deps.ha) throw new Error('Internal: postWithLedger called without a HyperAccounts client');

  const maxAttempts = 1 + property.journalRetries;
  for (let i = 0; i < maxAttempts; i++) {
    const attempt = store.nextAttempt(property.code, businessDate, kind, seq);
    const payload = toHyperAccountsJournal({ lines, accountRef: property.clearing.accountRef, invRef, journalDate });
    const rowId = store.insertLedgerRow({
      propertyCode: property.code,
      businessDate,
      kind,
      seq,
      attempt,
      invRef,
      status: 'ATTEMPTING',
      contentHash,
      lines,
      totals,
      journalDate,
    });
    store.audit(runId, 'POST_ATTEMPT', { rowId, invRef, attempt, payload }, property.code, businessDate);

    let result: JournalPostResult;
    try {
      result = await deps.ha.postJournal(payload);
    } catch (err) {
      // Ambiguous: Sage may hold this journal. Freeze the date until resolved.
      const message = err instanceof AmbiguousWriteError ? err.message : String(err);
      store.updateLedgerStatus(rowId, 'UNKNOWN', { note: message });
      store.audit(runId, 'POST_AMBIGUOUS', { rowId, invRef, message }, property.code, businessDate);
      store.deadLetter(runId, property.code, businessDate, 'Journal post outcome unknown', { rowId, invRef, message });
      await alert.send(
        'error',
        'POST_UNKNOWN',
        `Journal ${invRef} outcome UNKNOWN — verify in Sage whether it exists, then run: mewsy resolve --id ${rowId} --outcome posted|failed`,
        { propertyCode: property.code, businessDate, detail: { rowId, invRef, message } },
      );
      return { ok: false, kind: 'POST_UNKNOWN', invRef, sageTransactionRef: null };
    }

    if (result.outcome.kind === 'ok') {
      store.updateLedgerStatus(rowId, 'POSTED', {
        sageTransactionRef: result.sageTransactionRef,
        haResponse: result.rawResponse,
      });
      store.audit(
        runId,
        'POSTED',
        { rowId, invRef, sageTransactionRef: result.sageTransactionRef },
        property.code,
        businessDate,
      );
      logger.info(`Posted ${invRef} → Sage ref ${result.sageTransactionRef ?? '(none returned)'}`);
      return { ok: true, kind: 'POSTED', invRef, sageTransactionRef: result.sageTransactionRef };
    }

    if (result.outcome.kind === 'rejected') {
      store.updateLedgerStatus(rowId, 'FAILED', { note: `HTTP ${result.outcome.status}: ${result.outcome.body.slice(0, 1000)}` });
      store.audit(runId, 'POST_REJECTED', { rowId, invRef, status: result.outcome.status, body: result.outcome.body.slice(0, 1000) }, property.code, businessDate);
      store.deadLetter(runId, property.code, businessDate, 'Journal rejected by HyperAccounts', { rowId, invRef, status: result.outcome.status, body: result.outcome.body.slice(0, 1000) });
      await alert.send('error', 'POST_REJECTED', `Journal ${invRef} rejected (HTTP ${result.outcome.status}) — not in Sage`, { propertyCode: property.code, businessDate, detail: { rowId } });
      return { ok: false, kind: 'POST_FAILED', invRef, sageTransactionRef: null };
    }

    // failed_not_sent: definitely never reached HyperAccounts — safe to retry.
    store.updateLedgerStatus(rowId, 'FAILED', { note: result.outcome.error });
    store.audit(runId, 'POST_NOT_SENT', { rowId, invRef, error: result.outcome.error }, property.code, businessDate);
    if (i === maxAttempts - 1) {
      store.deadLetter(runId, property.code, businessDate, 'HyperAccounts unreachable', { rowId, invRef, error: result.outcome.error });
      await alert.send('error', 'POST_NOT_SENT', `Journal ${invRef} could not be sent (HyperAccounts unreachable) — will retry next run`, { propertyCode: property.code, businessDate, detail: { rowId, error: result.outcome.error } });
      return { ok: false, kind: 'POST_FAILED', invRef, sageTransactionRef: null };
    }
  }
  throw new Error('unreachable');
}

/**
 * Post-hoc reconciliation (spec §4 step 6 / §8.2): re-fetch the day from Mews
 * and confirm what is now in Sage (per the ledger) matches it exactly.
 */
async function reconcileAfterPost(
  deps: ProcessDateDeps,
  property: PropertyConfig,
  businessDate: string,
): Promise<{ verified: boolean; deltaLineCount: number; detail: string } | null> {
  const { mews, store, categoriesById } = deps;
  let fresh;
  try {
    fresh = await fetchDay(mews, property, businessDate);
  } catch (err) {
    return null; // fetch failed — reconciliation could not run
  }
  const rebuilt = buildFor(property, businessDate, fresh, categoriesById);
  if (!rebuilt.journal) {
    return { verified: false, deltaLineCount: -1, detail: `Reconcile rebuild blocked: ${rebuilt.blockers.join('; ')}` };
  }
  const posted = store.postedRows(property.code, businessDate).map((r) => store.parseLines(r));
  const delta = buildAdjustmentLines(posted, rebuilt.journal, businessDate);
  if (delta.length === 0) {
    return { verified: true, deltaLineCount: 0, detail: 'Sage postings match Mews Closed figures exactly' };
  }
  const totalDrift = delta.reduce((s, l) => s + Math.abs(l.netCents) + Math.abs(l.taxCents), 0);
  return {
    verified: false,
    deltaLineCount: delta.length,
    detail: `Mews figures moved after posting: ${delta.length} line(s), total drift ${formatEur(totalDrift)}`,
  };
}

export async function processDate(
  property: PropertyConfig,
  businessDate: string,
  mode: 'post' | 'dry-run',
  deps: ProcessDateDeps,
): Promise<DateOutcome> {
  const { store, alert, runId, categoriesById } = deps;

  const report: DateReport = {
    propertyCode: property.code,
    businessDate,
    outcome: 'BLOCKED',
    blockers: [],
    warnings: [],
  };

  // Spec §8.1: never act on a date whose Sage state is uncertain.
  const unresolved = store.unresolvedRows(property.code, businessDate);
  if (unresolved.length > 0 && mode === 'post') {
    const ids = unresolved.map((r) => `#${r.id} (${r.inv_ref}, ${r.status})`).join(', ');
    report.outcome = 'BLOCKED_UNRESOLVED';
    report.blockers.push(
      `Unresolved posting attempt(s) ${ids} — verify in Sage and run mewsy resolve before this date can proceed`,
    );
    await alert.send('error', 'BLOCKED_UNRESOLVED', report.blockers[0]!, {
      propertyCode: property.code,
      businessDate,
      detail: { rows: unresolved.map((r) => r.id) },
    });
    return { kind: 'BLOCKED_UNRESOLVED', advanceWatermark: false, report };
  }

  // §4 step 2: fetch the finalised Closed figures for D.
  const data = await fetchDay(deps.mews, property, businessDate);
  // §4 step 3 / §5: build the balanced journal.
  const build = buildFor(property, businessDate, data, categoriesById);
  report.warnings.push(...build.warnings);

  for (const w of build.warnings) {
    store.audit(runId, 'BUILD_WARNING', { warning: w }, property.code, businessDate);
    if (w.includes('suspense')) {
      await alert.send('warn', 'SUSPENSE_USED', w, { propertyCode: property.code, businessDate });
    }
  }

  if (!build.journal) {
    report.outcome = 'BLOCKED';
    report.blockers = build.blockers;
    store.audit(runId, 'BLOCKED', { blockers: build.blockers }, property.code, businessDate);
    store.deadLetter(runId, property.code, businessDate, 'Journal build blocked', { blockers: build.blockers });
    await alert.send(
      'error',
      'BLOCKED',
      `Cannot build journal for ${businessDate}: ${build.blockers.length} blocker(s). First: ${build.blockers[0]}`,
      { propertyCode: property.code, businessDate, detail: { blockers: build.blockers } },
    );
    return { kind: 'BLOCKED', advanceWatermark: false, report };
  }

  const journal: BuiltJournal = build.journal;
  report.totals = journal.totals;
  report.lines = journal.lines;
  const contentHash = journalContentHash(journal);

  // §4 step 4 / §8.1: idempotency against the posting ledger.
  const postedRows = store.postedRows(property.code, businessDate);
  const postedLineSets = postedRows.map((r) => store.parseLines(r));

  if (mode === 'dry-run') {
    report.outcome = 'DRY_RUN';
    const delta = postedRows.length > 0 ? buildAdjustmentLines(postedLineSets, journal, businessDate) : null;
    report.reconciliation = {
      verified: delta === null ? true : delta.length === 0,
      deltaLineCount: delta?.length ?? 0,
      detail:
        postedRows.length === 0
          ? `Would post ${journal.lines.length} line(s): revenue gross ${formatEur(journal.totals.revenueGrossCents)}, payments ${formatEur(journal.totals.paymentsCents)}`
          : delta!.length === 0
            ? 'Already posted with identical content'
            : `Already posted but figures differ — an adjustment of ${delta!.length} line(s) would be raised`,
    };
    store.audit(runId, 'DRY_RUN', { contentHash, totals: journal.totals, detail: report.reconciliation.detail }, property.code, businessDate);
    return { kind: 'DRY_RUN', advanceWatermark: false, report };
  }

  if (postedRows.length === 0) {
    // First post for this date (§4 step 5, §7).
    const invRef = revenueInvRef(property.code, businessDate);
    const result = await postWithLedger(
      deps, property, businessDate, 'REVENUE', 0, journal.lines, businessDate, contentHash, journal.totals, invRef,
    );
    report.invRef = invRef;
    report.sageTransactionRef = result.sageTransactionRef;
    if (!result.ok) {
      report.outcome = result.kind;
      return { kind: result.kind, advanceWatermark: false, report };
    }

    // §4 step 6: reconcile after posting.
    const rec = await reconcileAfterPost(deps, property, businessDate);
    if (rec === null) {
      report.outcome = 'POSTED_UNVERIFIED';
      report.reconciliation = { verified: false, deltaLineCount: -1, detail: 'Reconcile fetch failed — will verify next run' };
      await alert.send('warn', 'RECONCILE_UNVERIFIED', `Posted ${invRef} but could not re-fetch Mews to reconcile — will verify on next run`, { propertyCode: property.code, businessDate });
      return { kind: 'POSTED_UNVERIFIED', advanceWatermark: false, report };
    }
    report.reconciliation = rec;
    if (!rec.verified) {
      report.outcome = 'VARIANCE';
      store.audit(runId, 'VARIANCE', { detail: rec.detail }, property.code, businessDate);
      store.deadLetter(runId, property.code, businessDate, 'Reconciliation variance after posting', { detail: rec.detail });
      await alert.send('error', 'VARIANCE', `${rec.detail} — watermark held (spec §8.2)`, { propertyCode: property.code, businessDate });
      return { kind: 'VARIANCE', advanceWatermark: false, report };
    }
    store.audit(runId, 'RECONCILED', { detail: rec.detail, totals: journal.totals }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    report.outcome = 'POSTED';
    return { kind: 'POSTED', advanceWatermark: true, report };
  }

  // Something already posted: compare content (§8.1).
  const delta = buildAdjustmentLines(postedLineSets, journal, businessDate);
  if (delta.length === 0) {
    // Sage matches Mews again — any adjustment staged for an interim change
    // (since reverted) is now stale and must not remain approvable, or a
    // later approval would post a delta that no longer exists in Mews.
    const stalePending = store.pendingAdjustments(property.code).filter((r) => r.business_date === businessDate);
    for (const stale of stalePending) {
      store.updateLedgerStatus(stale.id, 'REJECTED', {
        note: `Withdrawn by run ${runId}: Mews figures now match Sage (no delta remains)`,
      });
      store.audit(runId, 'ADJUSTMENT_WITHDRAWN', { rowId: stale.id }, property.code, businessDate);
      await alert.send(
        'warn',
        'ADJUSTMENT_WITHDRAWN',
        `Pending adjustment #${stale.id} for ${businessDate} withdrawn — Mews figures reverted and Sage already matches`,
        { propertyCode: property.code, businessDate, detail: { rowId: stale.id } },
      );
    }
    // The fetch that produced this build IS the reconciliation: Sage == Mews.
    report.outcome = 'SKIPPED_SAME';
    report.reconciliation = { verified: true, deltaLineCount: 0, detail: 'Already posted with identical content' };
    store.audit(runId, 'SKIPPED_SAME', { contentHash }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    return { kind: 'SKIPPED_SAME', advanceWatermark: true, report };
  }

  // Content changed after posting → adjustment journal, never a repost (§8.1/8.3).
  const deltaHash = journalContentHash({ businessDate, accountRef: journal.accountRef, lines: delta });
  const journalDate = property.adjustmentDating === 'source' ? businessDate : deps.detectionDate;

  const pending = store.pendingAdjustments(property.code).filter((r) => r.business_date === businessDate);
  const samePending = pending.find((r) => r.content_hash === deltaHash);
  if (samePending) {
    report.outcome = 'ADJUSTMENT_PENDING';
    report.reconciliation = { verified: false, deltaLineCount: delta.length, detail: `Adjustment #${samePending.id} already staged, awaiting approval` };
    return { kind: 'ADJUSTMENT_PENDING', advanceWatermark: false, report };
  }
  for (const stale of pending) {
    store.updateLedgerStatus(stale.id, 'REJECTED', { note: `Superseded by run ${runId} (Mews figures moved again)` });
    store.audit(runId, 'ADJUSTMENT_SUPERSEDED', { rowId: stale.id }, property.code, businessDate);
  }

  const seq = store.nextSeq(property.code, businessDate, 'ADJUSTMENT');
  const invRef = adjustmentInvRef(property.code, businessDate, seq);
  const totalDrift = delta.reduce((s, l) => s + Math.abs(l.netCents) + Math.abs(l.taxCents), 0);

  if (property.requireAdjustmentApproval) {
    const rowId = store.insertLedgerRow({
      propertyCode: property.code,
      businessDate,
      kind: 'ADJUSTMENT',
      seq,
      attempt: 1,
      invRef,
      status: 'PENDING_APPROVAL',
      contentHash: deltaHash,
      lines: delta,
      totals: null,
      journalDate,
      note: `Delta vs Sage detected on ${deps.detectionDate}`,
    });
    store.audit(runId, 'ADJUSTMENT_STAGED', { rowId, invRef, lines: delta }, property.code, businessDate);
    await alert.send(
      'warn',
      'ADJUSTMENT_PENDING',
      `Mews figures for ${businessDate} changed after posting — adjustment ${invRef} staged (${delta.length} line(s), drift ${formatEur(totalDrift)}). Review with: mewsy adjustments show --id ${rowId}`,
      { propertyCode: property.code, businessDate, detail: { rowId, invRef } },
    );
    report.outcome = 'ADJUSTMENT_PENDING';
    report.invRef = invRef;
    report.reconciliation = { verified: false, deltaLineCount: delta.length, detail: `Adjustment staged (#${rowId})` };
    return { kind: 'ADJUSTMENT_PENDING', advanceWatermark: false, report };
  }

  const result = await postWithLedger(
    deps, property, businessDate, 'ADJUSTMENT', seq, delta, journalDate, deltaHash, null, invRef,
  );
  report.invRef = invRef;
  report.sageTransactionRef = result.sageTransactionRef;
  if (!result.ok) {
    report.outcome = result.kind;
    return { kind: result.kind, advanceWatermark: false, report };
  }
  await alert.send('warn', 'ADJUSTMENT_POSTED', `Adjustment ${invRef} posted for ${businessDate} (${delta.length} line(s), drift ${formatEur(totalDrift)})`, { propertyCode: property.code, businessDate });

  const rec = await reconcileAfterPost(deps, property, businessDate);
  report.reconciliation = rec ?? { verified: false, deltaLineCount: -1, detail: 'Reconcile fetch failed — will verify next run' };
  if (rec?.verified) {
    store.audit(runId, 'RECONCILED', { detail: rec.detail }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    report.outcome = 'ADJUSTMENT_POSTED';
    return { kind: 'ADJUSTMENT_POSTED', advanceWatermark: true, report };
  }
  report.outcome = rec ? 'VARIANCE' : 'POSTED_UNVERIFIED';
  if (rec && !rec.verified) {
    await alert.send('error', 'VARIANCE', `${rec.detail} — watermark held`, { propertyCode: property.code, businessDate });
  }
  return { kind: report.outcome, advanceWatermark: false, report };
}
