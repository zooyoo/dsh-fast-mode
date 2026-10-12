import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStateSource } = require('../src/client.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const calls = [];
  const resets = new Set();
  const connection = {
    generation: { subscribe: (fn) => { resets.add(fn); return () => resets.delete(fn); } },
    rpc: { call: (channel, endpoint, payload, signal) => new Promise((resolve, reject) => {
      calls.push({ channel, endpoint, payload, signal, resolve, reject });
    }) },
  };
  return { calls, resets, source: createStateSource(connection, 'session-a') };
}
const ok = (enabled) => ({ ok: true, value: { supported: true, enabled, active: enabled } });

test('UI 只在 Host 确认后亮起，切换期间拒绝重复点击', async () => {
  const f = fixture();
  const off = f.source.subscribe(() => {});
  try {
    assert.equal(f.calls[0].channel, '/dsh-fast-mode');
    assert.equal(f.calls[0].endpoint, 'state');
    f.calls[0].resolve(ok(false));
    await tick();
    const change = f.source.toggle();
    assert.equal(f.source.getSnapshot().pending, true);
    assert.equal(f.source.getSnapshot().value.enabled, false);
    await f.source.toggle();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].payload.enabled, true);
    f.calls[1].resolve(ok(true));
    await change;
    assert.equal(f.source.getSnapshot().value.enabled, true);
    assert.equal(f.source.getSnapshot().pending, false);
  } finally { off(); }
});

test('断线重连清理旧状态，迟到响应不能覆盖新状态', async () => {
  const f = fixture();
  const off = f.source.subscribe(() => {});
  try {
    for (const reset of f.resets) reset();
    assert.ok(f.calls[0].signal.aborted);
    f.calls[1].resolve(ok(false));
    await tick();
    f.calls[0].resolve(ok(true));
    await tick();
    assert.equal(f.source.getSnapshot().value.enabled, false);
  } finally { off(); }
});

test('卸载取消请求与订阅，重新挂载不留下永久 pending', async () => {
  const f = fixture();
  let notifications = 0;
  const off = f.source.subscribe(() => { notifications++; });
  f.calls[0].resolve(ok(false));
  await tick();
  const changing = f.source.toggle();
  off();
  const count = notifications;
  assert.ok(f.calls[1].signal.aborted);
  assert.equal(f.resets.size, 0);
  f.calls[1].resolve(ok(true));
  await changing;
  assert.equal(notifications, count);
  const offAgain = f.source.subscribe(() => {});
  try {
    assert.equal(f.calls.length, 3);
    f.calls[2].resolve(ok(false));
    await tick();
    assert.equal(f.source.getSnapshot().pending, false);
  } finally { offAgain(); }
});

test('RPC 失败后不保留误导的开启状态', async () => {
  const f = fixture();
  const off = f.source.subscribe(() => {});
  try {
    f.calls[0].resolve(ok(true));
    await tick();
    const change = f.source.toggle();
    f.calls[1].resolve({ ok: false, error: { message: '会话尚未就绪' } });
    await change;
    assert.equal(f.source.getSnapshot().value, null);
    assert.equal(f.source.getSnapshot().error, '会话尚未就绪');
  } finally { off(); }
});
