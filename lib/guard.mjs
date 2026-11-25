/**
 * Data protection for bots, in the spirit of dsh-bot: a bot may work in its
 * workspace, but it may not read or write DeepSeek Harness' own data
 * (the bots' store, the tickets, the credentials, the profiles).
 *
 * A guard sees every tool call before it runs: returning a string refuses the
 * call with that reason, returning undefined lets it through.
 *
 * The `dataAccess` setting decides how strict the guard is:
 *   'none'  — no read and no write of data files (default)
 *   'read'  — read-only tools (read/glob/grep) may look at data files, so a
 *             dispatcher can diagnose a broken one; writes and shell stay shut
 *   'write' — the guard steps aside completely
 *
 * @module dsh-hive/lib/guard
 */

import { homedir } from 'node:os';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

/** True when `child` is `parent` itself or sits below it. */
const under = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** `~`, `~/x` and `~\x` mean the home directory. */
const expand = (value) => String(value).trim().replace(/^~(?=[\\/]|$)/, homedir());

/** Fields that carry a path in Harness tools. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'source', 'destination', 'src', 'dst', 'from', 'to', 'cwd', 'directory', 'dir', 'image_path'];

/** Tools that only read; under `dataAccess: 'read'` these may touch a data file. */
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'working_directory']);

/** Tools that run a command line. */
const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'shell', 'exec']);

/**
 * Whether one path is off limits.
 * @param {unknown} raw the path a tool was given
 * @param {{ home: string[], allow: string[], base?: string }} scope protected roots, the workspace that stays open, and what a relative path is taken from
 */
export function isProtectedPath(raw, { home, allow, base }) {
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const p = expand(raw);
  // A relative path names a file in the directory the tool opens it from: the bot's
  // workspace, not this process's own working directory (which is Harness' home).
  const abs = normalize(isAbsolute(p) ? resolve(p) : resolve(base || process.cwd(), p));
  if (allow.some((a) => a && under(abs, normalize(resolve(expand(a)))))) return false;
  return home.some((h) => h && under(abs, normalize(resolve(h))));
}

/**
 * The reason a call is refused, or undefined.
 * @param {{ name?: string, arguments?: Record<string, unknown> }} call
 * @param {{ home: string[], allow: string[], mode?: 'none'|'read'|'write', label?: string, base?: string }} scope
 */
export function protectionReason(call, { home, allow, mode = 'none', label = '工作区', base }) {
  if (mode === 'write') return undefined;
  const name = call?.name;
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  const workspace = allow.find((a) => a) ?? label;
  // Where a relative path in a tool call is taken from: the bot's workspace.
  const from = base || allow.find((a) => a) || process.cwd();
  // Read-only tools may look at data files when the setting says so (diagnosing a broken
  // file is the one legitimate reason), but never write through them.
  if (mode === 'read' && READ_TOOLS.has(name)) return undefined;

  for (const key of PATH_KEYS) {
    const value = args[key];
    if (isProtectedPath(value, { home, allow, base: from })) {
      if (mode === 'read') {
        return `Refused: ${String(value)} 在 DeepSeek Harness 的数据目录里。当前数据保护是“只读”档：bot 可以读数据文件，但不能修改它；需要修改请在设置里把数据保护改为“放开”。`;
      }
      return `Refused: ${String(value)} 在 DeepSeek Harness 的数据目录里。bot 只能读写自己的工作区（${workspace}）；数据文件（bots.json、tickets、凭据、profile）不对 bot 开放。`;
    }
  }

  if (COMMAND_TOOLS.has(name)) {
    const command = String(args.command ?? '');
    const lower = command.toLowerCase();
    for (const root of home) {
      if (!root) continue;
      const variants = new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]);
      for (const variant of variants) {
        if (variant && lower.includes(variant.toLowerCase())) {
          if (mode === 'read') {
            return `Refused: 命令里出现了 Harness 数据目录（${root}）。当前数据保护是“只读”档：bot 可以读数据文件，但不能通过命令修改它。`;
          }
          return `Refused: 命令里出现了 Harness 数据目录（${root}）。bot 只能用工作区（${workspace}）里的文件；数据目录不对 bot 开放。`;
        }
      }
    }
  }

  return undefined;
}

/** Tools that write a file. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit', 'notebook_edit']);

/**
 * Commands that reach past the workspace: they delete, format, push, publish or send data out.
 * A read-only command (`git status`, `npm view`) stays quiet: asking about everything teaches
 * people to approve without reading.
 */
const RISKY = [
  /\brm\s+-[a-z]*[rf]/i,
  /\bdel\s+(\/|-[rf])/i,
  /\b(rmdir|rd)\s+\/s/i,
  /\bRemove-Item\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\b(shutdown|reboot|Restart-Computer)\b/i,
  /\breg\s+delete\b/i,
  /\b(takeown|icacls)\b/i,
  /\bgit\s+push\b/i,
  /\bnpm\s+(publish|unpublish)\b/i,
  /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b[^\n]*(-X\s*POST|--data|-d\s|--upload-file|-F\s|-T\s|-Method\s+(Post|Put|Patch)|-Body\b|-InFile\b)/i,
  /\b(ssh|scp|sftp|rsync)\b/i,
];

/**
 * The reason a call needs the person's go-ahead first (`approval: 'ask'`), or undefined.
 *
 * Only two things ask: a write outside the workspace, and a command that deletes, formats,
 * pushes, publishes or sends data out. Everything else — reading, searching, a write in the
 * workspace, `git status` — runs without a word, or the setting would be noise.
 *
 * @param {{ name?: string, arguments?: Record<string, unknown> }} call
 * @param {{ workspace?: string, base?: string }} scope
 */
export function approvalReason(call, { workspace, base } = {}) {
  const name = call?.name;
  const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (WRITE_TOOLS.has(name)) {
    const raw = PATH_KEYS.map((k) => args[k]).find((v) => typeof v === 'string' && v.trim() !== '');
    if (!raw) return undefined;
    const p = expand(raw);
    const abs = normalize(isAbsolute(p) ? resolve(p) : resolve(base || workspace || process.cwd(), p));
    if (workspace && !under(abs, normalize(resolve(expand(workspace))))) {
      return `这次要写 ${abs}，在工作区（${workspace}）之外`;
    }
    return undefined;
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = String(args.command ?? '');
    for (const re of RISKY) {
      if (re.test(command)) return `这条命令会删除、上传或改动机器（${command.trim().slice(0, 140)}）`;
    }
  }
  return undefined;
}