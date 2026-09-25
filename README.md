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
- 通过本地功能索引和工作区索引为首轮请求提供文件、符号和搜索导航
- `src/` 全量覆盖率由 c8 `--all --src src --exclude "agent-test/**" --exclude "server/**"` 统计，并设有实测基线门禁；CI 保存 LCOV 报告
- 执行 `list_files`、`read_file`、`grep`、`workspace_search` 只读工具
- 使用带跨进程锁的单写者 JSONL Event Store 持久化 Session、Turn、Run 与检查点
- 支持并行只读工具、暂停、取消、恢复和 steering
- 支持 `/pause` 在工具批次完成后的安全点暂停，重启后用 `/resume` 继续且不重复执行已完成工具
- 支持在 TUI/行模式中查看和切换工作目录，并为目标目录重建隔离的 Session 与运行时资源
- TUI 支持输入 `/` 打开命令候选菜单，按说明过滤并用方向键、Tab、Enter、Esc 操作
- 分层加载 `AGENTS.md`，项目规则只能收紧权限，不能提升到 System
- 支持 `full-context`、`evidence`、`metadata` 三种上下文隐私模式
- 限制工具权限、调用次数、执行时间、输出长度和 Windows 工作区路径
- 在工具执行前检查动作，并将工具输出作为不可信数据回填
- 对模型声明提供独立 Verifier 基础类型
- 通过结构化 Patch、审批、Checkpoint 和后状态哈希完成安全编辑与回滚
- 支持 `/rollback <checkpoint-id> [文件路径...]` 的按文件恢复，以及 `/rollback --to <检查点索引>` 的多步逆序回退；用户后续修改会被保护并明确列为 skipped
- 提供 `shell_exec`、`run_tests`、`run_build`、`package_install` 四类独立工具
- 模型命令只接受 `executable + argv`，不经过宿主 Shell 字符串解析
- 写操作可由 `AGENT_VERIFY_GATE=off|auto|strict` 控制自动验证；执行仍通过 ToolExecutor 与 Sandbox，失败会回灌 Agent，连续两次失败后暂停
- 自动验证可将 TAP、Jest、pytest、Go test 和 Cargo test 的失败输出解析为有界结构化摘要；未知格式仍保留脱敏后的原始输出
- Docker Sandbox 默认禁网、只读容器根、清空 Capability、禁止提权并限制 CPU、内存和 PID
- Sandbox 只挂载过滤后的临时工作区快照，排除 `.env*`、`.git`、`.echolens` 和 Git 忽略文件
- Sandbox 写入以 Artifact Bundle 返回，并通过独立审批的结构化 Patch 回放到宿主工作区
- `package_install` 使用内部 Docker 网络和域名 allowlist 代理，不向工作容器提供直连公网
- 支持 MCP stdio、Streamable HTTP、Tools、Resources、Prompts、进度与取消
- 提供 `outline_file`、`find_symbols`、`go_to_definition`、`find_references`、`get_diagnostics`
- TypeScript/JavaScript 代码智能优先使用 LSP，并在服务不可用时降级到 tree-sitter
- 提供版本化 Eval Harness、隔离 Fixture、隐藏 Grader、动态任务轮换和质量/成本/安全指标
- 支持本地静态 Candidate 的 Eval CLI，默认不连接模型或付费 API
- 支持版本锁定的 Eval Suite（静态任务 + 固定 seed 动态变体），归档逐任务原始结果与汇总报告；复现命令 `npm run eval:fixed`
- 提供带跨进程锁的持久后台任务队列、可配置 Worker 池并发、工作区互斥、租约恢复、显式取消/恢复和状态通知
- 提供 Explore、Test、Review 三种受限子 Agent，使用独立 Sandbox/Worktree、预算与工具白名单
- 后台任务持久化 input/output/cached tokens、模型步数和工具调用；`/tasks` 展示单任务用量，`/usage` 按任务与会话汇总估算成本
- 任务结束持久化 `change.set.completed` 变更包；`/diff [turn-id]` 从检查点字节重建多轮、多文件统一 diff，TUI 以聚合 Patch 视图展示并对超长 diff 做有界截断
- Worktree 子 Agent 使用过滤后的当前工作区作为基线，可读取未提交改动且不会把原有改动误报为子 Agent 产物
- TypeScript 启用未使用代码、数组越界、隐式返回、Switch 穿透和 Override 等额外静态检查
- 生命周期 Hook 只观察克隆事件，仓库级 Hook 必须显式信任且不能成为执行旁路
- 支持用户级与项目级可执行命令 Hook；项目 Hook 按配置和脚本内容指纹显式信任
- 支持按 Agent Skills 开放规范发现、校验和渐进式加载 Skill catalog；`/skills` 列表与 `/skill <name>` 手动查看可用 Skill

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
- `/session delete <session-id>`：确认后删除指定历史 Session 日志（当前 Session 不可删除）
- `/pwd` 或 `/workspace`：显示当前工作目录和 Session
- `/cd <path>` 或 `/workspace <path>`：切换工作目录；相对路径以当前目录为基准
- 在 TUI 中输入 `/`：打开带说明的命令候选菜单；`↑/↓` 选择、`Tab` 补全、`Enter` 确认、`Esc` 关闭
- `/resume`：恢复当前 Session 的未完成 Turn
- `/tasks`：查看后台 Worker 并发、运行中与排队数量及任务状态
- `/task concurrency <1-32>`：运行时调整后台 Worker 池并发；默认按 CPU 线程数的一半计算，也可通过 `AGENT_WORKER_CONCURRENCY` 配置
- `/steer 新要求`：运行中排队补充要求；暂停后写入并从当前检查点继续
- `/plan [on|off|plan|execute|verify|status]`：查看或切换执行阶段；规划阶段只提供只读工具
- `/goal <目标>`：设置长时目标；`/goal status|note <证据>|done|drop` 管理证据与状态
- `/tasks`：列出最近后台任务
- `/usage [session-id]`：汇总后台任务 token、模型步数、工具调用和估算成本；缺少模型单价时显示 `unknown`
- `/task <explore|test|review> [sandbox|worktree] <目标>`：创建并启动受限后台任务
- `/task cancel <id>`：取消后台任务
- `/task resume <id>`：显式恢复待处理、失败或已取消任务
- `Ctrl+C`：只取消当前 Turn，不删除 Session
- `/exit`：退出 CLI

