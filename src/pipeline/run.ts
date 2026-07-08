import { DateTime } from 'luxon';
import type { Alerter } from '../alerts.js';
import type { MewsyConfig, PropertyConfig } from '../config.js';
import { requireEnv } from '../config.js';
import { HyperAccountsClient } from '../hyperaccounts/client.js';
import { MewsClient } from '../mews/client.js';
import type { MewsAccountingCategory } from '../mews/types.js';
import type { Store } from '../store/store.js';
import {
  businessDateRange,
  currentBusinessDate,
  latestEligibleBusinessDate,
  nextDay,
  previousDay,
} from '../util/dates.js';
import { editableWindowDays } from '../util/duration.js';
import { logger } from '../util/logger.js';
import {
  processDate,
  type DateOutcome,
  type JournalPoster,
  type MewsDataSource,
} from './processDate.js';

/**
 * The daily loop (spec §4): determine eligible dates per property from the
 * watermark and the posting delay, process them chronologically, and advance
 * the watermark only on success. A property stops at its first failed date so
 * postings always land in order; other properties continue.
 */

export interface RunOptions {
  mode: 'post' | 'dry-run';
  /** Restrict to specific property codes (default: all). */
  onlyProperties?: string[];
  /** Explicit single date or range; default: watermark+1 .. latest eligible. */
  date?: string;
  from?: string;
  to?: string;
  now?: DateTime;
  /** Injectable factories for tests. */
  mewsFactory?: (property: PropertyConfig) => MewsDataSource;
  haFactory?: (property: PropertyConfig) => JournalPoster;
}

export interface PropertyRunSummary {
  propertyCode: string;
  delayDays: number;
  latestEligible: string;
  outcomes: DateOutcome[];
  stoppedEarly: boolean;
  error?: string;
}

export interface RunSummary {
  runId: string;
  mode: 'post' | 'dry-run';
  properties: PropertyRunSummary[];
}

function defaultMewsFactory(config: MewsyConfig) {
  return (property: PropertyConfig): MewsDataSource =>
    new MewsClient({
      baseUrl: process.env['MEWS_BASE_URL'] ?? config.mews.baseUrl,
      clientToken: requireEnv(config.mews.clientTokenEnv),
      accessToken: requireEnv(property.mewsAccessTokenEnv),
      clientName: config.mews.clientName,
    });
}

function defaultHaFactory() {
  return (property: PropertyConfig): JournalPoster =>
    new HyperAccountsClient({
      baseUrl: property.hyperAccounts.baseUrl,
      authToken: requireEnv(property.hyperAccounts.authTokenEnv),
    });
}

/** Posting delay = editable-history window + 1 day (spec §6), unless overridden. */
export async function resolvePostingDelay(
  property: PropertyConfig,
  mews: MewsDataSource,
): Promise<{ delayDays: number; source: string; mewsTimezone?: string }> {
  if (property.postingDelayDays !== null) {
    return { delayDays: property.postingDelayDays, source: 'config override' };
  }
  const conf = await mews.getConfiguration();
  const interval = conf.Enterprise?.EditableHistoryInterval;
  if (!interval) {
    throw new Error(
      `Mews configuration for ${property.code} has no EditableHistoryInterval — set postingDelayDays in config or confirm the Mews setting (spec §6)`,
    );
  }
  return {
    delayDays: editableWindowDays(interval) + 1,
    source: `Mews EditableHistoryInterval ${interval} + 1`,
    mewsTimezone: conf.Enterprise?.TimeZoneIdentifier,
  };
}

