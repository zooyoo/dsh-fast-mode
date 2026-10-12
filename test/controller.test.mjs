import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, ENDPOINT } from '../src/controller.js';

function fixture() {
  const sessions = new Map([['a', { session: {} }], ['b', { session: {} }]]);
  let model = 'gpt-5.4';
  let provider = 'openai';
  let supported = true;
  let preparations = 0;
  const ctx = {
    agents: { get: (id) => sessions.get(id) },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: { provider, model } } } }) },
    agentDefaultModel: { currentSelection: () => ({ provider, model }) },
    llm: { prepareCall: async () => { preparations++; } },
  };
  const controller = createController(ctx, async (resolve) => { await resolve(); return { supported }; });
  return { controller, sessions, ctx, setModel: (next) => { model = next; }, setSupported: (next) => { supported = next; provider += '-new'; },
    get preparations() { return preparations; },
    call: (payload) => controller.handle(ENDPOINT, payload),
  };
}

test('默认关闭，启用只影响该会话；重新创建 Session 恢复默认', async () => {
  const f = fixture();
  assert.equal((await f.call({ sessionId: 'a' })).value.enabled, false);
  assert.equal((await f.call({ sessionId: 'a', enabled: true })).value.active, true);
  assert.equal(f.controller.isEnabled('a'), true);
  assert.equal((await f.call({ sessionId: 'b' })).value.active, false);
  f.sessions.set('a', { session: {} });
  assert.equal(f.controller.isEnabled('a'), false);
});

test('切换非 GPT 暂停，切回恢复；暂停期间可以关闭', async () => {
  const f = fixture();
  await f.call({ sessionId: 'a', enabled: true });
  f.setModel('deepseek-chat');
  const paused = (await f.call({ sessionId: 'a' })).value;
  assert.equal(paused.active, false);
  assert.equal(paused.enabled, true);
  assert.equal(paused.supported, false);
  f.setModel('gpt-5.4');
  assert.equal((await f.call({ sessionId: 'a' })).value.active, true);
  f.setModel('claude-opus-4');
  assert.equal((await f.call({ sessionId: 'a', enabled: false })).value.enabled, false);
});

test('校验参数、会话和不支持模型', async () => {
  const f = fixture();
  for (const payload of [null, [], {}, { sessionId: '' }, { sessionId: 'a', enabled: 1 }]) {
    assert.equal((await f.call(payload)).error.code, 'INVALID_ARGUMENT');
  }
  assert.equal((await f.controller.handle('unknown', { sessionId: 'a', enabled: true })).error.code, 'NOT_FOUND');
  assert.equal(f.controller.isEnabled('a'), false);
  assert.equal((await f.call({ sessionId: 'missing' })).error.code, 'SESSION_NOT_READY');
  f.setModel('claude-sonnet-4');
  assert.equal((await f.call({ sessionId: 'a', enabled: true })).error.code, 'FAST_UNAVAILABLE');
  assert.equal(f.controller.isEnabled('a'), false);
  f.setModel('gpt-5');
  f.setSupported(false);
  assert.equal((await f.call({ sessionId: 'a', enabled: true })).error.code, 'FAST_UNAVAILABLE');
});

test('状态探测短时复用，换模型马上重新探测', async () => {
  const f = fixture();
  await f.call({ sessionId: 'a' });
  await f.call({ sessionId: 'a' });
  assert.equal(f.preparations, 1);
  f.setModel('gpt-4o');
  await f.call({ sessionId: 'a' });
  assert.equal(f.preparations, 2);
});

test('读取全局默认模型并且不向前端泄露适配器异常', async () => {
  const f = fixture();
  f.ctx.sessionProjections.snapshot = () => ({ values: {} });
  assert.equal((await f.call({ sessionId: 'a' })).value.model, 'gpt-5.4');
  f.setModel('gpt-5');
  f.ctx.llm.prepareCall = () => { throw new Error('secret-api-key'); };
  const result = await f.call({ sessionId: 'a' });
  assert.equal(result.value.supported, false);
  assert.ok(!JSON.stringify(result).includes('secret-api-key'));
});