TUI 还支持 `/help`、`/clear`，以及上述 Session、验证、回滚和 steering 命令。
TUI 可用 `Shift+Tab` 循环 `plan → execute → auto`；终端无法区分 Shift+Tab 时使用 `Ctrl+P`。

规划阶段结束后，TUI 或行模式会要求批准、修改或拒绝计划，也可批准并转为目标。批准计划只注入
紧随其后的首个执行 Turn；活动目标则在后续执行中持续注入，但不会授予权限、跳过审批或扩大工具范围。

Direct 路由默认启用流式响应；设置 `AGENT_DIRECT_STREAMING=false` 可关闭。

## 首轮工具导航

代码、配置、测试和仓库维护类请求会先在本地匹配功能目录与工作区索引，再把有限的候选文件、
符号和只读动作提示交给模型。高置信度和低置信度搜索场景要求模型首轮返回只读工具调用；取得
首个工具结果后恢复正常工具集合和最终结构化输出。该过程不增加额外模型调用，也不会让索引授予
文件权限；真实读取仍经过 `PathPolicy` 和 `ToolExecutor`。

`workspace_search` 统一搜索功能、文件、符号、配置、测试和字面量文本。索引只保存在本地内存，
排除 `.env*`、私有规则、凭据命名文件、Git 元数据、依赖和构建目录。设置
`AGENT_NAVIGATION_MODE=off` 可关闭导航并恢复模型自行探索的兼容行为。

## 模型智能路由

