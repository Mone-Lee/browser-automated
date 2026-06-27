# 项目结构与能力边界

本文档面向临时接手项目的开发者，说明仓库为什么按当前方式划分，以及四类核心能力分别应该改哪些文件。

## 对外产物

项目最终只对外抛出两个 CLI / Skill 名称：

| 产物 | 定位 | 适用场景 | 不负责 |
| --- | --- | --- | --- |
| `browser-opt` | 浏览器控制 | 一次性任务、即时网页操作、证据报告 | 匹配历史测试、生成 Playwright 测试 |
| `browser-e2e` | E2E 测试执行和生成 | 复用已有测试、自然语言 E2E、生成测试代码 | 纯即时操作报告 |

底层可以共用 `BrowserAgent`、确定性执行、handoff、Playwright 生成器，但新增能力必须先判断属于哪个对外产物，避免重新扩散出第三个入口。

## 四类能力分区

### 1. 自然语言执行网页操作

入口：

- CLI：`browser-opt "<自然语言流程>"`
- Skill：`skills/browser-opt/SKILL.md`

代码：

- `src/browser-opt/runner.ts`：解析 URL 和步骤，执行 `open -> snapshot -> screenshot -> act -> re-snapshot -> screenshot`，生成 PASS/FAIL 报告。
- `src/browser-opt/index.ts`：导出 browser-opt 的稳定模块 API。
- `src/cli/browser-opt.ts`：独立 bin 入口，只转发参数。
- `src/core/agent.ts`：封装 `agent-browser` 的 open、chat、snapshot、screenshot、session 等能力。

产物：

- `artifacts/browser-opt/<run-id>/report.json`
- `artifacts/browser-opt/<run-id>/report.md`
- `*.snapshot.json`
- `*.png`
- `run.log`

修改原则：

- 即时操作、证据采集、报告格式优先放在 `src/browser-opt/runner.ts`。
- 不在 `browser-opt` 中做测试索引匹配或测试代码生成。

### 2. 沉淀可复用 Skill / Workflow

入口：

- Skill：`skills/browser-opt`、`skills/browser-e2e`
- 当前复用索引：`tests/generated/index.json`
- 规划中的 workflow 目录：`.browser-automated/workflows/`

代码：

- `src/browser-e2e/test-reuse/service.ts`：E2E 测试复用主编排，负责匹配、一次性执行、生成建议。
- `src/browser-e2e/test-reuse/matcher.ts`：根据自然语言、标签和 hints 匹配已有生成测试。
- `src/browser-e2e/test-reuse/index-store.ts`：读写生成测试索引。
- `src/browser-e2e/test-reuse/types.ts`：测试复用链路的输入输出类型。

产物：

- `skills/browser-opt/SKILL.md`
- `skills/browser-e2e/SKILL.md`
- `tests/generated/index.json`
- 后续 workflow schema 建议放入 `.browser-automated/workflows/*.json`

修改原则：

- Skill 文档只描述触发和编排，不复制底层实现。
- 可复用流程应先沉淀到索引或 workflow，再由 `browser-e2e` 匹配复用。

### 3. 生成 E2E 测试代码

入口：

- CLI：`browser-e2e gen <url> <instruction>`
- CLI：`browser-e2e run <url> <instruction> --auto-generate`
- Skill：`skills/browser-e2e/SKILL.md`

代码：

- `src/browser-e2e/generate.ts`：把 URL 和自然语言描述转为结构化 `TestCase`。
- `src/browser-e2e/test-reuse/playwright.ts`：生成 Playwright spec、执行 spec、构建测试元数据。
- `src/browser-e2e/test-reuse/index-store.ts`：生成后更新索引。
- `src/browser-e2e/test-reuse/service.ts`：把生成能力串入 E2E workflow。

产物：

- `tests/generated/*.spec.ts`
- `tests/generated/index.json`

修改原则：

- 生成代码必须保持 Playwright Test 标准格式。
- 生成后要同步更新索引，否则后续自然语言无法命中已有测试。
- 断言不能只验证“无报错”，应绑定 URL、文本、可见元素或业务状态。

