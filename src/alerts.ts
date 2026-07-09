import type { Store } from './store/store.js';
import { logger } from './util/logger.js';

export type AlertSeverity = 'info' | 'warn' | 'error';

export interface AlertContext {
  propertyCode?: string;
  businessDate?: string;
  detail?: Record<string, unknown>;
  /** Posting-ledger row the alert is about, when there is one. */
  ledgerRowId?: number;
  /** The literal command that fixes it, e.g. "mewsy resolve --id 7 --outcome posted|failed". */
  remediation?: string;
}

/**
 * Alerting (spec §8.3: "No silent failure"). Every alert is:
 *  1. logged,
 *  2. written to the append-only audit log,
 *  3. POSTed to the optional webhook (best-effort; a webhook failure is
 *     logged but never fails the pipeline).
 *
 * The webhook payload is deliberately generic and structured (response
 * §1/D4a): severity, alertType, property, businessDate, ledgerRowId and the
 * literal remediation command. Rendering belongs in the receiver — for
 * Microsoft Teams that is a Workflows (Power Automate) flow triggered by
 * "When a Teams webhook request is received" (Teams incoming webhooks were
 * retired in May 2026); the `text` field keeps Slack incoming webhooks
 * working as-is. Severity separation: route 'error' (UNKNOWN / date-blocked)
 * to a named person; 'warn' to the channel.
 */
export class Alerter {
  constructor(
    private readonly store: Store,
    private readonly runId: string,
    private readonly webhookUrl?: string,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(severity: AlertSeverity, event: string, message: string, ctx: AlertContext = {}): Promise<void> {
    const scope = [ctx.propertyCode, ctx.businessDate].filter(Boolean).join(' ');
    const line = scope ? `[${scope}] ${message}` : message;
    if (severity === 'error') logger.error(line);
    else if (severity === 'warn') logger.warn(line);
    else logger.info(line);

    this.store.audit(
      this.runId,
      `ALERT_${event}`,
      { severity, message, ledgerRowId: ctx.ledgerRowId ?? null, remediation: ctx.remediation ?? null, ...(ctx.detail ?? {}) },
      ctx.propertyCode,
      ctx.businessDate,
    );

    if (this.webhookUrl) {
      try {
        const res = await this.fetchFn(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: `[mewsy ${severity}] ${line}`, // Slack-renderable convenience
            service: 'mewsy',
            runId: this.runId,
            severity,
            alertType: event,
            propertyCode: ctx.propertyCode ?? null,
            businessDate: ctx.businessDate ?? null,
            ledgerRowId: ctx.ledgerRowId ?? null,
            remediation: ctx.remediation ?? null,
            message,
            detail: ctx.detail ?? {},
          }),
        });
        if (!res.ok) {
          logger.warn(`Alert webhook returned HTTP ${res.status} — alert "${event}" may not have been delivered`);
        }
      } catch (err) {
        logger.warn(`Alert webhook delivery failed: ${String(err)}`);
      }
    }
  }
}

/**
 * Dead-man's switch ping (response §1/D4a — the highest-priority alerting
 * gap): every completed run pings the monitor URL; a run that completed with
 * problems pings `<url>/fail` (healthchecks.io convention). A crashed or
 * never-started run pings nothing — the external monitor alerts on the
 * MISSING ping, so a dead box is never indistinguishable from a healthy one.
 */
export async function sendHeartbeat(
  url: string,
  ok: boolean,
  runId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const target = ok ? url : `${url.replace(/\/+$/, '')}/fail`;
  try {
    const res = await fetchFn(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'mewsy', runId, ok }),
    });
    if (!res.ok) logger.warn(`Heartbeat ping returned HTTP ${res.status} (${target})`);
  } catch (err) {
    logger.warn(`Heartbeat ping failed: ${String(err)} (${target})`);
  }
}
