import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock } from '../src/util/lock.js';

describe('acquireLock', () => {
  it('grants, blocks a second acquirer, and releases', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mewsy-lock-')), 'db.lock');
    const release = acquireLock(path, 'run');
    expect(() => acquireLock(path, 'run')).toThrow(/holds the lock/);
    release();
    const again = acquireLock(path, 'run');
    again();
  });

  it('reclaims a stale lock left by a dead process', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mewsy-lock-')), 'db.lock');
    // A pid that cannot exist locally (beyond typical pid_max).
    writeFileSync(path, JSON.stringify({ pid: 2 ** 30, label: 'run', acquiredAtUtc: '2026-07-01T00:00:00Z' }));
    const release = acquireLock(path, 'run');
    release();
  });

  it('reclaims a corrupt lock file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mewsy-lock-')), 'db.lock');
    writeFileSync(path, 'not json');
    const release = acquireLock(path, 'run');
    release();
  });
});
