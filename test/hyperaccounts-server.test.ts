import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDayJournal, revenueInvRef, toHyperAccountsJournal } from '../src/domain/journal.js';
import { HyperAccountsClient } from '../src/hyperaccounts/client.js';
import { processDate, type ProcessDateDeps } from '../src/pipeline/processDate.js';
import type { Store } from '../src/store/store.js';
import { AmbiguousWriteError } from '../src/util/http.js';
import { startMockHyperAccounts, type MockHyperAccounts } from './fixtures/mockHyperAccounts.js';
import {
  categoriesById,
  FakeMews,
  makeAlerter,
  makeProperty,
  makeStore,
  specExampleData,
} from './helpers.js';

/**
 * Integration tests: the real HyperAccountsClient over real HTTP against the
 * in-repo mock server (test/fixtures/mockHyperAccounts.ts), which enforces
 * the documented vendor contract. Complements the fake-fetch unit tests in
 * clients.test.ts and the FakeHa pipeline tests.
 */

const DATE = '2026-07-01';

function specJournalPayload(invRef = revenueInvRef('PROP1', DATE)) {
  const property = makeProperty();
  const { categories, orderItems, payments } = specExampleData();
  const { journal } = buildDayJournal({
    property,
    businessDate: DATE,
    orderItems,
    payments,
    categoriesById: categoriesById(categories),
  });
  return toHyperAccountsJournal({ lines: journal!.lines, accountRef: '1200', invRef, journalDate: DATE });
}

describe('HyperAccountsClient against the mock server', () => {
  let mock: MockHyperAccounts;
  let client: HyperAccountsClient;

  beforeEach(async () => {
    mock = await startMockHyperAccounts();
    client = new HyperAccountsClient({ baseUrl: mock.baseUrl, authToken: mock.authToken, timeoutMs: 2000 });
  });

  afterEach(async () => {
    await mock.close();
  });

  it('posts a Mewsy-built journal that passes the vendor contract, then reads it back', async () => {
    const result = await client.postJournal(specJournalPayload());
    expect(result.outcome.kind).toBe('ok');
    expect(result.rawResponse).toContain('"success":true');
    expect(mock.journals).toHaveLength(1);

    const header = await client.findJournalByInvRef('MEWSY-REV-PROP1-20260701');
    expect(header).toMatchObject({ tranNumber: 90001, headerNumber: 1 });
    // The likely real Sage column name also works (readback.invRefField).
    const viaColumn = await client.findJournalByInvRef('MEWSY-REV-PROP1-20260701', 'INV_REF');
    expect(viaColumn?.tranNumber).toBe(90001);

    const splits = await client.searchSplits([{ field: 'headerNumber', type: 'eq', value: 1 }]);
    expect(splits.map((s) => s.nominalCode).sort()).toEqual(['1200', '4000', '4001', '4002']);
    expect(await client.findJournalByInvRef('MEWSY-REV-NOPE-20260701')).toBeNull();
  });

  it('rejects a bad AuthToken as a definite (non-ambiguous) outcome', async () => {
    const badClient = new HyperAccountsClient({ baseUrl: mock.baseUrl, authToken: 'wrong', timeoutMs: 2000 });
    const result = await badClient.postJournal(specJournalPayload());
    expect(result.outcome).toMatchObject({ kind: 'rejected', status: 401 });
    expect(mock.journals).toHaveLength(0);
  });

  it('contract guard: over-long details and unbalanced journals are rejected as success:false', async () => {
    const good = specJournalPayload();

    const longDetails = { ...good, splits: good.splits.map((s, i) => (i === 0 ? { ...s, details: 'x'.repeat(31) } : s)) };
    const rejected = await client.postJournal(longDetails);
    expect(rejected.outcome).toMatchObject({ kind: 'rejected', status: 422 });
    expect((rejected.outcome as { body: string }).body).toContain('30 chars');

    const unbalanced = { ...good, splits: good.splits.map((s, i) => (i === 0 ? { ...s, netAmount: s.netAmount + 1 } : s)) };
    const rejected2 = await client.postJournal(unbalanced);
    expect(rejected2.outcome).toMatchObject({ kind: 'rejected', status: 422 });
    expect((rejected2.outcome as { body: string }).body).toContain('balance');
    expect(mock.journals).toHaveLength(0);
  });

  it('treats a 500 and a timeout as ambiguous outcomes', async () => {
    mock.state.failureMode = 'server-error';
    await expect(client.postJournal(specJournalPayload())).rejects.toThrow(AmbiguousWriteError);

    mock.state.failureMode = 'blackhole';
    const impatient = new HyperAccountsClient({ baseUrl: mock.baseUrl, authToken: mock.authToken, timeoutMs: 300 });
    await expect(impatient.postJournal(specJournalPayload())).rejects.toThrow(AmbiguousWriteError);
  });

  it('probe() reports reachability', async () => {
    expect((await client.probe()).reachable).toBe(true);
  });
});

describe('pipeline against the mock server (real HTTP end to end)', () => {
  let mock: MockHyperAccounts;
  let store: Store;
  let mews: FakeMews;

  beforeEach(async () => {
    mock = await startMockHyperAccounts();
    store = makeStore();
    const { categories, orderItems, payments } = specExampleData();
    mews = new FakeMews(categories, orderItems, payments);
  });

  afterEach(async () => {
    await mock.close();
  });

  function deps(): { property: ReturnType<typeof makeProperty>; deps: ProcessDateDeps } {
    const property = makeProperty({
      hyperAccounts: {
        baseUrl: mock.baseUrl,
        authTokenEnv: 'unused',
        readback: { enabled: true, invRefField: 'invRef', compareSplits: true },
      },
    });
    return {
      property,
      deps: {
        mews,
        ha: new HyperAccountsClient({ baseUrl: mock.baseUrl, authToken: mock.authToken, timeoutMs: 2000 }),
        store,
        alert: makeAlerter(store),
        runId: 'it-run',
        categoriesById: categoriesById(mews.categories),
        detectionDate: '2026-07-05',
      },
    };
  }

  it('posts, captures the tranNumber via read-back, and reconciles against Sage', async () => {
    const { property, deps: d } = deps();
    const outcome = await processDate(property, DATE, 'post', d);
    expect(outcome.kind).toBe('POSTED');
    expect(outcome.advanceWatermark).toBe(true);
    const row = store.postedRows('PROP1', DATE)[0]!;
    expect(row.sage_transaction_ref).toBe('90001');
    expect(outcome.report.reconciliation?.detail).toContain('split-compared');
    expect(mock.journals).toHaveLength(1);
  });

  it('recovers an ambiguous post whose journal actually landed (real HTTP path)', async () => {
    const { property, deps: d } = deps();
    mock.state.failureMode = 'server-error';
    mock.state.ambiguousLands = true;
    const outcome = await processDate(property, DATE, 'post', d);
    expect(outcome.kind).toBe('POSTED');
    expect(store.postedRows('PROP1', DATE)[0]!.sage_transaction_ref).toBe('90001');
    expect(store.unresolvedRows('PROP1', DATE)).toHaveLength(0);

    // Sage is healthy again: the next run verifies and skips cleanly.
    mock.state.failureMode = 'none';
    const again = await processDate(property, DATE, 'post', deps().deps);
    expect(again.kind).toBe('SKIPPED_SAME');
    expect(mock.journals).toHaveLength(1); // never double-posted
  });
});