export async function runPipeline(
  config: MewsyConfig,
  store: Store,
  alert: Alerter,
  runId: string,
  options: RunOptions,
): Promise<RunSummary> {
  const now = options.now ?? DateTime.utc();
  const mewsFactory = options.mewsFactory ?? defaultMewsFactory(config);
  const haFactory = options.haFactory ?? defaultHaFactory();

  const selected = config.properties.filter(
    (p) => !options.onlyProperties || options.onlyProperties.includes(p.code),
  );
  if (options.onlyProperties) {
    for (const code of options.onlyProperties) {
      if (!config.properties.some((p) => p.code === code)) {
        throw new Error(`Unknown property code ${code} (configured: ${config.properties.map((p) => p.code).join(', ')})`);
      }
    }
  }

  const summary: RunSummary = { runId, mode: options.mode, properties: [] };

  for (const property of selected) {
    const propSummary: PropertyRunSummary = {
      propertyCode: property.code,
      delayDays: 0,
      latestEligible: '',
      outcomes: [],
      stoppedEarly: false,
    };
    summary.properties.push(propSummary);

    try {
      const mews = mewsFactory(property);
      const delay = await resolvePostingDelay(property, mews);
      propSummary.delayDays = delay.delayDays;
      if (delay.mewsTimezone && delay.mewsTimezone !== property.timezone) {
        await alert.send(
          'warn',
          'TIMEZONE_MISMATCH',
          `Config timezone ${property.timezone} differs from Mews TimeZoneIdentifier ${delay.mewsTimezone} — confirm the end-of-day boundary (spec §6)`,
          { propertyCode: property.code },
        );
      }

      const latestEligible = latestEligibleBusinessDate(now, property.timezone, property.endOfDayMinutes, delay.delayDays);
      propSummary.latestEligible = latestEligible;

      // Which dates? Explicit dates are validated against eligibility —
      // never post a date Mews can still change (spec §6).
      let dates: string[];
      if (options.date) {
        dates = [options.date];
      } else if (options.from || options.to) {
        const from = options.from ?? (store.getWatermark(property.code) ? nextDay(store.getWatermark(property.code)!) : property.startDate);
        const to = options.to ?? latestEligible;
        dates = businessDateRange(from, to);
      } else {
        const watermark = store.getWatermark(property.code);
        const from = watermark ? nextDay(watermark) : property.startDate;
        dates = from > latestEligible ? [] : businessDateRange(from, latestEligible);
      }

      const ineligible = dates.filter((d) => d > latestEligible);
      if (ineligible.length > 0) {
        if (options.mode === 'post') {
          throw new Error(
            `Date(s) ${ineligible.join(', ')} are inside the Mews editable-history window (latest eligible: ${latestEligible}) — refusing to post (spec §6)`,
          );
        }
        logger.warn(
          `[${property.code}] Date(s) ${ineligible.join(', ')} are not yet final in Mews (latest eligible ${latestEligible}) — dry-run figures may still change`,
        );
      }

      if (dates.length > property.maxCatchupDays) {
        await alert.send(
          'warn',
          'CATCHUP_TRUNCATED',
          `${dates.length} dates pending but maxCatchupDays=${property.maxCatchupDays} — processing the oldest ${property.maxCatchupDays}, re-run to continue`,
          { propertyCode: property.code },
        );
        dates = dates.slice(0, property.maxCatchupDays);
      }

      if (dates.length === 0) {
        logger.info(`[${property.code}] Nothing to do — watermark ${store.getWatermark(property.code) ?? '(none)'} , latest eligible ${latestEligible}`);
        continue;
      }

      logger.info(
        `[${property.code}] Processing ${dates.length} date(s) ${dates[0]}..${dates[dates.length - 1]} (delay ${delay.delayDays}d from ${delay.source}, mode ${options.mode})`,
      );

      const categories = await mews.getAccountingCategories();
      const categoriesById = new Map<string, MewsAccountingCategory>(categories.map((c) => [c.Id, c]));
      const ha = options.mode === 'post' ? haFactory(property) : null;
      const detectionDate = currentBusinessDate(now, property.timezone, property.endOfDayMinutes);

      for (const businessDate of dates) {
        const outcome = await processDate(property, businessDate, options.mode, {
          mews,
          ha,
          store,
          alert,
          runId,
          categoriesById,
          detectionDate,
        });
        propSummary.outcomes.push(outcome);
        store.audit(runId, 'DATE_OUTCOME', { outcome: outcome.kind }, property.code, businessDate);

        if (outcome.advanceWatermark && options.mode === 'post') {
          // The watermark may only advance contiguously: an explicit
          // --date/--from run ahead of watermark+1 must not skip over
          // never-posted dates (they would silently vanish from all future
          // scheduled runs). Out-of-order posts succeed but hold the
          // watermark; the scheduled run catches the gap up and passes the
          // already-posted date via SKIPPED_SAME.
          const watermark = store.getWatermark(property.code);
          const expectedNext = watermark ? nextDay(watermark) : property.startDate;
          if (businessDate === expectedNext) {
            store.advanceWatermark(property.code, businessDate);
          } else if (watermark === null || businessDate > watermark) {
            store.audit(runId, 'WATERMARK_HELD', { businessDate, watermark, expectedNext }, property.code, businessDate);
            await alert.send(
              'warn',
              'WATERMARK_HELD',
              `Posted ${businessDate} ahead of the watermark (${watermark ?? 'none'}) — dates ${expectedNext}..${previousDay(businessDate)} are still unposted; the next scheduled run will catch them up`,
              { propertyCode: property.code, businessDate },
            );
          }
        }
        // §4 step 7: only advance on success; keep postings strictly ordered.
        if (!outcome.advanceWatermark && options.mode === 'post') {
          propSummary.stoppedEarly = true;
          logger.warn(`[${property.code}] Stopping at ${businessDate} (${outcome.kind}) — later dates deferred to keep postings ordered`);
          break;
        }
      }
    } catch (err) {
      propSummary.error = String(err instanceof Error ? err.message : err);
      store.audit(runId, 'PROPERTY_RUN_ERROR', { error: propSummary.error }, property.code);
      await alert.send('error', 'RUN_ERROR', `Run failed for ${property.code}: ${propSummary.error}`, {
        propertyCode: property.code,
      });
    }
  }

  return summary;
}
