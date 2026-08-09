# Browser Automated 项目实现规划

## 1. 项目目标

本项目面向日常开发中的浏览器自动化场景：用户用自然语言描述网页操作流程，系统自动操作页面，并能将成功流程沉淀为可复用的 Workflow 或标准 E2E 测试代码。

最终输出形态为：

- `browser-opt` CLI：提供一次性自然语言浏览器控制、证据报告和 Workflow 复用。
- `browser-e2e` CLI：提供 Playwright 测试生成、复用和执行。

项目拆解为 3 个核心目标：

1. 自然语言执行网页操作。
2. 沉淀可复用 Workflow。
3. 自动生成 E2E 测试代码。

## 2. 技术路线

工具选型结论：`agent-browser + Playwright`。

综合考虑 token 消耗、自然语言执行能力、长流程稳定性，项目选择 `agent-browser` 作为主要网站自动化操作工具；使用 `Playwright CLI/codegen` 与 Playwright Test 填补 `agent-browser` 在 E2E 测试代码生成、断言表达、CI 稳定执行方面的不足。

核心分工：

- `Agent Browser` 负责“做对”：理解自然语言意图并完成真实网页操作。
- `Playwright CLI/codegen` 负责“写对”：辅助生成可维护、可重复执行的浏览器测试代码。
- `LLM` 负责“整理成可维护测试”：补全语义、提炼步骤、生成断言、命名测试、维护元数据索引。

目标流水线：

```text
自然语言任务
  ↓
CLI 解析并调度任务
  ↓
Agent Browser 执行
  ↓
记录 Action Trace
  ↓
Playwright CLI / codegen 辅助生成
  ↓
LLM 做语义补全与断言生成
  ↓
输出标准 Playwright Test
  ↓
注册到可复用 Workflow 或测试索引
```

## 3. 产品边界

### 3.1 应该支持

- 用自然语言描述单次网页操作并执行。
- 保存、匹配并复用一次性成功 Workflow。
- 优先复用已有 Playwright 测试，未命中时回退到一次性浏览器自动化。
- 将一次性成功流程沉淀为可复用 Workflow 或 Playwright Test。
- 遇到 CAPTCHA、MFA、OAuth、复杂拖拽、复杂人机交互时触发 handoff，由用户接管后恢复自动化。
- 生成的测试代码使用标准 Playwright Test，可在本地和 CI 中运行。

### 3.2 暂不优先支持

- 完全替代人工编写复杂业务断言。
- 自动破解 CAPTCHA、绕过风控或规避站点安全机制。
- 对所有高复杂度 Canvas/WebGL/低代码页面交互做通用语义理解。
- 在没有用户凭据、测试环境或登录态的情况下强行完成受保护流程。

## 4. 当前实现基线

当前仓库已经具备以下基础：

- `browser-opt` 与 `browser-e2e` CLI 入口，`browser-automated` 仅作为历史兼容入口。
- `BrowserAgent` 对 `agent-browser` CLI 的 TypeScript 封装。
- `browser-opt` 自然语言执行运行器。
- 测试用例生成器。
- `browser-opt` Workflow 保存、加载、匹配、运行能力。
- Workflow CLI 子命令：`save`、`list`、`match`、`run`。
- 生成测试索引 `tests/generated/index.json`。
- Playwright 测试生成目录 `tests/generated/`。
- `browser-opt` 的逐步骤证据报告：snapshot、截图、日志和 `report.json`/`report.md`。
- handoff/resume 完整闭环与模拟测试。
- `browser-e2e` 的自然语言步骤生成、Playwright spec 写入、索引更新与已生成用例复用。

通用 Action Trace schema、独立 trace 持久化与 `trace inspect/export` 命令尚未实现；后续规划应在现有能力上收敛目标，不重复建设新的自动化框架。

## 5. 目标架构

### 5.1 CLI 层

CLI 是可复用执行能力的主入口，负责参数解析、流程编排、产物落盘和错误码输出。

目标命令：

