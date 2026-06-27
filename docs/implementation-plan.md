# Browser Automated 项目实现规划

## 1. 项目目标

本项目面向日常开发中的浏览器自动化场景：用户用自然语言描述网页操作流程，系统自动操作页面，并能将成功流程沉淀为可复用的 Skill、Workflow 或标准 E2E 测试代码。

最终输出形态为：

- `CLI`：提供稳定、可脚本化、可集成 CI 的浏览器自动化与测试生成能力。
- `Skill`：作为自然语言触发入口，面向 Codex/Agent 使用，编排 CLI 完成网页操作、流程复用和 E2E 测试生成。

项目拆解为 3 个核心目标：

1. 自然语言执行网页操作。
2. 沉淀可复用 Skill / Workflow。
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
Skill 识别并调用 CLI
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
注册到可复用 Skill / Workflow 索引
```

## 3. 产品边界

### 3.1 应该支持

- 用自然语言描述单次网页操作并执行。
- 用自然语言描述完整 E2E 测试目标并执行。
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

- `browser-automated` CLI 入口。
- `BrowserAgent` 对 `agent-browser` CLI 的 TypeScript 封装。
- 自然语言测试运行器。
- 测试用例生成器。
- `browser-e2e` Skill。
- 生成测试索引 `tests/generated/index.json`。
- Playwright 测试生成目录 `tests/generated/`。
- 基础 handoff/resume 流程说明与部分测试。

后续规划应在现有能力上收敛目标，不重复建设新的自动化框架。

## 5. 目标架构

### 5.1 CLI 层

CLI 是可复用执行能力的主入口，负责参数解析、流程编排、产物落盘和错误码输出。

目标命令：

- `browser-automated chat <url> <instruction>`：执行单条自然语言操作。
- `browser-automated run <case-file>`：执行结构化自然语言测试用例。
- `browser-automated e2e <url> <instruction>`：执行自然语言 E2E 流程。
- `browser-automated e2e-gen <url> <instruction>`：生成 Playwright Test。
- `browser-automated browser-e2e <natural-language-case>`：Skill 主入口，负责自然语言整段解析、匹配、执行、生成。
- `browser-automated workflow save/run/list`：沉淀和复用 Workflow。
- `browser-automated trace inspect/export`：查看和导出 Action Trace。
- `browser-automated handoff/resume`：显式触发用户接管与恢复。

### 5.2 Skill 层

Skill 是自然语言入口，负责判断用户意图并调用 CLI，不直接承载复杂业务逻辑。

Skill 需要支持：

- 识别“执行网页操作”请求。
- 识别“生成 E2E 测试”请求。
- 识别“把刚才流程保存为 Skill/Workflow”请求。
- 优先匹配已有 generated tests 或 workflow。
- 在未命中时调用一次性执行流程。
- 执行成功后提示或自动触发生成测试。

Skill 输出应保持可执行、可追踪、可复用，避免只停留在自然语言建议。

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

目标：用户给出 URL 和自然语言指令后，CLI/Skill 能完成一次网页操作。

流程：

```text
用户输入自然语言
  ↓
Skill 判断为操作任务
  ↓
调用 browser-automated chat/e2e
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

状态：`In Progress`

### 6.2 沉淀可复用 Skill / Workflow

目标：成功执行过的流程可以被命名、索引、复用。

Workflow 建议结构：

```json
{
  "id": "login-and-open-dashboard",
  "name": "登录并打开仪表盘",
  "description": "登录测试账号并验证进入 dashboard",
  "urlPattern": "https://example.com/**",
  "tags": ["login", "dashboard"],
  "inputs": [
    { "name": "username", "type": "string", "secret": false },
    { "name": "password", "type": "string", "secret": true }
  ],
  "steps": [
    { "instruction": "打开登录页面" },
    { "instruction": "输入用户名 {{username}}" },
    { "instruction": "输入密码 {{password}}" },
    { "instruction": "点击登录按钮" }
  ],
  "assertions": [
    "URL 包含 /dashboard",
    "页面显示欢迎文案"
  ]
}
```

验收标准：

- 成功流程可以保存为 workflow。
- 后续自然语言请求可以匹配已有 workflow。
- workflow 支持参数化和敏感字段标记。
- workflow 可以作为 E2E 生成的输入。

状态：`Planned`

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

- 生成代码可通过 TypeScript 编译。
- 生成测试可被 Playwright Test 执行。
- 测试文件命名稳定，避免重复生成同名文件。
- `index.json` 能被 Skill 匹配逻辑使用。
- 生成断言不只检查“没有报错”，必须绑定 URL、文本、可见元素或业务状态。

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
- handoff 过程会写入 trace。
- CLI 和 Skill 都能清楚提示用户当前需要做什么。

状态：`In Progress`

## 7. 里程碑

### M1：自然语言执行闭环

目标：稳定完成一次性网页操作和自然语言 E2E 执行。

任务：

- [ ] 明确 `chat`、`e2e`、`browser-e2e` 的职责边界。
- [ ] 统一执行结果数据结构。
- [ ] 为每一步写入 Action Trace。
- [ ] 对失败动作输出结构化错误。
- [ ] 补充常见操作的单元测试。

验收：

- 用户可以通过 Skill 或 CLI 让浏览器完成一个 3 到 5 步自然语言流程。
- 失败时可以根据 trace 复盘。

