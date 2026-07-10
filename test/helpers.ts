import type { PropertyConfig } from '../src/config.js';
import type {
  AuditHeader,
  AuditSplit,
  HyperAccountsJournal,
  JournalPostResult,
  SearchFilter,
} from '../src/hyperaccounts/client.js';
import type {
  MewsAccountingCategory,
  MewsConfigurationResponse,
  MewsOrderItem,
  MewsPayment,
} from '../src/mews/types.js';
import type { MewsDataSource } from '../src/pipeline/processDate.js';
import { Alerter } from '../src/alerts.js';
import { openDb } from '../src/store/db.js';
import { Store } from '../src/store/store.js';
import { AmbiguousWriteError } from '../src/util/http.js';

export function makeProperty(overrides: Partial<PropertyConfig> = {}): PropertyConfig {
  return {
    code: 'PROP1',
    name: 'Test Hotel',
    startDate: '2026-07-01',
    mewsAccessTokenEnv: 'MEWS_ACCESS_TOKEN_PROP1',
    hyperAccounts: {
      baseUrl: 'http://localhost:5000',
      authTokenEnv: 'HA_TOKEN_PROP1',
      readback: { enabled: true, invRefField: 'INV_REF', splitLinkField: 'HEADER_NUMBER', compareSplits: true },
    },
    timezone: 'Europe/Dublin',
    endOfDay: '00:00',
    endOfDayMinutes: 0,
    postingDelayDays: null,
    maxCatchupDays: 31,
    roundingToleranceCents: 2,
    vatWarnToleranceCents: 2,
    vatMismatchPolicy: 'block',
    suspenseMaterialityCents: null,
    suspenseMaterialityPercent: null,
    requireAdjustmentApproval: true,
    adjustmentDating: 'detection',
    ledgerCodeField: 'LedgerAccountCode',
    journalRetries: 0,
    exemptSageTaxCode: 9,
    taxCodeMap: {
      'IE-R1': { sageTaxCode: 3, ratePercent: 13.5, label: 'accommodation' },
      'IE-R2': { sageTaxCode: 5, ratePercent: 9, label: 'food' },
      'IE-S': { sageTaxCode: 1, ratePercent: 23, label: 'standard' },
    },
    clearing: { accountRef: '1200', defaultNominal: '1200', byTender: { Cash: '1210' } },
    suspenseNominal: '2205',
    deptFromCostCenter: false,
    ...overrides,
  };
}

export function makeCategory(
  id: string,
  name: string,
  ledgerAccountCode: string | null,
  extra: Partial<MewsAccountingCategory> = {},
): MewsAccountingCategory {
  return { Id: id, IsActive: true, Name: name, Code: name.slice(0, 4).toUpperCase(), LedgerAccountCode: ledgerAccountCode, ...extra };
}

let itemCounter = 0;

export function makeItem(
  categoryId: string | null,
  net: number,
  taxCode: string | null,
  tax: number,
  extra: Partial<MewsOrderItem> = {},
): MewsOrderItem {
  itemCounter++;
  return {
    Id: `item-${itemCounter}`,
    AccountingCategoryId: categoryId,
    AccountingState: 'Closed',
    ClosedUtc: '2026-07-01T12:00:00Z',
    Amount: {
      Currency: 'EUR',
      NetValue: net,
      GrossValue: net + tax,
      TaxValues: taxCode === null ? [] : [{ Code: taxCode, Value: tax }],
    },
    ...extra,
  };
}

export function makePayment(gross: number, discriminator = 'CreditCard', extra: Partial<MewsPayment> = {}): MewsPayment {
  itemCounter++;
  return {
    Id: `pay-${itemCounter}`,
    AccountingState: 'Closed',
    ClosedUtc: '2026-07-01T12:00:00Z',
    Amount: { Currency: 'EUR', NetValue: gross, GrossValue: gross, TaxValues: [] },
    Data: { Discriminator: discriminator },
    ...extra,
  };
}

