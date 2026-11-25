import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackups } from '../lib/backup.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bots-backup-'));
  writeFileSync(join(dir, 'bots.json'), '{"bots":[1]}');
  writeFileSync(join(dir, 'settings.json'), '{"approval":"ask"}');
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'note.md'), '记得这件事');
  return dir;
}

test('快照打包 JSON 文件与 memory 目录', () => {
  const dir = setup();
  try {
    const backups = createBackups(dir, { now: () => 1000 });
    const meta = backups.snapshot('manual');
    assert.ok(meta?.id);
    assert.equal(meta.files.length, 2);
    assert.deepEqual(meta.dirs.map((d) => d.name), ['memory']);
    assert.ok(existsSync(join(dir, 'backups', meta.id, 'bots.json')));
    assert.ok(existsSync(join(dir, 'backups', meta.id, 'memory', 'note.md')));
    assert.equal(backups.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复快照把被改坏的文件放回去', () => {
  const dir = setup();
  try {
    const backups = createBackups(dir, { now: () => 2000 });
    const meta = backups.snapshot('manual');
    writeFileSync(join(dir, 'bots.json'), '改坏了');
    writeFileSync(join(dir, 'memory', 'note.md'), '也改坏了');
    const out = backups.restore(meta.id);
    assert.equal(out.ok, true);
    assert.equal(readFileSync(join(dir, 'bots.json'), 'utf8'), '{"bots":[1]}');
    assert.equal(readFileSync(join(dir, 'memory', 'note.md'), 'utf8'), '记得这件事');
    // 恢复前会自己再拍一份，避免恢复动作本身丢失现状
    assert.equal(backups.list()[0].reason, 'before-restore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一天最多拍一次启动快照', () => {
  const dir = setup();
  try {
    let clock = Date.UTC(2026, 10, 25, 1, 0, 0);
    const backups = createBackups(dir, { now: () => clock });
    const first = backups.snapshotOnceToday('startup');
    assert.ok(first?.id);
    clock += 3600_000;
    const second = backups.snapshotOnceToday('startup');
    assert.equal(second.id, first.id, '同一天再启动不重复占用额度');
    assert.equal(backups.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工作区只在开关打开时才进快照', () => {
  const dir = setup();
  const ws = mkdtempSync(join(tmpdir(), 'dsh-bots-ws-'));
  try {
    writeFileSync(join(ws, 'out.txt'), '产出');
    const backups = createBackups(dir, { now: () => 3000 });
    const plain = backups.snapshot('manual');
    assert.deepEqual(plain.dirs.map((d) => d.name), ['memory']);

    const withWs = backups.snapshot('manual', { workspace: true, workspaceDir: ws });
    assert.deepEqual(withWs.dirs.map((d) => d.name).sort(), ['memory', 'workspace']);
    assert.ok(existsSync(join(dir, 'backups', withWs.id, 'workspace', 'out.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('只保留最近 7 份快照', () => {
  const dir = setup();
  try {
    let clock = 5000;
    const backups = createBackups(dir, { now: () => (clock += 1) });
    for (let i = 0; i < 10; i += 1) backups.snapshot(`manual-${i}`);
    const list = backups.list();
    assert.equal(list.length, 7);
    assert.equal(list[0].reason, 'manual-9');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});