import { describe, expect, it } from 'vitest';
import { extractTransactionRef, HyperAccountsClient } from '../src/hyperaccounts/client.js';
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
  it('posts with the AuthToken header and extracts the transaction ref', async () => {
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      captured = {
        url: String(url),
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse({ transactionNumber: 12345 });
    };
    const client = new HyperAccountsClient({ baseUrl: 'http://localhost:5000', authToken: 'secret', fetchFn });
    const result = await client.postJournal({ date: '01/07/2026', invRef: 'X', accountRef: '1200', splits: [] });
    expect(result.outcome.kind).toBe('ok');
    expect(result.sageTransactionRef).toBe('12345');
    expect(captured!.url).toBe('http://localhost:5000/api/journal');
    expect(captured!.headers['AuthToken']).toBe('secret');
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
});

describe('extractTransactionRef', () => {
  it('handles common response shapes', () => {
    expect(extractTransactionRef({ transactionNumber: 42 })).toBe('42');
    expect(extractTransactionRef({ TranNumber: '99' })).toBe('99');
    expect(extractTransactionRef({ data: { Id: 'abc' } })).toBe('abc');
    expect(extractTransactionRef('  TXN-7 ')).toBe('TXN-7');
    expect(extractTransactionRef(1234)).toBe('1234');
    expect(extractTransactionRef(null)).toBeNull();
    expect(extractTransactionRef({ ok: true })).toBeNull();
  });
});
