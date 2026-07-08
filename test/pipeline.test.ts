import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyConfig } from '../src/config.js';
import { approveAdjustment } from '../src/pipeline/adjustments.js';
import { processDate, type ProcessDateDeps } from '../src/pipeline/processDate.js';
import { runPipeline } from '../src/pipeline/run.js';
import type { Store } from '../src/store/store.js';
import {
  categoriesById,
  FakeHa,
  FakeMews,
  makeAlerter,
  makeCategory,
  makeItem,
  makePayment,
  makeProperty,
  makeStore,
  specExampleData,
} from './helpers.js';

const DATE = '2026-07-01';

function makeDeps(mews: FakeMews, ha: FakeHa | null, store: Store): ProcessDateDeps {
  return {
    mews,
    ha,
    store,
    alert: makeAlerter(store),
    runId: 'test-run',
    categoriesById: categoriesById(mews.categories),
    detectionDate: '2026-07-05',
  };
}

describe('processDate — the §4 state machine', () => {
  let store: Store;
  let mews: FakeMews;
  let ha: FakeHa;
  let property: PropertyConfig;

  beforeEach(() => {
    store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    mews = new FakeMews(categories, orderItems, payments);
    ha = new FakeHa();
    property = makeProperty();
  });

  it('first run: posts, reconciles, allows watermark advance', async () => {
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('POSTED');
    expect(outcome.advanceWatermark).toBe(true);
    expect(ha.posted).toHaveLength(1);
    expect(ha.posted[0]!.invRef).toBe('MEWSY-REV-PROP1-20260701');
    expect(store.postedRows('PROP1', DATE)).toHaveLength(1);
    expect(outcome.report.reconciliation?.verified).toBe(true);
  });

  it('second run with identical data: SKIPPED_SAME, nothing reposted (spec §8.1)', async () => {
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    const second = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(second.kind).toBe('SKIPPED_SAME');
    expect(second.advanceWatermark).toBe(true);
    expect(ha.posted).toHaveLength(1); // no silent repost
  });

  it('changed figures after posting: stages a PENDING adjustment, never reposts (spec §8.1)', async () => {
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    mews.orderItems = [...mews.orderItems.slice(1), makeItem('cat-acc', 8000, 'IE-R1', 1080)];
    mews.payments = [makePayment(11699)];
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('ADJUSTMENT_PENDING');
    expect(outcome.advanceWatermark).toBe(false);
    expect(ha.posted).toHaveLength(1);
    const pending = store.pendingAdjustments('PROP1');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.inv_ref).toBe('MEWSY-ADJ-PROP1-20260701-0');
    expect(pending[0]!.journal_date).toBe('2026-07-05'); // detection-dated by default

    // Re-running with the same changed data must not stack duplicates.
    const again = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(again.kind).toBe('ADJUSTMENT_PENDING');
    expect(store.pendingAdjustments('PROP1')).toHaveLength(1);
  });

  it('approved adjustment posts the delta; the next run reconciles clean', async () => {
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    mews.orderItems = [...mews.orderItems.slice(1), makeItem('cat-acc', 8000, 'IE-R1', 1080)];
    mews.payments = [makePayment(11699)];
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    const pending = store.pendingAdjustments('PROP1')[0]!;

    const config = { mews: { baseUrl: '', clientTokenEnv: '', clientName: '' }, alerts: {}, properties: [property] };
    const result = await approveAdjustment(config, store, makeAlerter(store), 'approve-run', pending.id, () => ha);
    expect(result.ok).toBe(true);
    expect(ha.posted).toHaveLength(2);
    expect(ha.posted[1]!.invRef).toBe('MEWSY-ADJ-PROP1-20260701-0');

    const after = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(after.kind).toBe('SKIPPED_SAME');
    expect(after.advanceWatermark).toBe(true);
  });

  it('auto-posts adjustments when approval is not required', async () => {
    property = makeProperty({ requireAdjustmentApproval: false });
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    mews.payments = [makePayment(12834), makePayment(50)]; // extra €50 overpayment
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('ADJUSTMENT_POSTED');
    expect(outcome.advanceWatermark).toBe(true);
    expect(ha.posted).toHaveLength(2);
  });

  it('blocks on data problems without posting (spec §10)', async () => {
    mews.categories = [...mews.categories.slice(1)]; // drop the accommodation category
    const deps = makeDeps(mews, ha, store);
    const outcome = await processDate(property, DATE, 'post', deps);
    expect(outcome.kind).toBe('BLOCKED');
    expect(ha.posted).toHaveLength(0);
    expect(store.openDeadLetters('PROP1')).toHaveLength(1);
  });

  it('ambiguous post outcome freezes the date until resolved (UNKNOWN)', async () => {
    ha.mode = 'ambiguous';
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('POST_UNKNOWN');
    const unresolved = store.unresolvedRows('PROP1', DATE);
    expect(unresolved).toHaveLength(1);

    ha.mode = 'ok';
    const blocked = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(blocked.kind).toBe('BLOCKED_UNRESOLVED');
    expect(ha.posted).toHaveLength(0);

    // Human verifies the journal IS in Sage → resolve as posted → next run reconciles.
    store.updateLedgerStatus(unresolved[0]!.id, 'POSTED', { sageTransactionRef: 'SAGE-MANUAL' });
    const after = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(after.kind).toBe('SKIPPED_SAME');
  });

  it('rejected post records FAILED and a dead letter; a later run can retry', async () => {
    ha.mode = 'reject';
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('POST_FAILED');
    expect(store.openDeadLetters('PROP1')).toHaveLength(1);

    ha.mode = 'ok';
    const retry = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(retry.kind).toBe('POSTED');
    expect(store.openDeadLetters('PROP1')).toHaveLength(0); // resolved on success
  });

  it('detects mid-run variance: data changes between post and reconcile fetch', async () => {
    const { categories, orderItems, payments } = specExampleData();
    // Mutate the data as soon as the first (build) fetch has happened.
    const shiftyMews = new (class extends FakeMews {
      override async getClosedOrderItems() {
        const result = await super.getClosedOrderItems();
        if (this.fetchCount === 1) {
          this.orderItems = [...this.orderItems, makeItem('cat-bar', 100, 'IE-S', 23)];
          this.payments = [...this.payments, makePayment(123)];
        }
        return result;
      }
    })(categories, orderItems, payments);
    const outcome = await processDate(property, DATE, 'post', makeDeps(shiftyMews, ha, store));
    expect(outcome.kind).toBe('VARIANCE');
    expect(outcome.advanceWatermark).toBe(false);
    expect(store.openDeadLetters('PROP1').some((d) => d.reason.includes('variance'))).toBe(true);
  });

  it('withdraws a stale pending adjustment when Mews reverts to the posted figures', async () => {
    // Regression: post → Mews change stages a pending adjustment → change is
    // reverted → the pending row used to stay approvable forever.
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    const originalItems = mews.orderItems;
    const originalPayments = mews.payments;
    mews.orderItems = [...mews.orderItems.slice(1), makeItem('cat-acc', 8000, 'IE-R1', 1080)];
    mews.payments = [makePayment(11699)];
    await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(store.pendingAdjustments('PROP1')).toHaveLength(1);

    mews.orderItems = originalItems; // revert in Mews
    mews.payments = originalPayments;
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('SKIPPED_SAME');
    expect(store.pendingAdjustments('PROP1')).toHaveLength(0); // withdrawn, not approvable
    expect(ha.posted).toHaveLength(1); // nothing extra reached Sage
  });

  it('POSTED VAT_SPIKE rows do not count as the day already posted', async () => {
    // Regression: a Phase 0 vat-spike on date D used to derail D's real
    // revenue post into a bogus adjustment.
    const { buildVatSpikeLines, journalContentHash, vatSpikeInvRef } = await import('../src/domain/journal.js');
    for (const reverse of [false, true]) {
      const lines = buildVatSpikeLines(property, '9998', 10000, reverse);
      const id = store.insertLedgerRow({
        propertyCode: 'PROP1', businessDate: DATE, kind: 'VAT_SPIKE', seq: reverse ? 1 : 0, attempt: 1,
        invRef: vatSpikeInvRef('PROP1', DATE, reverse), status: 'ATTEMPTING',
        contentHash: journalContentHash({ businessDate: DATE, accountRef: '1200', lines }),
        lines, totals: null, journalDate: DATE,
      });
      store.updateLedgerStatus(id, 'POSTED', { sageTransactionRef: `SPIKE-${reverse}` });
    }
    const outcome = await processDate(property, DATE, 'post', makeDeps(mews, ha, store));
    expect(outcome.kind).toBe('POSTED'); // real day still posts as first REVENUE journal
    expect(ha.posted[0]!.invRef).toBe('MEWSY-REV-PROP1-20260701');
    expect(store.pendingAdjustments('PROP1')).toHaveLength(0);
  });

  it('dry-run touches nothing (Phase 1)', async () => {
    const outcome = await processDate(property, DATE, 'dry-run', makeDeps(mews, null, store));
    expect(outcome.kind).toBe('DRY_RUN');
    expect(outcome.advanceWatermark).toBe(false);
    expect(store.rowsForDate('PROP1', DATE)).toHaveLength(0);
    expect(outcome.report.totals?.revenueGrossCents).toBe(1283400);
  });
});

