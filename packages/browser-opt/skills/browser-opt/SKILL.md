---
name: browser-opt
description: Save, match, and execute project-level natural-language browser workflows with agent-browser, and inspect or update the installed browser-opt npm package version. Use for one-shot flows, reusable Workflow requests, interactive handoff, simplified PASS/FAIL evidence, version queries, update checks, and npm package updates.
---

# browser-opt skill

This skill is the deterministic browser execution entrypoint. It is intentionally separate from `browser-e2e`: `browser-opt` runs the flow now and reports evidence; it does not match generated tests or create Playwright code.

By default, the calling AI is responsible for understanding the page from `snapshot --json`; `agent-browser` only executes deterministic commands such as `open`, `fill @ref`, `click @ref`, screenshots, and waits. Do not use `agent-browser chat` unless the user explicitly asks for the legacy chat mode or passes `--agent-chat`.

## npm package version management

Treat explicit version queries and update requests as package management. Do not open Chrome,
start a browser run, or perform the normal pre-run update check for these requests.

- To view the installed `browser-opt` package version, run `browser-opt --version`.
- To compare the installed version with the current npm registry version, run
  `browser-opt check-update --no-cache --json`. Use `--no-cache` for an explicit user query so
  the answer is not taken from the short-lived background cache. Report `currentVersion`,
  `latestVersion`, and `status`. If the status is `unknown`, report the returned error and do not
  claim that the package is current.
- To update the npm package to the latest version, first resolve the current `browser-opt`
  executable and its real target. If it points into a local development repository, preserve the
  local link and report that package update is blocked by local-source mode; in that repository,
  use `npm run browser-opt:use-npm` only when the user explicitly wants to leave local-source mode.
  Otherwise run `browser-opt update`.
- After an update, run `browser-opt --version` and
  `browser-opt check-update --no-cache --json` again. Report the installed version and whether it
  matches npm. If `update` reports that the shell still resolves a stale executable, report both
  paths and versions instead of claiming the shell is already using the update.

Examples:

```text
/browser-opt 查看当前安装的 npm 包版本
/browser-opt 检查 browser-opt 是否有新版本
/browser-opt 更新 browser-opt npm 包到最新版
```

Natural-language steps that explicitly ask to open developer tools are mapped to
CDP's experimental `Target.openDevTools` command. This opens native DevTools for
the active target in the same Chrome window; do not use `agent-browser inspect`,
which opens a separate DevTools frontend URL. If the current Chrome version does
not support `Target.openDevTools`, report the failure instead of falling back to
the separate frontend. Supported expressions include `打开开发者工具`,
`启动 DevTools`, `调起 Chrome DevTools`, and `inspect current page`:

```text
/browser-opt 测试 https://example.com 的页面调试流程。

目标：
1. 打开开发者工具。
```

## Image upload examples

For test environments, describe upload steps as automatic URL uploads. `browser-opt` downloads the remote image into the run evidence directory and calls `agent-browser upload` with the local file path:

```text
/browser-opt 测试 https://example.com/live/create 的直播间创建流程。

目标：
1. 打开页面。
2. 在“直播间名称”输入“自动化测试直播间”。
3. 自动上传“直播间分享封面”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。
4. 自动上传“直播间封面”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。
5. 验证页面显示封面预览或上传成功状态。
```

For production environments, describe upload steps as manual handoff so the operator can choose real local images through the system file picker:

```text
/browser-opt 操作 https://example.com/live/create 的直播间创建流程。

目标：
1. 打开页面。
2. 在“直播间名称”输入“正式直播间名称”。
3. handoff 给操作人员：请手动选择“直播间分享封面”的本地真实图片，并在裁剪/确认完成后恢复自动化。
4. handoff 给操作人员：请手动选择“直播间封面”的本地真实图片，并在裁剪/确认完成后恢复自动化。
5. 验证页面显示封面预览或上传成功状态。
```

## Required agent-browser practice

Every execution must follow these rules:

- Before each `/browser-opt` execution, run `browser-opt check-update --json` once. If it returns
  `outdated`, tell the user the current and latest versions and recommend
  `browser-opt update`; if the shell still points to a stale binary or `update` 不可用，再回退到 `npx browser-opt@latest install`；然后继续
  requested workflow unless the user asks to update first. If it returns `unknown`, continue without blocking.
- 如果 `browser-opt` 因执行权限失败，先检查命令软链的真实目标。真实目标位于本地开发仓库时，禁止运行
  `npx browser-opt@latest install` 覆盖本地链接；应在该仓库重新运行 `npm run browser-opt:use-local`，再确认
  `browser-opt:status` 显示“本地源码”。
- Always open the actual system Chrome browser for the run. Do not open or operate inside the agent tool's built-in browser, including the Copilot/Codex in-app browser or any agent-browser dashboard/preview window.
- Strictly run an `open -> snapshot --json -> deterministic act -> re-snapshot` loop.
- Take a screenshot for every step.
- Use text matching or element existence checks for verification points.
- Retry with a fresh snapshot when an action fails or an element reference is stale.
- Use `--json` output when parsing elements.
- After every step, reason about the current page state and the next action.
- If a reference becomes invalid, take a fresh snapshot before retrying.
- Prefer deterministic commands and element refs over natural-language `chat`.
- Final report must include `PASS` or `FAIL`, evidence screenshot paths, and detailed logs.

