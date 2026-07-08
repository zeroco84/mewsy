import type { Store } from './store/store.js';
import { logger } from './util/logger.js';

export type AlertSeverity = 'info' | 'warn' | 'error';

/**
 * Alerting (spec §8.3: "No silent failure"). Every alert is:
 *  1. logged,
 *  2. written to the append-only audit log,
 *  3. POSTed to the optional webhook (best-effort; a webhook failure is
 *     logged but never fails the pipeline).
 */
export class Alerter {
  constructor(
    private readonly store: Store,
    private readonly runId: string,
    private readonly webhookUrl?: string,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async send(
    severity: AlertSeverity,
    event: string,
    message: string,
    ctx: { propertyCode?: string; businessDate?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    const scope = [ctx.propertyCode, ctx.businessDate].filter(Boolean).join(' ');
    const line = scope ? `[${scope}] ${message}` : message;
    if (severity === 'error') logger.error(line);
    else if (severity === 'warn') logger.warn(line);
    else logger.info(line);

    this.store.audit(
      this.runId,
      `ALERT_${event}`,
      { severity, message, ...(ctx.detail ?? {}) },
      ctx.propertyCode,
      ctx.businessDate,
    );

    if (this.webhookUrl) {
      try {
        const res = await this.fetchFn(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // `text` makes the payload renderable by Slack/Teams incoming
            // webhooks as-is; the structured fields ride alongside.
            text: `[mewsy ${severity}] ${line}`,
            service: 'mewsy',
            runId: this.runId,
            severity,
            event,
            propertyCode: ctx.propertyCode ?? null,
            businessDate: ctx.businessDate ?? null,
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
