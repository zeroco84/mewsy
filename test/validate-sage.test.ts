import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HyperAccountsClient } from '../src/hyperaccounts/client.js';
import { sageReferenceChecks } from '../src/pipeline/validateSage.js';
import { startMockHyperAccounts, type MockHyperAccounts } from './fixtures/mockHyperAccounts.js';
import { makeCategory, makeProperty } from './helpers.js';

describe('sageReferenceChecks against the mock server', () => {
  let mock: MockHyperAccounts;
  let client: HyperAccountsClient;
  const property = makeProperty();
  const categories = [
    makeCategory('cat-acc', 'Accommodation', '4000'),
    makeCategory('cat-food', 'Food', '4001'),
  ];

  beforeEach(async () => {
    mock = await startMockHyperAccounts();
    client = new HyperAccountsClient({ baseUrl: mock.baseUrl, authToken: mock.authToken, timeoutMs: 2000 });
  });

  afterEach(async () => {
    await mock.close();
  });

  it('reads status, tax codes and nominals with the documented shapes', async () => {
    const status = await client.getStatus();
    expect(status).toMatchObject({ companyName: 'MOCK SANDBOX CO', sdoStatusOk: true });
    const taxCodes = await client.getTaxCodes();
    expect(taxCodes.find((t) => t.index === 3)).toMatchObject({ rate: 13.5 });
    const nominals = await client.getNominals();
    expect(nominals.some((n) => n.accountRef === '4000')).toBe(true);
  });

  it('passes when every configured nominal and tax code matches Sage', async () => {
    const result = await sageReferenceChecks(client, property, categories);
    expect(result.problems).toBe(0);
    expect(result.lines.some((l) => l.includes('✓ All') && l.includes('nominal'))).toBe(true);
    expect(result.lines.some((l) => l.includes('✓ All') && l.includes('tax code'))).toBe(true);
  });

  it('flags a Mews ledger code missing from the Sage chart of accounts (spec §10)', async () => {
    const withGhost = [...categories, makeCategory('cat-spa', 'Spa', '4050')];
    const result = await sageReferenceChecks(client, property, withGhost);
    expect(result.problems).toBe(1);
    expect(result.lines.some((l) => l.includes('4050') && l.includes('does not exist'))).toBe(true);
  });

  it('flags inactive nominals and missing tax codes', async () => {
    mock.state.nominals = mock.state.nominals.map((n) => (n.accountRef === '2205' ? { ...n, inactiveFlag: 1 } : n));
    mock.state.taxCodes = mock.state.taxCodes.filter((t) => t.index !== 5);
    const result = await sageReferenceChecks(client, property, categories);
    expect(result.problems).toBe(2);
    expect(result.lines.some((l) => l.includes('2205') && l.includes('INACTIVE'))).toBe(true);
    expect(result.lines.some((l) => l.includes('T5') && l.includes('does not exist'))).toBe(true);
  });

  it('flags a Sage rate that differs from the configured ratePercent (wrong-VAT3 risk)', async () => {
    mock.state.taxCodes = mock.state.taxCodes.map((t) => (t.index === 3 ? { ...t, rate: 15 } : t));
    const result = await sageReferenceChecks(client, property, categories);
    expect(result.problems).toBe(1);
    expect(result.lines.some((l) => l.includes('13.5%') && l.includes('15%'))).toBe(true);
  });

  it('degrades to a skip note when the endpoints are unreachable', async () => {
    await mock.close();
    const result = await sageReferenceChecks(client, property, categories);
    expect(result.problems).toBe(0);
    expect(result.lines[0]).toContain('skipped');
  }, 15_000);
});
