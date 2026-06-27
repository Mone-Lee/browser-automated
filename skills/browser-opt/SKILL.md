---
name: browser-opt
description: Execute natural-language browser flows with agent-browser and produce PASS/FAIL evidence reports.
summary: Run M1 natural-language browser execution loops with screenshots, JSON snapshots, retries, and detailed logs.
---

# browser-opt skill

This skill is the M1 natural-language execution entrypoint. It is intentionally separate from `browser-e2e`: `browser-opt` runs the flow now and reports evidence; it does not match generated tests or create Playwright code.

## First-use reminder

For the first `browser-opt` invocation in each conversation, remind the user of the universal test template and the natural-language example before running the CLI:

```text
通用测试模板：
你是一个专业的自动化测试 Agent 执行以下测试用例：

网站：{URL}
测试用例：{描述，如 "用户注册流程"}

预期结果：
1. {步骤1}
2. {步骤2}
...

自然语言流程示例：
测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 在搜索框输入 "agent-browser"。
3. 点击搜索按钮。
4. 验证搜索结果页面是否包含至少 3 个结果项。
5. 点击第一个结果，验证跳转正确。
```

After the reminder, execute the user's supplied flow without asking for confirmation when the flow includes a URL.

## Required agent-browser practice

Every execution must follow these rules:

- Strictly run an `open -> snapshot --json -> act -> re-snapshot` loop.
- Take a screenshot for every step.
- Use text matching or element existence checks for verification points.
- Retry with a fresh snapshot when an action fails or an element reference is stale.
- Use `--json` output when parsing elements.
- After every step, reason about the current page state and the next action.
- If a reference becomes invalid, take a fresh snapshot before retrying.
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
browser-opt "<flow>" --profile Default
browser-opt "<flow>" --no-live-viewport
browser-opt "<flow>" --output-dir ./artifacts/browser-opt
```

## Output

The CLI writes an evidence directory under `artifacts/browser-opt/` unless `--output-dir` is provided.

Expected artifacts:

- `report.json` for machine parsing.
- `report.md` for human review.
- `00-open.png`, `01-before.png`, `01-after.png`, and later step screenshots.
- `*.snapshot.json` files captured through `agent-browser snapshot -i --json`.

The assistant response should summarize only the status, report paths, screenshot paths, and any failing step.
