/**
 * Needs (Bots 0.11): what the person asked for, one level above the tasks
 * (tickets) that do the work. A need is one request in the person's own terms
 * ("A comparison of Q3 competitor pricing"); the dispatcher names it when it
 * hands out the work, in the person's language, and every task it opens for that
 * request counts toward it. One need may take several tasks (research split
 * between teammates, then a write-up), and several messages (the request, a
 * change to it, "how is it going?"); a message may also hold two needs.
 *
 * A need stores only what a task does not know: its title, who asked where
 * (`origin`), the person's words (`asks`), its tasks (top-level ones: a
 * sub-task counts through the task that opened it) and whether the person
 * dropped it (`closed`). Its status comes from its tasks' stages
 * ({@link needStatus}); `snapshot` keeps the last one, for when the tasks are
 * pruned.
 *
 * Since 0.12 the panel shows needs as cards on a board, and a person may file one there
 * themselves: with a `description`, under a project (`projectId`, and its `number` there, so it
 * reads `OPC-12`), and either handed out at once or kept in To do (`todo`) until they start it.
 * `closed.outcome: 'done'` marks one done by hand. Since 0.13 a card in To do may wait for others
 * (`after`, need ids) and starts by itself, with `startWith` (a bot; none: the dispatcher), once they
 * are done.
 *
 * `needs.json` under the bots cache holds `{version: 1, needs}`. It is read on
 * first use and written whole through a temp file and a rename; a missing file
 * starts empty, one that is not JSON in the expected shape is set aside as
 * `needs.json.corrupt-<time>` before the first write replaces it.
 *
 * @module dsh-hive/lib/needs
 */

import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NEED_ID_RE = /^n[a-z0-9]{8}$/;
/** What a person sees a need as, most pressing first; `todo`: filed on the board, not handed out yet (0.12). */
export const NEED_STATUSES = ['waiting', 'working', 'failed', 'done', 'stopped', 'todo'];
/** Longest title, in characters. */
export const MAX_NEED_TITLE = 80;
/** Longest description of a card filed on the board, in characters. */
export const MAX_DESCRIPTION = 20_000;
/** Most cards one card may wait for (0.13). */
export const MAX_AFTER = 10;
const PROJECT_ID_RE = /^pj[a-z0-9]{8}$/;
/** Longest piece of the person's words one need keeps. */
export const MAX_ASK = 2000;
/** The person's messages one need keeps; past this the oldest go (the first, the request itself, stays). */
export const KEEP_ASKS = 20;
/** Settled needs `prune` keeps by default. */
export const KEEP_SETTLED = 500;

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `n` and 8 random lowercase letters and digits. */
export function newNeedId() {
  let id = 'n';
  for (let i = 0; i < 8; i += 1) id += ALNUM[randomInt(ALNUM.length)];
  return id;
}

/** One line of at most `max` characters (code points); a cut one ends with `…`. */
export function clampNeedTitle(text, max = MAX_NEED_TITLE) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

function normalizeAsk(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = str(raw.text, MAX_ASK).trim();
  if (!text) return null;
  return {
    ...(typeof raw.id === 'string' && raw.id ? { id: raw.id.slice(0, 200) } : {}),
    at: time(raw.at),
    text,
    ...(typeof raw.via === 'string' && raw.via ? { via: raw.via.slice(0, 40) } : {}),
    ...(typeof raw.who === 'string' && raw.who ? { who: raw.who.slice(0, 120) } : {}),
  };
}

function normalizeOrigin(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    ...(typeof o.threadKey === 'string' && o.threadKey ? { threadKey: o.threadKey.slice(0, 500) } : {}),
    ...(typeof o.via === 'string' && o.via ? { via: o.via.slice(0, 40) } : {}),
    ...(typeof o.who === 'string' && o.who ? { who: o.who.slice(0, 120) } : {}),
  };
}

const SNAPSHOT_KEYS = ['status', 'done', 'total', 'failed', 'stalled'];

/**
 * `links` as stored: `{kind: 'github', ref: 'owner/repo#12', url}` (`host/owner/repo#12` on GitHub
 * Enterprise, 0.16), at most 10; undefined for none.
 */
