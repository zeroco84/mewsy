import { describe, expect, it } from 'vitest';
import { HyperAccountsClient } from '../src/hyperaccounts/client.js';
import { MewsClient } from '../src/mews/client.js';
import type { FetchFn } from '../src/util/http.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('MewsClient', () => {
  it('follows cursor pagination and sends auth in the body', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const limitation = body['Limitation'] as { Cursor?: string };
      if (!limitation.Cursor) {
        return jsonResponse({ OrderItems: [{ Id: 'a' }, { Id: 'b' }], Cursor: 'next-1' });
      }
      return jsonResponse({ OrderItems: [{ Id: 'c' }], Cursor: null });
    };
    const client = new MewsClient({
      baseUrl: 'https://api.mews-demo.com',
      clientToken: 'CT',
      accessToken: 'AT',
      clientName: 'Mewsy test',
      fetchFn,
    });
    const items = await client.getClosedOrderItems({ startUtc: '2026-06-30T23:00:00Z', endUtc: '2026-07-01T23:00:00Z' });
    expect(items.map((i) => i.Id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.mews-demo.com/api/connector/v1/orderItems/getAll');
    expect(calls[0]!.body).toMatchObject({
      ClientToken: 'CT',
      AccessToken: 'AT',
      Client: 'Mewsy test',
      AccountingStates: ['Closed'],
      ClosedUtc: { StartUtc: '2026-06-30T23:00:00Z', EndUtc: '2026-07-01T23:00:00Z' },
    });
    expect(calls[1]!.body['Limitation']).toMatchObject({ Cursor: 'next-1' });
  });

  it('retries reads on 5xx then succeeds', async () => {
    let attempt = 0;
    const fetchFn: FetchFn = async () => {
      attempt++;
      if (attempt === 1) return new Response('boom', { status: 500 });
      return jsonResponse({ AccountingCategories: [{ Id: 'x', IsActive: true }], Cursor: null });
    };
    const client = new MewsClient({ baseUrl: 'https://x', clientToken: 'a', accessToken: 'b', clientName: 'c', fetchFn });
    const categories = await client.getAccountingCategories();
    expect(categories).toHaveLength(1);
    expect(attempt).toBe(2);
  });

  it('does not retry 4xx (bad credentials should fail loudly)', async () => {
    let attempt = 0;
    const fetchFn: FetchFn = async () => {
      attempt++;
      return new Response('invalid token', { status: 401 });
    };
    const client = new MewsClient({ baseUrl: 'https://x', clientToken: 'a', accessToken: 'b', clientName: 'c', fetchFn });
    await expect(client.getAccountingCategories()).rejects.toThrow(/401/);
    expect(attempt).toBe(1);
  });
});

describe('HyperAccountsClient', () => {
  it('posts with the AuthToken header and accepts the documented response shape (G1)', async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      captured = {
        url: String(url),
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: JSON.parse(String(init?.body)),
      };
      // Verbatim vendor response, typos included — never match on message.
      return jsonResponse({ success: true, code: 200, response: 0, message: 'Journal entried posted succesfully' });
    };
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 'secret', fetchFn });
    const result = await client.postJournal({ date: '01/07/2026', invRef: 'X', accountRef: '1200', splits: [] });
    expect(result.outcome.kind).toBe('ok');
    expect(result.rawResponse).toContain('"success":true');
    expect(captured!.url).toBe('http://localhost:5000/api/journal');
    expect(captured!.headers['AuthToken']).toBe('secret');
  });

  it('treats a 2xx body with success:false as a definite rejection (G1)', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ success: false, code: 422, response: 0, message: 'nominal not found' });
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 't', fetchFn });
    const result = await client.postJournal({ date: '01/07/2026', invRef: 'X', accountRef: '1200', splits: [] });
    expect(result.outcome).toMatchObject({ kind: 'rejected', status: 422 });
  });

  it('returns a definite rejected outcome on 4xx', async () => {
    const fetchFn: FetchFn = async () => new Response('nominal not found', { status: 400 });
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 't', fetchFn });
    const result = await client.postJournal({ date: '01/07/2026', invRef: 'X', accountRef: '1200', splits: [] });
    expect(result.outcome).toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('treats 5xx as ambiguous (journal may be in Sage)', async () => {
    const fetchFn: FetchFn = async () => new Response('ISE', { status: 500 });
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 't', fetchFn });
    await expect(client.postJournal({ date: '01/07/2026', invRef: 'X', accountRef: '1200', splits: [] })).rejects.toThrow(
      /may or may not/,
    );
  });

  it('searches auditHeaders by invRef with the filter-array grammar (G3)', async () => {
    let captured: { url: string; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(String(init?.body)) };
      return jsonResponse([{ invRef: 'MEWSY-REV-PROP1-20260701', tranNumber: 4211, headerNumber: 88 }]);
    };
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 't', fetchFn });
    const header = await client.findJournalByInvRef('MEWSY-REV-PROP1-20260701');
    expect(captured!.url).toBe('http://localhost:5000/api/search/auditHeaders');
    expect(captured!.body).toEqual([{ field: 'invRef', type: 'eq', value: 'MEWSY-REV-PROP1-20260701' }]);
    expect(header).toMatchObject({ tranNumber: 4211, headerNumber: 88 });

    // Alternate searchable column name is configurable (may be INV_REF on the instance).
    await client.findJournalByInvRef('X', 'INV_REF');
    expect((captured!.body as Array<{ field: string }>)[0]!.field).toBe('INV_REF');
  });

  it('unwraps enveloped search responses and returns [] when nothing matches', async () => {
    const fetchFn: FetchFn = async () => jsonResponse({ success: true, response: [{ nominalCode: '4000', netAmount: 9000 }] });
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 't', fetchFn });
    const splits = await client.searchSplits([{ field: 'headerNumber', type: 'eq', value: 88 }]);
    expect(splits).toEqual([{ nominalCode: '4000', netAmount: 9000 }]);

    const emptyFetch: FetchFn = async () => jsonResponse({ success: true, response: [] });
    const client2 = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 't', fetchFn: emptyFetch });
    expect(await client2.findJournalByInvRef('NOPE')).toBeNull();
  });
});
