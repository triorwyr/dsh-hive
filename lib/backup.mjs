/**
 * 数据快照：把 cache/bots 下的数据文件（以及 memory 目录）复制进 backups/<id>/，保留最近几份。
 * 恢复前会自动再拍一份，避免“恢复错了没得退”。
 * 工作区文件按设置决定是否一起备份（默认不备：它可能很大，且产出物通常另有去处）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 值得快照的数据文件：存在哪个就复制哪个。 */
export const BACKUP_FILES = [
  'bots.json',
  'tickets.json',
  'settings.json',
  'needs.json',
  'discussions.json',
  'topics.json',
  'task-files.json',
  'messages.jsonl',
  'tasks.jsonl',
  'usage.jsonl',
];

/** 目录：memory 总是跟着走（不可重建），workspace 由设置决定。 */
const ALWAYS_DIRS = ['memory'];
const WORKSPACE_DIR = 'workspace';

/** 最多保留几份快照；dsh-bot 用的是 7。 */
const MAX_SNAPSHOTS = 7;
/** 单个工作区文件超过这个大小就跳过，快照不该被一个视频撑爆。 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** 工作区一次快照的总量上限。 */
const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024;

/** 递归复制一棵目录，返回复制到的字节数与跳过项。 */
function copyTree(src, dst, budget) {
  let bytes = 0;
  const skipped = [];
  const walk = (from, to) => {
    let items = [];
    try {
      items = readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    try {
      mkdirSync(to, { recursive: true });
    } catch {
      return;
    }
    for (const item of items) {
      const a = join(from, item.name);
      const b = join(to, item.name);
      if (item.isDirectory()) {
        walk(a, b);
        continue;
      }
      let size = 0;
      try {
        size = statSync(a).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        skipped.push(`${item.name} (too large)`);
        continue;
      }
      if (budget > 0 && bytes + size > budget) {
        skipped.push(`${item.name} (over budget)`);
        continue;
      }
      try {
        copyFileSync(a, b);
        bytes += size;
      } catch {}
    }
  };
  walk(src, dst);
  return { bytes, skipped };
}

export function createBackups(dir, { now = Date.now } = {}) {
  const root = join(dir, 'backups');
  const indexFile = join(root, 'index.json');

  const readIndex = () => {
    try {
      const raw = JSON.parse(readFileSync(indexFile, 'utf8'));
      return Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === 'string') : [];
    } catch {
      return [];
    }
  };

  const writeIndex = (list) => {
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(indexFile, JSON.stringify(list, null, 2));
    } catch {}
  };

  /**
   * 拍一份快照。`opts.workspace` 为真时连工作区一起复制；`opts.workspaceDir` 是它的路径。
   * `reason` 记在元数据里，方便以后看是为什么拍的。
   */
  const snapshot = (reason = 'manual', opts = {}) => {
    const at = now();
    const id = `bk-${at}-${Math.random().toString(36).slice(2, 6)}`;
    const folder = join(root, id);
    try {
      mkdirSync(folder, { recursive: true });
      const files = [];
      for (const name of BACKUP_FILES) {
        const src = join(dir, name);
        if (!existsSync(src)) continue;
        copyFileSync(src, join(folder, name));
        files.push({ name, size: statSync(src).size });
      }
      const dirs = [];
      for (const name of ALWAYS_DIRS) {
        const src = join(dir, name);
        if (!existsSync(src)) continue;
        const r = copyTree(src, join(folder, name), 0);
        dirs.push({ name, bytes: r.bytes, skipped: r.skipped.length });
      }
      if (opts.workspace && typeof opts.workspaceDir === 'string' && opts.workspaceDir && existsSync(opts.workspaceDir)) {
        const r = copyTree(opts.workspaceDir, join(folder, WORKSPACE_DIR), MAX_WORKSPACE_BYTES);
        dirs.push({ name: WORKSPACE_DIR, bytes: r.bytes, skipped: r.skipped.length });
      }
      const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0) + dirs.reduce((sum, d) => sum + (d.bytes ?? 0), 0);
      const meta = { id, at, reason, files, dirs, bytes };
      writeFileSync(join(folder, 'meta.json'), JSON.stringify(meta, null, 2));
      const list = [meta, ...readIndex()];
      for (const old of list.slice(MAX_SNAPSHOTS)) {
        try {
          rmSync(join(root, old.id), { recursive: true, force: true });
        } catch {}
      }
      writeIndex(list.slice(0, MAX_SNAPSHOTS));
      return meta;
    } catch {
      return undefined;
    }
  };

  /** 今天已经拍过就跳过（启动时用，避免每重启一次就吃掉一份额度）。 */
  const snapshotOnceToday = (reason = 'startup', opts = {}) => {
    const list = readIndex();
    const day = (t) => {
      try {
        return new Date(t).toISOString().slice(0, 10);
      } catch {
        return '';
      }
    };
    if (list[0] && day(list[0].at) === day(now())) return list[0];
    return snapshot(reason, opts);
  };

  const list = () =>
    readIndex().map((x) => ({
      id: x.id,
      at: x.at,
      reason: x.reason,
      bytes: x.bytes ?? (x.files ?? []).reduce((sum, f) => sum + (f.size ?? 0), 0),
      files: (x.files ?? []).length,
      dirs: (x.dirs ?? []).map((d) => d.name),
    }));

  /** 把一份快照放回去：文件、memory、工作区（如果当时存了）。 */
  const restore = (id, opts = {}) => {
    const meta = readIndex().find((x) => x.id === id);
    if (!meta) return { ok: false, error: 'not-found' };
    const folder = join(root, id);
    if (!existsSync(folder)) return { ok: false, error: 'missing' };
    snapshot('before-restore', opts);
    const restored = [];
    for (const f of meta.files ?? []) {
      const src = join(folder, f.name);
      if (!existsSync(src)) continue;
      try {
        copyFileSync(src, join(dir, f.name));
        restored.push(f.name);
      } catch {}
    }
    for (const d of meta.dirs ?? []) {
      const src = join(folder, d.name);
      if (!existsSync(src)) continue;
      const dst = d.name === WORKSPACE_DIR ? opts.workspaceDir : join(dir, d.name);
      if (typeof dst !== 'string' || !dst) continue;
      try {
        copyTree(src, dst, 0);
        restored.push(`${d.name}/`);
      } catch {}
    }
    return { ok: true, id, restored };
  };

  return { snapshot, snapshotOnceToday, list, restore, root };
}