默认 `AGENT_ROUTING_MODE=off`，行为与单模型版本一致。将其设置为 `auto`、`fast`、
`balanced`、`quality`、`privacy` 或 `pinned:<profileId>` 后，CLI 会从主模型和本地
`AGENT_MODEL_PROFILES` 模型池中选择候选。模型池使用 JSON 数组，字段示例见 `.env.example`；
凭据只允许经 `credentialRef` 引用环境变量或 Gateway Token Store。

路由在 Turn 开始时锁定模型。网络、超时、限流和上游错误在模型未输出文本前默认可切换一次
符合能力与同等隐私边界的备用模型（可用 `AGENT_ROUTING_MAX_FALLBACKS` 调整上限）；认证、内容策略、协议错误、用户取消，以及工具已执行后
均不会自动切换或重放。`AGENT_ROUTING_ALLOW_TIER_DOWNGRADE=true` 时，故障 fallback 可使用
低一档模型；主选仍只会选择满足任务等级的模型。终端会显示模型选择与 fallback 原因，Session
事件保存模型选择元数据。

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

## 生命周期 Hook

用户 Hook 读取 `$ECHOLENS_HOME/hooks.json`（默认 `~/.echolens/hooks.json`），项目 Hook
读取 `.echolens/hooks.json`。配置采用版本化 JSON，示例见 `examples/hooks.example.json`。
支持 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 和
`SessionEnd`；命令从 stdin 读取事件 JSON，并可用 stdout JSON 拒绝 Prompt/工具或为 Prompt
补充上下文。

项目 Hook 在宿主机以当前用户权限执行，因此默认不受信。使用 `/hooks` 查看状态，确认命令和
指纹后运行 `/hooks trust <id|all>`；配置或 `trustFiles` 内容变化会自动撤销信任。
`/hooks revoke <id|all>` 撤销信任，`/hooks reload` 显式重载配置。Hook 只能拒绝动作，不能
自动批准或绕过原有 Schema、权限、guardrail 和审批链。敏感环境变量只能用 `envFrom` 引用。

## 文档

- [公开文档中心](doc/README.md)
- [功能链路总览与数据字典](doc/功能链路/README.md)
- [代码注释规范](doc/代码注释规范.md)

## 验证

```bash
npm run check:ci
npm run test:coverage
npm run gateway:build
npm run eval:smoke
npm run audit
```

真实 Docker Sandbox 验收仍使用 `npm run verify:docker`，需要本机预先准备镜像。

测试分为 Unit、Contract、Security 和 Performance 四类。完整命令、CI 平台矩阵
由 `package.json` 和 `.github/workflows/ci.yml` 定义。
Security 当前为 22 个已登记测试；符号链接创建受限时会在输出中记录诊断，Junction 拒绝分支仍独立验证。覆盖率产物复现命令为 `npm run test:coverage`。
`npm run eval:fixed` 运行 6 项固定版本地静态 Candidate 套件，并在 `.echolens/evals/results/` 生成带时间戳的 JSONL 与 JSON 摘要；该套件验证本地 Grader/结构化 Patch/安全事件判据，不代表真实模型完成率。`npm run eval -- --suite sandbox-smoke --docker` 才会请求 Docker Sandbox，缺少 Docker 时按失败关闭。
CI 将 quality（TypeScript + unit/contract/security）、performance、audit、coverage 分为独立 job；手动 `workflow_dispatch` 才会拉取沙箱镜像并执行 Docker 验收，相关原始日志以 artifact 上传。

## 目录

