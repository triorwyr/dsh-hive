import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLock } from '../lib/lock.mjs';

const spot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bots-lock-'));
  return { file: join(dir, 'owner.lock'), dir };
};

test('第一个实例拿到锁，活着的持有者让别人只读', () => {
  const { file, dir } = spot();
  const owner = process.ppid; // 一个确实活着的进程
  try {
    const first = createLock(file, { pid: owner, now: () => 5 });
    assert.deepEqual(first.take(), { ok: true });
    assert.equal(first.read().pid, owner);

    const second = createLock(file, { pid: process.pid, now: () => 6 });
    const got = second.take();
    assert.equal(got.ok, false);
    assert.equal(got.by.pid, owner);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持有者已经退出的锁会被接手', () => {
  const { file, dir } = spot();
  try {
    const first = createLock(file, { pid: 999999, now: () => 5 });
    first.take();
    const second = createLock(file, { pid: process.pid, now: () => 6 });
    assert.equal(second.take().ok, true, '死掉的 pid 不该挡住新进程');
    assert.equal(second.read().pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持有者释放后别人可以接手', () => {
  const { file, dir } = spot();
  try {
    const first = createLock(file, { pid: 2001 });
    assert.equal(first.take().ok, true);
    first.release();
    assert.equal(existsSync(file), false);
    const second = createLock(file, { pid: 2002 });
    assert.equal(second.take().ok, true);
    assert.equal(second.read().pid, 2002);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('别人不能替我释放锁', () => {
  const { file, dir } = spot();
  try {
    const owner = createLock(file, { pid: 3001 });
    owner.take();
    const other = createLock(file, { pid: 3002 });
    other.release();
    assert.equal(existsSync(file), true, '锁还在，因为释放的人不持有它');
    assert.equal(owner.read().pid, 3001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});