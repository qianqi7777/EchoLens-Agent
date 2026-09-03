# EchoLens Agent

一个从零开始、模型中立的本地代码 Agent。v0.7 加固了持久队列、可恢复会话和
Worktree 子 Agent，并通过更严格的 TypeScript 门禁收敛运行时实现。

## 已有能力

- 连接 OpenAI-compatible 模型服务
- 支持互不回退的 `direct`、`gateway` 两种显式路由
- 支持 Chat Completions 与 Responses 两种 Provider 协议
- 支持流式文本、连接前分类重试、Usage 与 Request ID 追踪
- 提供 Gateway 登录状态、模型能力目录和 OpenAPI 客户端契约
- 提供独立 Gateway MVP：Device Flow、Token 刷新/撤销、固定上游代理、SSE、用量和限流
- 执行 `list_files`、`read_file`、`grep` 只读工具
- 使用带跨进程锁的单写者 JSONL Event Store 持久化 Session、Turn、Run 与检查点
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
- Sandbox 写入以 Artifact Bundle 返回，并通过独立审批的结构化 Patch 回放到宿主工作区
- `package_install` 使用内部 Docker 网络和域名 allowlist 代理，不向工作容器提供直连公网
- 支持 MCP stdio、Streamable HTTP、Tools、Resources、Prompts、进度与取消
- 提供 `outline_file`、`find_symbols`、`go_to_definition`、`find_references`、`get_diagnostics`
- TypeScript/JavaScript 代码智能优先使用 LSP，并在服务不可用时降级到 tree-sitter
- 提供版本化 Eval Harness、隔离 Fixture、隐藏 Grader、动态任务轮换和质量/成本/安全指标
- 支持本地静态 Candidate 的 Eval CLI，默认不连接模型或付费 API
- 提供带跨进程锁的持久后台任务队列、租约恢复、显式取消/恢复和状态通知
- 提供 Explore、Test、Review 三种受限子 Agent，使用独立 Sandbox/Worktree、预算与工具白名单
- Worktree 子 Agent 使用过滤后的当前工作区作为基线，可读取未提交改动且不会把原有改动误报为子 Agent 产物
- TypeScript 启用未使用代码、数组越界、隐式返回、Switch 穿透和 Override 等额外静态检查
- 生命周期 Hook 只观察克隆事件，仓库级 Hook 必须显式信任且不能成为执行旁路

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
- `/tasks`：列出最近后台任务
- `/task <explore|test|review> [sandbox|worktree] <目标>`：创建并启动受限后台任务
- `/task cancel <id>`：取消后台任务
- `/task resume <id>`：显式恢复待处理、失败或已取消任务
- `Ctrl+C`：只取消当前 Turn，不删除 Session
- `/exit`：退出 CLI

TUI 还支持 `/help`、`/clear`，以及上述 Session、验证、回滚和 steering 命令。

Direct 路由默认启用流式响应；设置 `AGENT_DIRECT_STREAMING=false` 可关闭。

## Evals 与编排

Eval CLI 只读取本地任务和 Candidate JSON。默认结果写入 Git 忽略的
`.echolens/evals/results.jsonl`；只有显式使用 `--docker` 才会执行隐藏命令检查。

```powershell
npm run eval:smoke
npm run eval -- --task <task.json> --candidate <candidate.json>
npm run eval -- --template <template.json> --seed <seed> --candidate <candidate.json>
npm run agent-test:web
```

后台 Worker 不会在应用启动时自动运行待处理任务。创建或执行 `/task resume <id>` 才会启动；
正常退出会释放运行中租约并回到 `pending`，不会把任务误标成用户取消。

## Sandbox

模型触发的 Shell、测试、构建和安装动作默认需要审批。高隔离执行要求本机安装并启动
Docker，同时预先准备 `AGENT_SANDBOX_IMAGE` 指定的镜像；运行时使用 `--pull never`，
不会隐式下载镜像，也不会在 Docker 不可用时回退到宿主 Shell。

