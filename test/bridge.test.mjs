import test from 'node:test';
import assert from 'node:assert/strict';
import { isGpt, installBridge, withPriority } from '../src/bridge.js';

function fixture() {
  const sent = [];
  const snapshots = [];
  const models = {
    getModel(_provider, id) {
      assert.equal(this, models);
      return { id, api: id === 'gpt-custom' ? 'anthropic-messages' : 'openai-responses' };
    },
    async *streamSimple(model, context, options) {
      assert.equal(this, models);
      await new Promise((resolve) => setTimeout(resolve, context.delay));
      const initial = { model: model.id, input: context.input, reasoning: { effort: options.reasoning }, tools: context.tools };
      const body = options.onPayload ? await options.onPayload(initial, model) : initial;
      sent.push({ sessionId: options.sessionId, body });
      yield body;
    },
  };
  const snapshot = Object.freeze({ models, marker: 42 });
  class Adapter {
    current() { return snapshot; }
    modelOf(s, provider, model) { return s.models.getModel(provider, model); }
    prepareCall(provider, model) {
      return Promise.resolve({ model: this.modelOf(snapshot, provider, model), stream: (o) => this.streamWithSnapshot(o, snapshot) });
    }
    async *streamWithSnapshot(options, snapshot) {
      snapshots.push(snapshot);
      yield* snapshot.models.streamSimple(this.modelOf(snapshot, options.provider, options.model),
        { input: 'hello', delay: options.delay ?? 0, tools: [{ name: 'lookup' }] },
        { sessionId: options.sessionId, reasoning: options.reasoningEffort });
    }
  }
  const adapter = new Adapter();
  const send = async (options) => {
    const call = await adapter.prepareCall(options.provider, options.model);
    return Array.fromAsync(call.stream(Object.freeze(options)));
  };
  return { Adapter, adapter, sent, send, snapshots, snapshot };
}

const request = (sessionId, extra = {}) => ({ provider: 'custom-openai', model: 'gpt-5.4', sessionId, reasoningEffort: 'high', ...extra });

test('GPT 检测支持命名空间且拒绝相似名称', () => {
  for (const id of ['gpt-5', 'GPT-4o', 'openai/gpt-5.4']) assert.ok(isGpt(id));
  for (const id of ['claude-sonnet-4', 'deepseek-chat', 'mygpt-5', 'gptish', undefined]) assert.ok(!isGpt(id));
});

test('Priority 保留原回调的返回体且不修改原体', async () => {
  const body = Object.freeze({ model: 'gpt-5', service_tier: 'auto' });
  const options = withPriority({ onPayload: async () => ({ ...body, metadata: { retained: true } }) });
  assert.deepEqual(await options.onPayload(body), { model: 'gpt-5', service_tier: 'priority', metadata: { retained: true } });
  assert.equal(body.service_tier, 'auto');
  const fallback = withPriority({ onPayload() {} });
  assert.equal((await fallback.onPayload(body)).service_tier, 'priority');
});

test('并发 GPT 会话独立注入，保留 reasoning 和 tools', async () => {
  const f = fixture();
  const bridge = installBridge(f.Adapter, { isEnabled: (id) => id === 'fast' });
  try {
    await Promise.all([f.send(request('fast', { delay: 15 })), f.send(request('normal', { delay: 1 }))]);
    const fast = f.sent.find((r) => r.sessionId === 'fast').body;
    const normal = f.sent.find((r) => r.sessionId === 'normal').body;
    assert.equal(fast.service_tier, 'priority');
    assert.equal(normal.service_tier, undefined);
    assert.deepEqual(fast.reasoning, normal.reasoning);
    assert.deepEqual(fast.tools, normal.tools);
    assert.equal(f.snapshot.models.streamSimple.name, 'streamSimple');
    assert.ok(f.snapshots.includes(f.snapshot));
    assert.ok(f.snapshots.some((s) => s !== f.snapshot && s.marker === 42));
  } finally { bridge.dispose(); }
});

test('非 GPT、后台用途、无会话和不支持协议均透传', async () => {
  const f = fixture();
  const bridge = installBridge(f.Adapter, { isEnabled: () => true });
  try {
    for (const options of [request('s', { model: 'deepseek-chat' }), request('s', { purpose: 'compaction' }),
      request('s', { purpose: 'session-title' }), request(undefined), request('s', { model: 'gpt-custom' })]) await f.send(options);
    assert.ok(f.sent.every((item) => item.body.service_tier === undefined));
    assert.ok(f.snapshots.every((s) => s === f.snapshot));
  } finally { bridge.dispose(); }
});

test('probe 识别同一适配器实例，陌生路径默认不可用', async () => {
  const f = fixture();
  const bridge = installBridge(f.Adapter, { isEnabled: () => false });
  try {
    const results = await Promise.all([
      bridge.probe(() => f.adapter.prepareCall('provider', 'gpt-5')),
      bridge.probe(() => f.adapter.prepareCall('provider', 'gpt-custom')),
      bridge.probe(async () => ({})),
    ]);
    assert.deepEqual(results.map((r) => r.supported), [true, false, false]);
    assert.equal(f.sent.length, 0);
  } finally { bridge.dispose(); }
});

test('开关在请求开始时固定，后续请求使用新的状态', async () => {
  const f = fixture();
  let enabled = true;
  const bridge = installBridge(f.Adapter, { isEnabled: () => enabled });
  try {
    const prepared = await f.adapter.prepareCall('provider', 'gpt-5');
    const iterable = prepared.stream(request('s'));
    enabled = false;
    await Array.fromAsync(iterable);
    await f.send(request('s'));
    assert.equal(f.sent[0].body.service_tier, 'priority');
    assert.equal(f.sent[1].body.service_tier, undefined);
  } finally { bridge.dispose(); }
});

test('卸载恢复原方法；预先 prepare 的调用也不注入', async () => {
  const f = fixture();
  const original = f.Adapter.prototype.streamWithSnapshot;
  const prepare = f.Adapter.prototype.prepareCall;
  const bridge = installBridge(f.Adapter, { isEnabled: () => true });
  const call = await f.adapter.prepareCall('provider', 'gpt-5');
  bridge.dispose();
  assert.equal(f.Adapter.prototype.streamWithSnapshot, original);
  assert.equal(f.Adapter.prototype.prepareCall, prepare);
  await Array.fromAsync(call.stream(request('s')));
  assert.equal(f.sent[0].body.service_tier, undefined);
});

test('卸载不会覆盖后来加载的其他插件包装', async () => {
  const f = fixture();
  const bridge = installBridge(f.Adapter, { isEnabled: () => true });
  const ours = f.Adapter.prototype.streamWithSnapshot;
  const later = function (...args) { return ours.apply(this, args); };
  f.Adapter.prototype.streamWithSnapshot = later;
  bridge.dispose();
  assert.equal(f.Adapter.prototype.streamWithSnapshot, later);
  await f.send(request('s'));
  assert.equal(f.sent[0].body.service_tier, undefined);
});

test('拒绝重复安装和不兼容适配器', () => {
  assert.throws(() => installBridge(class {}, { isEnabled: () => true }), /incompatible/);
  const f = fixture();
  const bridge = installBridge(f.Adapter, { isEnabled: () => true });
  try { assert.throws(() => installBridge(f.Adapter, { isEnabled: () => true }), /duplicate/); }
  finally { bridge.dispose(); }
});
