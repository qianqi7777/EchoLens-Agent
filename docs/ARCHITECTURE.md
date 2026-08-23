# EchoLens Agent 提取版：用于构建 ClaudeCode 类产品

> 本文只提取 EchoLens 的 Agent/平台部分，目标是作为独立 Coding Agent 产品的设计输入。
> 标记“已实现”的内容来自当前代码；标记“规划”的内容来自平台化路线图，不能当作现成能力。

## 1. 一句话模型

EchoLens 的 Agent 不是一个只会聊天的 LLM 包装，而是一条受控运行链：

```text
用户请求
  -> Session / Workspace
  -> Profile Resolver
  -> 确定性上下文（Graph / Git / RAG）
  -> Agent Workflow（Evidence -> ReAct -> Verify）
  -> 结构化结果 + 证据 + 未解决项 + 运行轨迹
  -> API / TUI / CLI 展示
```

对于 ClaudeCode 类产品，可以把“Graph / Git / RAG”替换为更通用的文件系统、搜索、Shell、Git、测试和语言服务工具；控制层仍然成立。

## 2. 产品边界

### 默认原则

- 工作区和工具执行优先在本地，源码不默认上传服务器。
- LLM 负责理解、规划和选择工具；确定性工具负责事实。
- Agent 不能覆盖已经确认的确定性结果。
- 每个结论都应区分：事实、证据支持的推断、待核查线索。
- 模型路由失败时明确降级，不静默切换到更高隐私风险的路由。
- 服务器只做模型代理、扩展分发和配置同步，不取得本地仓库执行权。

### 当前不应直接宣称的能力

当前 EchoLens 是“只读代码分析 Agent”，不是完整 Coding Agent。写文件、执行命令、测试、审批、回滚和操作系统级隔离仍需单独实现。

## 3. 核心模块映射

| Agent 平台模块 | EchoLens 现有实现 | 提取时的通用定位 |
| --- | --- | --- |
| Model Provider | `platform/providers.py`、`platform/model_router.py` | OpenAI-compatible 模型适配与单路由选择 |
| Profile Resolver | `platform/profiles.py` | 能力、工具、预算和隐私策略的配置档 |
| Tool Registry | `platform/tools.py` | 工具名称、权限域、描述的注册表 |
| Agent Workflow | `rag/agent.py` | EvidenceCollector -> ReActExplorer -> Verifier |
| Deterministic Provider | Graph、Git、RAG、Review 引擎 | Agent 使用的事实和证据来源 |
| Runtime API | `server/app.py`、`server/engine.py` | 同步分析、流式事件、助手会话 |
| Client | `tui/src/components/AssistantPanel.tsx` 等 | Agent 运行状态、轨迹和结果展示 |
| Hub / Extension | `hub/`、`extensions/` | 模型代理和签名的声明式扩展分发 |

## 4. Agent 工作流

### 4.1 EvidenceCollector

先进行一次确定性检索，得到可复用的证据上下文。当前默认取 5 条代码块，每条包括 `node_id`、分数和裁剪后的源码。

失败时不终止整个流程，只标记 `degraded=true`，让后续 Agent 仍可使用其他工具。

### 4.2 ReActExplorer

使用 LangChain `create_agent`（底层可由 LangGraph 编排）循环执行：

```text
读取用户问题和已有上下文
  -> 选择工具
  -> 执行工具
  -> 观察结果
  -> 再次选择工具或输出答案
```

当前提示词要求最终输出 JSON：

```json
{
  "answer": "自然语言结论",
  "implicit_candidates": [
    {
      "name": "symbol",
      "node_id": "file:name:line",
      "reason": "证据支持的原因",
      "confidence": 0.8
    }
  ],
  "unresolved": ["无法确定的线索"]
}
```

JSON 解析有围栏清理、对象提取、字段缺失容错和 confidence `[0, 1]` 钳制。解析失败时保留原始文本并进入降级路径。

### 4.3 Verifier

Verifier 不相信模型直接给出的候选。当前规则是：

1. 候选必须有完整 `node_id`。
2. `node_id` 必须存在于代码图。
3. 该节点还必须出现在 Graph 上下文或检索证据中。
4. 不满足条件的候选移到 `unresolved`，不能混入确定性结果。

更适合通用 Coding Agent 的结果协议是：

```text
Claim {
  claim_id
  relation_type
  source_node
  target_node
  evidence_ids
  confidence
  status: accepted | rejected | unresolved
  rejection_reason
}
```

Verifier 的职责是验证“声明是否被证据支持”，而不是只检查节点是否存在。

## 5. 工具层

### 5.1 当前四个只读工具