- `browser-opt <natural-language-flow>`：执行一次性自然语言网页操作，并输出证据报告。
- `browser-e2e <natural-language-case>`：测试生成入口，负责自然语言整段解析、匹配、生成和执行。
- `browser-e2e gen <url> <instruction>`：生成 Playwright Test。
- `browser-opt save/list/match/run`：沉淀和复用一次性自然语言 Workflow。
- `browser-e2e trace inspect/export`：查看和导出 Action Trace（规划中）。
- `browser-e2e handoff/resume`：显式触发用户接管与恢复（规划中；当前由执行命令内联编排）。

### 5.2 Workflow 复用层

Workflow 复用层负责保存、索引、匹配和运行可重复的自然语言流程，不直接承载浏览器底层操作逻辑。

Workflow 复用层需要支持：

- 保存一次性成功流程。
- 按自然语言查询匹配已保存 workflow。
- 唯一命中时直接复用 workflow。
- 歧义命中时返回候选，交由调用方确认。
- 未命中时回退到 `browser-opt` 一次性执行。
- 输出稳定 JSON，方便 CLI、脚本和后续生成链路消费。

Workflow 输出应保持可执行、可追踪、可复用，避免只停留在自然语言建议。

### 5.3 Agent Browser 执行层

执行层负责网页真实操作。

职责：

- 启动或复用浏览器 session。
- 打开目标 URL。
- 执行自然语言动作或确定性动作。
- 获取 snapshot、URL、screenshot、页面文本。
- 将每一步动作、上下文、结果和失败信息写入 Action Trace。
- 在失败或检测到复杂交互时触发 handoff。

### 5.4 Trace 层

Action Trace 是一次性执行、测试生成、问题复盘之间的桥梁。

每条 trace 至少记录：

- `stepId`
- `timestamp`
- `url`
- `instruction`
- `actionType`
- `selector` 或目标元素描述
- `inputValue`，敏感信息需要脱敏
- `beforeSnapshot`
- `afterSnapshot`
- `screenshotPath`
- `status`
- `error`
- `handoffRequired`

Trace 产物用于：

- 生成 Playwright 测试代码。
- 复盘失败原因。
- 维护 Workflow。
- 为 LLM 生成断言提供上下文。

### 5.5 Playwright 生成层

生成层负责将成功执行流程转为标准 Playwright Test。

职责：

- 根据 Action Trace 生成初始 Playwright 操作序列。
- 使用 Playwright CLI/codegen 结果校准 locator 和动作。
- 生成 `test(...)`、`page.goto(...)`、`expect(...)`。
- 输出稳定 locator，优先级为 role/test id/label/text/css。
- 根据自然语言目标生成断言。
- 写入 `tests/generated/*.spec.ts`。
- 更新 `tests/generated/index.json`。

## 6. 核心流程规划

### 6.1 自然语言执行网页操作

目标：用户给出 URL 和自然语言指令后，`browser-opt` 能完成一次网页操作。

流程：

```text
用户输入自然语言
  ↓
browser-opt 解析自然语言流程
  ↓
Agent Browser 打开页面并执行
  ↓
记录 Action Trace
  ↓
返回执行结果、当前 URL、关键截图或失败原因
```

验收标准：

- 能执行打开页面、点击、输入、选择、提交等常见操作。
- 每一步都有 trace。
- 失败时能返回可理解的失败原因。
- 支持可见浏览器观察长流程执行。

状态：`Done`

### 6.2 沉淀可复用 Workflow

目标：成功执行过的流程可以被命名、索引、复用。

当前 `browser-opt` Workflow 已落地为项目级 JSON 文件，默认目录为 `.browser-opt/workflows/`。结构保持克制，先服务保存、人工维护和稳定复用：

```json
{
  "id": "示例首页验证流程",
  "name": "示例首页验证流程",
  "target": {
    "url": "https://example.com"
  },
  "steps": [
    "验证页面包含 \"Example\"。",
    "点击导航中的 More information",
    "验证页面成功跳转"
  ],
  "createdAt": "2026-07-28T08:00:00.000Z",
  "updatedAt": "2026-07-28T08:00:00.000Z"
}
```

已实现能力：

