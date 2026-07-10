import { describe, expect, it } from 'vitest';
import { sendHeartbeat } from '../src/alerts.js';

describe('sendHeartbeat', () => {
  async function target(url: string, ok: boolean): Promise<string> {
    let captured = '';
    await sendHeartbeat(url, ok, 'run-1', (async (u: RequestInfo | URL) => {
      captured = String(u);
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch);
    return captured;
  }

  it('pings the plain URL on success', async () => {
    expect(await target('https://hc-ping.com/abc/mewsy-daily', true)).toBe('https://hc-ping.com/abc/mewsy-daily');
  });

  it('appends /fail to the PATH, preserving any query string', async () => {
    // Regression: naive string append produced ...?create=1/fail — a fail
    // ping that registered as a healthy success.
    expect(await target('https://hc-ping.com/abc/mewsy-daily?create=1', false)).toBe(
      'https://hc-ping.com/abc/mewsy-daily/fail?create=1',
    );
    expect(await target('https://hc-ping.com/abc/mewsy-daily/', false)).toBe('https://hc-ping.com/abc/mewsy-daily/fail');
    expect(await target('https://hc-ping.com/abc', false)).toBe('https://hc-ping.com/abc/fail');
  });
});
