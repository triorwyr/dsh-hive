/**
 * The files a task touched (Phase 2): every `write`/`edit` a bot makes while it
 * works on a ticket is recorded here, so the task's page can list what it produced.
 *
 * A convenience store, like the message timeline: a write that fails is ignored,
 * and the panel stats each path again to say whether it is still there.
 *
 * @module dsh-hive/lib/taskfiles
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** At most this many files kept per task, and this many tasks kept overall. */
const MAX_PER_TASK = 200;
const MAX_TASKS = 500;

/**
 * @param {string} dir the bots' data directory (`cache/bots`)
 * @param {{now?: () => number}} [options]
 */
export function createTaskFiles(dir, { now = Date.now } = {}) {
  const file = join(dir, 'task-files.json');
  /** @type {{version: 1, tasks: Record<string, object[]>}|null} */
  let data = null;

  const load = () => {
    if (data) return data;
    data = { version: 1, tasks: {} };
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && raw.tasks && typeof raw.tasks === 'object') data = raw;
    } catch {
      // A missing or unreadable file starts fresh; it is only a convenience.
    }
    return data;
  };

  const write = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, file);
    } catch {
      // The list is a convenience.
    }
  };

  return {
    /** Note one file a task wrote (again): the latest time and a write count. */
    record(ticketId, { path, tool = '', botId = '' } = {}) {
      if (!ticketId || typeof path !== 'string' || path.trim() === '') return null;
      const d = load();
      const list = d.tasks[ticketId] ?? (d.tasks[ticketId] = []);
      const abs = path.trim();
      const at = now();
      let found = list.find((x) => x.path === abs);
      if (found) {
        found.at = at;
        found.writes = (Number(found.writes) || 1) + 1;
        if (tool) found.tool = tool;
        if (botId) found.botId = botId;
      } else {
        found = { path: abs, tool, botId, at, writes: 1 };
        list.push(found);
      }
      if (list.length > MAX_PER_TASK) list.splice(0, list.length - MAX_PER_TASK);
      const ids = Object.keys(d.tasks);
      if (ids.length > MAX_TASKS) {
        ids.sort((a, b) => (d.tasks[a].at(-1)?.at ?? 0) - (d.tasks[b].at(-1)?.at ?? 0));
        for (const id of ids.slice(0, ids.length - MAX_TASKS)) delete d.tasks[id];
      }
      write();
      return found;
    },
    /** The files recorded for a task, oldest first (a copy). */
    list(ticketId) {
      return [...(load().tasks[ticketId] ?? [])];
    },
    /** Forget a task's files (when it is pruned). */
    drop(ticketId) {
      const d = load();
      if (d.tasks[ticketId]) {
        delete d.tasks[ticketId];
        write();
      }
    },
  };
}