function linksOf(raw) {
  const links = (Array.isArray(raw.links) ? raw.links : [])
    .filter((l) => l && l.kind === 'github' && /^(?:[a-z0-9.-]+(?::\d{1,5})?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(String(l.ref ?? '')))
    .map((l) => ({ kind: 'github', ref: String(l.ref), ...(typeof l.url === 'string' && /^https?:\/\/[^\s/]+\/\S+$/.test(l.url) ? { url: l.url.slice(0, 300) } : {}) }))
    .slice(0, 10);
  return { links: links.length ? links : undefined };
}

/** `after` (need ids, not its own, at most MAX_AFTER) and `startWith` (a bot id) as stored, or undefined. */
function afterFields(raw) {
  const after = [...new Set((Array.isArray(raw.after) ? raw.after : []).filter((id) => NEED_ID_RE.test(String(id)) && id !== raw.id))].slice(0, MAX_AFTER);
  const startWith = typeof raw.startWith === 'string' && raw.startWith.trim() ? raw.startWith.trim().slice(0, 100) : '';
  return { after: after.length ? after : undefined, startWith: startWith || undefined };
}

/** A stored need in its known shape, unknown fields kept; null when it is not one. */
export function normalizeNeed(raw) {
  if (!raw || typeof raw !== 'object' || !NEED_ID_RE.test(String(raw.id ?? ''))) return null;
  const title = clampNeedTitle(raw.title);
  if (!title) return null;
  const asks = (Array.isArray(raw.asks) ? raw.asks : []).map(normalizeAsk).filter(Boolean);
  const tickets = [...new Set((Array.isArray(raw.tickets) ? raw.tickets : []).filter((t) => typeof t === 'string' && t))];
  const createdAt = time(raw.createdAt) || Date.now();
  const snap = raw.snapshot && typeof raw.snapshot === 'object' && NEED_STATUSES.includes(raw.snapshot.status) ? raw.snapshot : null;
  return {
    ...raw,
    id: raw.id,
    title,
    ...(raw.auto === true ? { auto: true } : { auto: undefined }),
    botId: typeof raw.botId === 'string' ? raw.botId : '',
    origin: normalizeOrigin(raw.origin),
    asks,
    tickets,
    createdAt,
    updatedAt: time(raw.updatedAt) || createdAt,
    ...(raw.closed && typeof raw.closed === 'object'
      ? { closed: { at: time(raw.closed.at) || createdAt, by: raw.closed.by === 'user' ? 'user' : 'dispatcher', ...(raw.closed.outcome === 'done' ? { outcome: 'done' } : {}) } }
      : { closed: undefined }),
    // Filed under a project with its number there (0.12); a number only counts with its project.
    ...(PROJECT_ID_RE.test(String(raw.projectId ?? '')) && Number.isInteger(raw.number) && raw.number > 0 ? { projectId: raw.projectId, number: raw.number } : { projectId: undefined, number: undefined }),
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.slice(0, MAX_DESCRIPTION).trim() } : { description: undefined }),
    ...(raw.todo === true ? { todo: true } : { todo: undefined }),
    // Cards it waits for, and who takes it when they are done (0.13).
    ...afterFields(raw),
    // Where it lives outside Bots too: a GitHub issue (0.14).
    ...linksOf(raw),
    ...(NEED_ID_RE.test(String(raw.mergedInto ?? '')) ? { mergedInto: raw.mergedInto } : { mergedInto: undefined }),
    ...(snap ? { snapshot: Object.fromEntries([...SNAPSHOT_KEYS.map((k) => [k, k === 'status' ? snap.status : Math.max(0, Math.round(Number(snap[k]) || 0))]), ['at', time(snap.at)]]) } : { snapshot: undefined }),
  };
}

