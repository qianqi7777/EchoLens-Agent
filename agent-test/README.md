# Agent Test Lab

`agent-test` 是 EchoLens Agent 的独立本地评测系统。它负责把测试运行、Issue
评测和不同 Agent CLI 的横向数据放在同一个工作台里。

## 启动

```powershell
npm run agent-test:web
```

然后打开 `http://127.0.0.1:4317`。

默认模式只使用本地模拟 Provider，不访问模型 API。要执行真实 CLI，必须用
`AGENT_TEST_ENABLE_EXTERNAL=true npm run agent-test:web` 启动服务，再在页面中显式
打开“执行真实 CLI”，并为 Provider 配置本机已安装的命令。支持 `{prompt}`、
`{repo}`、`{issue}` 三个占位符。

## Issue 数据

页面可以加载本地 JSON，也可以读取公开 GitHub Issue（只读取标题、正文和状态）。
评测任务中的 `checks` 是验证修复是否落地的本地命令，命令在临时工作区中执行。
示例见 `fixtures/issues.example.json`。

## 指标

- 发现数：Provider 输出中声明的 `foundBugs`，或启发式识别的 bug 数
- 解决数：Issue 的全部验证命令通过数
- 解决率：解决数 / Issue 总数
- 平均耗时：每个 Issue 的 Provider 命令耗时
- 失败原因：命令退出码、超时或验证命令失败

页面中的“EchoLens Agent（本地基线）”用于快速回归指标；它不会伪装成真实模型运行结果。
真实 Codex、Claude Code 或 Cloudecode 只有在显式打开外部执行并设置环境开关后才会启动。

生产代码中的测试仍保持模块就近，便于单元测试直接复用私有边界；测试支持工具、
评测夹具和评测入口统一收拢到本目录。
