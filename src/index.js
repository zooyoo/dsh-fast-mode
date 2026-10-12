import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import adapterPackage from '@deepseek-ai/dsh-llm-pi-ai/package.json' with { type: 'json' };
import { installBridge } from './bridge.js';
import { createController, CHANNEL } from './controller.js';

export const name = 'dsh-fast-mode';
export const inject = ['connection', 'webServer', 'agents', 'sessionProjections', 'agentDefaultModel', 'llm'];

export function apply(ctx) {
  if (adapterPackage.version !== '0.2.0-rc.2') {
    throw new Error('dsh-fast-mode requires @deepseek-ai/dsh-llm-pi-ai 0.2.0-rc.2');
  }
  let bridge;
  const controller = createController(ctx, (resolve) => bridge.probe(resolve));
  // 桥接和路由都随插件卸载，避免热重载留下重复拦截。
  ctx.effect(() => {
    bridge = installBridge(PiAiAdapter, { isEnabled: controller.isEnabled });
    return () => bridge.dispose();
  });
  ctx.connection.rpc.handle(CHANNEL, controller.handle);
}