- `browser-opt save "<名称>" --flow "<完整自然语言流程>"` 保存 Workflow。
- `browser-opt list [--json]` 列出当前项目 Workflow。
- `browser-opt match "<查询>" [--json]` 输出唯一命中、相似候选或未命中结果。
- `browser-opt run "<查询>"` 或 `browser-opt run --workflow-id <id>` 执行已保存 Workflow。
- Workflow 名称支持中文，文件名与 `id` 做安全校验。
- 加载目录时跳过单个损坏 JSON，并输出 warning。
- 同名 Workflow 默认拒绝覆盖，显式 `--force` 时更新并保留 `createdAt`。
- 运行时将结构化 Workflow 渲染回现有 runner 可消费的自然语言 flow。
- 匹配逻辑支持中文归一化、意图词清理、相似候选排序和歧义返回。

验收标准：

- 成功流程可以保存为 workflow。已完成。
- 后续自然语言请求可以匹配已有 workflow。已完成。
- workflow 可以通过 CLI 直接执行。已完成。
- workflow 支持 JSON 输出，供 CLI 和脚本稳定解析。已完成。

状态：`Done`

### 6.3 自动生成 E2E 测试代码

目标：从自然语言目标或成功 Action Trace 自动生成标准 Playwright Test。

流程：

```text
自然语言测试目标 / 成功 Trace
  ↓
生成候选步骤
  ↓
Playwright locator 校准
  ↓
LLM 生成测试语义、命名、断言
  ↓
格式化并写入 tests/generated/*.spec.ts
  ↓
执行 npm test 或 npx playwright test 校验
  ↓
更新 generated index
```

验收标准：

- 已能从 URL 和编号自然语言步骤生成 Playwright spec，并写入 `tests/generated/*.spec.ts`。
- 已能更新 `index.json`，供 CLI 匹配和复用已生成用例。
- 已具备单个生成 spec 的 Playwright 执行入口。
- 尚未在生成完成后自动执行 TypeScript 或 Playwright 校验。
- 尚未基于成功 Action Trace 校准 locator；当前使用运行时 snapshot 与启发式定位。
- 断言目前覆盖可解析的 URL 和文本场景，尚未保证每个生成用例都有业务断言。

状态：`In Progress`

### 6.4 Handoff 状态保存与恢复

目标：当 AI 无法完成复杂交互时，用户可以接管可见浏览器，完成后恢复自动化。

触发场景：

- CAPTCHA / bot detection。
- MFA / 2FA。
- OAuth 授权、第三方登录、权限 consent。
- 复杂拖拽、文件上传、人脸识别、设备认证。
- 连续 3 次操作失败且无明确可恢复策略。

状态流：

```text
自动执行中
  ↓
检测到挑战或连续失败
  ↓
保存会话状态
  ↓
打开可见浏览器
  ↓
用户完成手动步骤
  ↓
基于同一会话恢复
  ↓
继续自动化执行
```

状态保存内容：

- cookies
- localStorage/sessionStorage
- 当前 URL
- 当前 tab
- viewport
- user agent
- trace 上下文
- 已完成步骤索引

验收标准：

- 能从失败步骤进入 handoff。
- 用户完成后可从同一 session 恢复。
- 恢复后不会重复执行已经完成的步骤。
- handoff 过程会写入步骤证据与运行日志。
- CLI 能清楚提示用户当前需要做什么。

状态：`Done`

## 7. 里程碑

### M1：自然语言执行闭环

目标：稳定完成 `browser-opt` 一次性自然语言网页操作。

任务：

- [x] 明确 `browser-opt` 作为自然语言执行闭环入口。
- [x] 统一执行结果数据结构。
- [x] 为每一步落盘 snapshot、截图、日志与结构化报告。
- [x] 对失败动作输出结构化错误。
- [x] 补充常见操作的单元测试。
- [ ] 定义跨 `browser-opt` 与 `browser-e2e` 复用的 Action Trace schema。

验收：

- 用户可以通过 `browser-opt` 让浏览器完成一个 3 到 5 步自然语言流程。已完成。
- 失败时可以根据报告、snapshot、截图和日志复盘。

### M2：Handoff 完整闭环