## Interactive handoff execution

Start every browser run that may require handoff as a detached task and keep the returned stable `runId`. This applies to both full flows with a URL and saved workflows. Do not keep an `exec_command` or PTY session id as the recovery handle; Codex may discard that process handle when the handoff response ends the current turn.

```bash
browser-opt start --flow "<full natural language flow>" --json
browser-opt start --workflow-id "<matched.id>" --json
browser-opt status --run-id "<runId>" --json
```

Poll `status` until it returns `PASS`, `FAIL`, or `HANDOFF`. When it returns `HANDOFF`, ask the user to finish the manual action and end the current turn normally. After the user replies `done`, restore the original runner and browser with:

```bash
browser-opt resume --run-id "<runId>" --json
browser-opt status --run-id "<runId>" --json
```

The detached task executes the requested flow exactly once. `status` is read-only and `resume` only sends a one-time signal to that original process. Never start a second direct flow, `run`, or `start` command to simulate resume.

## Saved workflows

Reusable flows are stored as JSON files under the calling project's
`.browser-opt/workflows/` directory by default. Resolve relative paths from the
calling project's current working directory, not from this skill or package directory.

Install the browser environment and this Skill explicitly before the first Workflow run:

```bash
npx browser-opt@latest install
```

The installer installs or updates the global `browser-opt` CLI and `agent-browser`
runtime once so ordinary Workflow calls do not execute `npx`. By default it uses
the system's standard Chrome and installs into the shared Agent Skills directory.
Codex, GitHub Copilot, Gemini CLI, and Qoder share this default directory. Use
`--agent claude` for Claude Code, `--skills-dir <dir>` for another agent root, or
`--skip-runtime` when only the Skill should be installed. Update all installed
components later with `browser-opt update`；如果当前 shell 仍指向旧二进制，再回退到 `npx browser-opt@latest install`。
Use the global command for ordinary invocations on macOS, Linux, and Windows:

```bash
browser-opt
```

To remove the global runtime and installed Skill, run:

```bash
browser-opt uninstall
```

Use `--all-data` only when the current project's `.browser-opt` states, artifacts, and handoff records should
also be deleted.

Treat an explicit save request as Workflow management, not browser execution. Extract the
Workflow name and the complete natural-language flow from the request, then run `save`.
Do not open Chrome, call `start`, or execute the saved flow while saving it:

```bash
browser-opt save "创建安选公开直播流程" --flow "<full natural language flow>"
browser-opt save "创建安选公开直播流程" --flow "<full natural language flow>" --workflow-dir ./custom/workflows
```

The flow must include one target URL and all reusable business steps and verification
points. Preserve concrete test data, upload URLs, and handoff instructions. If the request
does not provide a Workflow name or target URL, ask for the missing value instead of
inventing it. Saving an existing name fails by default. Only pass `--force` when the user
explicitly asks to overwrite or update that Workflow. After saving, report the Workflow
name and returned file path, and show the short `/browser-opt` request that can execute it.

Example Skill request for saving without execution:

```text
/browser-opt 把下面的流程保存为“示例首页验证流程”，先不要执行。

目标页面：https://example.com

目标：
1. 验证页面包含“Example Domain”。
2. 点击“More information”链接。
3. 验证跳转后的页面可以正常访问。
```

Translate it into a single save command:

```bash
browser-opt save "示例首页验证流程" --flow "测试 https://example.com。\n\n目标：\n1. 验证页面包含“Example Domain”。\n2. 点击“More information”链接。\n3. 验证跳转后的页面可以正常访问。"
```

Then the user can execute the saved Workflow with this Skill request:

```text
/browser-opt 执行示例首页验证流程
```

Saved workflow files are structured JSON, not a single `flow` string. The
persisted schema uses `target.url` as the page entrypoint plus a `steps` string
array for business actions after the page is opened. When `target.url` exists,
do not include a first step such as "打开页面":

```json
{
  "id": "创建安选公开直播流程",
  "name": "创建安选公开直播流程",
  "target": {
    "url": "https://example.com/live/create"
  },
  "steps": [
    "在“直播间名称”输入“自动化测试直播间”。",
    "验证页面包含“创建成功”。"
  ],
  "createdAt": "2026-07-28T08:00:00.000Z",
  "updatedAt": "2026-07-28T08:00:00.000Z"
}
```

When `/browser-opt` is followed by an execution request without a URL, such as:

```text
/browser-opt 执行创建安选公开直播流程
```

Do not treat it as a new one-shot flow. First run:

```bash
browser-opt match "<short request>" --json
```

Handle the JSON result as follows:

