import { describe, expect, it } from 'vitest';
import { runVatSpike } from '../src/pipeline/vatSpike.js';
import { FakeHa, makeAlerter, makeProperty, makeStore } from './helpers.js';

const DATE = '2026-07-01';

describe('runVatSpike double-post guards', () => {
  it('posts once, then refuses an identical re-run (deterministic invRef, server accepts duplicates)', async () => {
    const store = makeStore();
    const ha = new FakeHa();
    const property = makeProperty();
    const base = {
      property, store, alert: makeAlerter(store), runId: 'spike-run',
      revenueNominal: '9998', date: DATE, netCentsPerRate: 10000, reverse: false,
    };

    const first = await runVatSpike({ ...base, ha });
    expect(first.posted).toBe(true);
    expect(ha.posted).toHaveLength(1);

    const second = await runVatSpike({ ...base, ha });
    expect(second.posted).toBe(false);
    expect(second.message).toContain('already posted');
    expect(ha.posted).toHaveLength(1); // nothing reposted

    // The reversal is a different invRef and still goes through…
    const reversal = await runVatSpike({ ...base, ha, reverse: true });
    expect(reversal.posted).toBe(true);
    expect(ha.posted).toHaveLength(2);
    // …and is itself protected from re-runs.
    const reversalAgain = await runVatSpike({ ...base, ha, reverse: true });
    expect(reversalAgain.posted).toBe(false);
    expect(ha.posted).toHaveLength(2);
  });

  it('refuses when the invRef already exists in Sage even without a local ledger row', async () => {
    const store = makeStore();
    const ha = new FakeHa();
    const property = makeProperty();
    const base = {
      property, store, alert: makeAlerter(store), runId: 'spike-run',
      revenueNominal: '9998', date: DATE, netCentsPerRate: 10000, reverse: false,
    };
    await runVatSpike({ ...base, ha }); // journal lands in "Sage"

    const freshStore = makeStore(); // e.g. the ledger DB was lost/rebuilt
    const retry = await runVatSpike({ ...base, store: freshStore, ha });
    expect(retry.posted).toBe(false);
    expect(retry.message).toContain('already exists in Sage');
    expect(ha.posted).toHaveLength(1);
  });
});