```text
src/
  cli.ts                 交互式命令行入口
  core/                  模型中立的消息、权限与 System Policy
  context/               项目指令来源和权限收紧契约
  code-intelligence/     tree-sitter 索引、TypeScript LSP 和代码工具
  navigation/            本地工作区索引、功能目录与首轮导航解析
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
    workspace-manager.ts 工作目录命令、路径校验和运行时原子切换
    commands/command-catalog.ts
                         内置命令目录、别名、说明、参数提示和候选过滤
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
自动验证默认开启（`AGENT_VERIFY_GATE=auto`）：本回合写入返回变更文件后，受控验证命令经 Sandbox 执行；缺少验证计划或 Sandbox 不可用时记录 skipped，不代表通过。`strict` 在 Sandbox 不可用时暂停；连续两次验证失败后均会暂停。此闭环依赖 Docker Sandbox 可用，自动验证也消耗单回合最多 24 次工具预算。
失败解析目前依据 TAP、Jest、pytest、Go test 与 Cargo test 的文本形态；非标准/custom reporter 可能无法结构化，此时仍回传原有脱敏截断输出，不代表覆盖所有测试运行器。
后台子 Agent 使用异步 I/O Worker 池；并发默认 `max(1, floor(os.cpus().length / 2))`，允许 1–32 并可由 `AGENT_WORKER_CONCURRENCY` 或 `/task concurrency` 覆盖。同一显式 workspace key 在队列认领时互斥，缺省任务由 allocator 分配独立 Sandbox/Worktree。Docker 主机建议从并发 2–4 起步并按内存/CPU 配额调节；该建议不是压力测试结论。
后台任务用量按子 Agent 实际收到的 usage 事件累计；成本只复用已配置模型 Profile 的公开单价，任一单价缺失会记录并展示 `unknown`，不会把未知成本当作 0。CLI 入队时自动写入当前 Session ID；未提供该 metadata 的历史或外部入队任务归入 `unknown`。
任务级 diff 只包含新格式检查点保存的前后内容；旧检查点缺少补丁后内容时会明确拒绝重建。diff 不重新读取任务结束后的工作区，因此后续用户修改不会被伪装成 Agent 变更；统一输出有字符上限，单文件可通过运行时变更包 API 查询。
按索引回退使用当前工作区检查点目录中按 `createdAt` 排序的检查点，索引从 0 开始；中途失败会停止并报告已处理范围，不提供跨工作区或强制覆盖用户后续修改的回退。
手动暂停只在工具批次完成后、下一次模型调用前生效；模型请求或工具执行中不会被硬中断。命令行非交互执行不能在已阻塞的同步输入期间注入 `/pause`，TUI 支持运行中输入该命令。
当前全量 `src/` 覆盖率实测为行 84.92%、函数 89.65%、分支 77.60%（20,612 行计数；LCOV 仅包含 `src/`，排除 Eval Harness 与 Gateway 源码）；覆盖率门禁按行 84%、函数 88%、分支 76% 设置，尚不支持“核心模块覆盖率 95%”的表述。复现命令为 `npm run test:coverage`，LCOV 文件为 `coverage/lcov.info`。
Security 的符号链接验证受当前运行账户权限影响：在不允许创建文件 symlink 的 Windows 环境，仅该能力分支会带诊断跳过；Junction 拒绝仍单独运行。该环境不能据此声称文件 symlink 创建成功分支已覆盖。
A2A 暂不接入：当前编排没有跨服务、跨团队或远程 Agent Card/Task 互操作需求。Docker 缺失时 Sandbox 工具仍会明确失败，不会
回退到低隔离宿主执行。LSP 语言覆盖仍限于 TypeScript/JavaScript；Skill 的 scripts 尚未提供独立执行命令，
仍必须由后续运行时通过 ToolExecutor/Sandbox 接入；Skill 级评测与自动激活属于后续 T-13/T-14。HTTP/MCP/Prompt/Agent 型 Hook 尚未实现。
固定 Eval Suite 目前使用本地静态 Candidate Fixture 验证确定性评分路径，不是模型能力基准；沙箱任务需要显式 Docker 环境，未实际执行时不会记为通过。

Gateway 本地 MVP 可使用 `npm run gateway:server` 启动，使用 `npm run gateway:login -- --url <地址>`
完成 Device Flow。Gateway 使用 SQLite 持久化哈希令牌和月度用量；单机部署样例位于
`server/model-gateway/deploy/`。水平扩展前仍需将限流状态迁移到共享基础设施，并接入
正式账号系统与云 Secret Store。
