# EchoLens Agent

一个从零开始的本地代码 Agent 骨架。目前只保留已经能独立运行、且不依赖旧
EchoLens 服务的部分：模型路由、ReAct 工具循环、统一工具执行器、只读工作区
工具和最小 CLI。

## 已有能力

- 连接 OpenAI-compatible 模型服务
- 支持 `local`、`direct`、`cloud` 三种显式路由
- 执行 `list_files`、`read_file`、`grep` 只读工具
- 限制工具权限、调用次数、执行时间、输出长度和工作区路径
- 保留模型与工具调用轨迹
- 对模型声明提供独立 Verifier 基础类型

## 快速开始

要求 Node.js 22 或更高版本。

```powershell
npm install
$env:AGENT_MODEL_ROUTE = "local"
$env:AGENT_LOCAL_MODEL = "qwen3-coder"
$env:AGENT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1"
$env:AGENT_LOCAL_API_KEY = "local"
$env:AGENT_WORKSPACE_ROOT = "D:\path\to\project"
npm run dev
```

完整变量示例见 `.env.example`。当前程序不会自动读取 `.env` 文件，环境变量
应由 shell、IDE 或进程管理器注入。

## 验证

```bash
npm run check
```

## 目录

```text
src/
  cli.ts                 交互式命令行入口
  runtime/
    react-loop.ts        模型与工具的最小循环
    model-router.ts      OpenAI-compatible 模型路由
    tool-executor.ts     权限、预算、超时和输出限制
    tool-registry.ts     工具注册表
    workspace-tools.ts   安全的只读代码工具
    verifier.ts          声明验证基础
docs/
  ARCHITECTURE.md        产品边界和后续路线
```

## 当前边界

这是只读代码 Agent，不是完整 Coding Agent。写文件、Shell、审批、沙箱、回滚、
会话持久化和事件流尚未实现。下一步应优先加入结构化事件和 `apply_patch`，
再考虑命令执行与多 Agent。