### 4. Handoff 机制

入口：

- 当前内置在 `browser-e2e` 执行流程中。

代码：

- `src/cli/index.ts`：用户交互提示、等待用户输入 done、打印 live viewport 信息。
- `src/browser-e2e/deterministic.ts`：连续失败计数、handoff 生命周期回调、恢复后继续执行。
- `src/core/agent.ts`：challenge 探测、`handoff()`、`resume()`、同 session 可见浏览器。
- `src/browser-e2e/test-reuse/service.ts`：把 handoff 配置传入一次性执行流程。

触发场景：

- CAPTCHA / bot detection
- OAuth 授权或 consent
- MFA / 2FA
- 连续 3 次动作失败

修改原则：

- handoff 必须保留同一 session，避免用户完成后状态丢失。
- 恢复后不应重复已经成功的步骤。
- handoff 过程要进入执行结果和日志，方便失败复盘。

## 推荐阅读顺序

1. `README.md`：了解两个对外入口。
2. `docs/project-structure.md`：确认能力边界和文件归属。
3. `src/cli/index.ts`：理解 CLI 如何分发到两个产物。
4. `src/browser-opt/runner.ts`：理解一次性自然语言执行闭环。
5. `src/browser-e2e/test-reuse/service.ts`：理解 E2E 匹配、执行、生成闭环。
6. `src/browser-e2e/deterministic.ts`：理解确定性步骤和 handoff。
7. `src/browser-e2e/test-reuse/playwright.ts`：理解测试代码生成和执行。

## 当前目录职责

```text
src/
  cli/
    browser-opt.ts        browser-opt 独立 CLI 入口
    browser-e2e.ts        browser-e2e 独立 CLI 入口
    index.ts              共享参数解析、旧入口兼容、handoff 交互
  core/
    agent.ts              agent-browser 命令封装、session、可见浏览器、handoff/resume
    types.ts              通用 TestCase、StepResult、AgentOptions 类型
    index.ts              core 稳定导出
  browser-opt/
    runner.ts             browser-opt 的自然语言执行闭环和证据报告
    index.ts              browser-opt 稳定导出
  browser-e2e/
    deterministic.ts      自然语言步骤到确定性动作的解析、执行和 handoff
    generate.ts           自然语言描述到 TestCase 的生成
    runner.ts             结构化 JSON TestCase 的运行器
    index.ts              browser-e2e 稳定导出
    test-reuse/
      service.ts          browser-e2e 测试复用主编排
      matcher.ts          已生成测试匹配
      index-store.ts      tests/generated/index.json 读写
      playwright.ts       Playwright spec 生成与执行
      types.ts            Skill / generated test 类型

skills/
  browser-opt/            Codex/Agent 使用的一次性操作 Skill
  browser-e2e/            Codex/Agent 使用的 E2E Skill

docs/
  implementation-plan.md  阶段规划
  project-structure.md    当前结构和能力边界

tests/
  core/                   core 共享能力测试
  browser-opt/            browser-opt 执行闭环测试
  browser-e2e/            E2E 执行、生成与测试复用链路测试
  cli/                    CLI 用户侧行为测试
  generated/              自动生成的 Playwright 测试与索引
```

## 后续扩展落点

| 要做的事 | 建议落点 |
| --- | --- |
| browser-opt 报告字段扩展 | `src/browser-opt/runner.ts` |
| browser-e2e 新子命令 | `src/cli/index.ts`、必要时补 thin wrapper |
| 新的测试匹配策略 | `src/browser-e2e/test-reuse/matcher.ts` |
| workflow schema | `src/browser-e2e/workflows/*` 或 `src/browser-e2e/test-reuse/workflows/*` |
| workflow 文件 | `.browser-automated/workflows/*.json` |
| handoff 状态持久化 | `src/browser-e2e/deterministic.ts` 与 `src/core/agent.ts` |
| Playwright locator 生成优化 | `src/browser-e2e/test-reuse/playwright.ts` |