describe('runPipeline — the daily loop (spec §4/§6)', () => {
  it('catches up from the start date to the latest eligible date and advances the watermark', async () => {
    const store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    const mews = new FakeMews(categories, orderItems, payments, 'P1D'); // delay = 2
    const ha = new FakeHa();
    const property = makeProperty({ startDate: '2026-07-01' });
    const config = { mews: { baseUrl: '', clientTokenEnv: '', clientName: '' }, alerts: {}, properties: [property] };

    // On 4 July, delay 2 → eligible up to 2 July.
    const summary = await runPipeline(config, store, makeAlerter(store), 'run-1', {
      mode: 'post',
      now: DateTime.fromISO('2026-07-04T10:00:00Z'),
      mewsFactory: () => mews,
      haFactory: () => ha,
    });
    const prop = summary.properties[0]!;
    expect(prop.delayDays).toBe(2);
    expect(prop.latestEligible).toBe('2026-07-02');
    expect(prop.outcomes.map((o) => o.kind)).toEqual(['POSTED', 'POSTED']);
    expect(store.getWatermark('PROP1')).toBe('2026-07-02');
    expect(ha.posted.map((p) => p.invRef)).toEqual(['MEWSY-REV-PROP1-20260701', 'MEWSY-REV-PROP1-20260702']);
  });

  it('stops a property at the first failed date to keep postings ordered', async () => {
    const store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    const mews = new FakeMews(categories, orderItems, payments, 'P1D');
    const ha = new FakeHa();
    ha.mode = 'reject';
    const property = makeProperty();
    const config = { mews: { baseUrl: '', clientTokenEnv: '', clientName: '' }, alerts: {}, properties: [property] };
    const summary = await runPipeline(config, store, makeAlerter(store), 'run-1', {
      mode: 'post',
      now: DateTime.fromISO('2026-07-04T10:00:00Z'),
      mewsFactory: () => mews,
      haFactory: () => ha,
    });
    const prop = summary.properties[0]!;
    expect(prop.outcomes).toHaveLength(1); // 2 July never attempted
    expect(prop.stoppedEarly).toBe(true);
    expect(store.getWatermark('PROP1')).toBeNull();
  });

  it('refuses to post a date still inside the editable window (spec §6)', async () => {
    const store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    const mews = new FakeMews(categories, orderItems, payments, 'P1D');
    const ha = new FakeHa();
    const config = { mews: { baseUrl: '', clientTokenEnv: '', clientName: '' }, alerts: {}, properties: [makeProperty()] };
    const summary = await runPipeline(config, store, makeAlerter(store), 'run-1', {
      mode: 'post',
      date: '2026-07-03', // eligible max is 2 July
      now: DateTime.fromISO('2026-07-04T10:00:00Z'),
      mewsFactory: () => mews,
      haFactory: () => ha,
    });
    expect(summary.properties[0]!.error).toMatch(/editable-history window/);
    expect(ha.posted).toHaveLength(0);
  });

  it('dry-run mode never constructs a HyperAccounts client and processes all dates', async () => {
    const store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    const mews = new FakeMews(categories, orderItems, payments, 'P2D'); // delay 3
    const config = { mews: { baseUrl: '', clientTokenEnv: '', clientName: '' }, alerts: {}, properties: [makeProperty()] };
    const summary = await runPipeline(config, store, makeAlerter(store), 'run-1', {
      mode: 'dry-run',
      now: DateTime.fromISO('2026-07-05T10:00:00Z'),
      mewsFactory: () => mews,
      haFactory: () => {
        throw new Error('must not be called in dry-run');
      },
    });
    expect(summary.properties[0]!.outcomes.map((o) => o.kind)).toEqual(['DRY_RUN', 'DRY_RUN']);
    expect(store.getWatermark('PROP1')).toBeNull();
  });

  it('an explicit --date ahead of the watermark posts but holds the watermark (no silent gaps)', async () => {
    // Regression: `run --date D` used to advance the watermark to D, silently
    // skipping every unposted date before it from all future scheduled runs.
    const store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    const mews = new FakeMews(categories, orderItems, payments, 'P1D'); // delay 2
    const ha = new FakeHa();
    const property = makeProperty({ startDate: '2026-07-01' });
    const config = { mews: { baseUrl: '', clientTokenEnv: '', clientName: '' }, alerts: {}, properties: [property] };
    const now = DateTime.fromISO('2026-07-04T10:00:00Z'); // latest eligible 2026-07-02

    const explicit = await runPipeline(config, store, makeAlerter(store), 'run-1', {
      mode: 'post',
      date: '2026-07-02', // ahead of the never-started watermark (expected next: 07-01)
      now,
      mewsFactory: () => mews,
      haFactory: () => ha,
    });
    expect(explicit.properties[0]!.outcomes.map((o) => o.kind)).toEqual(['POSTED']);
    expect(store.getWatermark('PROP1')).toBeNull(); // held — 07-01 is still unposted

    // The scheduled run now catches up 07-01 and passes 07-02 via SKIPPED_SAME.
    const scheduled = await runPipeline(config, store, makeAlerter(store), 'run-2', {
      mode: 'post',
      now,
      mewsFactory: () => mews,
      haFactory: () => ha,
    });
    expect(scheduled.properties[0]!.outcomes.map((o) => o.kind)).toEqual(['POSTED', 'SKIPPED_SAME']);
    expect(store.getWatermark('PROP1')).toBe('2026-07-02');
    expect(ha.posted.map((p) => p.invRef)).toEqual(['MEWSY-REV-PROP1-20260702', 'MEWSY-REV-PROP1-20260701']);
  });

  it('respects maxCatchupDays as a safety valve', async () => {
    const store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    const mews = new FakeMews(categories, orderItems, payments, 'P1D');
    const ha = new FakeHa();
    const config = {
      mews: { baseUrl: '', clientTokenEnv: '', clientName: '' },
      alerts: {},
      properties: [makeProperty({ maxCatchupDays: 3, startDate: '2026-06-01' })],
    };
    const summary = await runPipeline(config, store, makeAlerter(store), 'run-1', {
      mode: 'post',
      now: DateTime.fromISO('2026-07-04T10:00:00Z'),
      mewsFactory: () => mews,
      haFactory: () => ha,
    });
    expect(summary.properties[0]!.outcomes).toHaveLength(3);
    expect(store.getWatermark('PROP1')).toBe('2026-06-03');
  });
});
