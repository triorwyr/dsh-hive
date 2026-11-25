/**
 * One writer per data directory.
 *
 * Two DeepSeek Harness windows can be pointed at the same `cache/bots`: both would load the
 * same JSON, both would write it back, and the last one to save would quietly undo the other's
 * work. So the first process to start takes `owner.lock`; a later one sees a live pid there and
 * runs read-only instead, which its panel says out loud.
 *
 * The lock is a file, so it outlives a crash: a pid that no longer answers is taken over.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/** Whether `pid` is a process this machine still runs (EPERM means alive, just not ours to signal). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * `createLock(file, { now, pid, host })` → `{ take, release, read, file }`.
 * `take()` gives `{ ok: true }` or `{ ok: false, by }` with the holder's record.
 */
export function createLock(file, { now = Date.now, pid = process.pid, host = '' } = {}) {
  const read = () => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  };
  const take = () => {
    const held = read();
    if (held && Number(held.pid) !== pid && alive(Number(held.pid))) return { ok: false, by: held };
    try {
      writeFileSync(file, JSON.stringify({ pid, at: now(), host }));
    } catch {
      // A directory we cannot write is not a directory we can run on either; let it through.
    }
    return { ok: true };
  };
  const release = () => {
    const held = read();
    if (held && Number(held.pid) !== pid) return;
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
  return { take, release, read, file };
}