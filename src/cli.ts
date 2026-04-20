#!/usr/bin/env node
/**
 * CLI for the browser-automated natural language e2e test runner.
 *
 * Usage:
 *   browser-automated run    <test-file.json>    Run test cases from a JSON file
 *   browser-automated gen    <url> <description> Generate a test case from a description
 *   browser-automated chat   <url> <instruction> Run a one-shot natural language instruction
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { NaturalLanguageTestRunner } from './runner.js';
import { TestCaseGenerator } from './generate.js';
import { BrowserAgent } from './agent.js';
import { executeDeterministicScenario } from './deterministic.js';
import { BrowserE2ESkillService } from './skills/service.js';
import { executePlaywrightSpec } from './skills/playwright.js';
import type { TestCase, TestRunSummary } from './types.js';

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
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
    case 'e2e':
      await cmdE2E(args);
      break;
    case 'e2e-gen':
      await cmdE2EGen(args);
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commands
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
    return; // unreachable but satisfies TypeScript definite assignment
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
// /browser-e2e — interactive skill entrypoint
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

async function cmdBrowserE2E(args: string[]): Promise<void> {
  const text = args.join(' ').trim();

  if (!text) {
    console.log(`使用方式：
  browser-automated browser-e2e <自然语言测试描述>

示例：
  browser-automated browser-e2e 测试网站 https://example.com/login 的登录功能。\n\n目标：\n1. 打开登录页面。\n2. 输入用户名 "testuser" 和密码 "password123"。\n3. 点击登录按钮。\n4. 验证是否跳转到仪表盘页面（URL 包含 /dashboard 或看到欢迎文字）。`);
    process.exit(1);
  }

  const url = extractUrlFromText(text);
  if (!url) {
    console.error('无法从描述中提取 URL，请确保文本中包含完整 URL（如 https://example.com）。');
    process.exit(1);
  }

  const service = new BrowserE2ESkillService();
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
    url: url!,
    instruction: text,
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

async function cmdE2E(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [url, ...instructionParts] = parsed.positionals;
  const instruction = instructionParts.join(' ').trim();

  if (!url || !instruction) {
    console.error(
      'Usage: browser-automated e2e <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>]',
    );
    process.exit(1);
  }

  const assertion = getStringFlag(parsed.flags, 'assert');
  const autoGenerate = getBooleanFlag(parsed.flags, 'auto-generate');
  const generatedName = getStringFlag(parsed.flags, 'name');
  const tags = parseCsv(getStringFlag(parsed.flags, 'tags'));

  const service = new BrowserE2ESkillService();
  const result = await service.trigger({
    url,
    instruction,
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
    console.error('Usage: browser-automated e2e-gen <url> <instruction> [--name <name>] [--tags <a,b>]');
    process.exit(1);
  }

  const name = getStringFlag(parsed.flags, 'name');
  const tags = parseCsv(getStringFlag(parsed.flags, 'tags'));

  const service = new BrowserE2ESkillService();
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
// Output helpers
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

function printUsage(): void {
  console.log(`
Usage: browser-automated <command> [options]

Commands:
  run  <test-file.json>  [--bail] [--screenshot-on-failure]
       Run e2e test cases defined in a JSON file.

  gen  <url> <description>
       Generate a test case JSON from a natural language description.

  chat <url> <instruction>
       Execute a single natural language instruction in the browser.

    e2e <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>]
      Trigger e2e skill workflow: prefer existing Playwright test, fallback to one-shot NL execution.

    e2e-gen <url> <instruction> [--name <name>] [--tags <a,b>]
      Generate a reusable Playwright test from natural language flow.

Examples:
  browser-automated run tests/login.json --screenshot-on-failure
  browser-automated gen https://example.com "Fill the contact form and submit"
  browser-automated chat https://example.com "Click the sign-in button"
  browser-automated e2e https://example.com "Search for pricing and open contact"
  browser-automated e2e-gen https://example.com "Search for pricing and open contact" --name "pricing contact flow"
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

  if (result.guidance) {
    console.log(result.guidance);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
