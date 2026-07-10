import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { HyperAccountsClient, type HyperAccountsJournal } from '../src/hyperaccounts/client.js';
import { AmbiguousWriteError } from '../src/util/http.js';

/**
 * LIVE verification against a real HyperAccounts instance (the "sandbox":
 * your own install pointed at a TEST Sage company — the vendor documents no
 * hosted sandbox). Skipped unless explicitly enabled. Run with:
 *
 *   HYPERACCOUNTS_LIVE_URL=http://localhost:5000 \
 *   HYPERACCOUNTS_LIVE_TOKEN=... \
 *   HYPERACCOUNTS_LIVE_CONFIRM=post-test-journals \
 *   npm run test:live
 *
 * Optional: HYPERACCOUNTS_LIVE_NOMINAL (default 9999 — Sage's suspense/
 * mispostings account) and HYPERACCOUNTS_LIVE_TAXCODE (default 9, non-VATable).
 *
 * Read-only checks run with just URL+TOKEN. The posting checks additionally
 * require HYPERACCOUNTS_LIVE_CONFIRM=post-test-journals; they post only tiny
 * NET-ZERO journals (a 1-cent debit and credit on the same nominal, invRefs
 * prefixed MEWSY-LT-), so they leave no balance movement behind — but they DO
 * create audit rows, so never point this at a production company. The company
 * name is printed first so you can see exactly which dataset you hit.
 *
 * The output is a verification report answering the open instance questions
 * in DECISIONS.md §8 empirically: G1 (response schema), G2 (duplicate invRef),
 * G3 (searchable invRef column), G4 (auth), G6 (details limit).
 */

// Pick up .env like the CLI does (non-overriding).
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const URL_ = process.env['HYPERACCOUNTS_LIVE_URL'];
const TOKEN = process.env['HYPERACCOUNTS_LIVE_TOKEN'];
const CONFIRM = process.env['HYPERACCOUNTS_LIVE_CONFIRM'] === 'post-test-journals';
const NOMINAL = process.env['HYPERACCOUNTS_LIVE_NOMINAL'] ?? '9999';
const TAXCODE = Number(process.env['HYPERACCOUNTS_LIVE_TAXCODE'] ?? '9');

const readOnly = Boolean(URL_ && TOKEN);
const posting = readOnly && CONFIRM;

const report: string[] = [];
const note = (line: string) => {
  report.push(line);
  console.log(`  [LIVE] ${line}`);
};

const runStamp = Date.now().toString(36).toUpperCase();
const client = readOnly ? new HyperAccountsClient({ baseUrl: URL_!, authToken: TOKEN!, timeoutMs: 20_000 }) : null;

/** 1-cent debit + credit on the same nominal: balanced AND net-zero on the account. */
function netZeroJournal(invRef: string, details = 'Mewsy live test'): HyperAccountsJournal {
  return {
    date: '01/01/2027', // pre-opening date, unmistakable in the audit trail
    invRef,
    accountRef: NOMINAL,
    splits: [
      { details, nominalCode: NOMINAL, netAmount: 0.01, taxAmount: 0, taxCode: TAXCODE, type: 15, extraRef: 'MEWSY-LIVE-TEST' },
      { details, nominalCode: NOMINAL, netAmount: 0.01, taxAmount: 0, taxCode: TAXCODE, type: 16, extraRef: 'MEWSY-LIVE-TEST' },
    ],
  };
}

describe.skipIf(!readOnly)('Hyperext sandbox — read-only verification (G4, reference data)', () => {
  it('authenticates and identifies the company (CHECK THIS IS THE TEST COMPANY)', async () => {
    const status = await client!.getStatus();
    expect(status).not.toBeNull();
    note(`G4: AuthToken header accepted at ${URL_}`);
    note(`Company: "${status!.companyName ?? '?'}" · Sage ${status!.sageVersion ?? '?'} · API ${status!.apiVersion ?? '?'} · SDO ok=${status!.sdoStatusOk}`);
    expect(status!.sdoStatusOk).not.toBe(false);
  }, 30_000);

  it('reads the tax-code table (feeds F2/G10 configuration)', async () => {
    const taxCodes = await client!.getTaxCodes();
    expect(taxCodes.length).toBeGreaterThan(0);
    const interesting = taxCodes.filter((t) => t.rate > 0 || (t.description ?? '').trim() !== '');
    note(`Tax codes: ${interesting.map((t) => `T${t.index}=${t.rate}%${t.description ? ` (${t.description})` : ''}`).join(', ')}`);
  }, 30_000);

  it('reads the nominal ledger and confirms the test nominal exists', async () => {
    const nominals = await client!.getNominals();
    expect(nominals.length).toBeGreaterThan(0);
    const testNominal = nominals.find((n) => n.accountRef === NOMINAL);
    note(`Nominal ledger: ${nominals.length} accounts; test nominal ${NOMINAL} ${testNominal ? `exists ("${testNominal.name ?? ''}")` : 'MISSING — set HYPERACCOUNTS_LIVE_NOMINAL'}`);
    expect(testNominal).toBeDefined();
  }, 30_000);
});