- `matched`: run `browser-opt start --workflow-id "<matched.id>" --json`, retain its `runId`, and follow the interactive handoff execution protocol above.
- `ambiguous`: do not rely on the CLI's human-readable stdout as the user-facing
  choice list, and do not ask through a modal/input tool that may render Markdown
  as plain text. Parse `match --json`, then ask in a normal assistant message.
  Show the returned candidates, at most three, numbered from 1. Render each
  candidate name itself as a Markdown file link using `filePath`, such as
  `[创建安选公开直播流程](</absolute/path/创建安选公开直播流程.json>)`. Do not show a
  bare `file://` URL. Ask the user to reply with the number (for example `1`,
  `2`, or `3`), even when there is only one weakly similar candidate. Do not
  open a browser before the choice. Then map the selected number back to the
  candidate ID and run it. In GitHub Copilot Chat, local Markdown file links may
  render as plain text; include `displayPath` in backticks after the link so the
  path remains visible and can be opened through VS Code's file detection.
- `not-found`: tell the user no saved workflow matched and show the returned
  available workflow names as Markdown file links using `filePath` when present.
  Ask for a more specific request or a full flow with URL.
- Warnings describe invalid workflow files that were skipped. Report them without
  blocking valid candidates.

Use `--workflow-dir` consistently on both `match` and `run` when the user selects
a custom directory. Use `browser-opt list --json` when
the user asks to see all saved workflows.

Example ambiguous response format:

```markdown
匹配结果是 `ambiguous`，请回复要执行的流程编号：

1. [创建安选公开直播（测试环境）](</Users/lee/project/.browser-opt/workflows/创建安选公开直播（测试环境）.json>)
   `.browser-opt/workflows/创建安选公开直播（测试环境）.json`
2. [创建安选私域直播](</Users/lee/project/.browser-opt/workflows/创建安选私域直播.json>)
   `.browser-opt/workflows/创建安选私域直播.json`

请回复数字，例如 `1`。
```

## Trigger

Use `/browser-opt` followed by either a full natural-language flow or a saved
workflow request. A full flow includes its target URL:

```text
/browser-opt 测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 在搜索框输入 "agent-browser"。
3. 点击搜索按钮。
4. 验证搜索结果页面是否包含至少 3 个结果项。
5. 点击第一个结果，验证跳转正确。
```

Translate that into:

```bash
browser-opt start --flow "<full natural language flow>" --json
```

Keep the returned `runId`, poll it with `status`, and use `resume` after every handoff as described above. Do not execute a full flow through a long-running shell or PTY handle.

Optional runtime flags:

```bash
browser-opt "<flow>" --profile Default
browser-opt "<flow>" --state ./.browser-opt/states/browser-opt-default.json
browser-opt "<flow>" --no-live-viewport
browser-opt "<flow>" --output-dir ./.browser-opt/artifacts
browser-opt "<flow>" --agent-chat
```

Auth state reuse policy:

- `browser-opt` first checks its saved auth state under `.browser-opt/states/`.
- If a default state file exists, it loads that state first, so only cookies/storage are reused and prior Chrome tabs are not restored.
- If the default state opens on a login screen or later redirects there, close the state window and replace it once with the selected Chrome profile before entering handoff. Keep that profile window and the original `browser-opt` runner alive for resume so the operator can use Chrome's password manager.
- Saved workflows keep the original runner alive as a detached task and use `runId` for handoff recovery across Codex turns; an `exec_command` session id is never a durable recovery handle.
- Programmatic runs use the same one-time profile fallback when the default state is invalid.
- If no default state file exists, the single main agent opens the target directly with `--profile Default` and saves state from that same window. Do not create a separate profile importer.
- Pass `--profile <name>` to choose a different Chrome profile for first import and default-state fallback.
- Pass `--state <path>` to use a custom state file without automatic profile fallback.
- Do not rely on focused-browser reuse for login import: ordinary Chrome is usually not CDP-accessible, and auto-connect can attach to the wrong temporary browser.

It explicitly pins the system's standard Chrome executable and isolates the `browser-opt` agent-browser namespace, so a previously installed Chrome for Testing daemon cannot be reused accidentally. It shows and keeps that actual system Chrome browser by default so the user can watch the operation and inspect the final page state. This must be a real Chrome window, not the agent tool's built-in browser such as the Copilot/Codex in-app browser, and it must not open the agent-browser dashboard at `http://localhost:4848`. Use `--no-live-viewport` only when the user explicitly wants headless execution. `--agent-chat` is a legacy compatibility mode. It may require `AI_GATEWAY_API_KEY`; avoid it when the caller can inspect snapshots and produce deterministic actions.

## Output

The CLI writes an evidence directory under `.browser-opt/artifacts/` unless `--output-dir` is provided.

Expected artifacts:

- `report.json` for machine parsing.
- `report.md` for human review.
- `00-open.png`, `01-before.png`, `01-after.png`, and later step screenshots.
- `*.snapshot.json` files captured through `agent-browser snapshot -i --json`.

The assistant response must be concise:

- If the run succeeds, reply only with `执行成功`.
- If the run fails, summarize the failure status, report paths, screenshot paths, and failing step.
