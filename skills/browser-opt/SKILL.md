---
name: browser-opt
description: Execute natural-language browser flows with agent-browser and produce simplified PASS/FAIL results.
summary: Run deterministic browser execution loops with screenshots, JSON snapshots, retries, and concise success output.
---

# browser-opt skill

This skill is the deterministic browser execution entrypoint. It is intentionally separate from `browser-e2e`: `browser-opt` runs the flow now and reports evidence; it does not match generated tests or create Playwright code.

By default, the calling AI is responsible for understanding the page from `snapshot --json`; `agent-browser` only executes deterministic commands such as `open`, `fill @ref`, `click @ref`, screenshots, and waits. Do not use `agent-browser chat` unless the user explicitly asks for the legacy chat mode or passes `--agent-chat`.

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

For saved workflows, start the browser run as a detached task and keep the returned stable `runId`. Do not keep an `exec_command` or PTY session id as the recovery handle; Codex may discard that process handle when the handoff response ends the current turn.

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js start --workflow-id "<matched.id>" --json
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js status --run-id "<runId>" --json
```

Poll `status` until it returns `PASS`, `FAIL`, or `HANDOFF`. When it returns `HANDOFF`, ask the user to finish the manual action and end the current turn normally. After the user replies `done`, restore the original runner and browser with:

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js resume --run-id "<runId>" --json
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js status --run-id "<runId>" --json
```

The detached task still executes `browser-opt run` exactly once. `status` is read-only and `resume` only sends a one-time signal to that original process. Never start a second `run` or `start` command to simulate resume.

## Saved workflows

Reusable flows are stored as JSON files under the calling project's
`.browser-opt/workflows/` directory by default. Resolve relative paths from the
calling project's current working directory, not from this skill or package directory.

This local symlinked skill should invoke the current repository's built CLI
directly, because the agent execution environment may not include the globally
linked npm bin directory in `PATH`. The repository must be built during setup
or after source changes; do not run `npm --prefix ... run build` from the
calling project's sandbox. Use this command prefix for every `browser-opt`
invocation:

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js
```

Only use `browser-opt ...` when `command -v browser-opt` succeeds in the same
execution environment. Only use `npx browser-opt ...` when the calling project
has installed the package locally or the npm package has been published.

Save a complete flow without executing it:

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js save "创建安选公开直播流程" --flow "<full natural language flow>"
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js save "创建安选公开直播流程" --flow "<full natural language flow>" --workflow-dir ./custom/workflows
```

Saving an existing name fails by default. Only pass `--force` when the user
explicitly wants to replace it.

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

When `/browser-opt` is followed by a short request without a URL, such as:

```text
/browser-opt 执行创建安选公开直播流程
```

Do not treat it as a new one-shot flow. First run:

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js match "<short request>" --json
```

Handle the JSON result as follows:

- `matched`: run `/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js start --workflow-id "<matched.id>" --json`, retain its `runId`, and follow the interactive handoff execution protocol above.
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
a custom directory. Use `/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js list --json` when
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
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js "<full natural language flow>"
```

Optional runtime flags:

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js "<flow>" --profile Default
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js "<flow>" --state ./.browser-opt/states/browser-opt-default.json
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js "<flow>" --no-live-viewport
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js "<flow>" --output-dir ./.browser-opt/artifacts
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/dist/cli/browser-opt.js "<flow>" --agent-chat
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

It shows and keeps the actual system Chrome browser by default so the user can watch the operation and inspect the final page state. This must be a real Chrome window, not the agent tool's built-in browser such as the Copilot/Codex in-app browser, and it must not open the agent-browser dashboard at `http://localhost:4848`. Use `--no-live-viewport` only when the user explicitly wants headless execution. `--agent-chat` is a legacy compatibility mode. It may require `AI_GATEWAY_API_KEY`; avoid it when the caller can inspect snapshots and produce deterministic actions.

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
