/**
 * 集中存放 CLI 层的共享常量与长文本提示，避免命令实现文件混入大量展示文案。
 * 这些常量会被多个入口和命令复用，独立存放后更便于维护与后续扩展。
 */

export const LIVE_VIEWPORT_DASHBOARD_URL = 'http://localhost:4848';

export const HANDOFF_DONE_ANSWERS = ['done', 'ok', '继续', '完成'] as const;

export const BROWSER_E2E_SKILL_USAGE = `使用方式：
      browser-e2e <自然语言测试描述>

示例：
  browser-e2e 测试网站 https://example.com/login 的登录功能。\n\n目标：\n1. 打开登录页面。\n2. 输入用户名 "testuser" 和密码 "password123"。\n3. 点击登录按钮。\n4. 验证是否跳转到仪表盘页面（URL 包含 /dashboard 或看到欢迎文字）。`;

export const BROWSER_OPT_USAGE = `使用方式：
  browser-opt <自然语言流程> [--state <path>] [--profile <name>] [--reuse-focused-browser] [--clean-browser] [--no-live-viewport] [--output-dir <dir>] [--agent-chat]`;

export const BROWSER_E2E_BIN_USAGE = `
Usage: browser-e2e <natural-language-case> [options]
       browser-e2e run <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>]
       browser-e2e gen <url> <instruction> [--name <name>] [--tags <a,b>]

Commands:
  <natural-language-case>
      Skill 入口：提取 URL、匹配已有 Playwright 测试，未命中时执行一次性 NL 流程。

  run <url> <instruction>
      执行 E2E skill workflow：优先代码用例，未命中时回退一次性执行。

  gen <url> <instruction>
      从自然语言流程生成可复用 Playwright 测试。
`;

export const LEGACY_CLI_USAGE = `
Usage: browser-automated <command> [options]

Note:
  browser-automated 是历史兼容入口；新集成请优先使用 browser-opt / browser-e2e。

Commands:
  run  <test-file.json>  [--bail] [--screenshot-on-failure]
       Run e2e test cases defined in a JSON file.

  gen  <url> <description>
       Generate a test case JSON from a natural language description.

  chat <url> <instruction>
       Execute a single natural language instruction in the browser.

    e2e <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>] [--profile <name>] [--no-live-viewport]
      Trigger e2e skill workflow: prefer existing Playwright test, fallback to one-shot NL execution.

    e2e-gen <url> <instruction> [--name <name>] [--tags <a,b>]
      Generate a reusable Playwright test from natural language flow.

    browser-opt <natural-language-flow> [--profile <name>] [--no-live-viewport] [--output-dir <dir>]
      Execute an M1 natural-language browser flow with screenshots, JSON snapshots, and a PASS/FAIL report.

Examples:
  browser-automated run tests/login.json --screenshot-on-failure
  browser-automated gen https://example.com "Fill the contact form and submit"
  browser-automated chat https://example.com "Click the sign-in button"
  browser-e2e run https://example.com "Search for pricing and open contact"
  browser-e2e run https://example.com "Login and verify dashboard"
  browser-e2e run https://example.com "Login and verify dashboard" --profile Work --no-live-viewport
  browser-e2e gen https://example.com "Search for pricing and open contact" --name "pricing contact flow"
  browser-opt "测试 https://example.com 的搜索功能。\\n\\n目标：\\n1. 打开首页。\\n2. 验证页面包含 Example"
`;
