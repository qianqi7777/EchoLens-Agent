# 测试与 CI

本地验证默认使用模拟 Provider 和受控进程替身，不调用真实模型或付费 API。

## 命令与范围

在仓库根目录先运行 `npm ci`，使用 Node.js 22 或 24：

| 命令 | 检查范围 |
| --- | --- |
| `npm run check` | TypeScript 类型检查、测试分类登记、Unit、Contract、Security |
| `npm run check:ci` | `check` 加独立的 Performance 测试 |
| `npm run test:coverage` | Unit、Contract、Security 的全量源码覆盖率和核心行覆盖率门禁 |
| `npm run audit` | 依赖漏洞检查，high 及以上会失败 |
| `npm run pack:check` | 构建、打包、临时安装及 CLI 冒烟检查 |
| `npm run eval:fixed` | 120 项固定任务的本地脚本运行时评测 |

`check:ci` 不包含覆盖率、依赖审计、打包检查和真实 Docker 验收。修改运行时或安全边界时，应另跑相关检查，不能仅据这个命令判断全部 CI 已通过。

测试文件在 `agent-test/test-suites.json` 中登记；分类检查会拒绝遗漏或重复登记。

## GitHub Actions

工作流定义在 [ci.yml](../.github/workflows/ci.yml)，push 和 pull request 均会触发。

| Job | 环境与内容 |
| --- | --- |
| quality | Ubuntu、Windows × Node.js 22、24，执行 `npm run check` |
| performance | Ubuntu / Node.js 24，执行 Performance 测试 |
| audit | Ubuntu / Node.js 24，执行依赖审计 |
| coverage | Ubuntu / Node.js 24，执行覆盖率门禁 |
| package | Ubuntu、Windows / Node.js 24，执行打包冒烟检查 |
| docker-verify | 仅手动触发，执行真实 Docker 验收并保存日志 |

以 PR 当前提交的检查结果为合并依据。本地某个平台通过，不代表其他平台已验证。

## 覆盖率口径

`c8 --all --src src` 统计全部 `src/`，包含未被测试加载的文件；不把 `agent-test/` 和 `server/` 纳入此指标。
全量门禁为行覆盖率 84%、函数覆盖率 88%、分支覆盖率 76%。

固定核心集合为 `src/runtime/`、`src/orchestration/`、`src/providers/`、`src/session/`、`src/sandbox/`、`src/skills/`。
核心门禁读取同一份 `coverage/lcov.info`，按六个目录覆盖行数之和除以总行数计算，要求不低于 95%；不是六个百分比的平均值。
缺失目录、重复文件或无效计数会失败，且按原始计数判断，显示值四舍五入不能使门禁通过。

平台、Node 版本和条件分支可能导致结果略有差异。引用具体数字时应同时注明环境、日期和统计范围，并保留原始 LCOV。
CI 在生成 LCOV 后，即使门禁失败也会上传 `source-coverage-lcov` artifact；任务取消或尚未生成文件时不上传。
本地 LCOV 属于生成产物，不提交到 Git。

## 常见失败排查

1. 先打开第一个失败步骤的完整日志，区分类型错误、测试断言失败和覆盖率未达标。
2. Windows 临时路径可能包含 8.3 别名。路径字符串与 `realpath` 不同不等于被链接重定向；持久工作区逐级检查目录，并拒绝符号链接和 Junction，包括父目录中的链接。
3. 核心覆盖率不足时下载 LCOV，检查未覆盖的行为并补充回归测试；保持统计集合和门禁一致。
4. 符号链接或短路径测试可能受操作系统能力限制；查看 skip/诊断信息，不把未执行的分支当成验收成功。

固定任务评测的输入格式和质量边界见 [Eval 功能链路](./功能链路/07-Eval评测与动态任务.md)；本地网页入口见 [Agent Test Lab](../agent-test/README.md)。