/**
 * How far a need got, from its tasks (the top-level ones it lists, as stored; missing ones are left
 * out). `stageOf` is lib/tickets.mjs's. The first row that matches wins:
 *
 * | status    | when                                                                  |
 * | --------- | --------------------------------------------------------------------- |
 * | `done`    | the person (or the dispatcher) marked it done (`closed.outcome`)      |
 * | `stopped` | the person (or the dispatcher, for them) dropped it                   |
 * | `todo`    | filed on the board to start later, and no task yet                    |
 * | `waiting` | a task asks a question, or is blocked, and nobody answered yet        |
 * | `working` | a task is open (queued, working, stalled)                             |
 * | `done`    | every task ended, and at least one is done                            |
 * | `failed`  | every task ended, none done, one failed                               |
 * | `stopped` | every task ended stopped                                              |
 *
 * With no task found (all pruned), the stored `snapshot` stands, else it is `working`.
 * `failed` and `stalled` count tasks in those stages, so an open need can say "one failed".
 * @param {object} need
 * @param {object[]} tasks - its tickets, as found
 * @param {(t: object) => string} stageOf
 */
export function needStatus(need, tasks, stageOf) {
  const list = (Array.isArray(tasks) ? tasks : []).filter(Boolean);
  const stages = list.map((t) => ({ t, stage: stageOf(t) }));
  const count = (s) => stages.filter((x) => x.stage === s).length;
  const done = count('done');
  const failed = stages.filter((x) => x.stage === 'failed' && x.t.ended).length;
  const stalled = count('stalled');
  const waiting = stages.filter((x) => x.stage === 'question' || (x.stage === 'failed' && !x.t.ended));
  const open = stages.filter((x) => !x.t.ended);
  let status;
  if (need?.closed) status = need.closed.outcome === 'done' ? 'done' : 'stopped';
  else if (list.length === 0 && need?.todo && !need?.tickets?.length) status = 'todo';
  else if (list.length === 0) status = need?.snapshot?.status ?? 'working';
  else if (waiting.length) status = 'waiting';
  else if (open.length) status = 'working';
  else if (done) status = 'done';
  else if (failed) status = 'failed';
  else status = 'stopped';
  const total = list.length || need?.snapshot?.total || 0;
  const endedAt = list.length && open.length === 0 ? Math.max(...list.map((t) => time(t.ended?.at))) : 0;
  return {
    status,
    done: list.length ? done : (need?.snapshot?.done ?? 0),
    total,
    failed,
    stalled,
    ...(endedAt ? { endedAt } : {}),
    // The tasks waiting for the person, so the board can say what they are asked.
    waiting: waiting.map((x) => x.t.id),
  };
}

/**
 * The needs file under `dir`. Writes go through at once; `onChange(fn)` hears each one.
 * @param {string} dir
 * @param {{now?: () => number}} [opts]
 */
