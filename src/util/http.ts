/**
 * HTTP helper with two distinct behaviours:
 *
 * - Reads (Mews fetches) are idempotent: retry freely on network errors,
 *   429 and 5xx with exponential backoff.
 * - The journal POST is money-moving and its outcome can be AMBIGUOUS: a
 *   timeout, connection reset or 5xx may mean Sage already accepted the
 *   journal. Those must never be silently retried — the caller records an
 *   UNKNOWN outcome and a human (or a Sage read-back) resolves it.
 */

export type FetchFn = typeof globalThis.fetch;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
    this.name = 'HttpError';
  }
}

/**
 * A write failed in a way where the server may or may not have applied it.
 * `sent` distinguishes "request possibly processed" from "definitely not sent"
 * (e.g. connection refused / DNS failure before any bytes were exchanged).
 */
export class AmbiguousWriteError extends Error {
  constructor(
    message: string,
    public readonly cause_: unknown,
  ) {
    super(message);
    this.name = 'AmbiguousWriteError';
  }
}

export interface JsonRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Retries for idempotent requests. Use 0 for non-idempotent writes. */
  retries?: number;
  fetchFn?: FetchFn;
}

const DEFAULT_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the failure guarantees the request never reached the server. */
function definitelyNotSent(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (err as { code?: string })?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

async function rawJsonRequest(url: string, opts: JsonRequestOptions): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: opts.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return text; // some endpoints return plain text (e.g. a transaction number)
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Idempotent JSON request with retry/backoff on 429/5xx/network errors. */
export async function idempotentJsonRequest(url: string, opts: JsonRequestOptions): Promise<unknown> {
  const retries = opts.retries ?? 4;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await rawJsonRequest(url, opts);
    } catch (err) {
      lastError = err;
      const retryable =
        !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      if (!retryable || attempt === retries) throw err;
      const backoffMs = 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

export type WriteOutcome =
  | { kind: 'ok'; response: unknown }
  | { kind: 'rejected'; status: number; body: string } // definite 4xx: not applied
  | { kind: 'failed_not_sent'; error: string }; // definitely never reached the server

/**
 * Non-idempotent write. Returns a definite outcome where one is knowable and
 * throws AmbiguousWriteError where the server may have applied the write
 * (timeout, reset, 5xx). Never retries.
 */
export async function nonIdempotentWrite(url: string, opts: JsonRequestOptions): Promise<WriteOutcome> {
  try {
    const response = await rawJsonRequest(url, { ...opts, retries: 0 });
    return { kind: 'ok', response };
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status >= 400 && err.status < 500) {
        return { kind: 'rejected', status: err.status, body: err.body };
      }
      // 5xx: the server saw the request; it may or may not have written.
      throw new AmbiguousWriteError(`Server error ${err.status} — journal may or may not be in Sage`, err);
    }
    if (definitelyNotSent(err)) {
      return { kind: 'failed_not_sent', error: String(err) };
    }
    throw new AmbiguousWriteError(
      `Network failure after the request may have been sent — journal may or may not be in Sage: ${String(err)}`,
      err,
    );
  }
}