| 工具 | 作用 | 权限域 |
| --- | --- | --- |
| `search_code` | 向量检索相关代码片段 | `retrieval.query` |
| `read_file` | 读取工作区内指定行范围 | `workspace.read` |
| `grep` | 在源码中递归文本搜索 | `workspace.read` |
| `inspect_deps` | 查询符号的正向/反向依赖 | `graph.query` |

工具共同约束：路径解析后必须位于工作区根目录内；搜索跳过 `node_modules` 等供应商目录；输出应裁剪，避免将完整仓库内容塞入上下文。

### 5.2 当前实现的真实边界

`ToolRegistry` 目前是元数据注册表，`AgentAnalyzer._make_tools()` 仍直接创建 LangChain 工具并执行。要做成 ClaudeCode 类产品，必须把所有内置工具、MCP 工具和未来写入/命令工具收敛到一个执行入口：

```text
ToolExecutor.invoke(name, arguments, context)
  -> 参数 Schema 校验
  -> Profile / 权限检查
  -> 工作区路径检查
  -> 并发、预算、超时检查
  -> 执行适配器
  -> 输出裁剪和敏感信息清理
  -> Evidence 标准化
  -> 记录 tool.called / tool.result 事件
```

LangChain Tool、MCP Tool 都只能是 Adapter，不能拥有第二套安全规则。

### 5.3 ClaudeCode 类产品必须额外增加的工具

建议按风险分层：

```text
L0 无副作用：list_files、read_file、search、symbol_lookup
L1 可审查写入：apply_patch、create_file、rename_file
L2 外部副作用：shell、test、package_install、git_commit、network_request
```

L1/L2 默认需要用户审批。写入和命令执行必须在临时工作树或受控进程中运行，具备超时、CPU/内存限制、网络策略和回滚 artifact。Windows 不能直接假设 Linux `bubblewrap` 可用，应使用 Job Object、容器或明确的受限进程方案。

## 6. Profile 与模型路由

### 6.1 Profile

当前四种 Profile：

| Profile | 能力 | 适用场景 |
| --- | --- | --- |
| `fast` | Graph only | 快速、离线、确定性查询 |
| `explain` | Graph + RAG | 带源码证据的解释，默认档 |
| `deep` | Graph + RAG + Agent + Verifier | 复杂隐式关系分析 |
| `review` | Git diff + Impact + Review Workflow | 变更风险审查 |

通用产品应把 Profile 继续扩展为：允许工具、最大步骤、最大 token、超时、并发、是否需要审批、隐私等级和是否允许网络。

### 6.2 Model Router

当前支持：

- `direct`：用户 API Key 直连 OpenAI-compatible 服务。
- `local`：Ollama、LM Studio、vLLM 等本地服务。
- `cloud`：通过 Hub 访问云端模型。

路由是“只选一个”，失败不自动 fallback。隐私等级为：

```text
local-only -> metadata -> evidence -> full-context
```

任何可能提高源码上传范围的切换都必须由用户显式选择。状态接口应区分“配置完整”与“上游网络可达”，不能把两者混为一谈。

## 7. 结果、降级与可观测性

### 7.1 结果对象

当前 Agent 结果包含：

```text
answer              最终回答
implicit_candidates 模型发现、经 Verifier 过滤的候选
unresolved          待核查项
degraded            是否走降级路径
raw                 未成功解析时的原始模型文本
trace               工具调用轨迹摘要
```

轨迹只展示工具名和裁剪后的结果摘要，不把完整源码推给前端或日志。

### 7.2 建议事件模型（规划）

```text
session/created
workspace/preparing
workspace/ready
agent/turn-started
agent/step-started
tool/called
tool/result
evidence/retrieved
verifier/accepted
verifier/rejected
agent/message
agent/turn-completed
job/failed
```

每条事件至少包含 `session_id`、递增 `seq`、`type`、时间戳和版本化 `payload`。UI 只消费事件投影，不自己拼装一个可变的“半成品结果”。

### 7.3 降级规则

- 无模型：返回 Graph/RAG 结果，并明确“Agent 未启用”。
- 检索失败：保留 Agent 其他工具能力，标记证据降级。
- 模型调用失败：返回可诊断错误，不自动换路由。
- JSON 解析失败：保留 `raw`，不要把未验证文本当结构化结论。
- Verifier 拒绝：候选进入 `unresolved`，答案中明确说明拒绝原因。

## 8. API 与会话入口

当前入口：

```text
POST /workspace/prepare  准备 Graph/RAG 工作区
POST /analyze            dependency / impact 同步分析
WS   /stream             阶段、候选、证据和完成事件
POST /assistant/chat     连续助手对话
GET  /assistant/status   模型配置和降级诊断
GET  /platform/status    Profile、工具和路由能力
POST /review             确定性变更审查
```