export function createNeeds(dir, { now = Date.now } = {}) {
  const file = join(dir, 'needs.json');
  /** @type {{version: 1, needs: object[]}|null} */
  let data = null;
  const byId = new Map();
  const byTicket = new Map();
  const listeners = new Set();

  const setAside = () => {
    try {
      let to = `${file}.corrupt-${now()}`;
      for (let n = 1; existsSync(to); n += 1) to = `${file}.corrupt-${now()}-${n}`;
      renameSync(file, to);
    } catch {
      // It goes when the next write replaces it.
    }
  };

  const index = (n) => {
    byId.set(n.id, n);
    if (!n.mergedInto) for (const t of n.tickets) byTicket.set(t, n.id);
  };

  const load = () => {
    if (data) return data;
    let parsed = null;
    let text = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`cannot read ${file} (${error?.code ?? error?.message ?? error}); fix or move it, needs are not loaded until then`, { cause: error });
    }
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.needs)) {
        parsed = null;
        setAside();
      }
    }
    data = { version: 1, needs: [] };
    for (const raw of parsed?.needs ?? []) {
      const n = normalizeNeed(raw);
      if (!n || byId.has(n.id)) continue;
      data.needs.push(n);
      index(n);
    }
    return data;
  };

  const save = () => {
    try {
      mkdirSync(dir, { recursive: true });
      // A need quotes what the person said: readable by this user only.
      writeFileSync(`${file}.tmp`, JSON.stringify(data, (k, v) => (v === undefined ? undefined : v)), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      // Kept in memory; the next write tries again.
    }
  };

  const changed = (need) => {
    save();
    for (const fn of listeners) {
      try {
        fn(need);
      } catch {
        // A listener must not break a write.
      }
    }
  };

  /** The need, following merges to the one that took it. */
  const find = (id) => {
    load();
    let n = byId.get(String(id ?? '').trim().replace(/^need\//, ''));
    for (let hops = 0; n?.mergedInto && hops < 8; hops += 1) n = byId.get(n.mergedInto) ?? n;
    return n?.mergedInto ? undefined : n;
  };

  const addAsksTo = (n, asks) => {
    let added = false;
    for (const raw of asks ?? []) {
      const a = normalizeAsk(raw);
      if (!a) continue;
      if (a.id ? n.asks.some((x) => x.id === a.id) : n.asks.some((x) => x.text === a.text && x.at === a.at)) continue;
      n.asks.push(a);
      added = true;
    }
    if (n.asks.length > KEEP_ASKS) n.asks = [n.asks[0], ...n.asks.slice(-(KEEP_ASKS - 1))];
    return added;
  };

  return {
    /** Every need not merged away, newest first. */
    list() {
      load();
      return data.needs.filter((n) => !n.mergedInto).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get: (id) => find(id),

    /** The need a top-level ticket counts toward, if any. */
    byTicket(ticketId) {
      load();
      const id = byTicket.get(String(ticketId ?? ''));
      return id ? find(id) : undefined;
    },

    /**
     * A new need. `title` is the request restated for the person; `auto` marks one the dispatcher did
     * not name (its title is the person's own words, clipped).
     * @param {{title: string, botId?: string, origin?: object, asks?: object[], tickets?: string[], auto?: boolean}} p
     */
    create({ title, botId = '', origin = {}, asks = [], tickets = [], auto = false, projectId, number, description, todo = false, after, startWith, links }) {
      load();
      const at = now();
      let id = newNeedId();
      while (byId.has(id)) id = newNeedId();
      const n = normalizeNeed({ id, title, botId, origin, asks, tickets, createdAt: at, updatedAt: at, ...(auto ? { auto: true } : {}), projectId, number, description, ...(todo ? { todo: true } : {}), after, startWith, links });
      if (!n) throw new Error('a need needs a title');
      data.needs.push(n);
      index(n);
      changed(n);
      return n;
    },

    /** Count a (top-level) ticket toward a need, with the person's words that came with it. */
    addTicket(id, ticketId, asks = []) {
      const n = find(id);
      if (!n) return undefined;
      const prev = byTicket.get(ticketId);
      if (prev && prev !== n.id) {
        const other = byId.get(prev);
        if (other) other.tickets = other.tickets.filter((t) => t !== ticketId);
      }
      if (!n.tickets.includes(ticketId)) n.tickets.push(ticketId);
      byTicket.set(ticketId, n.id);
      addAsksTo(n, asks);
      // Work handed out again makes a dropped (or done) need live again, and a card in To do started.
      n.closed = undefined;
      n.todo = undefined;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /** The person said more about a need (a change, a follow-up): their words join it. */
    addAsks(id, asks) {
      const n = find(id);
      if (!n || !addAsksTo(n, asks)) return n;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    rename(id, title) {
      const n = find(id);
      const next = clampNeedTitle(title);
      if (!n || !next) return undefined;
      n.title = next;
      n.auto = undefined;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /** `id`'s tasks and words go to `into`; `id` is then only a pointer to it. */
    merge(id, into) {
      const from = find(id);
      const to = find(into);
      if (!from || !to || from.id === to.id) return undefined;
      for (const t of from.tickets) {
        if (!to.tickets.includes(t)) to.tickets.push(t);
        byTicket.set(t, to.id);
      }
      addAsksTo(to, from.asks);
      to.asks.sort((a, b) => a.at - b.at);
      to.createdAt = Math.min(to.createdAt, from.createdAt);
      // Work moved into a card in To do starts it.
      if (to.tickets.length) to.todo = undefined;
      to.updatedAt = now();
      from.mergedInto = to.id;
      from.tickets = [];
      from.updatedAt = now();
      changed(to);
      return to;
    },

    /**
     * The person dropped it (their tasks are stopped by the caller), or, with `outcome: 'done'`,
     * marked it done (their open tasks are closed by the caller). It leaves To do either way.
     */
    close(id, { by = 'dispatcher', outcome } = {}) {
      const n = find(id);
      if (!n) return undefined;
      n.closed = { at: now(), by: by === 'user' ? 'user' : 'dispatcher', ...(outcome === 'done' ? { outcome: 'done' } : {}) };
      n.todo = undefined;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /**
     * Hand a card out (0.12): it leaves To do, and a dropped or done one is live again; `botId`: the
     * dispatcher that takes it now. Its tasks are opened by the caller and counted with `addTicket`.
     */
    start(id, { botId } = {}) {
      const n = find(id);
      if (!n) return undefined;
      if (typeof botId === 'string' && botId) n.botId = botId;
      n.todo = undefined;
      n.closed = undefined;
      // With no task yet, an old status no longer says anything.
      if (!n.tickets.length) n.snapshot = undefined;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /**
     * Put back what `start` changed (`todo`, `closed`, `snapshot`, `botId`, as read before it): a card
     * whose start failed before any task of it opened is left as the person had it.
     */
    restore(id, before = {}) {
      const n = find(id);
      if (!n) return n;
      for (const k of ['todo', 'closed', 'snapshot', 'botId']) n[k] = before[k];
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /**
     * The cards a card waits for (0.13), and who takes it once they are done (`startWith`: a bot id;
     * '' for the dispatcher). An empty `after` waits for none.
     */
    wait(id, { after = [], startWith = '' } = {}) {
      const n = find(id);
      if (!n) return undefined;
      Object.assign(n, afterFields({ id: n.id, after, startWith }));
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /** File a need under a project with its number there, or under none (`projectId` empty). */
    file(id, { projectId = '', number = 0 } = {}) {
      const n = find(id);
      if (!n) return undefined;
      const filed = PROJECT_ID_RE.test(String(projectId)) && Number.isInteger(number) && number > 0;
      n.projectId = filed ? projectId : undefined;
      n.number = filed ? number : undefined;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /** A project went: its needs are filed under none (they keep everything else). Returns how many. */
    unfile(projectId) {
      load();
      let count = 0;
      for (const n of data.needs) {
        if (n.projectId !== projectId) continue;
        n.projectId = undefined;
        n.number = undefined;
        n.updatedAt = now();
        count += 1;
      }
      if (count) changed(null);
      return count;
    },

    /** The card's description: what the person wrote below its title on the board ('' removes it). */
    describe(id, description) {
      const n = find(id);
      if (!n) return undefined;
      const next = String(description ?? '').slice(0, MAX_DESCRIPTION).trim();
      n.description = next || undefined;
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /** Keep the latest status (a write only when it changed). */
    snapshot(id, s) {
      const n = find(id);
      if (!n || !s || !NEED_STATUSES.includes(s.status)) return n;
      const prev = n.snapshot ?? {};
      if (SNAPSHOT_KEYS.every((k) => prev[k] === s[k])) return n;
      n.snapshot = { ...Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, s[k]])), at: now() };
      n.updatedAt = now();
      changed(n);
      return n;
    },

    /**
     * Retention: keep the newest `keepSettled` needs that are done, failed or stopped (by their last
     * change), drop older ones and merged pointers whose target went. Open needs are never dropped.
     */
    prune({ keepSettled = KEEP_SETTLED } = {}) {
      load();
      const settled = data.needs.filter((n) => !n.mergedInto && ['done', 'failed', 'stopped'].includes(n.snapshot?.status ?? (n.closed ? 'stopped' : ''))).sort((a, b) => b.updatedAt - a.updatedAt);
      const drop = new Set(settled.slice(keepSettled).map((n) => n.id));
      for (const n of data.needs) if (n.mergedInto && (drop.has(n.mergedInto) || !byId.has(n.mergedInto))) drop.add(n.id);
      if (drop.size === 0) return 0;
      data.needs = data.needs.filter((n) => !drop.has(n.id));
      byId.clear();
      byTicket.clear();
      for (const n of data.needs) index(n);
      changed(null);
      return drop.size;
    },

    /** `fn(need)` after each write (`null` for a prune). Returns an unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
