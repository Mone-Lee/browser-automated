/**
 * 执行结构化自然语言 TestCase，作为 browser-e2e 的兼容运行器和测试基础设施。
 */
import * as path from 'node:path';
import { createBrowserAgent, type BrowserAgentFactory, type BrowserAgent } from '../core/agent.js';
import { executeDeterministicStep } from './deterministic.js';
import type {
  TestCase,
  TestResult,
  TestRunSummary,
  StepResult,
  RunnerOptions,
} from '../core/types.js';

/**
 * NaturalLanguageTestRunner 按顺序执行 TestCase 中的步骤，并在失败时按需截图。
 */
export class NaturalLanguageTestRunner {
  private readonly options: Required<RunnerOptions>;
  private readonly agentFactory: BrowserAgentFactory;

  constructor(options: RunnerOptions = {}, agentFactory: BrowserAgentFactory = createBrowserAgent) {
    this.options = {
      screenshotOnFailure: options.screenshotOnFailure ?? false,
      screenshotDir: options.screenshotDir ?? process.cwd(),
      bail: options.bail ?? false,
    };
    this.agentFactory = agentFactory;
  }

  /**
   * 执行单个 TestCase 并返回完整结果。
   */
  async runOne(testCase: TestCase): Promise<TestResult> {
    const agent = this.agentFactory({ timeout: testCase.timeout });
    const startTime = Date.now();
    const stepResults: StepResult[] = [];
    let passed = true;
    let testError: string | undefined;

    try {
      agent.open(testCase.url);

      for (const step of testCase.steps) {
        const stepResult = await this.executeStep(agent, step.instruction, step.assertion);
        stepResults.push(stepResult);

        if (!stepResult.passed) {
          passed = false;
          if (this.options.screenshotOnFailure) {
            const screenshotPath = path.join(
              this.options.screenshotDir,
              `${sanitizeFilename(testCase.name)}-failure.png`,
            );
            try {
              agent.screenshot(screenshotPath);
            } catch {
              // 截图是尽力行为，不覆盖原始失败原因。
            }
          }
          break;
        }
      }
    } catch (err) {
      passed = false;
      testError = err instanceof Error ? err.message : String(err);
    } finally {
      agent.close();
    }

    return {
      name: testCase.name,
      passed,
      duration: Date.now() - startTime,
      error: testError,
      steps: stepResults,
    };
  }

  /**
   * 按顺序执行多个 TestCase，并汇总通过和失败数量。
   */
  async run(testCases: TestCase[]): Promise<TestRunSummary> {
    const startTime = Date.now();
    const results: TestResult[] = [];

    for (const testCase of testCases) {
      const result = await this.runOne(testCase);
      results.push(result);

      if (this.options.bail && !result.passed) {
        break;
      }
    }

    const passed = results.filter((r) => r.passed).length;

    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      duration: Date.now() - startTime,
      results,
    };
  }

  private async executeStep(
    agent: BrowserAgent,
    instruction: string,
    assertion?: string,
  ): Promise<StepResult> {
    const result = executeDeterministicStep(agent, instruction, assertion);
    return result.step;
  }
}

/** 将文件名中的非法字符替换为下划线。 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}
