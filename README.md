# EchoLens Agent

一个从零开始的本地代码 Agent 骨架。目前只保留已经能独立运行、且不依赖旧
EchoLens 服务的部分：模型路由、ReAct 工具循环、统一工具执行器、只读工作区
工具和最小 CLI。

## 已有能力

- 连接 OpenAI-compatible 模型服务
- 支持互不回退的 `direct`、`gateway` 两种显式路由
- 支持 Chat Completions 与 Responses 两种 Provider 协议
- 提供 Gateway 登录状态、模型能力目录和 OpenAPI 客户端契约
- 执行 `list_files`、`read_file`、`grep` 只读工具
- 限制工具权限、调用次数、执行时间、输出长度和工作区路径
- 保留模型与工具调用轨迹
- 对模型声明提供独立 Verifier 基础类型

## 快速开始

要求 Node.js 22 或更高版本。

```powershell
npm install
npm run dev
```

首次启动会进入终端设置向导，可选择 DeepSeek、自定义 OpenAI-compatible API
或 EchoLens Gateway。配置写入已被 Git 忽略的 `.env.local`，后续启动会自动加载。
需要更换模型路由时运行 `npm run setup`。完整变量示例见 `.env.example`；shell、
IDE 和进程管理器显式注入的环境变量仍可使用。

v0.2 的模型请求只支持 `full-context`。`metadata` 和 `evidence` 要等 Context
Manager 能真正裁剪上下文后才会开放；当前选择这两种模式会在读取凭据和联网前失败。
远程模型 URL 必须使用 HTTPS，本机 loopback 调试地址除外。

## 验证

```bash
npm run check
npm run test:performance
npm run audit
```

测试分为 Unit、Contract、Security 和 Performance 四类。完整命令、CI 平台矩阵
由 `package.json` 和 `.github/workflows/ci.yml` 定义。

## 目录

```text
src/
  cli.ts                 交互式命令行入口
  core/                  模型中立的消息、权限与 System Policy
  context/               项目指令来源和权限收紧契约
  credentials/           凭据引用与异步解析接口
  providers/
    openai-compatible/   Chat Completions 与 Responses Codec
    gateway/             Gateway 状态和模型目录客户端
  runtime/
    react-loop.ts        模型与工具的最小循环
    model-router.ts      OpenAI-compatible 模型路由
    tool-executor.ts     权限、预算、超时和输出限制
    tool-registry.ts     工具注册表
    workspace-tools.ts   安全的只读代码工具
    verifier.ts          声明验证基础
  testing/               契约测试支持工具
contracts/
  gateway.openapi.json   Gateway 客户端 OpenAPI 契约
```

## 当前边界

这是只读代码 Agent，不是完整 Coding Agent。Gateway 服务端、设备登录、写文件、
Shell、审批、沙箱、回滚、会话持久化和事件流尚未实现。远程 Gateway 客户端不具备
读取工作区或执行本地工具的权限。
