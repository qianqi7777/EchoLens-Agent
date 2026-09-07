# Agent Test Lab

EchoLens 的本地测试工作台，包含 Issue/CLI 对比和本仓库质量检查。它与 `npm run eval` 的 Task/Candidate 评测是两个入口，JSON 格式不通用。

## 1. 启动与快速试用

在仓库根目录执行（Node.js >= 22，首次需要 `npm install`）：

```powershell
npm run agent-test:web
```

打开 [本地工作台](http://127.0.0.1:4317)。默认选中“本地模拟”，真实 CLI 锁定，不调用模型，也不执行 Issue 中的验证命令。

1. 保留默认示例和“本地模拟”，点击“运行对比”。
2. 在“对比结果”展开任务，查看模式、输出和验证状态。模拟结果为“未验证”，解决率、平均任务耗时显示“不适用”。
3. 通过任务集工具栏导入/导出 JSON、格式化或重新加载示例；结果右上角可导出带时间和原始任务集的 JSON。
4. 点击“质量检查”运行本仓库固定的 `npm run check:ci`，在“质量日志”查看结果并下载日志。它不测试输入框里的另一仓库，也不会执行真实模型验证脚本。
5. 点击“取消”中断当前请求和子进程。服务显示忙碌时等待清理完成；刷新或关闭页面也会发出断开取消。页面不保存运行历史，刷新前请导出需要保留的结果。

端口占用时，不要结束未知进程，改用其他端口：

```powershell
$env:AGENT_TEST_PORT = '4318'
npm run agent-test:web
```

## 2. 准备自己的任务

本地仓库路径是相对于 `AGENT_TEST_REPO_ROOT` 的路径，默认基准为 EchoLens 仓库根目录。也支持基准内的绝对路径。路径越界或指向基准外的 Junction 会被拒绝。

评测外部仓库时，启动前设置一个你信任的允许根目录：

```powershell
$env:AGENT_TEST_REPO_ROOT = 'D:\YourTrustedProjects'
npm run agent-test:web
```

页面选择其子目录。“质量检查”始终在 EchoLens 仓库根目录执行，不跟随这个允许目录或页面输入变化。

任务示例：[issues.example.json](./fixtures/issues.example.json)。字段：

| 字段 | 要求 |
| --- | --- |
| `repo` | 非空任务集名称，不会触发 clone |
| `issues` | 1-100 条任务 |
| `id` | 唯一安全 ID，最多 128 字符，不包含路径分隔符 |
| `title` / `body` | 标题必填，正文可选；发送给 CLI 的任务描述 |
| `checks` | 验证数组，可选；为空时永远不会计为已解决 |
| `checks[].id` | 在单个任务内唯一 |
| `command.executable` / `args` | 本机可执行程序和字符串参数数组；不解析 Shell 命令串 |
| `cwd` | 副本内相对目录；默认副本根目录，不允许绝对路径或 `..` |
| `timeoutMs` | 单条验证超时，1-300000 ms；默认 60000 |
| `expectedExitCode` / `stdoutIncludes` | 默认要求退出码 0；可附加输出包含断言 |

示例对应本地目录 `agent-test/fixtures/lab-project`，其中 `greet.cjs` 故意返回错误结果。真实评测该示例时，将页面“本地仓库路径”设置为此目录。检查会断言 `greet('Ada')` 与 `greet('Lin')` 的实际返回值，不再用永远通过的 `process.exit(0)` 当作修复证据。

“读取 GitHub Issues”只下载公开标题、正文、状态，不 clone 仓库、不自动生成 checks。返回首个请求页中的 Issue，Pull Request 会过滤，实际数量可能少于所选数量。HTTP 错误或空结果会保留当前任务集。未登录访问可能被 GitHub 限流。

## 3. 真实 CLI 执行（可能产生费用）

仅在你明确接受费用和本地执行风险后开启：

```powershell
$env:AGENT_TEST_ENABLE_EXTERNAL = 'true'
npm run agent-test:web
```

然后选择“真实 CLI”、勾选已安装并完成登录的 Provider，每次点击运行还需确认。关闭开关后重启服务可恢复锁定。此文档不包含任何真实凭据。

- EchoLens Runner 使用服务进程继承的模型环境配置，不自动读取工作区 `.env.local`，也不打开初始化向导。必须预先在本机环境中配置模型路由。Runner 的 tsx loader 使用绝对模块 URL，可从临时副本启动。
- Codex、Claude Code、Cloudecode 使用 `agent-test/src/server.ts` 中固定的命令适配。安装和登录由用户完成，网页不能提交任意 Provider command。Windows 仅提供 `.cmd/.bat` 启动器的安装可能无法直接以 `shell:false` 启动；使用原生可执行文件或审查后添加基于 Node 的固定适配，不开启任意 Shell 字符串执行。
- 每个 Provider、每条 Issue 使用独立临时副本。副本排除 `.git`、`.echolens`、嵌套 `node_modules`、`studydoc(s)`、`.env*`、AGENTS 和常见私钥文件；Git 仓库按公开文件清单复制。不会自动安装依赖；依赖目录被排除，需使用不依赖已安装包的验证，或另行设计可信环境准备流程。
- **临时副本不是操作系统沙箱。** 外部 CLI 和 checks 以当前用户权限在宿主运行，可能访问网络或其他文件。仅评测可信仓库、可信 Issue 和可信验证命令；不应暴露本服务到局域网/互联网。
- 单个 CLI 最多运行 10 分钟；输出总量最多 64 KiB，日志使用现有脱敏规则尽力过滤秘密。取消/超时会终止进程树；若无法确认停止，结果会明确提示检查本机进程。

## 4. 如何解读结果

- 模拟模式：只统计题目关键词命中，不证明任何 Agent 找到或修复 Bug。
- 真实模式的“声明 / 输出关键词”：仍是 CLI 自报或文本启发式指标，不是独立发现率，不适合作为竞品排名依据。
- 已解决：CLI 正常退出且至少存在一个 Check，所有 Checks 通过。命令失败或超时不执行后续验证；检查首个失败后停止并展示具体日志。
- 缺少 checks：CLI 可能完成了工作，但没有验收证据，不计为已解决。
- 平均任务耗时：包括副本准备、CLI 和验证，不只是模型推理耗时。不同安装、依赖和模型会影响结果。
- “质量日志”与“Issue 对比结果”独立，不将本仓库测试通过等同于 Issue 修复通过。

## 5. 回归验证

```powershell
npm run agent-test:test
npm run check:ci
```

可选浏览器验证需要另行安装 Playwright 和兼容浏览器，并保持默认锁定的服务运行：

```powershell
# 已有 Playwright 时，可通过环境变量指定其模块路径；不需要真实模型。
$env:AGENT_TEST_BROWSER_CHANNEL = 'msedge'
npm run agent-test:web:test
```

`AGENT_TEST_PLAYWRIGHT_MODULE` 可指向已安装的 Playwright 包目录；未指定则从项目依赖解析。`AGENT_TEST_URL` 可覆盖本地端口。浏览器测试覆盖模拟对比、导入导出、HTTP 错误、取消、日志注入和三种视口；截图仅写入被 Git 忽略的 `.echolens/web-check/`。浏览器测试里的质量接口使用 Mock，不运行真实 CLI。

完整数据流见 [测试工作台功能链路](../doc/功能链路/09-测试工作台与Issue对比.md)。
