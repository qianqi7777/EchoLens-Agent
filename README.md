# EchoLens Agent

一个从零开始、模型中立的本地代码 Agent。v0.5 开始提供 Docker Sandbox、
安全编辑闭环、可恢复会话和全屏 TUI，远程 Gateway 始终没有本地工具执行权。

## 已有能力

- 连接 OpenAI-compatible 模型服务
- 支持互不回退的 `direct`、`gateway` 两种显式路由
- 支持 Chat Completions 与 Responses 两种 Provider 协议
- 支持流式文本、连接前分类重试、Usage 与 Request ID 追踪
- 提供 Gateway 登录状态、模型能力目录和 OpenAPI 客户端契约
- 提供独立 Gateway MVP：Device Flow、Token 刷新/撤销、固定上游代理、SSE、用量和限流
- 执行 `list_files`、`read_file`、`grep` 只读工具
- 使用单写者 JSONL Event Store 持久化 Session、Turn、Run 与检查点
- 支持并行只读工具、暂停、取消、恢复和 steering
- 分层加载 `AGENTS.md`，项目规则只能收紧权限，不能提升到 System
- 支持 `full-context`、`evidence`、`metadata` 三种上下文隐私模式
- 限制工具权限、调用次数、执行时间、输出长度和 Windows 工作区路径
- 在工具执行前检查动作，并将工具输出作为不可信数据回填
- 对模型声明提供独立 Verifier 基础类型
- 通过结构化 Patch、审批、Checkpoint 和后状态哈希完成安全编辑与回滚
- 提供 `shell_exec`、`run_tests`、`run_build`、`package_install` 四类独立工具
- 模型命令只接受 `executable + argv`，不经过宿主 Shell 字符串解析
- Docker Sandbox 默认禁网、只读容器根、清空 Capability、禁止提权并限制 CPU、内存和 PID
- Sandbox 只挂载过滤后的临时工作区快照，排除 `.env*`、`.git`、`.echolens` 和 Git 忽略文件

## 快速开始

要求 Node.js 22 或更高版本。

```powershell
npm install
npm run dev
```

在支持 ANSI 的交互式终端中，`npm run dev` 会启动全屏 TUI；输入问题后按 Enter
运行，`Ctrl+C` 取消当前 Turn。非 TTY 环境自动保留 readline 兼容模式。

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

TUI 还支持 `/help`、`/clear`，以及上述 Session、验证、回滚和 steering 命令。

Direct 路由默认启用流式响应；设置 `AGENT_DIRECT_STREAMING=false` 可关闭。

## Sandbox

模型触发的 Shell、测试、构建和安装动作默认需要审批。高隔离执行要求本机安装并启动
Docker，同时预先准备 `AGENT_SANDBOX_IMAGE` 指定的镜像；运行时使用 `--pull never`，
不会隐式下载镜像，也不会在 Docker 不可用时回退到宿主 Shell。

当前网络策略仅实现 `none`。`package_install` 已有独立权限和 Schema，但域名代理尚未
配置时会失败关闭。Sandbox 中的写入发生在临时快照，不能绕过 `apply_patch` 修改宿主源码。

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
    sandbox-tools.ts     Sandbox Shell、测试、构建与安装工具
    verifier.ts          声明验证基础
  sandbox/
    docker-sandbox.ts    Docker 高隔离执行适配器
    workspace-stager.ts  排除秘密和忽略文件的临时工作区快照
    process-runner.ts    shell=false、超时、取消和输出限制
  session/               Event Store、检查点和 Session Runtime
  testing/               契约测试支持工具
contracts/
  gateway.openapi.json   Gateway 客户端 OpenAPI 契约
```

## 当前边界

v0.5 当前完成了 Sandbox Adapter 和 Shell/Test/Build 的第一阶段。域名级网络代理、MCP、
Skills/Hooks、tree-sitter 和 LSP 仍未实现；Docker 缺失时 Sandbox 工具会明确失败，不会
提供低隔离的 Windows 宿主执行。远程 Gateway 只代理模型请求，不具备读取工作区或执行
本地工具的权限。

Gateway 本地 MVP 可使用 `npm run gateway:server` 启动，使用 `npm run gateway:login -- --url <地址>`
完成 Device Flow。Gateway 使用 SQLite 持久化哈希令牌和月度用量；单机部署样例位于
`server/model-gateway/deploy/`。水平扩展前仍需将限流状态迁移到共享基础设施，并接入
正式账号系统与云 Secret Store。