目标：复杂交互可以在用户接管后恢复自动化。

任务：

- [x] 定义 handoff session state schema。
- [x] 实现自动触发策略。
- [x] 实现显式 `handoff/resume` CLI。
- [x] 记录 handoff 的步骤证据和运行日志。
- [x] 恢复后跳过已完成步骤。
- [x] 为 CAPTCHA/MFA/OAuth 场景补充模拟测试。

验收：

- 遇到复杂交互时能稳定打开可见浏览器。已完成。
- 用户完成后自动化能继续执行剩余步骤。已完成。

### M3：Workflow 复用

目标：自然语言流程可以沉淀、匹配、参数化复用。

任务：

- [x] 定义 browser-opt Workflow 文件格式。
- [x] 实现 `browser-opt save/list/match/run`。
- [x] 实现 workflow matcher。
- [x] 支持中文名称、稳定 ID、同名覆盖保护和无效文件诊断。
- [x] Workflow 运行复用现有 BrowserOptRunner；独立执行使用新 session，handoff 通过原进程恢复同一 session。

验收：

- 用户可以把一次流程保存为 workflow。已完成。
- 后续类似请求无需重新探索页面即可执行。已完成唯一命中与 ID 执行；歧义候选仍需用户选择。

### M4：Trace 到 Playwright Test

目标：把成功执行流程转为可维护测试。

任务：

- [ ] 设计并实现 Action Trace schema。
- [ ] 实现 trace 持久化目录。
- [ ] 从成功 trace 生成 Playwright 操作序列。
- [x] 从编号自然语言步骤生成基础 Playwright 操作序列。
- [x] 生成可解析的 URL、文本基础断言。
- [x] 写入 `tests/generated/*.spec.ts`。
- [x] 更新 `tests/generated/index.json`。
- [ ] 生成后自动执行 typecheck 或 Playwright 校验。

验收：

- 一次成功执行可以生成一个可运行的 Playwright Test。
- 生成测试可被后续自然语言请求命中。

### M5：工程化与文档

目标：让 CLI 可被日常开发稳定使用。

任务：

- [x] README 对齐当前 CLI 形态。
- [x] 补充 `browser-opt`、Workflow 与 `browser-e2e` 使用示例。
- [x] 补充 `browser-opt` 安装、登录态与调试说明。
- [ ] 补充 CI 示例。
- [ ] 明确生成文件与本地运行产物的 git ignore 策略。
- [x] 明确 `browser-opt` 报告、截图、snapshot 与 Workflow 的落盘位置。
- [ ] 统一 Action Trace、`browser-e2e` 运行证据与截图的落盘位置。

验收：

- 新用户能根据 README 安装、执行、生成测试。
- 生成产物路径清晰，便于提交或忽略。

## 8. 进度看板

| 模块 | 状态 | 当前产物 | 下一步 |
| --- | --- | --- | --- |
| CLI 基础 | Done | `src/cli/`、`package.json` bin | 已提供 `browser-opt`、`browser-e2e` 与历史兼容入口；后续按 trace 能力扩展命令 |
| Agent Browser 封装 | In Progress | `src/core/agent.ts` | 已提供 session、截图与 handoff；补充通用 trace 输出 |
| 自然语言执行 | Done | `src/browser-opt/runner.ts` | `browser-opt` 执行闭环已完成 |
| Playwright 生成 | In Progress | `src/browser-e2e/generate.ts`、`src/browser-e2e/test-reuse/playwright.ts`、`tests/generated/` | 接入成功 trace、校准稳定 locator 与强制校验 |
| 测试索引 | Done | `src/browser-e2e/test-reuse/index-store.ts`、`matcher.ts` | 已支持生成后更新、自然语言匹配和执行；后续视需要增加跨索引查询 |
| Workflow 复用 | Done | `src/browser-opt/workflow/`、`browser-opt save/list/match/run`、`tests/browser-opt/workflow.test.ts` | 已闭环 Workflow 文件生成，后续支持转成 E2E 测试用例 |
| Action Trace | Planned | `browser-opt` 的逐步骤报告与证据文件 | 定义通用 schema、落盘目录和 inspect/export 命令 |
| Handoff | Done | session state、handoff/resume CLI、步骤证据与模拟测试 | 闭环已完成，后续按场景补充回归用例 |
| 文档 | In Progress | README、本文档 | 补充 troubleshooting 和示例 |

