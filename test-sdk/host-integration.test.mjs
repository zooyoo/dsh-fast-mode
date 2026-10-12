import './asar-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { Context } = await import('@deepseek-ai/cordis');
const { HostConnectionService } = await import('@deepseek-ai/dsh-client-connection');
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai');
const plugin = await import('../lib/index.js');

await test('真实 Cordis/Connection：插件与 API Gateway 共存并随卸载清理', { timeout: 3000 }, async () => {
  const ctx = new Context();
  const routes = new Map();
  ctx.provide('webServer', { register(route) {
    assert.equal(routes.has(route.path), false);
    routes.set(route.path, route);
    return () => routes.delete(route.path);
  } });
  new HostConnectionService(ctx, [], {});
  ctx.provide('agents', { get: () => undefined });
  ctx.provide('sessionProjections', { snapshot: () => ({ values: {} }) });
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'gpt-5' }) });
  ctx.provide('llm', { prepareCall: async () => ({}) });
  ctx.connection.rpc.intercept('/api', () => true, async () => ({ ok: true, value: 'existing-gateway' }));
  const original = PiAiAdapter.prototype.streamWithSnapshot;
  const fork = ctx.plugin(plugin);
  try {
    // 给 Cordis 的依赖解析与 apply 队列一次执行机会。
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(routes.has('/dsh-fast-mode'), '插件需要在真实 Connection 注册独立通道');
    assert.notEqual(PiAiAdapter.prototype.streamWithSnapshot, original);
    await fork.dispose();
    assert.equal(routes.has('/dsh-fast-mode'), false);
    assert.equal(PiAiAdapter.prototype.streamWithSnapshot, original);
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/existing', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'local-smoke', method: 'existing', payload: {} }),
    }));
    assert.deepEqual((await response.json()).result, { ok: true, value: 'existing-gateway' });
  } finally {
    await ctx.fiber.dispose();
  }
});
