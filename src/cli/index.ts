#!/usr/bin/env node
/**
 * 统一承载 browser-opt、browser-e2e 与历史 browser-automated 入口的参数分发。
 * 对外主产物是 browser-opt / browser-e2e；browser-automated 仅保留兼容旧命令。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { NaturalLanguageTestRunner } from '../browser-e2e/runner.js';
import { TestCaseGenerator } from '../browser-e2e/generate.js';
import { BrowserAgent } from '../core/agent.js';
import { executeDeterministicScenario } from '../browser-e2e/deterministic.js';
import { BrowserE2ETestReuseService } from '../browser-e2e/test-reuse/service.js';
import { executePlaywrightSpec } from '../browser-e2e/test-reuse/playwright.js';
import { BrowserOptRunner, browserOptTemplate } from '../browser-opt/runner.js';
import type { TestCase, TestRunSummary } from '../core/types.js';

const LIVE_VIEWPORT_DASHBOARD_URL = 'http://localhost:4848';

export async function runCli(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case 'run':
      await cmdRun(args);
      break;
    case 'gen':
      await cmdGen(args);
      break;
    case 'chat':
      await cmdChat(args);
      break;
    case 'browser-e2e':
      await cmdBrowserE2E(args);
      break;
    case 'browser-opt':
      await cmdBrowserOpt(args);
      break;
    case 'e2e':
      await cmdE2E(args);
      break;
    case 'e2e-gen':
      await cmdE2EGen(args);
      break;
    default:
      printUsage(command);
      process.exit(1);
  }
}

export async function runBrowserOptCli(args: string[]): Promise<void> {
  await cmdBrowserOpt(args);
}

export async function runBrowserE2ECli(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    await cmdBrowserE2E([]);
    return;
  }

  switch (subcommand) {
    case 'run':
      await cmdE2E(rest);
      return;
    case 'gen':
      await cmdE2EGen(rest);
      return;
    case 'skill':
      await cmdBrowserE2E(rest);
      return;
    default:
      await cmdBrowserE2E(args);
  }
}

function resolveMainEntrypoint(): { command: string | undefined; args: string[] } {
  const executable = path.basename(process.argv[1] ?? '');
  if (executable === 'browser-opt' || executable === 'browser-opt-cli.ts') {
    return { command: 'browser-opt', args: process.argv.slice(2) };
  }
  if (executable === 'browser-e2e' || executable === 'browser-e2e-cli.ts') {
    return { command: 'browser-e2e-bin', args: process.argv.slice(2) };
  }

  const [, , command, ...args] = process.argv;
  return { command, args };
}

// ---------------------------------------------------------------------------
// 命令处理
// ---------------------------------------------------------------------------

async function cmdRun(args: string[]): Promise<void> {
  const [filePath, ...flags] = args;

  if (!filePath) {
    console.error('Usage: browser-automated run <test-file.json> [--bail] [--screenshot-on-failure]');
    process.exit(1);
  }

  const bail = flags.includes('--bail');
  const screenshotOnFailure = flags.includes('--screenshot-on-failure');

  let testCases: TestCase[];
  try {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    testCases = Array.isArray(parsed) ? (parsed as TestCase[]) : [parsed as TestCase];
  } catch (err) {
    console.error(`Failed to read test file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
    return; // 仅用于满足 TypeScript 的确定赋值分析。
  }

  const runner = new NaturalLanguageTestRunner({ bail, screenshotOnFailure });
  const summary = await runner.run(testCases);

  printSummary(summary);
  process.exit(summary.failed > 0 ? 1 : 0);
}

async function cmdGen(args: string[]): Promise<void> {
  const [url, ...descParts] = args;
  const description = descParts.join(' ');

  if (!url || !description) {
    console.error('Usage: browser-automated gen <url> <description>');
    process.exit(1);
  }

  const generator = new TestCaseGenerator();
  const testCase = await generator.generate(url, description);
  console.log(JSON.stringify(testCase, null, 2));
}

async function cmdChat(args: string[]): Promise<void> {
  const [url, ...instrParts] = args;
  const instruction = instrParts.join(' ');

  if (!url || !instruction) {
    console.error('Usage: browser-automated chat <url> <instruction>');
    process.exit(1);
  }

  const agent = new BrowserAgent();
  try {
    const result = executeDeterministicScenario(agent, url, instruction);
    if (!result.passed) {
      console.error(result.error || 'Deterministic execution failed.');
      process.exit(1);
    }
    console.log(result.output ?? 'Done.');
  } finally {
    agent.close();
  }
}

// ---------------------------------------------------------------------------
// /browser-e2e 交互式 Skill 入口
// ---------------------------------------------------------------------------

function extractUrlFromText(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s。，、，]+/);
  return match ? match[0] : null;
}

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function isDoneAnswer(input: string): boolean {
  const value = input.trim().toLowerCase();
  return value === 'done' || value === 'ok' || value === '继续' || value === '完成';
}

async function waitForHandoffDone(): Promise<void> {
  while (true) {
    const answer = await promptUser('已切换到真实浏览器，请处理验证码/OAuth/MFA 后输入 done 继续：\n> ');
    if (isDoneAnswer(answer)) {
      return;
    }
    console.log('未识别输入，请输入 done / ok / 继续 / 完成。');
  }
}

function createHandoffInput(url: string, instruction: string, options: { liveViewport?: boolean; profile?: string } = {}) {
  return {
    url,
    instruction,
    profile: options.profile ?? 'Default',
    liveViewport: options.liveViewport ?? true,
    handoff: {
      maxConsecutiveFailuresBeforeHandoff: 3,
      maxHandoffsPerScenario: 1,
      onActionFailure: async (context: { consecutiveFailures: number; error: string }) => {
        if (context.consecutiveFailures >= 3) {
          return;
        }
        console.log(`动作失败（${context.consecutiveFailures}/3）：${context.error}`);
        const answer = await promptUser('输入 handoff 立即人工接管，或直接回车继续自动重试：\n> ');
        return answer.trim().toLowerCase() === 'handoff' ? 'handoff' : 'continue';
      },
      onHandoffRequired: async (context: { handoffMessage: string; handoffOutput: string; sessionId?: string }) => {
        console.log('\n=== User Handoff ===');
        console.log(`Reason: ${context.handoffMessage}`);
        if (context.sessionId) {
          console.log(`Session: ${context.sessionId}`);
        }
        console.log(`Live viewport: ${LIVE_VIEWPORT_DASHBOARD_URL}`);
        console.log('已打开可视浏览器，请手动完成验证码 / OAuth / MFA。');
        console.log('完成后请在这里输入 done（或 ok / 继续 / 完成）以恢复自动化。');
        if (context.handoffOutput?.trim()) {
          console.log(context.handoffOutput.trim());
        }
      },
      waitForUserResume: waitForHandoffDone,
      onHandoffCompleted: async () => {
        console.log('用户接管完成，恢复自动化执行。\n');
      },
    },
  };
}

async function cmdBrowserE2E(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const text = parsed.positionals.join(' ').trim();
  const liveViewport = resolveLiveViewport(parsed.flags);
  const profile = resolveProfile(parsed.flags);

  if (!text) {
    console.log(`使用方式：
      browser-e2e <自然语言测试描述>

示例：
  browser-e2e 测试网站 https://example.com/login 的登录功能。\n\n目标：\n1. 打开登录页面。\n2. 输入用户名 "testuser" 和密码 "password123"。\n3. 点击登录按钮。\n4. 验证是否跳转到仪表盘页面（URL 包含 /dashboard 或看到欢迎文字）。`);
    process.exit(1);
  }

  const url = extractUrlFromText(text);
  if (!url) {
    console.error('无法从描述中提取 URL，请确保文本中包含完整 URL（如 https://example.com）。');
    process.exit(1);
  }

  const service = new BrowserE2ETestReuseService();
  if (liveViewport) {
    console.log(`\nLive viewport: ${LIVE_VIEWPORT_DASHBOARD_URL}\n`);
  }
  console.log(`Profile: ${profile}`);
  const existing = service.checkForExistingTests(text);

  // ---------- 命中已有用例：告知用户并让其决策 ----------
  if (existing.best && existing.best.score >= 0.5) {
    console.log('\n已找到相关测试用例：');
    console.log(`  名称：${existing.best.test.name}`);
    console.log(`  文件：${existing.best.test.filePath}`);
    console.log(`  匹配度：${(existing.best.score * 100).toFixed(0)}%`);

    if (existing.candidates.length > 1) {
      const others = existing.candidates.slice(1, 4);
      console.log(`\n  其他候选（共 ${existing.candidates.length} 个）：`);
      for (const c of others) {
        console.log(`    - ${c.test.name}  (${(c.score * 100).toFixed(0)}%)`);
      }
    }

    const answer = await promptUser(
      '\n请选择操作：\n  [1] 执行已有 Playwright 测试用例\n  [2] 使用自然语言重新执行（agent-browser）\n  [q] 退出\n> ',
    );

    if (answer === '1') {
      console.log(`\n正在执行：${existing.best.test.filePath}\n`);
      const result = executePlaywrightSpec(existing.best.test.filePath);
      if (result.output) console.log(result.output);
      console.log(result.passed ? '\n✓ 测试通过' : '\n✗ 测试失败');
      process.exit(result.passed ? 0 : 1);
    } else if (answer !== '2') {
      console.log('已退出。');
      process.exit(0);
    }

    console.log('\n将使用自然语言执行测试...\n');
  } else {
    console.log('\n未找到已有测试用例，将使用自然语言执行...\n');
  }

  // ---------- 无匹配或用户选 [2]：执行一次性 NL 测试 ----------
  const result = await service.runOneShotInstruction({
    ...createHandoffInput(url!, text, { liveViewport, profile }),
    autoGenerate: false,
  });

  printSkillExecutionResult(result);

  if (result.execution.passed) {
    const genAnswer = await promptUser(
      '\n是否将本次测试生成为可复用的 Playwright 代码？\n  [y] 生成并保存\n  [n] 不生成\n> ',
    );

    if (genAnswer.toLowerCase() === 'y') {
      const generated = await service.generateCodeFromInstruction({ url: url!, instruction: text });
      console.log(`\n✓ 已生成：${generated.filePath}`);
      console.log(`  测试名：${generated.testCase.name}`);
    }
  }

  process.exit(result.execution.passed ? 0 : 1);
}

async function cmdBrowserOpt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const text = parsed.positionals.join(' ').trim();
  const liveViewport = resolveBrowserOptLiveViewport(parsed.flags);
  const profile = resolveProfile(parsed.flags);
  const outputDir = getStringFlag(parsed.flags, 'output-dir');
  const useAgentChat = getBooleanFlag(parsed.flags, 'agent-chat');

  if (!text) {
    console.log(`使用方式：
  browser-opt <自然语言流程> [--profile <name>] [--no-live-viewport] [--output-dir <dir>] [--agent-chat]

${browserOptTemplate()}`);
    process.exit(1);
  }

  const runner = new BrowserOptRunner();
  const result = await runner.run(text, {
    profile,
    liveViewport,
    outputDir,
    useAgentChat,
  });

  printBrowserOptResult(result);
  process.exit(result.passed ? 0 : 1);
}

async function cmdE2E(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [url, ...instructionParts] = parsed.positionals;
  const instruction = instructionParts.join(' ').trim();

  if (!url || !instruction) {
    console.error(
      'Usage: browser-e2e run <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>]',
    );
    process.exit(1);
  }

  const assertion = getStringFlag(parsed.flags, 'assert');
  const autoGenerate = getBooleanFlag(parsed.flags, 'auto-generate');
  const liveViewport = resolveLiveViewport(parsed.flags);
  const profile = resolveProfile(parsed.flags);
  const generatedName = getStringFlag(parsed.flags, 'name');
  const tags = parseCsv(getStringFlag(parsed.flags, 'tags'));

  const service = new BrowserE2ETestReuseService();
  if (liveViewport) {
    console.log(`Live viewport: ${LIVE_VIEWPORT_DASHBOARD_URL}`);
  }
  console.log(`Profile: ${profile}`);
  const result = await service.trigger({
    ...createHandoffInput(url, instruction, { liveViewport, profile }),
    assertion,
    autoGenerate,
    generatedName,
    tags,
  });

  printSkillExecutionResult(result);
  process.exit(result.execution.passed ? 0 : 1);
}

async function cmdE2EGen(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [url, ...instructionParts] = parsed.positionals;
  const instruction = instructionParts.join(' ').trim();

  if (!url || !instruction) {
    console.error('Usage: browser-e2e gen <url> <instruction> [--name <name>] [--tags <a,b>]');
    process.exit(1);
  }

  const name = getStringFlag(parsed.flags, 'name');
  const tags = parseCsv(getStringFlag(parsed.flags, 'tags'));

  const service = new BrowserE2ETestReuseService();
  const generated = await service.generateCodeFromInstruction({
    url,
    instruction,
    name,
    tags,
  });

  console.log('Generated Playwright e2e test:');
  console.log(`  File: ${generated.filePath}`);
  console.log(`  Name: ${generated.testCase.name}`);
  console.log(`  URL:  ${generated.testCase.url}`);
}

// ---------------------------------------------------------------------------
// 输出辅助函数
// ---------------------------------------------------------------------------

function printSummary(summary: TestRunSummary): void {
  console.log('\n=== Test Run Summary ===');
  console.log(`Total:  ${summary.total}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Duration: ${summary.duration}ms\n`);

  for (const result of summary.results) {
    const icon = result.passed ? '✓' : '✗';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);

    for (const step of result.steps) {
      const stepIcon = step.passed ? '  ✓' : '  ✗';
      console.log(`${stepIcon} ${step.instruction}`);
      if (step.error) {
        console.log(`      Error: ${step.error}`);
      }
    }

    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  }
}

function printUsage(command?: string): void {
  if (command === 'browser-e2e-bin') {
    console.log(`
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
`);
    return;
  }

  console.log(`
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
`);
}

function parseCliArgs(args: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function getBooleanFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true;
}

function resolveProfile(flags: Record<string, string | boolean>): string {
  return getStringFlag(flags, 'profile') ?? 'Default';
}

function resolveLiveViewport(flags: Record<string, string | boolean>): boolean {
  if (getBooleanFlag(flags, 'no-live-viewport')) {
    return false;
  }
  if (getBooleanFlag(flags, 'live-viewport')) {
    return true;
  }
  return true;
}

function resolveBrowserOptLiveViewport(flags: Record<string, string | boolean>): boolean {
  if (getBooleanFlag(flags, 'no-live-viewport')) {
    return false;
  }
  if (getBooleanFlag(flags, 'live-viewport')) {
    return true;
  }
  return true;
}

function parseCsv(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function printSkillExecutionResult(result: {
  mode: 'code' | 'one-shot';
  matched?: { test: { name: string; filePath: string }; score: number } | null;
  execution: { passed: boolean; output?: string; steps?: Array<{ instruction: string; passed: boolean; error?: string; output?: string }>; error?: string };
  guidance?: string;
  generated?: { filePath: string };
  handoff?: { triggered: boolean; count: number };
}): void {
  console.log(`Mode: ${result.mode}`);
  if (result.matched) {
    console.log(`Matched test: ${result.matched.test.name} (${result.matched.test.filePath})`);
    console.log(`Match score: ${result.matched.score.toFixed(2)}`);
  }

  console.log(`Passed: ${result.execution.passed ? 'yes' : 'no'}`);
  if (result.execution.error) {
    console.log(`Error: ${result.execution.error}`);
  }

  if (result.execution.steps && result.execution.steps.length > 0) {
    for (const step of result.execution.steps) {
      const mark = step.passed ? '  ✓' : '  ✗';
      console.log(`${mark} ${step.instruction}`);
      if (step.output) {
        console.log(step.output);
      }
      if (step.error) {
        console.log(`    ${step.error}`);
      }
    }
  }

  if (result.execution.output) {
    console.log(result.execution.output);
  }

  if (result.generated) {
    console.log(`Generated file: ${result.generated.filePath}`);
  }

  if (result.handoff?.triggered) {
    console.log(`Handoff: yes (${result.handoff.count})`);
  }

  if (result.guidance) {
    console.log(result.guidance);
  }
}

function printBrowserOptResult(result: {
  passed: boolean;
  report: {
    status: 'PASS' | 'FAIL';
    reportJsonPath: string;
    reportMarkdownPath: string;
    logPath: string;
    screenshots: string[];
    logs: string[];
    steps: Array<{ index: number; instruction: string; passed: boolean; error?: string }>;
  };
}): void {
  if (result.passed) {
    console.log('执行成功');
    return;
  }

  const report = result.report;
  console.log(`Status: ${report.status}`);
  console.log(`Report JSON: ${report.reportJsonPath}`);
  console.log(`Report Markdown: ${report.reportMarkdownPath}`);
  console.log(`Log: ${report.logPath}`);
  console.log('Evidence screenshots:');
  for (const screenshot of report.screenshots) {
    console.log(`  - ${screenshot}`);
  }
  console.log('Detailed log:');
  for (const log of report.logs) {
    console.log(`  ${log}`);
  }
  for (const step of report.steps) {
    const mark = step.passed ? 'PASS' : 'FAIL';
    console.log(`${mark} ${step.index}. ${step.instruction}`);
    if (step.error) {
      console.log(`  Error: ${step.error}`);
    }
  }
}

async function main(): Promise<void> {
  const entrypoint = resolveMainEntrypoint();
  if (entrypoint.command === 'browser-e2e-bin') {
    await runBrowserE2ECli(entrypoint.args);
    return;
  }
  await runCli(entrypoint.command, entrypoint.args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