describe.skipIf(!posting)('Hyperext sandbox — posting verification (G1/G2/G3/G6)', () => {
  const invRef = `MEWSY-LT-${runStamp}`;
  let headerNumber: number | string | undefined;

  it('G1: posts a net-zero journal and gets the documented response shape', async () => {
    const result = await client!.postJournal(netZeroJournal(invRef));
    expect(result.outcome.kind).toBe('ok');
    note(`G1: POST /api/journal accepted ${invRef}; raw response: ${result.rawResponse}`);
  }, 30_000);

  it('G3: discovers the searchable invRef column and captures tranNumber', async () => {
    let header = await client!.findJournalByInvRef(invRef, 'invRef');
    let field = 'invRef';
    if (!header) {
      header = await client!.findJournalByInvRef(invRef, 'INV_REF');
      field = 'INV_REF';
    }
    expect(header, 'journal not findable via invRef nor INV_REF — read-back is load-bearing; investigate before go-live').not.toBeNull();
    headerNumber = header!.headerNumber;
    note(`G3: searchable column is "${field}"${field !== 'invRef' ? ' → set hyperAccounts.readback.invRefField accordingly' : ' (config default is correct)'}`);
    note(`G3: tranNumber=${header!.tranNumber ?? 'MISSING'} headerNumber=${header!.headerNumber ?? 'MISSING'}`);
    expect(header!.tranNumber).toBeDefined();
  }, 30_000);

  it('G3: split search returns usable rows (compareSplits viability)', async () => {
    if (headerNumber === undefined || headerNumber === null) {
      note('G3: headerNumber missing from header — split comparison will degrade to header-only verification');
      return;
    }
    const splits = await client!.searchSplits([{ field: 'headerNumber', type: 'eq', value: headerNumber }]);
    const usable = splits.filter((s) => typeof s.nominalCode === 'string' && typeof s.netAmount === 'number');
    note(`G3: searchSplit returned ${splits.length} row(s), ${usable.length} with nominalCode+netAmount — compareSplits ${usable.length === splits.length && splits.length > 0 ? 'VIABLE' : 'will degrade to header-only'}`);
  }, 30_000);

  it('G2: observes duplicate-invRef behaviour', async () => {
    try {
      const dup = await client!.postJournal(netZeroJournal(invRef));
      if (dup.outcome.kind === 'ok') {
        note('G2: duplicate invRef ACCEPTED — server provides no idempotency backstop; Mewsy\'s ledger remains the only guard (as assumed)');
      } else {
        note(`G2: duplicate invRef REJECTED (${JSON.stringify(dup.outcome)}) — a server-side backstop exists`);
      }
    } catch (err) {
      note(`G2: duplicate post outcome ambiguous (${err instanceof AmbiguousWriteError ? err.message : String(err)}) — observe manually`);
    }
  }, 30_000);

  it('G6: probes the details length limit (documented max 30)', async () => {
    const longRef = `MEWSY-LT-${runStamp}-D`;
    const result = await client!.postJournal(netZeroJournal(longRef, 'x'.repeat(31)));
    if (result.outcome.kind === 'ok') {
      const header = await client!.findJournalByInvRef(longRef).catch(() => null)
        ?? await client!.findJournalByInvRef(longRef, 'INV_REF').catch(() => null);
      const stored = header?.details;
      note(`G6: 31-char details ACCEPTED${typeof stored === 'string' ? ` — stored as ${stored.length} chars` : ''} (docs say max 30; Mewsy truncates at 30 regardless)`);
    } else {
      note(`G6: 31-char details REJECTED as documented (${JSON.stringify(result.outcome).slice(0, 200)})`);
    }
  }, 30_000);
});

describe.skipIf(readOnly)('Hyperext sandbox (disabled)', () => {
  it.skip('set HYPERACCOUNTS_LIVE_URL + HYPERACCOUNTS_LIVE_TOKEN (and HYPERACCOUNTS_LIVE_CONFIRM=post-test-journals for posting checks), then: npm run test:live', () => {});
});

afterAll(() => {
  if (report.length === 0) return;
  console.log('\n================ LIVE VERIFICATION REPORT ================');
  for (const line of report) console.log(`  ${line}`);
  console.log('  → Update DECISIONS.md §8 and hyperAccounts.readback.invRefField with these findings.');
  console.log('===========================================================\n');
});
