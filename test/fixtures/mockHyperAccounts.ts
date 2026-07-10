import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * In-process mock of the HyperAccounts REST API, faithful to the vendor API
 * reference (see docs/DECISIONS-RESPONSE.md §2):
 *
 *   POST /api/journal              — vendor response shape verbatim (incl.
 *                                    typos); returns NO transaction number
 *   POST /api/search/auditHeaders  — filter-array search over posted journals
 *   POST /api/searchSplit          — line-level search by headerNumber
 *   GET  <anything>                — 200 (reachability probe)
 *
 * Beyond happy paths it acts as a CONTRACT GUARD: it rejects journals that
 * violate the documented field limits (details ≤30, invRef ≤30, nominal ≤8,
 * deptNumber ≤2, type ∈ {15,16}, dd/mm/yyyy date) or that do not balance
 * (Σ JD net+tax = Σ JC net+tax) — so a regression in Mewsy's payload
 * construction fails the integration tests here before it could fail in Sage.
 *
 * Note: duplicate invRefs are ACCEPTED (real behaviour unverified — G2);
 * Mewsy must not rely on server-side rejection for idempotency.
 */

export interface MockJournalRecord {
  date: string;
  invRef: string;
  accountRef: string;
  splits: Array<{
    details: string;
    nominalCode: string;
    netAmount: number;
    taxAmount: number;
    taxCode: number;
    type: number;
    deptNumber?: string;
    extraRef?: string;
  }>;
  tranNumber: number;
}

export type MockFailureMode =
  | 'none'
  | 'server-error' // 500 on /api/journal → client must treat as ambiguous
  | 'blackhole'; // never responds → client timeout (ambiguous)

export interface MockHyperAccounts {
  baseUrl: string;
  authToken: string;
  /** Everything "in Sage", searchable via the audit endpoints. */
  journals: MockJournalRecord[];
  state: {
    failureMode: MockFailureMode;
    /**
     * When a 'server-error'/'blackhole' post fails, did the journal land in
     * Sage anyway? Drives the ambiguous-outcome recovery tests.
     */
    ambiguousLands: boolean;
    /** Search endpoints return 500 (read-back down → UNKNOWN freeze path). */
    searchDown: boolean;
    /** Reference data served by /api/nominal/ and /api/taxCode — mutable per test. */
    nominals: Array<{ accountRef: string; name: string; type: number; balance: number; inactiveFlag: number }>;
    taxCodes: Array<{ index: number; description: string; rate: number }>;
    companyName: string;
  };
  close(): Promise<void>;
}

