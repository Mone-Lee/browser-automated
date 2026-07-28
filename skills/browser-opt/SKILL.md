---
name: browser-opt
description: Execute natural-language browser flows with agent-browser and produce simplified PASS/FAIL results.
summary: Run deterministic browser execution loops with screenshots, JSON snapshots, retries, and concise success output.
---

# browser-opt skill

This skill is the deterministic browser execution entrypoint. It is intentionally separate from `browser-e2e`: `browser-opt` runs the flow now and reports evidence; it does not match generated tests or create Playwright code.

By default, the calling AI is responsible for understanding the page from `snapshot --json`; `agent-browser` only executes deterministic commands such as `open`, `fill @ref`, `click @ref`, screenshots, and waits. Do not use `agent-browser chat` unless the user explicitly asks for the legacy chat mode or passes `--agent-chat`.

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

## Saved workflows

Reusable flows are stored as versioned JSON files under the calling project's
`browser-opt/workflows/` directory by default. Resolve relative paths from the
calling project's current working directory, not from this skill or package directory.

Save a complete flow without executing it:

```bash
browser-opt save "创建安选公开直播流程" --flow "<full natural language flow>"
browser-opt save "创建安选公开直播流程" --flow "<full natural language flow>" --workflow-dir ./custom/workflows
```

Saving an existing name fails by default. Only pass `--force` when the user
explicitly wants to replace it.

When `/browser-opt` is followed by a short request without a URL, such as:

```text
/browser-opt 执行创建安选公开直播流程
```

Do not treat it as a new one-shot flow. First run:

```bash
browser-opt match "<short request>" --json
```

Handle the JSON result as follows:

- `matched`: run `browser-opt run --workflow-id "<matched.id>"`.
- `ambiguous`: show the returned candidates, at most three, and ask the user to
  choose one. Do not open a browser before the choice. Then run the selected ID.
- `not-found`: tell the user no saved workflow matched and show the returned
  available workflow names. Ask for a more specific request or a full flow with URL.
- Warnings describe invalid workflow files that were skipped. Report them without
  blocking valid candidates.

Use `--workflow-dir` consistently on both `match` and `run` when the user selects
a custom directory. Use `browser-opt list --json` when the user asks to see all
saved workflows.

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
browser-opt "<full natural language flow>"
```

Optional runtime flags:

```bash
browser-opt "<flow>" --profile Default
browser-opt "<flow>" --state ./.browser-automated/states/browser-opt-default.json
browser-opt "<flow>" --no-live-viewport
browser-opt "<flow>" --output-dir ./artifacts/browser-opt
browser-opt "<flow>" --agent-chat
```

Auth state reuse policy:

- `browser-opt` first checks its saved auth state under `.browser-automated/states/`.
- If a default state file exists, it loads that state first, so only cookies/storage are reused and prior Chrome tabs are not restored.
- If the default state opens on a login screen, or the page asynchronously redirects to login before/during a step, `browser-opt` falls back to the selected Chrome profile once and saves refreshed cookies/storage back to the default state file.
- If no default state file exists, it starts once with `--profile Default` and saves cookies/storage for later runs.
- Pass `--profile <name>` to choose a different Chrome profile for first import and default-state fallback.
- Pass `--state <path>` to use a custom state file without automatic profile fallback.
- Do not rely on focused-browser reuse for login import: ordinary Chrome is usually not CDP-accessible, and auto-connect can attach to the wrong temporary browser.

It shows and keeps the actual system Chrome browser by default so the user can watch the operation and inspect the final page state. This must be a real Chrome window, not the agent tool's built-in browser such as the Copilot/Codex in-app browser, and it must not open the agent-browser dashboard at `http://localhost:4848`. Use `--no-live-viewport` only when the user explicitly wants headless execution. `--agent-chat` is a legacy compatibility mode. It may require `AI_GATEWAY_API_KEY`; avoid it when the caller can inspect snapshots and produce deterministic actions.

## Output

The CLI writes an evidence directory under `artifacts/browser-opt/` unless `--output-dir` is provided.

Expected artifacts:

- `report.json` for machine parsing.
- `report.md` for human review.
- `00-open.png`, `01-before.png`, `01-after.png`, and later step screenshots.
- `*.snapshot.json` files captured through `agent-browser snapshot -i --json`.

The assistant response must be concise:

- If the run succeeds, reply only with `执行成功`.
- If the run fails, summarize the failure status, report paths, screenshot paths, and failing step.