网络策略支持 `none` 和 `allowlist`。只有 `package_install` 可以申请域名 allowlist；工作容器
只连接 Docker 内部网络，通过受限代理访问经 DNS 和公网地址检查后的域名。Sandbox 写入先保存
到 `.echolens/artifacts/`，再由 `apply_sandbox_patch` 展示 diff、审批、创建 Checkpoint 并应用。

运行真实 Docker 验收前需预先准备镜像，然后执行：

```powershell
npm run verify:docker
```

## MCP 与代码智能

MCP 配置默认读取 `.echolens/mcp.json`。可从 `examples/mcp.example.json` 开始配置；示例中的
Server 全部禁用且不包含真实地址。敏感 Header 和环境变量只能通过 `headersFrom`、`envFrom`
引用当前进程环境，不能把 Token 明文写入配置。第三方 MCP 描述和输出均作为不可信数据，
外部调用默认需要审批。

tree-sitter 工具无需后台进程。TypeScript LSP 按需启动，定义、引用和诊断结果只保留工作区内
的相对路径；LSP 不可用时定义、引用和语法诊断自动降级到 tree-sitter。

## 文档

- [公开文档中心](doc/README.md)
- [功能链路总览与数据字典](doc/功能链路/README.md)
- [代码注释规范](doc/代码注释规范.md)

## 验证

```bash
npm run check:ci
npm run gateway:build
npm run eval:smoke
npm run audit
```

真实 Docker Sandbox 验收仍使用 `npm run verify:docker`，需要本机预先准备镜像。

测试分为 Unit、Contract、Security 和 Performance 四类。完整命令、CI 平台矩阵
由 `package.json` 和 `.github/workflows/ci.yml` 定义。

## 目录

```text
src/
  cli.ts                 交互式命令行入口
  core/                  模型中立的消息、权限与 System Policy
  context/               项目指令来源和权限收紧契约
  code-intelligence/     tree-sitter 索引、TypeScript LSP 和代码工具
  orchestration/         后台队列、独立工作区、受限子 Agent 和只读 Hook
  credentials/           凭据引用与异步解析接口
  mcp/                   MCP 配置、Client 生命周期与工具桥接
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
    file-lock.ts         Session 与后台队列共用的跨进程文件锁
    workspace-tools.ts   安全的只读代码工具
    sandbox-tools.ts     Sandbox Shell、测试、构建与安装工具
    verifier.ts          声明验证基础
  sandbox/
    docker-sandbox.ts    Docker 高隔离执行适配器
    workspace-stager.ts  排除秘密和忽略文件的临时工作区快照
    artifact-store.ts    Artifact Bundle 与结构化 Patch 提案
    egress-proxy.ts      域名 allowlist 出站代理
    process-runner.ts    shell=false、超时、取消和输出限制
  session/               Event Store、检查点和 Session Runtime
agent-test/              独立 Eval、测试支持、全部测试文件和 Issue 对比网页
contracts/
  gateway.openapi.json   Gateway 客户端 OpenAPI 契约
```

## 当前边界

v0.7 已完成持久状态的跨进程单写者加固、当前工作区 Worktree 基线和更严格的静态检查。
A2A 暂不接入：当前编排没有跨服务、跨团队或远程 Agent Card/Task 互操作需求。Docker 缺失时 Sandbox 工具仍会明确失败，不会
回退到低隔离宿主执行。LSP 语言覆盖仍限于 TypeScript/JavaScript；MCP OAuth、Skills 和
可执行生命周期 Hook 尚未实现。远程 Gateway 只代理模型请求，没有本地工具执行权。

Gateway 本地 MVP 可使用 `npm run gateway:server` 启动，使用 `npm run gateway:login -- --url <地址>`
完成 Device Flow。Gateway 使用 SQLite 持久化哈希令牌和月度用量；单机部署样例位于
`server/model-gateway/deploy/`。水平扩展前仍需将限流状态迁移到共享基础设施，并接入
正式账号系统与云 Secret Store。
