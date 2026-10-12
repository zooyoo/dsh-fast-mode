import { AsyncLocalStorage } from 'node:async_hooks';

const OWNER = Symbol.for('dsh-fast-mode.bridge');
const APIS = new Set(['openai-responses', 'openai-completions', 'openai-codex-responses']);

export function isGpt(model) {
  return typeof model === 'string' && /^gpt(?:-|$)/i.test(model.split('/').at(-1));
}

export function canInject(model) {
  return isGpt(model?.id) && APIS.has(model?.api);
}

export function withPriority(options = {}) {
  const previous = options.onPayload;
  return {
    ...options,
    async onPayload(payload, model) {
      // 尊重已有回调返回的新对象；返回 undefined 表示沿用原对象。
      const result = previous ? await previous(payload, model) : undefined;
      const body = result ?? payload;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('dsh-fast-mode: invalid OpenAI payload');
      }
      return { ...body, service_tier: 'priority' };
    },
  };
}

export function installBridge(Adapter, { isEnabled, onRequest = () => {} }) {
  const proto = Adapter?.prototype;
  if (!proto || typeof proto.streamWithSnapshot !== 'function' ||
      typeof proto.prepareCall !== 'function' || typeof proto.modelOf !== 'function' ||
      typeof proto.current !== 'function') {
    throw new Error('dsh-fast-mode: incompatible PiAiAdapter; requires DSH 0.2.0-rc.2');
  }
  if (proto[OWNER]) throw new Error('dsh-fast-mode: duplicate bridge installation');
  const originalStream = proto.streamWithSnapshot;
  const originalPrepare = proto.prepareCall;
  const probes = new AsyncLocalStorage();
  let active = true;

  function prepare(provider, model, signal) {
    // 探测只读模型描述，不读取认证信息，也不发起模型生成。
    const probe = active && probes.getStore();
    if (probe) {
      const descriptor = this.modelOf(this.current(), provider, model);
      probe.supported = canInject(descriptor);
      probe.api = descriptor.api;
    }
    return originalPrepare.call(this, provider, model, signal);
  }

  function stream(options, snapshot) {
    if (!active || options.purpose || !options.sessionId ||
        !isGpt(options.model) || !isEnabled(String(options.sessionId))) {
      return originalStream.call(this, options, snapshot);
    }
    const descriptor = this.modelOf(snapshot, options.provider, options.model);
    if (!canInject(descriptor)) return originalStream.call(this, options, snapshot);
    const models = new Proxy(snapshot.models, {
      get(target, key) {
        if (key === 'streamSimple') {
          return (model, context, piOptions) => {
            // 独立快照隔离并发会话；已经开始的请求不因按钮切换而改变。
            const result = target.streamSimple(model, context, withPriority(piOptions));
            onRequest(String(options.sessionId), { provider: options.provider, model: options.model });
            return result;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return originalStream.call(this, options, { ...snapshot, models });
  }

  const marker = {};
  proto[OWNER] = marker;
  proto.prepareCall = prepare;
  proto.streamWithSnapshot = stream;
  return {
    async probe(resolve) {
      const result = { supported: false, api: null };
      await probes.run(result, resolve);
      return result;
    },
    dispose() {
      active = false;
      // 其他插件在我们之后包装时，保留其包装；本包装此后直接透传。
      if (proto.streamWithSnapshot === stream) proto.streamWithSnapshot = originalStream;
      if (proto.prepareCall === prepare) proto.prepareCall = originalPrepare;
      if (proto[OWNER] === marker) delete proto[OWNER];
    },
  };
}
