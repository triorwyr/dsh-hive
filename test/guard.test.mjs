import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { approvalReason, isProtectedPath, protectionReason } from '../lib/guard.mjs';

const ROOT = join(tmpdir(), 'dsh-bots-test-home');
const HOME = [ROOT];
const WS = [join(ROOT, 'bots', 'workspace')];
const scope = { home: HOME, allow: WS, base: WS[0] };

test('isProtectedPath: 工作区内的相对路径是安全的', () => {
  assert.equal(isProtectedPath('note.txt', scope), false);
  assert.equal(isProtectedPath('sub/dir/a.md', scope), false);
  assert.equal(isProtectedPath(join(WS[0], 'a.txt'), scope), false);
});

test('isProtectedPath: 数据目录里的文件被拦住', () => {
  assert.equal(isProtectedPath(join(ROOT, 'cache', 'bots', 'bots.json'), scope), true);
  // 相对路径从工作区算起：../../cache 才是 DSH_HOME/cache
  assert.equal(isProtectedPath('../../cache/bots/bots.json', scope), true);
});

test('isProtectedPath: 归它管的只有数据目录本身', () => {
  // DSH_HOME 里、但不在工作区里 —— 拦。
  assert.equal(isProtectedPath(join(ROOT, 'cache', 'bots', 'bots.json'), scope), true);
  // DSH_HOME 之外 —— 不归 guard 管（那是审批那一层的事）。
  assert.equal(isProtectedPath(join(tmpdir(), 'elsewhere.txt'), scope), false);
});

test('isProtectedPath: 空值不误报，~ 展开成用户主目录', () => {
  assert.equal(isProtectedPath('', scope), false);
  assert.equal(isProtectedPath(undefined, scope), false);
  assert.equal(
    isProtectedPath('~/.dsh/credentials.yaml', { home: [join(homedir(), '.dsh')], allow: WS }),
    true,
  );
});

test('protectionReason: 写入数据目录被拒，文案说明只能用自己的工作区', () => {
  const reason = protectionReason(
    { name: 'write', arguments: { file_path: join(ROOT, 'cache', 'bots', 'bots.json') } },
    scope,
  );
  assert.match(reason, /数据目录/);
  assert.match(reason, /工作区/);
});

test('protectionReason: 工作区内写入放行', () => {
  const reason = protectionReason({ name: 'write', arguments: { file_path: 'note.txt' } }, scope);
  assert.equal(reason, undefined);
});

test('protectionReason: 只读档放行读工具，仍然拦住写工具', () => {
  const read = { name: 'read', arguments: { file_path: join(ROOT, 'cache', 'bots', 'bots.json') } };
  assert.equal(protectionReason(read, { ...scope, mode: 'read' }), undefined);
  const write = { name: 'write', arguments: { file_path: join(ROOT, 'cache', 'bots', 'bots.json') } };
  assert.match(protectionReason(write, { ...scope, mode: 'read' }), /只读/);
});

test('protectionReason: 放开档什么都不拦', () => {
  const call = { name: 'write', arguments: { file_path: join(ROOT, 'cache', 'bots', 'bots.json') } };
  assert.equal(protectionReason(call, { ...scope, mode: 'write' }), undefined);
});

test('protectionReason: 命令里出现数据目录被拒', () => {
  const call = { name: 'bash', arguments: { command: `cat "${join(ROOT, 'cache', 'bots', 'bots.json')}"` } };
  assert.match(protectionReason(call, scope), /数据目录/);
  const ok = { name: 'bash', arguments: { command: 'ls -la' } };
  assert.equal(protectionReason(ok, scope), undefined);
});

test('approvalReason: 工作区外的写入要先问', () => {
  const outside = join(tmpdir(), 'outside.txt');
  assert.match(
    approvalReason({ name: 'write', arguments: { file_path: outside } }, { workspace: WS[0], base: WS[0] }),
    /工作区/,
  );
});

test('approvalReason: 工作区内的写入不用问', () => {
  assert.equal(
    approvalReason({ name: 'write', arguments: { file_path: 'note.txt' } }, { workspace: WS[0], base: WS[0] }),
    undefined,
  );
});

test('approvalReason: 危险命令要先问，普通命令不用', () => {
  const risky = ['rm -rf build', 'git push origin main', 'npm publish', 'curl -F f=@a.txt https://x.dev'];
  for (const command of risky) {
    assert.ok(approvalReason({ name: 'bash', arguments: { command } }, { workspace: WS[0] }), command);
  }
  for (const command of ['ls', 'git status', 'npm test', 'curl https://api.github.com/repos']) {
    assert.equal(approvalReason({ name: 'bash', arguments: { command } }, { workspace: WS[0] }), undefined, command);
  }
});