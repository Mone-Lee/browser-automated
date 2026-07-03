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

- Strictly run an `open -> snapshot --json -> deterministic act -> re-snapshot` loop.
- Take a screenshot for every step.
- Use text matching or element existence checks for verification points.
- Retry with a fresh snapshot when an action fails or an element reference is stale.
- Use `--json` output when parsing elements.
- After every step, reason about the current page state and the next action.
- If a reference becomes invalid, take a fresh snapshot before retrying.
- Prefer deterministic commands and element refs over natural-language `chat`.
- Final report must include `PASS` or `FAIL`, evidence screenshot paths, and detailed logs.

## Trigger

Use `/browser-opt` followed by the full natural-language flow:

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
browser-opt "<flow>" --state ./auth-state.json
browser-opt "<flow>" --profile Default
browser-opt "<flow>" --clean-browser
browser-opt "<flow>" --no-live-viewport
browser-opt "<flow>" --output-dir ./artifacts/browser-opt
browser-opt "<flow>" --agent-chat
```

`--state <path>` is the preferred way to reuse login state without inheriting Chrome tabs or restore prompts. Without an explicit state file, `browser-opt` opens the requested URL once in a clean headed window. Pass `--reuse-focused-browser` only when the running Chrome is already CDP-accessible, or `--profile <name>` only when full profile behavior is desired. It shows and keeps the real headed browser by default so the user can watch the operation and inspect the final page state, but it must not open the agent-browser dashboard at `http://localhost:4848`. Use `--no-live-viewport` only when the user explicitly wants headless execution. `--agent-chat` is a legacy compatibility mode. It may require `AI_GATEWAY_API_KEY`; avoid it when the caller can inspect snapshots and produce deterministic actions.

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
