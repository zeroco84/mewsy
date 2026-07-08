export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, message: string, detail?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : '';
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${message}${suffix}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (m: string, d?: Record<string, unknown>) => log('debug', m, d),
  info: (m: string, d?: Record<string, unknown>) => log('info', m, d),
  warn: (m: string, d?: Record<string, unknown>) => log('warn', m, d),
  error: (m: string, d?: Record<string, unknown>) => log('error', m, d),
};