## 9. 数据与目录规划

当前已落盘的目录：

```text
tests/generated/
  *.spec.ts
  index.json

.browser-opt/
  workflows/
    <workflow-id>.json
  states/
    browser-opt-<profile>.json
  handoffs/
    <run-id>/run.json
    <run-id>/output.log
    <run-id>/resume.signal
  artifacts/
    <run-id>/report.json
    <run-id>/report.md
```

`browser-opt` 已使用 `.browser-opt/` 下的目录；`tests/generated/` 也已用于生成 spec 与索引。以下 `.browser-automated/` 目录仍是通用 Action Trace 方案的规划，尚未由代码创建：

```text
.browser-automated/
  traces/
    <run-id>/trace.json
    <run-id>/screenshots/
  sessions/
    <session-id>.json
```

约定：

- `tests/generated/` 放可提交的测试代码与索引。
- `.browser-automated/traces/` 放本地运行证据，可按需忽略。
- `.browser-automated/sessions/` 放临时状态，默认不提交。
- `.browser-opt/workflows/` 放 `browser-opt` 可复用流程，是否提交由项目决定。
- `.browser-opt/states/` 放登录态 state，默认不提交。
- `.browser-opt/handoffs/` 放后台 Workflow 的跨会话控制文件。每次 `browser-opt start` 创建一个 `<run-id>` 目录：`run.json` 记录进程、Workflow 与路径元数据，`output.log` 保存后台输出，`resume.signal` 由 `browser-opt resume --run-id <run-id>` 写入一次性恢复信号。该目录仅用于运行中或近期任务恢复，默认不提交。
- `.browser-opt/artifacts/` 放 `browser-opt` 执行报告、截图和 snapshot，可按需忽略。

## 10. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 自然语言执行不稳定 | 长流程失败率高 | 使用 trace 复盘，成功流程沉淀为 workflow/test |
| locator 不稳定 | 生成测试易碎 | Playwright 生成时优先 role/test id/label |
| CAPTCHA/MFA 无法自动处理 | 流程中断 | handoff 到用户，恢复同一 session |
| token 消耗过高 | 成本与速度不可控 | 让 Agent Browser 执行，LLM 只处理摘要、断言和生成 |
| 生成断言过弱 | 测试价值低 | 强制断言绑定 URL、文本、可见元素或业务状态 |
| 敏感信息进入 trace | 安全风险 | 对 password/token/cookie 等字段脱敏 |

## 11. Definition of Done

项目阶段性完成需要满足：

- 用户可以通过 `browser-opt` 触发自然语言浏览器自动化。
- 用户可以通过 `browser-e2e gen` 触发 E2E 测试生成。
- CLI 可独立执行同等能力，适合脚本化和 CI。
- 成功执行流程会产生可复盘的通用 Action Trace。
- 成功流程可以保存为 Workflow 或生成 Playwright Test。
- 生成测试可运行、可索引、可复用。
- 遇到复杂交互时可以 handoff 给用户，并恢复后续自动化。

## 12. 后续实现优先级

推荐优先级：

1. 自然语言执行闭环已完成，当前以 `browser-opt` 作为稳定入口。
2. Handoff 的完整状态保存与恢复已完成，后续只按真实场景补充回归用例。
3. 先定义并持久化通用 Action Trace，复用现有 `browser-opt` 逐步骤证据，补齐导出和脱敏能力。
4. 接着将成功 Trace 接入 Playwright 生成链路，校准 locator、补强断言，并在生成后自动校验。
5. 最后补齐 CI、git ignore 策略和面向团队的排障文档。

这样可以保证实施顺序与真实落地阻塞点一致，并持续贴近项目最终形态：用 CLI 触发和执行，用 Agent Browser 完成操作，用 Workflow 复用稳定流程，用 Playwright 沉淀测试。
