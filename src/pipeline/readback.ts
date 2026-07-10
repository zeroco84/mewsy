import type {
  AuditHeader,
  AuditSplit,
  HyperAccountsJournal,
  JournalPostResult,
  SearchFilter,
} from '../hyperaccounts/client.js';
import type { JournalLine } from '../domain/journal.js';
import { decimalFromCents } from '../util/money.js';

/**
 * Sage read-back (G3, response §2): HyperAccounts exposes searches over
 * Sage's AUDIT_HEADER / AUDIT_SPLIT tables, which turns guesses into checks:
 *
 *  - before posting, an invRef already present in Sage means a previous
 *    attempt landed (or a resolve was mistaken) — never post it again;
 *  - an ambiguous journal POST is resolved by searching for its invRef
 *    (found ⇒ POSTED, absent ⇒ safe retry; freeze only if the search
 *    itself is down);
 *  - reconciliation verifies what is actually IN Sage — including that each
 *    Mewsy invRef appears EXACTLY ONCE (the server accepts duplicates, G2,
 *    so a duplicate is a double-post and must surface as a variance).
 *
 * All search failures surface as 'unavailable', never as 'absent' — a false
 * absent would authorise a repost.
 */

/** What the pipeline needs from a Sage-posting client (HyperAccountsClient satisfies this). */
export interface SagePoster {
  postJournal(journal: HyperAccountsJournal): Promise<JournalPostResult>;
  findJournalsByInvRef(invRef: string, field?: string): Promise<AuditHeader[]>;
  searchSplits(filters: SearchFilter[]): Promise<AuditSplit[]>;
}

export interface ReadbackConfig {
  enabled: boolean;
  invRefField: string;
  splitLinkField: string;
  compareSplits: boolean;
}

export type SagePresence =
  | { kind: 'present'; count: number; tranNumber: string | null }
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: string };

/** Is a journal with this invRef in Sage right now? */
export async function checkPresenceInSage(
  ha: SagePoster,
  invRef: string,
  readback: ReadbackConfig,
): Promise<SagePresence> {
  if (!readback.enabled) return { kind: 'unavailable', error: 'read-back disabled in config' };
  try {
    const headers = await ha.findJournalsByInvRef(invRef, readback.invRefField);
    if (headers.length === 0) return { kind: 'absent' };
    return { kind: 'present', count: headers.length, tranNumber: tranNumberOf(headers[0]!) };
  } catch (err) {
    return { kind: 'unavailable', error: String(err instanceof Error ? err.message : err) };
  }
}

export type AmbiguousResolution =
  | { kind: 'posted'; tranNumber: string | null }
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: string };

/** After an ambiguous write outcome: is the journal actually in Sage? */
export async function resolveAmbiguousOutcome(
  ha: SagePoster,
  invRef: string,
  readback: ReadbackConfig,
): Promise<AmbiguousResolution> {
  const presence = await checkPresenceInSage(ha, invRef, readback);
  if (presence.kind === 'present') return { kind: 'posted', tranNumber: presence.tranNumber };
  return presence;
}

/** Best-effort tranNumber capture after a successful post (G1: the POST response carries none). */
export async function lookupTranNumber(
  ha: SagePoster,
  invRef: string,
  readback: ReadbackConfig,
): Promise<string | null> {
  const presence = await checkPresenceInSage(ha, invRef, readback);
  return presence.kind === 'present' ? presence.tranNumber : null;
}

function tranNumberOf(header: AuditHeader): string | null {
  return header.tranNumber === undefined || header.tranNumber === null ? null : String(header.tranNumber);
}

export type SageVerification =
  | { kind: 'verified'; detail: string }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'unavailable'; detail: string };

/**
 * Verify posted journals exist in Sage EXACTLY ONCE and (optionally) that
 * their splits match the ledger's lines. Split comparison uses per-nominal
 * sums of absolute net/tax so it is insensitive to the audit table's sign
 * conventions; rows without the expected fields degrade to header-only
 * verification rather than false-alarming.
 */
export async function verifyInSage(
  ha: SagePoster,
  postedJournals: Array<{ invRef: string; lines: JournalLine[] }>,
  readback: ReadbackConfig,
): Promise<SageVerification> {
  if (!readback.enabled) return { kind: 'unavailable', detail: 'read-back disabled in config' };
  try {
    let comparedSplits = 0;
    for (const journal of postedJournals) {
      const headers = await ha.findJournalsByInvRef(journal.invRef, readback.invRefField);
      if (headers.length === 0) {
        return { kind: 'mismatch', detail: `Sage read-back: journal ${journal.invRef} not found in AUDIT_HEADER` };
      }
      if (headers.length > 1) {
        // Mewsy invRefs are unique by construction; two headers = double-post.
        return {
          kind: 'mismatch',
          detail: `Sage read-back: invRef ${journal.invRef} appears ${headers.length} times in AUDIT_HEADER — duplicate posting in Sage (tranNumbers ${headers.map((h) => h.tranNumber ?? '?').join(', ')})`,
        };
      }
      const header = headers[0]!;
      if (!readback.compareSplits || header.headerNumber === undefined || header.headerNumber === null) continue;

      const splits = await ha.searchSplits([{ field: readback.splitLinkField, type: 'eq', value: header.headerNumber }]);
      const usable = splits.filter((s) => typeof s.nominalCode === 'string' && typeof s.netAmount === 'number');
      if (splits.length === 0 || usable.length !== splits.length) continue; // shape not as expected — header check only

      const sage = new Map<string, { net: number; tax: number }>();
      for (const s of usable) {
        const cur = sage.get(s.nominalCode!) ?? { net: 0, tax: 0 };
        cur.net += Math.abs(s.netAmount!);
        cur.tax += Math.abs(typeof s.taxAmount === 'number' ? s.taxAmount : 0);
        sage.set(s.nominalCode!, cur);
      }
      const ours = new Map<string, { net: number; tax: number }>();
      for (const l of journal.lines) {
        const cur = ours.get(l.nominalCode) ?? { net: 0, tax: 0 };
        cur.net += Math.abs(decimalFromCents(l.netCents));
        cur.tax += Math.abs(decimalFromCents(l.taxCents));
        ours.set(l.nominalCode, cur);
      }
      for (const key of new Set([...sage.keys(), ...ours.keys()])) {
        const a = sage.get(key) ?? { net: 0, tax: 0 };
        const b = ours.get(key) ?? { net: 0, tax: 0 };
        if (Math.abs(a.net - b.net) > 0.005 || Math.abs(a.tax - b.tax) > 0.005) {
          return {
            kind: 'mismatch',
            detail: `Sage read-back: splits of ${journal.invRef} differ on nominal ${key} (Sage net ${a.net.toFixed(2)}/tax ${a.tax.toFixed(2)} vs ledger ${b.net.toFixed(2)}/${b.tax.toFixed(2)})`,
          };
        }
      }
      comparedSplits++;
    }
    return {
      kind: 'verified',
      detail: `verified in Sage via read-back (${postedJournals.length} journal(s)${comparedSplits > 0 ? `, ${comparedSplits} split-compared` : ''})`,
    };
  } catch (err) {
    return { kind: 'unavailable', detail: `Sage read-back unavailable (${String(err instanceof Error ? err.message : err)})` };
  }
}
