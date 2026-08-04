/**
 * 承载 browser-e2e 命令族的交互式 skill 入口、handoff 编排与代码生成流程。
 * 这里聚焦 E2E 领域逻辑，避免入口分发文件同时承担交互、参数解析和输出职责。
 */
import * as readline from 'node:readline';
import { executePlaywrightSpec } from '../../browser-e2e/test-reuse/playwright.js';
import { BrowserE2ETestReuseService } from '../../browser-e2e/test-reuse/service.js';
import type { BrowserE2ETriggerInput } from '../../browser-e2e/test-reuse/types.js';
import {
  getBooleanFlag,
  getStringFlag,
  parseCliArgs,
  parseCsv,
  resolveLiveViewport,
  resolveProfile,
  resolveReuseRunningBrowser,
  resolveStatePath,
} from '../utils/args.js';
import {
  BROWSER_E2E_SKILL_USAGE,
  HANDOFF_DONE_ANSWERS,
  LIVE_VIEWPORT_DASHBOARD_URL,
} from '../utils/constants.js';
import { printSkillExecutionResult } from '../utils/output.js';

export async function cmdBrowserE2E(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const text = parsed.positionals.join(' ').trim();
  const liveViewport = resolveLiveViewport(parsed.flags);
  const profile = resolveProfile(parsed.flags);
  const statePath = resolveStatePath(parsed.flags);
  const reuseRunningBrowser = resolveReuseRunningBrowser(parsed.flags, statePath);

  if (!text) {
    console.log(BROWSER_E2E_SKILL_USAGE);
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
  console.log(`Browser mode: ${formatBrowserMode({ statePath, reuseRunningBrowser, profile })}`);
  const existing = service.checkForExistingTests(text);

  if (existing.best && existing.best.score >= 0.5) {
    console.log('\n已找到相关测试用例：');
    console.log(`  名称：${existing.best.test.name}`);
    console.log(`  文件：${existing.best.test.filePath}`);
    console.log(`  匹配度：${(existing.best.score * 100).toFixed(0)}%`);

    if (existing.candidates.length > 1) {
      const others = existing.candidates.slice(1, 4);
      console.log(`\n  其他候选（共 ${existing.candidates.length} 个）：`);
      for (const candidate of others) {
        console.log(`    - ${candidate.test.name}  (${(candidate.score * 100).toFixed(0)}%)`);
      }
    }

    const answer = await promptUser(
      '\n请选择操作：\n  [1] 执行已有 Playwright 测试用例\n  [2] 使用自然语言重新执行（agent-browser）\n  [q] 退出\n> ',
    );

    if (answer === '1') {
      console.log(`\n正在执行：${existing.best.test.filePath}\n`);
      const result = executePlaywrightSpec(existing.best.test.filePath);
      if (result.output) {
        console.log(result.output);
      }
      console.log(result.passed ? '\n✓ 测试通过' : '\n✗ 测试失败');
      process.exit(result.passed ? 0 : 1);
    }

    if (answer !== '2') {
      console.log('已退出。');
      process.exit(0);
    }

    console.log('\n将使用自然语言执行测试...\n');
  } else {
    console.log('\n未找到已有测试用例，将使用自然语言执行...\n');
  }

  const result = await service.runOneShotInstruction({
    ...createHandoffInput(url, text, { liveViewport, profile, statePath, reuseRunningBrowser }),
    autoGenerate: false,
  });

  printSkillExecutionResult(result);

  if (result.execution.passed) {
    const genAnswer = await promptUser(
      '\n是否将本次测试生成为可复用的 Playwright 代码？\n  [y] 生成并保存\n  [n] 不生成\n> ',
    );

    if (genAnswer.toLowerCase() === 'y') {
      const generated = await service.generateCodeFromInstruction({ url, instruction: text });
      console.log(`\n✓ 已生成：${generated.filePath}`);
      console.log(`  测试名：${generated.testCase.name}`);
    }
  }

  process.exit(result.execution.passed ? 0 : 1);
}

export async function cmdE2E(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [url, ...instructionParts] = parsed.positionals;
  const instruction = instructionParts.join(' ').trim();

  if (!url || !instruction) {
    console.error(
      'Usage: browser-e2e run <url> <instruction> [--assert <assertion>] [--auto-generate] [--name <name>] [--tags <a,b>]',
    );
    process.exit(1);
  }

  const service = new BrowserE2ETestReuseService();
  const liveViewport = resolveLiveViewport(parsed.flags);
  const profile = resolveProfile(parsed.flags);
  const statePath = resolveStatePath(parsed.flags);
  const reuseRunningBrowser = resolveReuseRunningBrowser(parsed.flags, statePath);
  const result = await service.trigger({
    ...createHandoffInput(url, instruction, { liveViewport, profile, statePath, reuseRunningBrowser }),
    assertion: getStringFlag(parsed.flags, 'assert'),
    autoGenerate: getBooleanFlag(parsed.flags, 'auto-generate'),
    generatedName: getStringFlag(parsed.flags, 'name'),
    tags: parseCsv(getStringFlag(parsed.flags, 'tags')),
  });

  if (liveViewport) {
    console.log(`Live viewport: ${LIVE_VIEWPORT_DASHBOARD_URL}`);
  }
  console.log(`Browser mode: ${formatBrowserMode({ statePath, reuseRunningBrowser, profile })}`);
  printSkillExecutionResult(result);
  process.exit(result.execution.passed ? 0 : 1);
}

export async function cmdE2EGen(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [url, ...instructionParts] = parsed.positionals;
  const instruction = instructionParts.join(' ').trim();

  if (!url || !instruction) {
    console.error('Usage: browser-e2e gen <url> <instruction> [--name <name>] [--tags <a,b>]');
    process.exit(1);
  }

  const service = new BrowserE2ETestReuseService();
  const generated = await service.generateCodeFromInstruction({
    url,
    instruction,
    name: getStringFlag(parsed.flags, 'name'),
    tags: parseCsv(getStringFlag(parsed.flags, 'tags')),
  });

  console.log('Generated Playwright e2e test:');
  console.log(`  File: ${generated.filePath}`);
  console.log(`  Name: ${generated.testCase.name}`);
  console.log(`  URL:  ${generated.testCase.url}`);
}

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
  return HANDOFF_DONE_ANSWERS.includes(value as (typeof HANDOFF_DONE_ANSWERS)[number]);
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

function createHandoffInput(
  url: string,
  instruction: string,
  options: { liveViewport?: boolean; profile?: string; statePath?: string; reuseRunningBrowser?: boolean } = {},
): BrowserE2ETriggerInput {
  return {
    url,
    instruction,
    profile: options.profile,
    statePath: options.statePath,
    reuseRunningBrowser: options.reuseRunningBrowser ?? false,
    liveViewport: options.liveViewport ?? true,
    handoff: {
      maxConsecutiveFailuresBeforeHandoff: 3,
      maxHandoffsPerScenario: 1,
      onActionFailure: async (context) => {
        if (context.consecutiveFailures >= 3) {
          return;
        }
        console.log(`动作失败（${context.consecutiveFailures}/3）：${context.error}`);
        const answer = await promptUser('输入 handoff 立即人工接管，或直接回车继续自动重试：\n> ');
        return answer.trim().toLowerCase() === 'handoff' ? 'handoff' : 'continue';
      },
      onHandoffRequired: async (context) => {
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

function formatBrowserMode(options: {
  statePath?: string;
  reuseRunningBrowser: boolean;
  profile?: string;
}): string {
  if (options.statePath) {
    return `state:${options.statePath}`;
  }
  if (options.reuseRunningBrowser) {
    return 'reuse-running-browser';
  }
  if (options.profile) {
    return `profile:${options.profile}`;
  }
  return 'clean-window';
}
