import './asar-loader.mjs';
import { loadedEntries, sdkVersion } from './asar-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
// 必须在注册只读 ASAR hooks 后动态导入真实 SDK。
const { PiAiAdapter } = await import('@deepseek-ai/dsh-llm-pi-ai');
const { openAIResponsesApi } = await import('@earendil-works/pi-ai/api/openai-responses.lazy');
const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy');
import { installBridge } from '../src/bridge.js';

const TEST_KEY = 'dsh-local-mock-not-a-real-api-key';
const tool = {
  name: 'lookup_weather', description: '查询城市天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
};

function sendResponses(res) {
  const item = { type: 'message', id: 'msg_local', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'local-ok', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: 'resp_local', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'local-ok' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'local-ok' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_local', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } } } },
  ];
  res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
}
function sendCompletions(res, model) {
  const make = (delta, finish_reason = null) => ({ id: 'chatcmpl_local', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] });
  const events = [make({ role: 'assistant', content: 'local-ok' }), { ...make({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }];
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}
async function mockServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: req.url, body, session: req.headers['x-client-request-id'] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
      if (req.url === '/v1/responses') sendResponses(res);
      else if (req.url === '/v1/chat/completions') sendCompletions(res, body.model);
      else throw new Error(`Unexpected local route: ${req.url}`);
    } catch (error) {
      res.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
function fixture(baseUrl) {
  const profiles = new Map();
  const auth = {
    apiKey: {
      async resolve({ credential }) {
        assert.equal(credential?.key, TEST_KEY);
        return { source: 'local-test', auth: { apiKey: TEST_KEY } };
      },
    },
  };
  for (const [id, api, implementation] of [
    ['mock-responses', 'openai-responses', openAIResponsesApi()],
    ['mock-completions', 'openai-completions', openAICompletionsApi()],
  ]) {
    const models = ['gpt-5.2', 'deepseek-chat'].map(model => ({
      id: model, name: model, provider: id, api, baseUrl,
      reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    profiles.set(id, {
      modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 5000, timeoutMs: 5000,
      piProvider: { id, name: id, auth, getModels: () => models, stream: implementation.stream, streamSimple: implementation.streamSimple },
    });
  }
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    // 显式测试凭证与禁用环境认证的上下文：不访问 Host 凭证或用户配置。
    resolveApiKey: async () => TEST_KEY,
    auth: { authContext: { env: async () => { throw new Error('Ambient credentials are forbidden in this test'); }, fileExists: async () => { throw new Error('Credential files are forbidden in this test'); } } },
  });
  return adapter;
}
function options(overrides = {}) {
  return {
    provider: 'mock-responses', model: 'gpt-5.2', sessionId: 'fast-session',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello-local' }] }],
    tools: [tool], reasoningEffort: 'high', maxTokens: 512,
    ...overrides,
  };
}
async function consume(stream) {
  const result = [];
  for await (const chunk of stream) result.push(chunk);
  assert.equal(result.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'local-ok', JSON.stringify(result));
  assert.deepEqual(result.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason.kind), ['stop'], JSON.stringify(result));
  assert.equal(result.find(chunk => chunk.type === 'usage')?.usage.totalTokens, 12, JSON.stringify(result));
  return result;
}

await test('DSH 0.2.0-rc.2 真实 PiAiAdapter + OpenAI SDK 本地 HTTP 集成', { timeout: 30000 }, async t => {
  assert.equal(sdkVersion, '0.2.0-rc.2');
  const server = await mockServer();
  const adapter = fixture(server.baseUrl);
  const enabled = new Set(['fast-session']);
  const originalStream = PiAiAdapter.prototype.streamWithSnapshot;
  const originalPrepare = PiAiAdapter.prototype.prepareCall;
  const bridge = installBridge(PiAiAdapter, { isEnabled: id => enabled.has(id) });
  let enabledPayload;
  t.after(async () => { bridge.dispose(); await server.close(); });

  await t.test('probe 经过真实 prepareCall，不发送 HTTP', async () => {
    const start = server.requests.length;
    let prepared;
    const result = await bridge.probe(async () => { prepared = await adapter.prepareCall('mock-responses', 'gpt-5.2'); });
    assert.deepEqual(result, { supported: true, api: 'openai-responses' });
    assert.equal(prepared.model.id, 'gpt-5.2');
    assert.equal(typeof prepared.stream, 'function');
    assert.equal(server.requests.length, start);
    assert.deepEqual(await bridge.probe(() => adapter.prepareCall('mock-responses', 'deepseek-chat')), { supported: false, api: 'openai-responses' });
  });
  await t.test('准备后流式请求开启 priority，保留 tools、reasoning、tokens 和输入', async () => {
    const prepared = await adapter.prepareCall('mock-responses', 'gpt-5.2');
    await consume(prepared.stream(options()));
    const { body, url } = server.requests.at(-1);
    assert.equal(url, '/v1/responses');
    assert.equal(body.service_tier, 'priority');
    assert.equal(body.reasoning.effort, 'high');
    assert.equal(body.tools[0].name, tool.name);
    assert.deepEqual(body.tools[0].parameters, tool.parameters);
    assert.equal(body.max_output_tokens, 512);
    assert.match(JSON.stringify(body.input), /hello-local/);
    assert.equal(body.stream, true);
    enabledPayload = body;
  });
  await t.test('关闭开关后同一个 prepared call 不携带 service_tier', async () => {
    const prepared = await adapter.prepareCall('mock-responses', 'gpt-5.2');
    enabled.delete('fast-session');
    try {
      await consume(prepared.stream(options()));
      const disabledPayload = server.requests.at(-1).body;
      assert.equal(Object.hasOwn(disabledPayload, 'service_tier'), false);
      const { service_tier, ...originalFields } = enabledPayload;
      assert.equal(service_tier, 'priority');
      assert.deepEqual(disabledPayload, originalFields, '除 service_tier 外，请求体必须完全一致');
    } finally {
      enabled.add('fast-session');
    }
  });
  await t.test('非 GPT 使用真实 OpenAI Responses 路径，不携带 service_tier', async () => {
    await consume(adapter.stream(options({ model: 'deepseek-chat' })));
    assert.equal(server.requests.at(-1).body.model, 'deepseek-chat');
    assert.equal(Object.hasOwn(server.requests.at(-1).body, 'service_tier'), false);
  });
  await t.test('不同会话并发隔离开关，直接 stream 路径有效', async () => {
    const start = server.requests.length;
    await Promise.all([
      consume(adapter.stream(options({ sessionId: 'fast-session' }))),
      consume(adapter.stream(options({ sessionId: 'normal-session' }))),
    ]);
    const requests = server.requests.slice(start);
    assert.equal(requests.length, 2);
    assert.equal(requests.find(req => req.session === 'fast-session').body.service_tier, 'priority');
    assert.equal(Object.hasOwn(requests.find(req => req.session === 'normal-session').body, 'service_tier'), false);
  });
  await t.test('后台 purpose 与无 session 调用均不携带 service_tier', async () => {
    for (const overrides of [{ purpose: 'session-title' }, { purpose: 'compaction' }, { sessionId: undefined }]) {
      await consume(adapter.stream(options(overrides)));
      assert.equal(Object.hasOwn(server.requests.at(-1).body, 'service_tier'), false);
    }
  });
  await t.test('冻结调用 options 和原 models 集合不被修改', async () => {
    const snapshot = adapter.current();
    const models = snapshot.models;
    const streamSimple = models.streamSimple;
    const frozen = Object.freeze(options());
    await consume(adapter.stream(frozen));
    assert.equal(snapshot.models, models);
    assert.equal(models.streamSimple, streamSimple);
    assert.equal(Object.hasOwn(frozen, 'onPayload'), false);
    assert.equal(server.requests.at(-1).body.service_tier, 'priority');
  });
  await t.test('真实 Chat Completions 请求同样开启 priority 并保留 tools 与 reasoning', async () => {
    await consume(adapter.stream(options({ provider: 'mock-completions' })));
    const { body, url } = server.requests.at(-1);
    assert.equal(url, '/v1/chat/completions');
    assert.equal(body.service_tier, 'priority');
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.tools[0].function.name, tool.name);
    assert.deepEqual(body.tools[0].function.parameters, tool.parameters);
  });
  await t.test('卸载还原原型，已 prepared 及直接调用均不再追加参数', async () => {
    const prepared = await adapter.prepareCall('mock-responses', 'gpt-5.2');
    bridge.dispose();
    assert.equal(PiAiAdapter.prototype.streamWithSnapshot, originalStream);
    assert.equal(PiAiAdapter.prototype.prepareCall, originalPrepare);
    for (const stream of [prepared.stream(options()), adapter.stream(options())]) {
      await consume(stream);
      assert.equal(Object.hasOwn(server.requests.at(-1).body, 'service_tier'), false);
    }
  });
  assert.ok([...loadedEntries].some(name => name.includes('/openai/') && name.endsWith('/client.mjs')), '必须实际加载安装包里的 OpenAI SDK');
  t.diagnostic(`SDK ${sdkVersion}; ${loadedEntries.size} 个真实安装包模块; ${server.requests.length} 次本地 HTTP 请求; 无外部 API 调用`);
});