/** The worked example from spec §5. */
export function specExampleData() {
  const categories = [
    makeCategory('cat-acc', 'Accommodation', '4000'),
    makeCategory('cat-food', 'Food', '4001'),
    makeCategory('cat-bar', 'Bar', '4002'),
  ];
  const orderItems = [
    makeItem('cat-acc', 9000, 'IE-R1', 1215),
    makeItem('cat-food', 1500, 'IE-R2', 135),
    makeItem('cat-bar', 800, 'IE-S', 184),
  ];
  const payments = [makePayment(12834)];
  return { categories, orderItems, payments };
}

export function categoriesById(categories: MewsAccountingCategory[]): Map<string, MewsAccountingCategory> {
  return new Map(categories.map((c) => [c.Id, c]));
}

export class FakeMews implements MewsDataSource {
  fetchCount = 0;
  constructor(
    public categories: MewsAccountingCategory[],
    public orderItems: MewsOrderItem[],
    public payments: MewsPayment[],
    public editableHistoryInterval = 'P1D',
  ) {}

  async getConfiguration(): Promise<MewsConfigurationResponse> {
    return {
      Enterprise: {
        Id: 'ent-1',
        Name: 'Test Hotel',
        TimeZoneIdentifier: 'Europe/Dublin',
        EditableHistoryInterval: this.editableHistoryInterval,
      },
    };
  }
  async getAccountingCategories(): Promise<MewsAccountingCategory[]> {
    return this.categories;
  }
  async getClosedOrderItems(): Promise<MewsOrderItem[]> {
    this.fetchCount++;
    return this.orderItems;
  }
  async getClosedPayments(): Promise<MewsPayment[]> {
    return this.payments;
  }
}

export type FakeHaMode = 'ok' | 'reject' | 'ambiguous' | 'unreachable';

/**
 * Simulates HyperAccounts including the audit-table read-back: `posted`
 * doubles as the Sage AUDIT_HEADER store, searchable by invRef.
 */
export class FakeHa {
  posted: HyperAccountsJournal[] = [];
  mode: FakeHaMode = 'ok';
  /** 'ok' = searches work over `posted`; 'down' = searches throw. */
  readback: 'ok' | 'down' = 'ok';
  /** When an 'ambiguous' post throws, did the journal actually land in Sage? */
  ambiguousLands = false;

  async postJournal(journal: HyperAccountsJournal): Promise<JournalPostResult> {
    if (this.mode === 'ambiguous') {
      if (this.ambiguousLands) this.posted.push(journal);
      throw new AmbiguousWriteError('timeout — journal may or may not be in Sage', new Error('timeout'));
    }
    if (this.mode === 'reject') {
      return { outcome: { kind: 'rejected', status: 400, body: 'bad journal' }, rawResponse: null };
    }
    if (this.mode === 'unreachable') {
      return { outcome: { kind: 'failed_not_sent', error: 'ECONNREFUSED' }, rawResponse: null };
    }
    this.posted.push(journal);
    // Real /api/journal response shape (G1): no transaction number.
    const body = { success: true, code: 200, response: 0, message: 'Journal entried posted succesfully' };
    return { outcome: { kind: 'ok', response: body }, rawResponse: JSON.stringify(body) };
  }

  async findJournalsByInvRef(invRef: string): Promise<AuditHeader[]> {
    if (this.readback === 'down') throw new Error('audit search unavailable');
    return this.posted
      .map((j, index) => ({ j, index }))
      .filter(({ j }) => j.invRef === invRef)
      .map(({ index }) => ({ invRef, tranNumber: `SAGE-${index + 1}`, headerNumber: index + 1 }));
  }

  async searchSplits(filters: SearchFilter[]): Promise<AuditSplit[]> {
    if (this.readback === 'down') throw new Error('audit search unavailable');
    const headerNumber = Number(filters.find((f) => f.field === 'HEADER_NUMBER')?.value);
    const journal = this.posted[headerNumber - 1];
    if (!journal) return [];
    return journal.splits.map((s) => ({
      nominalCode: s.nominalCode,
      netAmount: s.netAmount,
      taxAmount: s.taxAmount,
      type: s.type === 15 ? 'JD' : 'JC', // live API returns strings
      headerNumber,
    }));
  }
}

export function makeStore(): Store {
  return new Store(openDb(':memory:'));
}

export function makeAlerter(store: Store, runId = 'test-run'): Alerter {
  return new Alerter(store, runId);
}
