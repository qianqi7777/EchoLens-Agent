# Plan 模式、计划确认与 Goal 证据链

## 执行阶段

`ExecutionPhase` 包含 `plan`、`execute`、`verify`。`/plan on` 进入只读规划阶段，`/plan off`
恢复自动分类；也可显式选择三个阶段。TUI 的 Shift+Tab（兼容入口 Ctrl+P）按
`plan → execute → auto` 循环，`verify` 不参与快捷循环。

阶段切换在下一次 Agent 循环生效：模型可见工具和 Runtime 权限都会重新计算。在途写调用仍由
既有 Schema、guardrail 与审批链校验，不会因为模式切换获得豁免。

这里的执行阶段与 checkpoint 的 `phase: model | tools | finished` 是两套状态：前者约束模型能力，
后者记录可恢复的 ReAct 状态机位置。

## 计划确认

规划阶段使用 `PLAN_SCHEMA` 请求结构化计划，并产生 `plan.proposed` 事件。不支持结构化输出或输出
不合规时保留 raw 文本，运行不会失败。UI 持有确认交互，支持批准、编辑后批准、拒绝，以及批准并
设为目标；决定写入 `plan.decided`。批准后切换到执行阶段，计划只注入紧随其后的首个 execute Turn。

## Goal 与证据

`/goal <描述>` 创建活动目标，`/goal note <文本>` 添加人工证据，`/goal status` 查看状态，
`/goal done` 和 `/goal drop` 分别以完成或放弃收口。活动目标在每次执行时注入目标、验收标准和最近
证据，但它只是用户级执行上下文，不能修改权限或审批语义。

SessionRuntime 自动从 `checkpoint.saved` 与 `verification.completed` 采集证据并发射
`goal.progress`。`goal.set`、`goal.progress`、`goal.closed` 均进入 JSONL Event Store，因此重启与
后台任务恢复后仍能重建活动目标。验证通过只提示可能满足标准，最终完成仍由用户通过 `/goal done`
确认。
