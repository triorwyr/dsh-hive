import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAudit } from '../lib/audit.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'dsh-bots-audit-'));

test('审计日志把密钥打码', () => {
  const d = dir();
  try {
    const audit = createAudit(d);
    audit.write('allowed', {
      botId: 'b1',
      reason: 'sk-abcdef1234567890',
      note: 'password=hunter2',
      header: 'Bearer abc.def.ghi',
      argv: 'tool --token abcdef123456',
      plain: 'nothing secret here',
    });
    const [line] = audit.list(1);
    assert.equal(line.event, 'allowed');
    assert.equal(line.reason, 'sk-abcdef***');
    assert.equal(line.note, 'password=***');
    assert.equal(line.header, 'Bearer ***');
    assert.equal(line.argv, 'tool --token ***');
    assert.equal(line.plain, 'nothing secret here');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('审计日志按追加写入，list 按时间从旧到新', () => {
  const d = dir();
  try {
    const audit = createAudit(d);
    audit.write('first', { n: 1 });
    audit.write('second', { n: 2 });
    const items = audit.list(10);
    assert.equal(items.length, 2);
    assert.equal(items[0].event, 'first');
    assert.equal(items[1].event, 'second');
    const raw = readFileSync(audit.file, 'utf8').trim().split('\n');
    assert.equal(raw.length, 2);
    for (const line of raw) assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('审计目录不存在时自动建，写入失败不抛', () => {
  const d = join(dir(), 'nested', 'deeper');
  try {
    const audit = createAudit(d);
    assert.doesNotThrow(() => audit.write('ok', { a: 1 }));
    assert.equal(audit.list(5).length, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});