ClaudeCode 类产品可以在此基础上增加：

```text
POST /sessions
POST /sessions/{id}/turns
GET  /sessions/{id}/events?after_seq=N
POST /jobs/{id}/cancel
POST /approvals/{id}/allow
```

当前 WebSocket 是一次运行内的临时流；断线恢复、Job、事件持久化属于路线图能力，尚未作为当前实现依赖。

## 9. Hub 与扩展安全

Hub 的职责是模型代理和声明式扩展分发，不读取本地仓库。扩展首期只允许官方配置，不执行第三方 Python 代码。

Manifest 至少应包含：

```json
{
  "id": "product.review",
  "version": "1.0.0",
  "runtime": ">=0.1.0",
  "permissions": ["workspace.read"],
  "sha256": "...",
  "signature": "..."
}
```

安装流程：版本和运行时兼容性检查 -> 哈希校验 -> Ed25519 签名校验 -> 显式权限确认 -> 独立目录落盘 -> 可回滚。不要让扩展通过网络下载后直接 import/exec。

## 10. 抽成独立产品时的最小目录

```text
agent_product/
├── runtime/
│   ├── session.py       # 会话、消息、取消
│   ├── turn.py          # 一次用户回合
│   ├── executor.py      # 唯一工具执行入口
│   ├── policy.py        # 权限、审批、隐私、预算
│   ├── context.py       # 历史、工具输出、证据窗口
│   ├── events.py        # 结构化事件和投影
│   └── router.py        # direct/local/cloud
├── tools/
│   ├── registry.py
│   ├── filesystem.py
│   ├── search.py
│   ├── shell.py
│   └── git.py
├── workflows/
│   ├── react.py
│   ├── review.py
│   └── verifier.py
├── providers/
│   ├── model.py
│   ├── retrieval.py
│   └── language_service.py
├── api/
│   ├── http.py
│   └── websocket.py
└── client/
    └── tui_or_web/
```

不要一开始拆成多 Agent。先让一个 Runtime 把 Session、Tool、Policy、Context、Model 和 Event 做对，再把工作流作为可替换实现。

## 11. 推荐实现顺序

### P0：最小可用回合

实现 `messages -> model -> tool_call -> tool_result -> model -> final`，工具只做 `read/search`，支持流式输出和清晰错误。

### P1：统一执行器

将所有工具收敛到 `ToolExecutor`，加入 Pydantic 参数 Schema、路径边界、输出上限、超时、调用次数预算和结构化审计事件。

### P2：上下文和会话

限制历史消息、工具结果和源码片段的 token；保存 Session、Turn、Tool Trace；支持事件序号和断线后从 `after_seq` 继续。

### P3：写入与命令沙箱

增加 `apply_patch`、测试和 Shell。每个高风险动作先生成计划和 diff，等待审批后执行；执行在临时工作树中，失败可回滚。

### P4：Verifier、评测和扩展

建立固定任务集，评测工具选择成功率、证据覆盖率、幻觉率、平均工具次数、延迟、成本和降级率；最后再开放签名扩展和 MCP Adapter。

## 12. 必须保留的设计经验

1. 确定性结果和模型推断分栏展示，不让自然语言覆盖事实。
2. 工具权限不能只写在 metadata；执行路径必须强制经过统一执行器。
3. 路由失败不能静默提升隐私等级。
4. 所有外部输入都要做路径、大小、数量和超时限制。
5. 前端消费结构化事件，不依赖解析模型文本来更新状态。
6. 评测不仅看最终回答，还看工具轨迹和证据引用。
7. 没有写入、测试、审批、回滚和隔离闭环时，不要把产品称为完整 Coding Agent。

## 13. 最小运行伪代码

```python
def run_turn(session, user_message):
    profile = profiles.resolve(session.profile)
    context = context_manager.build(session, user_message, profile)
    emit("agent/turn-started", session=session.id)

    while budget.has_remaining():
        response = model_router.call(profile.route, context.messages)
        if not response.tool_calls:
            answer = verifier.finalize(response.text, context.evidence)
            emit("agent/turn-completed", answer=answer)
            return answer

        for call in response.tool_calls:
            result = tool_executor.invoke(call.name, call.arguments, session.context)
            context.add_tool_result(result)
            emit("tool/result", summary=result.summary, evidence_ids=result.evidence_ids)

    return degraded("达到本回合预算，返回当前已验证结果")
```

这段伪代码对应的关键不在 ReAct 循环本身，而在 `ToolExecutor`、`ContextManager`、`Policy`、`Verifier` 和事件记录必须独立于具体模型框架。

