import { idempotentJsonRequest, type FetchFn } from '../util/http.js';
import type {
  MewsAccountingCategory,
  MewsConfigurationResponse,
  MewsOrderItem,
  MewsPayment,
} from './types.js';

/**
 * Mews Connector API client (spec §4 step 2).
 *
 * Every operation is an HTTPS POST to /api/connector/v1/{resource}/{operation}
 * with ClientToken + AccessToken + Client in the body. The AccessToken selects
 * the property (one AccessToken per Mews enterprise/property).
 *
 * Closed-flow extraction: order items and payments are filtered by ClosedUtc
 * within the business-date window and AccountingStates=["Closed"], which is
 * the programmatic equivalent of the Mews Accounting Report on the Closed type.
 */

export interface MewsClientOptions {
  baseUrl: string;
  clientToken: string;
  accessToken: string;
  clientName: string;
  fetchFn?: FetchFn;
  pageSize?: number;
}

interface UtcInterval {
  startUtc: string;
  endUtc: string;
}

const MAX_PAGES = 200;

export class MewsClient {
  constructor(private readonly opts: MewsClientOptions) {}

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/connector/v1/${path}`;
    const payload = {
      ClientToken: this.opts.clientToken,
      AccessToken: this.opts.accessToken,
      Client: this.opts.clientName,
      ...body,
    };
    return (await idempotentJsonRequest(url, {
      method: 'POST',
      body: payload,
      fetchFn: this.opts.fetchFn,
    })) as T;
  }

  /** Enterprise configuration — timezone and the editable-history window. */
  async getConfiguration(): Promise<MewsConfigurationResponse> {
    return await this.call<MewsConfigurationResponse>('configuration/get', {});
  }

  private async getAllPages<T>(
    path: string,
    body: Record<string, unknown>,
    extract: (response: Record<string, unknown>) => T[] | undefined,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response: Record<string, unknown> =
        (await this.call<Record<string, unknown>>(path, {
          ...body,
          Limitation: { Count: this.opts.pageSize ?? 1000, ...(cursor ? { Cursor: cursor } : {}) },
        })) ?? {};
      const items = extract(response) ?? [];
      out.push(...items);
      cursor = (response['Cursor'] as string | null | undefined) ?? null;
      if (!cursor || items.length === 0) return out;
    }
    throw new Error(`Mews ${path}: exceeded ${MAX_PAGES} pages — refusing to continue (possible cursor loop)`);
  }

  /** All accounting categories (active and inactive — items may reference retired ones). */
  async getAccountingCategories(): Promise<MewsAccountingCategory[]> {
    return await this.getAllPages<MewsAccountingCategory>(
      'accountingCategories/getAll',
      {},
      (r) => r['AccountingCategories'] as MewsAccountingCategory[] | undefined,
    );
  }

  /** Revenue items that closed inside the window (Closed accounting flow). */
  async getClosedOrderItems(interval: UtcInterval): Promise<MewsOrderItem[]> {
    return await this.getAllPages<MewsOrderItem>(
      'orderItems/getAll',
      {
        ClosedUtc: { StartUtc: interval.startUtc, EndUtc: interval.endUtc },
        AccountingStates: ['Closed'],
      },
      (r) => r['OrderItems'] as MewsOrderItem[] | undefined,
    );
  }

  /** Payments that closed inside the window (Closed accounting flow). */
  async getClosedPayments(interval: UtcInterval): Promise<MewsPayment[]> {
    return await this.getAllPages<MewsPayment>(
      'payments/getAll',
      {
        ClosedUtc: { StartUtc: interval.startUtc, EndUtc: interval.endUtc },
        AccountingStates: ['Closed'],
      },
      (r) => r['Payments'] as MewsPayment[] | undefined,
    );
  }
}
