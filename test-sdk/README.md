# 真实 DSH SDK 集成测试

这组测试从本机安装的 DSH `app.asar` **只读加载**真实 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`、`@earendil-works/pi-ai@0.87.1` 和 OpenAI SDK。`PiAiAdapter`、pi-ai 模型集合、协议序列化和 OpenAI HTTP 客户端均运行真实代码。测试只替换部署 profile、认证回调及 HTTP 服务端；不替换适配器或 `globalThis.fetch`。

## 运行要求

- Node.js 24，需支持同步 `node:module.registerHooks()`；实测版本 `v24.18.0`。
- 本地安装 DSH 桌面端 `0.2.0-rc.2`。加载器会核验真实 SDK 版本，不匹配即失败。
- 能读取 `app.asar`，并允许进程监听和访问 `127.0.0.1` 的随机端口。
- 无需 `npm install`，没有网络下载依赖。
- `npm run test:sdk` 的脚本应指向 `node test-sdk/sdk-integration.test.mjs`。该命令使用 `node:test` 自运行模式，断言失败会返回非零退出码。

使用 PowerShell 7：

```powershell
$ErrorActionPreference = 'Stop'
node test-sdk/sdk-integration.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'SDK integration tests failed' }
```

如果项目已配置对应的 npm script：

```powershell
$ErrorActionPreference = 'Stop'
npm run test:sdk
if ($LASTEXITCODE -ne 0) { throw 'SDK integration tests failed' }
```

默认安装包位置为 `%LOCALAPPDATA%/Programs/DeepSeek Harness/resources/app.asar`，其它安装位置可指定：

```powershell
$ErrorActionPreference = 'Stop'
$env:DSH_TEST_ASAR = 'D:\Apps\DeepSeek Harness\resources\app.asar'
node test-sdk/sdk-integration.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'SDK integration tests failed' }
```

在本机的 DSH Windows 文件沙箱中，默认 `node --test` 因其子进程管道被禁止而产生 `spawn EPERM`。`--test-isolation=none` 与同步 hooks 的组合在本次环境出现静默等待，因此这里直接运行测试文件；不会创建子进程或需要权限升级。

## 已覆盖的行为

1. `bridge.probe()` 经过真实 `PiAiAdapter.prepareCall()`，能识别 GPT / 非 GPT，且不发送 HTTP。
2. 真正消费 `prepareCall().stream()` 时，开启 Fast 的 GPT 请求体包含 `service_tier: "priority"`。
3. 关闭 Fast 后，已准备好的调用不携带该字段；开关前后请求体除该字段外完全一致。
4. 非 GPT 模型通过真实 OpenAI Responses 协议发送，但不追加该字段。
5. 两个会话并发调用真实 `adapter.stream()` 时，仅开启的会话包含该字段。
6. `purpose` 为 session-title / compaction，或缺少 `sessionId` 时，不追加该字段。
7. 冻结的调用 options、原 snapshot 的 models 引用及 `streamSimple` 方法不被修改。
8. 真实 OpenAI Responses 和 Chat Completions 请求都保留工具定义和 reasoning 参数；Responses 额外核验输入、输出 token 上限及 stream 字段。
9. 卸载恢复适配器原型，卸载前准备的调用和卸载后的直接调用均不再注入 priority。
10. 每次 HTTP 请求均返回合法 SSE 流，并验证 DSH 转换后的文本增量为 `local-ok`、usage 为 12 tokens、终止类型为 `stop`。

`test-sdk/asar-loader.mjs` 将安装包模块映射到工作区 `.analysis/runtime/` 下的**虚拟 URL**，由同步 hooks 提供源码；该目录无需存在，不提取依赖到磁盘。加载器服务于此固定 SDK 的测试，不是通用 Electron ASAR 模块加载器，也不会随插件运行。

## Host 加载回归

`npm run test:host` 会先构建插件，再运行 `host-integration.test.mjs`。此测试在隔离的真实 Cordis Context 中创建真实 Connection 服务，预先注册已有 `/api` Gateway，验证插件独立通道可以共存、卸载会恢复适配器和移除路由、原 Gateway 仍能响应。WebServer 路由表和会话服务使用测试替身，不连接正在运行的用户 Host。

## 范围与限制

- 全部 HTTP 仅发往测试创建的 `127.0.0.1` mock，使用常量假凭证；不读取 Host 凭证、用户配置或环境认证信息，不调用收费 API。
- 只测试 bridge 和真实 SDK 请求路径；没有启动或修改 DSH Host，没有验证桌面 UI 按钮。
- 本地服务器验证请求已携带 priority，不能证明真实服务端接受该参数、实际提速或计费方式。
- 本组未测试 Codex OAuth、Codex SSE / WebSocket、图片、远端代理、重试或用户真实 provider 配置。
- 安装包公开 SDK 文件仅在测试进程内读取，不修改安装包、不注册 Host 插件、不执行依赖安装脚本。

## 本机执行记录

2026-10-12（Asia/Shanghai）：`node test-sdk/sdk-integration.test.mjs` 通过 10 / 10 个测试计数（1 个父测试 + 9 个子测试），0 失败、0 跳过；加载 338 个真实安装包模块，捕获 12 次本地 HTTP 请求。详细报告见 `.analysis/sdk-integration-result.json`。
