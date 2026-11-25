/**
 * An append-only log of what bots did and what the guard did about it.
 *
 * One JSON object per line in `audit.jsonl` under the bots' data directory:
 *
 *   {"at":1732…,"event":"allowed","botId":"bot-…","tool":"write","path":"D:\\…"}
 *   {"at":1732…,"event":"refused","botId":"bot-…","tool":"write","reason":"…"}
 *   {"at":1732…,"event":"needs-approval","botId":"bot-…","tool":"bash","detail":"…"}
 *   {"at":1732…,"event":"approved","botId":"bot-…","by":"user"}
 *
 * Nothing reads it back automatically (a listing is there for the panel and for a person
 * looking into what happened); every write is best-effort, and a failure never stops a bot.
 *
 * @module dsh-hive/lib/audit
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Lines kept before the live file is rotated into `audit-<ts>.jsonl`. */
const MAX_LINES = 20000;
/** Rotated files kept beside it. */
const MAX_FILES = 5;

/**
 * Secrets are scrubbed before a line is written: an audit log has to be safe to read, to send
 * and to keep, and a command that carried a key is exactly the line someone will look at.
 */
const SECRETS = [
  [/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1***'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/\b(token|password|passwd|secret|api[_-]?key|apikey|access[_-]?key)(\s*[=:]\s*)("[^"]{6,}"|'[^']{6,}'|[^\s,;"']{6,})/gi, '$1$2***'],
  [/(--?(?:token|password|passwd|secret|api[_-]?key|api-key)\s+)(\S{6,})/gi, '$1***'],
];

/** Scrub one string; anything else passes through. */
const scrubText = (text) => {
  let out = String(text);
  for (const [re, repl] of SECRETS) out = out.replace(re, repl);
  return out;
};

/** Scrub every string a field carries, so nested details stay safe too. */
const scrub = (value) => {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
};

/**
 * @param {string} dir the bots' data directory
 * @param {{ now?: () => number }} [opts]
 */
export function createAudit(dir, { now = Date.now } = {}) {
  const file = join(dir, 'audit.jsonl');
  let lines = -1;

  const count = () => {
    if (lines >= 0) return lines;
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      lines = 0;
    }
    return lines;
  };

  const rotate = () => {
    try {
      renameSync(file, join(dir, `audit-${now()}.jsonl`));
      lines = 0;
      const old = readdirSync(dir)
        .filter((n) => /^audit-\d+\.jsonl$/.test(n))
        .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(MAX_FILES);
      for (const o of old) {
        try {
          unlinkSync(join(dir, o.n));
        } catch {
          // A file another process holds stays; it goes next time.
        }
      }
    } catch {
      // Rotation is housekeeping: a failure leaves the file growing, nothing else.
    }
  };

  /** Record one event; `fields` are merged into the line. Never throws. */
  const write = (event, fields = {}) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: now(), event, ...scrub(fields) })}\n`, 'utf8');
      lines = count() + 1;
      if (lines > MAX_LINES) rotate();
    } catch {
      // The log is a nicety, not a gate.
    }
  };

  /** The newest `limit` lines, oldest first. */
  const list = (limit = 200) => {
    try {
      const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      return all.slice(-Math.max(1, Math.min(5000, Number(limit) || 200))).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { event: 'unparsed', line };
        }
      });
    } catch {
      return [];
    }
  };

  return { write, list, file };
}