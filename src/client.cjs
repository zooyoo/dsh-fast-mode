const CHANNEL = '/dsh-fast-mode';
const ENDPOINT = 'state';

function createStateSource(connection, sessionId) {
  let snapshot = { value: null, pending: false, error: null };
  let sequence = 0;
  let request;
  let timer;
  let stopGeneration;
  const listeners = new Set();
  const publish = (next) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (listeners.size) timer = setTimeout(() => { void refresh(); }, 2000);
  };
  async function call(enabled) {
    const ticket = ++sequence;
    request?.abort();
    request = new AbortController();
    clearTimeout(timer);
    const changing = enabled !== undefined;
    if (changing) publish({ ...snapshot, pending: true, error: null });
    try {
      const result = await connection.rpc.call(CHANNEL, ENDPOINT,
        { sessionId, ...(changing ? { enabled } : {}) },
        AbortSignal.any([request.signal, AbortSignal.timeout(10000)]));
      if (ticket !== sequence) return;
      if (!result.ok) throw new Error(result.error.message);
      publish({ value: result.value, pending: false, error: null });
    } catch (error) {
      if (ticket !== sequence) return;
      publish({ value: null, pending: false, error: error?.message || 'Fast 状态读取失败' });
    } finally {
      if (ticket === sequence) schedule();
    }
  }
  function refresh() {
    if (!snapshot.pending) return call();
  }
  function reset() {
    ++sequence;
    request?.abort();
    publish({ value: null, pending: false, error: null });
    void refresh();
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    toggle: () => snapshot.pending ? Promise.resolve() : call(!snapshot.value?.enabled),
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stopGeneration = connection.generation.subscribe(reset);
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          ++sequence;
          request?.abort();
          clearTimeout(timer);
          stopGeneration?.();
          // StrictMode 再订阅时不能继承一个永远 pending 的请求。
          snapshot = { value: null, pending: false, error: null };
        }
      };
    },
  };
}

const CSS = `
.dsh-fast-mode-button{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer;transition:background .15s,color .15s}
.dsh-fast-mode-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsh-fast-mode-button[data-active=true]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dsh-fast-mode-button:disabled{opacity:.45;cursor:not-allowed}
.dsh-fast-mode-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`;

function apply(ctx) {
  const React = require('react');
  const h = React.createElement;
  const connection = ctx.connection;
  function FastButton({ sessionId }) {
    const source = React.useMemo(() => createStateSource(connection, sessionId), [sessionId]);
    const { value, pending, error } = React.useSyncExternalStore(source.subscribe, source.getSnapshot);
    const active = !!value?.active;
    const paused = !!value?.enabled && !active;
    const unavailable = !value?.supported && !value?.enabled;
    let title = error || value?.reason || '正在读取 Fast 状态';
    if (value?.supported) {
      title = `${value.model}：${active ? '点击关闭' : '点击开启'} Fast。仅作用于本会话的后续 GPT 请求，使用 Priority 服务层级，可能有额外费用；上游是否采纳及实际加速取决于服务商。推理强度保持不变。`;
    } else if (paused) {
      title = `${title}；已暂停，切回受支持的 GPT 后恢复。点击可关闭本会话开关。`;
    }
    return h('button', {
      type: 'button', className: 'dsh-fast-mode-button',
      disabled: pending || unavailable, 'data-active': active,
      'aria-pressed': !!value?.enabled, 'aria-busy': pending,
      'aria-label': `GPT Fast：${active ? '已开启' : paused ? '已暂停' : '已关闭'}`,
      title, onClick: () => { void source.toggle(); },
    }, h('svg', { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'm13 2-9 12h7l-1 8 10-12h-7l1-8Z' })),
    pending ? 'Fast …' : active ? 'Fast 开' : paused ? 'Fast 暂停' : 'Fast');
  }
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  });
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'dsh-fast-mode', order: 30,
  }, FastButton));
}

module.exports = { name: 'dsh-fast-mode', inject: ['slots', 'connection'], apply, createStateSource };
