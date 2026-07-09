import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Single-process lock (response §4): "single scheduled run" holds right up
 * until someone runs `mewsy run` by hand while investigating an alert. The
 * ledger's check-then-post is not atomic across processes, so mutating
 * commands take an exclusive lock file next to the database.
 *
 * Stale locks (crashed process) are detected by probing the recorded pid
 * and reclaimed automatically.
 */
export function acquireLock(path: string, label: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, label, acquiredAtUtc: new Date().toISOString() }), {
        flag: 'wx',
      });
      const release = () => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder: { pid?: number; label?: string; acquiredAtUtc?: string } = {};
      try {
        holder = JSON.parse(readFileSync(path, 'utf8')) as typeof holder;
      } catch {
        /* corrupt lock file — treat as stale */
      }
      if (holder.pid && pidAlive(holder.pid)) {
        throw new Error(
          `Another mewsy process holds the lock (${holder.label ?? 'unknown command'}, pid ${holder.pid}, since ${holder.acquiredAtUtc ?? '?'}). ` +
            `Wait for it to finish; if that process is dead, delete ${path}.`,
        );
      }
      try {
        unlinkSync(path); // stale — reclaim and retry once
      } catch {
        /* raced with another reclaimer */
      }
    }
  }
  throw new Error(`Could not acquire lock at ${path}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; anything else (ESRCH) = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
