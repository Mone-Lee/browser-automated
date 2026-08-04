# browser-automated

自然语言浏览器自动化工具集。项目内部复用 `agent-browser`、确定性执行器、Playwright 生成器和 handoff 编排；对外只收敛为两个产物：

- `browser-opt`：浏览器控制，适合即时操作、保存和复用自然语言 Workflow，以及带证据报告的确定性执行。
- `browser-e2e`：E2E 测试执行与生成，适合复用已有测试、沉淀 Playwright 代码。

旧的 `browser-automated` CLI 仍保留为兼容入口，但新文档和新集成应优先使用 `browser-opt` / `browser-e2e`。

## 能力划分

| 能力 | 对外入口 | 主要代码 | 主要产物 |
| --- | --- | --- | --- |
| 自然语言入口、确定性执行网页操作 | `browser-opt` | `src/browser-opt/`、`src/core/agent.ts` | `.browser-opt/artifacts/<run>/report.{json,md}`、截图、snapshot |
| 沉淀可复用 Skill / Workflow | `browser-opt save/run`、`skills/browser-opt` | `src/browser-opt/workflow/`、`skills/browser-opt` | `.browser-opt/workflows/*.json` |
| 生成 E2E 测试代码 | `browser-e2e gen`、`browser-e2e run --auto-generate` | `src/browser-e2e/generate.ts`、`src/browser-e2e/test-reuse/playwright.ts` | `tests/generated/*.spec.ts`、`tests/generated/index.json` |
| handoff 机制 | `browser-e2e` 执行流程内置 | `src/cli/`、`src/browser-e2e/deterministic.ts`、`src/core/agent.ts` | 同一 session 的用户接管与恢复记录 |

更详细的结构说明见 [docs/project-structure.md](/Users/lee/Documents/project/browser-automated/docs/project-structure.md)。

## 安装

```bash
npm install
npx agent-browser install
```

## 快速开始

一次性自然语言浏览器操作：

开发期如果已经执行过 `npm link`，建议直接使用 `browser-opt ...`；只有当前项目
本地安装了包，或未来 npm 包正式发布后，再优先使用 `npx browser-opt ...`。

```bash
browser-opt "测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 验证页面包含 \"Example\"。"
```

执行成功时只输出 `执行成功`；执行失败时才输出报告路径、日志路径、截图路径和失败步骤。默认模式会把常见访问、输入、点击和验证步骤转成确定性 `agent-browser` 命令；只有显式传 `--agent-chat` 时才使用旧的 `agent-browser chat` 兼容模式。

`browser-opt` 的登录态复用以 state 文件为主：默认会优先加载 `.browser-opt/states/` 下已有 state，避免恢复浏览器标签；没有 state 时，唯一主 agent 直接使用 `--profile Default` 打开目标页并保存 state。交互式 CLI 遇到默认 state 失效时，会关闭 state 窗口并切换到所选 Chrome Profile 的可见实例，再从该实例进入 handoff，以便人工使用 Chrome 密码管理器。终端直接运行时可输入 `done` 恢复；Codex 执行已保存 Workflow 时使用 `start` 返回的稳定 `runId`，后续通过 `resume --run-id` 恢复原 runner，不依赖会跨 turn 失效的 PTY session，也不要启动第二次 `run`。显式传 `--state <path>` 时表示用户要使用隔离 state，不会自动回退到 profile。`browser-opt` 不使用 focused browser 复用普通 Chrome 登录态，因为普通 Chrome 通常没有开放 CDP 调试端口，容易连到错误的临时浏览器。

`browser-opt` 默认显示并保留真实浏览器，便于观察操作流程和执行后的页面状态，但不会打开 agent-browser 的 `http://localhost:4848` 截图面板。

保存流程并在当前项目中一句话复用：

```bash
browser-opt save "示例首页验证流程" --flow "测试 https://example.com。
1. 验证页面包含 \"Example\"。"
browser-opt run "执行示例首页验证流程"
```

Workflow 默认保存到当前工作目录的 `.browser-opt/workflows/`。可以通过
`browser-opt list` 查看，或用 `browser-opt match "<查询>" --json` 获取 Skill
可解析的唯一命中、前三个相似候选或未命中结果。

保存后的 JSON 会落成更适合人工维护的结构化格式，大致如下：

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

其中 `steps` 是纯字符串数组，方便手动调整顺序和文案；运行时会再渲染回 browser-opt 现有的自然语言执行格式。

E2E skill 流程：

```bash
npx browser-e2e "测试网站 https://example.com/login 的登录功能。

目标：
1. 打开登录页面。
2. 输入用户名 \"testuser\" 和密码 \"password123\"。
3. 点击登录按钮。
4. 验证 URL 包含 /dashboard。"
```

直接执行 E2E workflow：

```bash
npx browser-e2e run https://example.com "打开 pricing 页面并进入 contact 页面" --assert "Contact 页面应可见"
```

从自然语言生成 Playwright 测试：

```bash
npx browser-e2e gen https://example.com "打开 pricing 页面并进入 contact 页面" --name "pricing contact flow" --tags marketing,navigation
```

生成产物：

- `tests/generated/*.spec.ts`
- `tests/generated/index.json`

## Handoff

`browser-opt` 在受保护页面检测到登录态失效时，会优先保留当前 session 进入用户接管：

1. 打开同一 session 的可见浏览器。
2. 提示用户完成登录、验证码、授权或 MFA。
3. 用户输入 `done`、`ok`、`继续` 或 `完成` 后恢复自动化。
4. 恢复后等待页面离开登录态，再保存新的 cookies/storage 到 state 文件。

`browser-e2e` 在遇到 CAPTCHA、OAuth、MFA 或连续失败 3 次后也会触发同一类用户接管。

`--profile <name>` 可指定首次打开使用的 Chrome profile。`--state <path>` 可指定登录态 state 文件，`--session <id>` 可覆盖自动生成的稳定 session，`--no-live-viewport` 可关闭可见浏览器。

## Skill 入口

项目内置两个 Skill：

- `skills/browser-opt`：执行即时或已保存的浏览器 Workflow 并产出证据，不生成测试。
- `skills/browser-e2e`：优先匹配已有 Playwright 测试；未命中时执行一次性流程；通过后可生成测试代码。

`/browser-opt` 在其他项目中的安装、软链调试、`npm link` 后的更新规则，以及当前项目的即时测试方式见 [docs/browser-opt-debug.md](/Users/lee/Documents/project/browser-automated/docs/browser-opt-debug.md)。

## 开发

```bash
npm run build
npm test
npm run typecheck
```

## 目录速览

```text
src/
  cli/                    # browser-opt、browser-e2e 和兼容入口
  core/                   # agent-browser 封装与共享类型
  browser-opt/            # browser-opt 执行闭环、Workflow 存储匹配与报告生成
  browser-e2e/            # E2E 执行、生成、索引、匹配与 handoff

skills/
  browser-opt/            # 一次性浏览器控制 Skill
  browser-e2e/            # E2E 执行与生成 Skill

tests/
  core/                   # BrowserAgent 等共享底层能力测试
  browser-opt/            # browser-opt 执行闭环测试
  browser-e2e/            # E2E 执行、生成、复用链路测试
  cli/                    # CLI 参数和用户侧行为测试
  generated/              # 生成的 Playwright 测试和索引
```
