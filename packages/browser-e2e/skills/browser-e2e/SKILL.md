---
name: browser-e2e
description: Prefer generated Playwright tests for natural-language e2e requests, fallback to deterministic one-shot execution and guide code generation.
summary: Run browser e2e automation with code-first reuse and deterministic browser commands.
---

# browser-e2e skill

This skill orchestrates browser automation with three stages:

1. Try to match an existing generated Playwright e2e test and execute it.
2. If no strong match exists, run one-shot deterministic e2e via agent-browser commands.
3. If one-shot execution passes, guide or auto-generate a reusable Playwright test.

## Execution mode

One-shot execution is deterministic by default:

- Uses `open`, `snapshot -i`, `fill`, `click`, `get url`, and assertion checks.
- Does not depend on `agent-browser chat`.
- Does not require `AI_GATEWAY_API_KEY` for one-shot execution.

Default runtime behavior for one-shot execution:

- Prefer `--state <path>` when only login state should be reused without Chrome tabs or restore prompts. Without a state file, open the requested URL once in a clean headed window. Use `--reuse-focused-browser` only when the running Chrome is already CDP-accessible, or `--profile <name>` only when full profile behavior is desired.
- Live viewport is enabled by default; use `--no-live-viewport` to disable.
- The dashboard page (`http://localhost:4848`) is auto-opened when live viewport is active.

Note: if the target page has captcha, deterministic runs may still need captcha handling (manual input, test whitelist, or backend bypass policy).

## User Handoff

When headless automation cannot continue (CAPTCHA, complex auth, MFA), hand off control to the user:

```bash
# 1. Open a visible Chrome at the current page
$B handoff "Stuck on CAPTCHA at login page"

# 2. Ask user to finish manual steps
#    "I've opened Chrome at the login page. Please solve the CAPTCHA
#     and let me know when you're done."

# 3. After user says done, continue from current state
$B resume
```

### Handoff trigger policy

- Immediate handoff when challenge signals are detected:
	- CAPTCHA / bot detection
	- OAuth authorization / consent flows
	- MFA / 2FA verification flows
- Fallback handoff after 3 consecutive failures when no challenge signal is detected.
- Browser state (cookies, localStorage, tabs) is preserved across handoff and resume.

## Trigger

Use `/browser-e2e` prefix followed by the full natural language description to invoke this skill:

```
/browser-e2e 测试网站 <url> 的<功能>。

目标：
1. 打开页面。
2. 执行关键输入。
3. 执行关键点击。
4. 验证 URL 或页面关键文案。
```

Install the published CLI and this Skill with `npx --yes browser-e2e setup`.
By default it installs to the shared Agent Skills directory, similar to
`npx skills add`. Use `--agent claude` for the Claude Code skills directory, or
`--skills-dir <dir>` for another agent root.
Use this command prefix for every `browser-e2e` invocation:

```bash
npx --yes browser-e2e
```

Only use `browser-e2e ...` when `command -v browser-e2e` succeeds in the same
execution environment; otherwise use `npx --yes browser-e2e ...`.

The agent translates this into:

```bash
npx --yes browser-e2e "<full natural language text>"
```

## CLI commands

- `npx --yes browser-e2e <自然语言测试描述>` — 主入口，提取 URL、检查已有用例、交互式决策
- `npx --yes browser-e2e setup [--with-deps] [--skip-skill] [--agent agents|claude] [--skills-dir <dir>]`
- `npx --yes browser-e2e run <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>]`
- `npx --yes browser-e2e gen <url> <instruction> [--name <name>] [--tags <a,b>]`

Deterministic action patterns recognized from natural language steps:

- 打开/访问页面 -> `open`
- 输入/填写用户名、密码、验证码 -> `snapshot -i` + `fill`
- 点击按钮（如登录） -> `snapshot -i` + `click`
- 验证 URL 包含 /xxx -> `get url` + include check
- 验证看到关键文案 -> snapshot text include check

## Artifacts

- Generated tests: `tests/generated/*.spec.ts`
- Generated index: `tests/generated/index.json`

## Matching strategy

- Primary: keyword and tags match.
- Fallback: token-overlap semantic score.

## Natural language case template

Use this format when writing one-shot test cases:

```text
测试网站 <url> 的<功能>。

目标：
1. <步骤1>
2. <步骤2>
3. <步骤3>
4. <验证步骤>
```

Login example:

```text
测试网站 https://example.com/login 的登录功能。

目标：
1. 打开登录页面。
2. 输入用户名 "testuser" 和密码 "password123"。
3. 点击登录按钮。
4. 验证是否跳转到仪表盘页面（URL 包含 /dashboard 或看到欢迎文字）。
```

## Migration note

Older versions may mention one-shot execution via `agent-browser chat`.
Current behavior is deterministic-first. If you need LLM-driven execution, use explicit custom scripts instead of the default `browser-e2e` one-shot flow.
