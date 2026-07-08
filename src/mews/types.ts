/**
 * Minimal Mews Connector API shapes — only the fields Mewsy reads.
 * Field names follow the Mews Connector API (PascalCase).
 */

export interface MewsTaxValue {
  /** Mews tax code, e.g. "IE-R1" — the key into config taxCodeMap. */
  Code: string;
  /** Tax amount in the item currency. */
  Value: number;
}

export interface MewsAmount {
  Currency: string;
  NetValue: number;
  GrossValue: number;
  TaxValues: MewsTaxValue[];
}

export interface MewsEnterprise {
  Id: string;
  Name?: string;
  TimeZoneIdentifier?: string;
  /** ISO 8601 duration, e.g. "P1D" — the accounting editable-history window. */
  EditableHistoryInterval?: string;
  DefaultLanguageCode?: string;
}

export interface MewsConfigurationResponse {
  Enterprise?: MewsEnterprise;
  [key: string]: unknown;
}

export interface MewsAccountingCategory {
  Id: string;
  IsActive: boolean;
  Name?: string | null;
  Code?: string | null;
  Classification?: string | null;
  LedgerAccountCode?: string | null;
  PostingAccountCode?: string | null;
  CostCenterCode?: string | null;
}

export interface MewsOrderItem {
  Id: string;
  AccountingCategoryId?: string | null;
  Amount: MewsAmount;
  AccountingState: string;
  ClosedUtc?: string | null;
  ConsumedUtc?: string | null;
  Type?: string | null;
  Name?: string | null;
  BillId?: string | null;
}

export interface MewsPayment {
  Id: string;
  AccountingCategoryId?: string | null;
  Amount: MewsAmount;
  AccountingState: string;
  State?: string | null;
  ClosedUtc?: string | null;
  Type?: string | null;
  BillId?: string | null;
  Data?: { Discriminator?: string | null } | null;
}

export interface MewsDayData {
  orderItems: MewsOrderItem[];
  payments: MewsPayment[];
}