### M2：Handoff 完整闭环

目标：复杂交互可以在用户接管后恢复自动化。

任务：

- [ ] 定义 handoff session state schema。
- [ ] 实现自动触发策略。
- [ ] 实现显式 `handoff/resume` CLI。
- [ ] 记录 handoff trace。
- [ ] 恢复后跳过已完成步骤。
- [ ] 为 CAPTCHA/MFA/OAuth 场景补充模拟测试。

验收：

- 遇到复杂交互时能稳定打开可见浏览器。
- 用户完成后自动化能继续执行剩余步骤。

### M3：Workflow / Skill 复用

目标：自然语言流程可以沉淀、匹配、参数化复用。

任务：

- [ ] 定义 Workflow 文件格式。
- [ ] 实现 `workflow save/run/list`。
- [ ] 实现 workflow matcher。
- [ ] 支持参数和 secret 字段。
- [ ] Skill 中加入 workflow 优先匹配。
- [ ] workflow 可转成 Playwright Test。

验收：

- 用户可以把一次流程保存为 workflow。
- 后续类似请求无需重新探索页面即可执行。

### M4：Trace 到 Playwright Test

目标：把成功执行流程转为可维护测试。

任务：

- [ ] 设计并实现 Action Trace schema。
- [ ] 实现 trace 持久化目录。
- [ ] 从 trace 生成 Playwright 操作序列。
- [ ] 生成基础断言。
- [ ] 写入 `tests/generated/*.spec.ts`。
- [ ] 更新 `tests/generated/index.json`。
- [ ] 生成后执行 typecheck 或 Playwright 校验。

验收：

- 一次成功执行可以生成一个可运行的 Playwright Test。
- 生成测试可被后续自然语言请求命中。

### M5：工程化与文档

目标：让 CLI + Skill 可被日常开发稳定使用。

任务：

- [ ] README 对齐最终 CLI + Skill 形态。
- [ ] 补充使用示例。
- [ ] 补充错误排查文档。
- [ ] 补充 CI 示例。
- [ ] 明确生成文件目录和 git ignore 策略。
- [ ] 统一日志、trace、截图的落盘位置。

验收：

- 新用户能根据 README 安装、执行、生成测试。
- 生成产物路径清晰，便于提交或忽略。

## 8. 进度看板

| 模块 | 状态 | 当前产物 | 下一步 |
| --- | --- | --- | --- |
| CLI 基础 | In Progress | `src/cli.ts`、`package.json` bin | 收敛命令职责和结果格式 |
| Agent Browser 封装 | In Progress | `src/agent.ts` | 补充 trace 与结构化错误 |
| 自然语言执行 | In Progress | `src/runner.ts`、`src/deterministic.ts` | 统一 step result |
| Skill 入口 | In Progress | `skills/browser-e2e/SKILL.md` | 加入 workflow 复用说明 |
| Playwright 生成 | In Progress | `src/skills/playwright.ts`、`tests/generated/` | 从 trace 生成更稳定 locator 和断言 |
| 测试索引 | In Progress | `src/skills/index-store.ts`、`matcher.ts` | 扩展到 workflow index |
| Workflow 复用 | Planned | 暂无独立模块 | 设计 schema 与 CLI |
| Action Trace | Planned | 部分运行结果 | 落盘 schema 和导出命令 |
| Handoff | In Progress | Skill/README 描述与部分测试 | 完整 session state 保存恢复 |
| 文档 | In Progress | README、本文档 | 补充 troubleshooting 和示例 |

## 9. 数据与目录规划

建议目录：

```text
tests/generated/
  *.spec.ts
  index.json

.browser-automated/
  traces/
    <run-id>/trace.json
    <run-id>/screenshots/
  workflows/
    <workflow-id>.json
  sessions/
    <session-id>.json
```

约定：

- `tests/generated/` 放可提交的测试代码与索引。
- `.browser-automated/traces/` 放本地运行证据，可按需忽略。
- `.browser-automated/workflows/` 放可复用流程，是否提交由项目决定。
- `.browser-automated/sessions/` 放临时状态，默认不提交。

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

- 用户可以通过 Skill 触发自然语言浏览器自动化。
- 用户可以通过 Skill 触发 E2E 测试生成。
- CLI 可独立执行同等能力，适合脚本化和 CI。
- 成功执行流程会产生可复盘 Action Trace。
- 成功流程可以保存为 Workflow 或生成 Playwright Test。
- 生成测试可运行、可索引、可复用。
- 遇到复杂交互时可以 handoff 给用户，并恢复后续自动化。

## 12. 后续实现优先级

推荐优先级：

1. 先完成自然语言执行闭环，确保 Skill 和 CLI 都能稳定驱动浏览器完成基础流程。
2. 再补齐 handoff 的完整状态保存与恢复，因为复杂交互是自动化能否落地的关键前提。
3. 然后实现 Workflow 保存与匹配，减少重复自然语言探索，提升复用率。
4. 接着完善 Trace 到 Playwright Test 的生成链路，把稳定流程沉淀为标准测试。
5. 最后补齐工程化和文档，让 CLI + Skill 更适合团队长期使用。

这样可以保证实施顺序与真实落地阻塞点一致，并持续贴近项目最终形态：用 Skill 触发，用 CLI 执行，用 Agent Browser 完成操作，用 Playwright 沉淀测试。
