# EchoLens Agent

一个从零开始、模型中立的本地代码 Agent。v0.3 提供可恢复会话、事件流、
受控上下文、并行只读工具和流式 CLI，远程 Gateway 始终没有本地工具执行权。

## 已有能力

- 连接 OpenAI-compatible 模型服务
- 支持互不回退的 `direct`、`gateway` 两种显式路由
- 支持 Chat Completions 与 Responses 两种 Provider 协议
- 支持流式文本、连接前分类重试、Usage 与 Request ID 追踪
- 提供 Gateway 登录状态、模型能力目录和 OpenAPI 客户端契约
- 执行 `list_files`、`read_file`、`grep` 只读工具
- 使用单写者 JSONL Event Store 持久化 Session、Turn、Run 与检查点
- 支持并行只读工具、暂停、取消、恢复和 steering
- 分层加载 `AGENTS.md`，项目规则只能收紧权限，不能提升到 System
- 支持 `full-context`、`evidence`、`metadata` 三种上下文隐私模式
- 限制工具权限、调用次数、执行时间、输出长度和 Windows 工作区路径
- 在工具执行前检查动作，并将工具输出作为不可信数据回填
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

远程模型 URL 必须使用 HTTPS，本机 loopback 调试地址除外。运行期 Session 数据
保存在工作区的 `.echolens/sessions/`，该目录默认被 Git 忽略且不可由 Agent 工具读取。

常用启动和会话命令：

```powershell
npm run dev -- --resume latest
```

- `/sessions`：列出最近 Session
- `/resume`：恢复当前 Session 的未完成 Turn
- `/steer 新要求`：持久化新要求并从当前检查点继续
- `Ctrl+C`：只取消当前 Turn，不删除 Session
- `/exit`：退出 CLI

Direct 路由默认启用流式响应；设置 `AGENT_DIRECT_STREAMING=false` 可关闭。

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
    react-loop.ts        可恢复 Agent 状态机的兼容导出
    resumable-react-agent.ts  model -> tools -> model 状态机
    model-router.ts      OpenAI-compatible 模型路由
    tool-scheduler.ts    有界并行只读调度与副作用屏障
    tool-executor.ts     权限、预算、超时和输出限制
    tool-registry.ts     工具注册表
    workspace-tools.ts   安全的只读代码工具
    verifier.ts          声明验证基础
  session/               Event Store、检查点和 Session Runtime
  testing/               契约测试支持工具
contracts/
  gateway.openapi.json   Gateway 客户端 OpenAPI 契约
```

## 当前边界

这是只读代码 Agent，不是完整 Coding Agent。Gateway 服务端、设备登录、写文件、
Shell、审批交互、沙箱和回滚尚未实现。远程 Gateway 客户端不具备读取工作区或执行
本地工具的权限。
