# dsh-fast-mode

在 **DSH 桌面端 0.2.0-rc.2** 的对话输入框右侧增加 `⚡ Fast` 按钮。默认关闭，手动开启后，仅为当前会话的 GPT 请求追加：

```json
{"service_tier":"priority"}
```

不修改模型、推理强度、温度或输出长度。按 [OpenAI Fast mode 文档](https://developers.openai.com/api/docs/guides/fast-mode)，受支持模型的 `priority` 与 `fast` 具有相同作用；这里采用旧 SDK 已识别的 `priority` 值。

## 安装

1. 确认 DSH 桌面端版本为 **0.2.0-rc.2**。
2. 打开 DSH 的插件管理，使用本地压缩包的**绝对路径**安装，例如：

   ```text
   D:\zoyo\project\dsh\dsh-fast-mode\dsh-fast-mode-0.1.0.tgz
   ```

3. 启用 `dsh-fast-mode`。插件管理器会应用随包附带的 `cordis.patch.yml`。如果当前 profile 提示需要重启，按提示重启 DSH。
4. 打开一个对话，选择 GPT 模型，等待输入框右侧的 `⚡ Fast` 按钮就绪，点击即可开启。

包内已经包含 `lib/` 构建产物，不需要在安装时构建。插件不要求新的 API Key，继续使用 DSH 已有的模型连接。

## 使用行为

| 按钮状态 | 含义 |
| --- | --- |
| `Fast`，可点击 | 当前为可注入参数的 GPT 路径，开关关闭 |
| `Fast 开`，高亮 | 当前会话已开启，后续 GPT 请求会请求 Priority 层级 |
| `Fast 暂停` | 开关保留，但当前模型或调用路径不适用；切回受支持的 GPT 后恢复，也可点击关闭 |
| `Fast`，灰色 | 非 GPT、会话未就绪、连接中断或不支持的适配器；悬停查看原因 |
| `Fast …` | 正在等待 Host 确认开关状态 |

- 开关按当前 Session 隔离，不影响其他会话，也不自动传递到子智能体。
- 生效边界是**下一次模型请求**；不会改变已经发出的请求。
- 模型名称支持 `gpt-*` 和 `openai/gpt-*` 等命名空间形式。任意自定义别名不会自动推断成 GPT。
- 切换模型的按钮状态通常在 2 秒内同步；请求注入会再次检查实际模型，非 GPT 始终不注入。
- 会话标题、上下文压缩等带 `purpose` 的后台请求不注入 Fast。
- 状态只保存在 Host 内存中。页面刷新且 Host 仍保留该 Session 时可恢复状态；Host 重启、插件重载或 Session 被释放后默认关闭。
- 关闭开关表示停止追加参数，恢复原有请求设置。如果上游项目本身默认使用 Fast，关闭本插件不会更改该项目设置。

**费用与效果：** Fast / Priority 可能按更高费率计费。高亮表示插件已启用参数注入，不代表服务商已授予加速。第三方中转可能忽略或拒绝该参数，具体模型、账号权限及拥塞也会影响实际层级和延迟；本插件不会自动重发一遍普通请求来掩盖拒绝。

## 兼容范围

- 精确适配 DSH `0.2.0-rc.2` 与 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`。
- 对使用该内置适配器的 GPT `openai-responses`、`openai-completions` 和可用的 `openai-codex-responses` 调用路径进行参数注入。
- 第三方适配器、命名不明的模型、自定义别名和非 OpenAI 协议默认不可用。
- 是否支持参数注入由实际 Host 适配器探测，是否提供 Priority 服务由上游决定。
- 更新 DSH 后需重新验证兼容性。包声明精确版本，Host 入口也会检查适配器版本；不要使用版本豁免强行加载。

## 实现说明

Host 通过 DSH 的 `connection.rpc.handle` 在独立 `/dsh-fast-mode` 通道提供会话状态接口，Client 使用原生 `conversation.input.right` Slot 注册按钮。样式使用 DSH 主题变量，支持明暗主题、键盘焦点与 `aria-pressed`。

该版本的公开 `GenerateOptions` 没有 `service_tier` 扩展点，适配器也不会转发未知字段。因此插件包含一层**固定版本兼容包装**：

1. 包装宿主同一模块实例中的 `PiAiAdapter.prototype.streamWithSnapshot`。
2. 仅对已开启的 GPT 会话创建本次请求独享的 snapshot / models 代理。
3. 在 `models.streamSimple` 的 `onPayload` 中保留原回调结果并追加 `service_tier: "priority"`。
4. 原适配器继续完成认证、工具序列化、图像处理、流式解析、取消和重试。
5. 卸载时恢复原方法；若后续有其他插件再包装，保留其方法并让本包装停止注入。

这是基于已核实 SDK 源码的兼容层，**不是 DSH 官方公开请求中间件**。插件不修改 DSH 安装文件、不修改原生 provider 配置，也不替换全局 `fetch`。

## 开发与验证

开发环境使用 Node.js 24；构建与基础测试没有额外 npm 依赖。

```powershell
$ErrorActionPreference = 'Stop'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed' }
npm run test:sdk
if ($LASTEXITCODE -ne 0) { throw 'SDK tests failed' }
npm run test:host
if ($LASTEXITCODE -ne 0) { throw 'Host tests failed' }
npm pack
if ($LASTEXITCODE -ne 0) { throw 'Pack failed' }
```

`npm test` 在单进程中验证会话隔离、参数保留、模型切换、重连、错误处理和卸载，适合 Windows 沙箱环境。`test:sdk` 与 `test:host` 需要本机 DSH 安装包，使用只读 SDK 加载器和本地模拟服务执行集成测试，不使用真实 API Key，不调用付费模型。安装路径可通过 `DSH_TEST_ASAR` 覆盖，详见仓库中的 `test-sdk/README.md`。

已验证：18 项基础测试、10 项真实 SDK 测试（含父测试）与 1 项真实 Host 注册/卸载测试。真实 SDK 捕获了 12 次本地 HTTP 请求，覆盖 Responses 和 Chat Completions，确认开关前后请求体除 `service_tier` 外一致，且流式文本、usage 与终止状态正常。Host 测试确认与现有 `/api` Gateway 共存。

尚未在用户 profile 安装进行界面实测，也未验证 Codex OAuth / WebSocket 路径或真实上游的参数接受情况、提速和计费。支持注入不等于上游保证提供 Fast。

目录：

- `src/index.js`：Host 插件入口与版本检查。
- `src/controller.js`：会话开关与只读能力探测。
- `src/bridge.js`：固定版本适配桥及请求隔离。
- `src/client.cjs`：输入框按钮和状态同步。
- `lib/`：安装时使用的构建产物。
- `test/`：无需 DSH 的基础测试。
- `test-sdk/`：本机 DSH SDK 集成测试。

## 参考

- [OpenAI Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
- DSH 桌面安装包 `0.2.0-rc.2` 内置的 `dsh-llm-pi-ai`、Client Slots / Connection 和插件管理器源码。
- 当前运行时 Cordis Inspect 公布的 Host Services、Client Slot 和主题契约。

MIT License。