/** Default Irish-flavoured reference data matching config/mewsy.example.json. */
function defaultReferenceData() {
  return {
    nominals: ['1100', '1200', '1210', '1215', '2205', '4000', '4001', '4002', '9998', '9999'].map((ref) => ({
      accountRef: ref,
      name: `Nominal ${ref}`,
      type: 1,
      balance: 0,
      inactiveFlag: 0,
    })),
    taxCodes: [
      { index: 0, description: 'Zero rated', rate: 0 },
      { index: 1, description: 'Standard rate', rate: 23 },
      { index: 2, description: 'Exempt transactions', rate: 0 },
      { index: 3, description: 'Reduced rate', rate: 13.5 },
      { index: 5, description: 'Second reduced rate', rate: 9 },
      { index: 9, description: 'Non-Vatable Tax Code', rate: 0 },
    ],
    companyName: 'MOCK SANDBOX CO',
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Vendor rejection shape: 2xx transport with success:false is also real — use HTTP 200 here. */
function vendorReject(res: ServerResponse, message: string): void {
  json(res, 200, { success: false, code: 422, response: 0, message });
}

function validateJournal(journal: Omit<MockJournalRecord, 'tranNumber'>): string | null {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(journal.date ?? '')) return `date ${JSON.stringify(journal.date)} is not dd/mm/yyyy`;
  if (typeof journal.invRef !== 'string' || journal.invRef.length === 0 || journal.invRef.length > 30) {
    return 'invRef missing or exceeds 30 chars';
  }
  if (!Array.isArray(journal.splits) || journal.splits.length === 0) return 'splits missing';
  let debits = 0;
  let credits = 0;
  for (const split of journal.splits) {
    if (typeof split.details !== 'string' || split.details.length > 30) return `split details exceeds 30 chars: ${JSON.stringify(split.details)}`;
    if (typeof split.nominalCode !== 'string' || split.nominalCode.length === 0 || split.nominalCode.length > 8) return 'split nominalCode missing or exceeds 8 chars';
    if (split.type !== 15 && split.type !== 16) return `split type must be 15 (JD) or 16 (JC), got ${split.type}`;
    if (typeof split.netAmount !== 'number' || typeof split.taxAmount !== 'number' || split.netAmount < 0 || split.taxAmount < 0) {
      return 'split amounts must be non-negative numbers (sign is carried by type)';
    }
    if (split.deptNumber !== undefined && String(split.deptNumber).length > 2) return 'split deptNumber exceeds 2 chars';
    if (split.extraRef !== undefined && String(split.extraRef).length > 30) return 'split extraRef exceeds 30 chars';
    if (split.type === 15) debits += split.netAmount + split.taxAmount;
    else credits += split.netAmount + split.taxAmount;
  }
  if (Math.abs(debits - credits) > 0.005) return `journal does not balance: JD ${debits.toFixed(2)} vs JC ${credits.toFixed(2)}`;
  return null;
}

type Filter = { field: string; type: string; value: unknown };

export async function startMockHyperAccounts(authToken = 'mock-ha-token'): Promise<MockHyperAccounts> {
  const journals: MockJournalRecord[] = [];
  const state: MockHyperAccounts['state'] = {
    failureMode: 'none',
    ambiguousLands: false,
    searchDown: false,
    ...defaultReferenceData(),
  };
  let tranCounter = 90000;
  const sockets = new Set<Socket>();

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = req.url ?? '';

    if (req.method === 'GET') {
      // Reference endpoints (vendor API reference shapes) — authenticated.
      if (url.startsWith('/api/') && req.headers['authtoken'] !== authToken) {
        return json(res, 401, { success: false, code: 401, message: 'invalid AuthToken' });
      }
      if (url === '/api/status') {
        return json(res, 200, {
          success: true,
          code: 200,
          response: { apiVersion: '1.23.0.0', sageVersion: '31.1', companyName: state.companyName, sdoStatusOk: true, odbcStatusOk: true },
          message: '',
        });
      }
      if (url === '/api/taxCode') return json(res, 200, { results: state.taxCodes });
      if (url === '/api/nominal/' || url === '/api/nominal') return json(res, 200, { results: state.nominals });
      return json(res, 200, { ok: true }); // probe
    }
    if (req.headers['authtoken'] !== authToken) return json(res, 401, { success: false, code: 401, message: 'invalid AuthToken' });

    let parsed: unknown;
    try {
      parsed = body.trim() === '' ? null : JSON.parse(body);
    } catch {
      return json(res, 400, { success: false, code: 400, message: 'malformed JSON' });
    }

    if (url === '/api/journal' && req.method === 'POST') {
      const journal = parsed as Omit<MockJournalRecord, 'tranNumber'>;
      if (state.failureMode !== 'none') {
        if (state.ambiguousLands) {
          tranCounter++;
          journals.push({ ...journal, tranNumber: tranCounter });
        }
        if (state.failureMode === 'blackhole') return; // hold the socket — client times out
        return json(res, 500, { success: false, code: 500, message: 'internal server error' });
      }
      const violation = validateJournal(journal);
      if (violation) return vendorReject(res, violation);
      tranCounter++;
      journals.push({ ...journal, tranNumber: tranCounter });
      // Verbatim vendor response, typos included; no transaction number (G1).
      return json(res, 200, { success: true, code: 200, response: 0, message: 'Journal entried posted succesfully' });
    }

    if (url === '/api/search/auditHeaders' && req.method === 'POST') {
      if (state.searchDown) return json(res, 500, { success: false, code: 500, message: 'search unavailable' });
      const filters = (parsed ?? []) as Filter[];
      // Accept both the camelCase response name and the likely Sage column name.
      const invRef = filters.find((f) => f.field === 'invRef' || f.field === 'INV_REF')?.value;
      const matches = journals
        .map((j, index) => ({ j, headerNumber: index + 1 }))
        .filter(({ j }) => invRef === undefined || j.invRef === invRef)
        .map(({ j, headerNumber }) => {
          const net = j.splits.filter((s) => s.type === 15).reduce((sum, s) => sum + s.netAmount, 0);
          const tax = j.splits.filter((s) => s.type === 15).reduce((sum, s) => sum + s.taxAmount, 0);
          return {
            invRef: j.invRef,
            tranNumber: j.tranNumber,
            headerNumber,
            date: j.date,
            accountRef: j.accountRef,
            details: j.splits[0]?.details ?? '',
            netAmount: net,
            taxAmount: tax,
            grossAmount: net + tax,
            outstanding: 0,
          };
        });
      return json(res, 200, matches);
    }

    if (url === '/api/searchSplit' && req.method === 'POST') {
      if (state.searchDown) return json(res, 500, { success: false, code: 500, message: 'search unavailable' });
      const filters = (parsed ?? []) as Filter[];
      const headerNumber = Number(filters.find((f) => f.field === 'headerNumber')?.value);
      const journal = journals[headerNumber - 1];
      if (!journal) return json(res, 200, []);
      return json(
        res,
        200,
        journal.splits.map((s) => ({
          nominalCode: s.nominalCode,
          netAmount: s.netAmount,
          taxAmount: s.taxAmount,
          type: s.type,
          headerNumber,
        })),
      );
    }

    return json(res, 404, { success: false, code: 404, message: `no route for ${req.method} ${url}` });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    authToken,
    journals,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy(); // frees blackholed requests
        server.close((err) => {
          // Idempotent: a second close (test + afterEach) is not an error.
          if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
          else resolve();
        });
      }),
  };
}
