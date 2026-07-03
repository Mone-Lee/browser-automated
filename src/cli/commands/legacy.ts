/**
 * 承载历史 browser-automated 入口的 run/gen/chat 命令，实现旧能力兼容但不混入新入口细节。
 * 这些命令都属于直接执行型流程，放在同一文件里便于维护历史兼容边界。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeDeterministicScenario } from '../../browser-e2e/deterministic.js';
import { TestCaseGenerator } from '../../browser-e2e/generate.js';
import { NaturalLanguageTestRunner } from '../../browser-e2e/runner.js';
import { BrowserAgent } from '../../core/agent.js';
import type { TestCase } from '../../core/types.js';
import { printSummary } from '../utils/output.js';

export async function cmdRun(args: string[]): Promise<void> {
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
    return;
  }

  const runner = new NaturalLanguageTestRunner({ bail, screenshotOnFailure });
  const summary = await runner.run(testCases);

  printSummary(summary);
  process.exit(summary.failed > 0 ? 1 : 0);
}

export async function cmdGen(args: string[]): Promise<void> {
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

export async function cmdChat(args: string[]): Promise<void> {
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
