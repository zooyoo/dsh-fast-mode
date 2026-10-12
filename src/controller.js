import { isGpt } from './bridge.js';

export const CHANNEL = '/dsh-fast-mode';
export const ENDPOINT = 'state';

export function createController(ctx, probe) {
  // 状态跟随 Session 生命周期，刷新页面保留，重启 Host 后默认关闭。
  const states = new WeakMap();
  function stateOf(session) {
    if (!states.has(session)) states.set(session, { enabled: false });
    return states.get(session);
  }
  function selectionOf(session) {
    const projected = ctx.sessionProjections.snapshot(session, ['modelSelection']);
    return projected.values.modelSelection?.next ?? ctx.agentDefaultModel.currentSelection();
  }
  function isEnabled(id) {
    const agent = ctx.agents.get(id);
    return !!agent && stateOf(agent.session).enabled;
  }
  async function status(agent, signal) {
    const selection = selectionOf(agent.session);
    const state = stateOf(agent.session);
    const base = { enabled: state.enabled, supported: false, active: false,
      provider: selection?.provider ?? null, model: selection?.model ?? null,
      serviceTier: 'priority' };
    if (!isGpt(selection?.model)) return { ...base, reason: '仅 GPT 模型可开启 Fast' };
    try {
      const route = JSON.stringify([selection.provider, selection.model]);
      if (state.route !== route || !state.capability || Date.now() - state.checkedAt > 3000) {
        const capability = await probe(() => ctx.llm.prepareCall({
          provider: selection.provider, model: selection.model,
        }, signal));
        state.route = route;
        state.capability = capability;
        state.checkedAt = Date.now();
      }
      const supported = state.capability.supported;
      return { ...base, enabled: state.enabled, supported, active: supported && state.enabled,
        reason: supported ? null : '当前模型调用路径不支持 Fast 参数注入' };
    } catch {
      // 不把适配器异常原文传给浏览器，防止暴露认证或服务商配置。
      return { ...base, reason: '模型暂不可用，无法确认 Fast 支持状态' };
    }
  }
  function failure(code, message) {
    return { ok: false, error: { code, message, details: {} } };
  }
  return {
    isEnabled,
    async handle(endpoint, payload, signal) {
      if (endpoint !== ENDPOINT) return failure('NOT_FOUND', '未知 Fast 接口');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 256 ||
          (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')) {
        return failure('INVALID_ARGUMENT', 'Fast 请求参数无效');
      }
      const agent = ctx.agents.get(payload.sessionId);
      if (!agent) return failure('SESSION_NOT_READY', '会话尚未就绪');
      try {
        let value = await status(agent, signal);
        if (payload.enabled !== undefined) {
          if (payload.enabled && !value.supported) return failure('FAST_UNAVAILABLE', value.reason);
          stateOf(agent.session).enabled = payload.enabled;
          value = { ...value, enabled: payload.enabled, active: payload.enabled && value.supported };
        }
        return { ok: true, value };
      } catch {
        return failure('STATE_UNAVAILABLE', '无法读取当前会话的 Fast 状态');
      }
    },
  };
}
