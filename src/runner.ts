import * as path from 'node:path';
import { createBrowserAgent, type BrowserAgentFactory, type BrowserAgent } from './agent.js';
import { executeDeterministicStep } from './deterministic.js';
import type {
  TestCase,
  TestResult,
  TestRunSummary,
  StepResult,
  RunnerOptions,
} from './types.js';

/**
 * Runs e2e test cases described in natural language using the `agent-browser` CLI.
 *
 * Each test case is executed in an isolated browser session. Steps are processed
 * sequentially — an optional `assertion` on each step is evaluated via the `chat`
 * interface so the LLM can confirm the expected state.
 *
 * @example
 * ```ts
 * import { NaturalLanguageTestRunner } from 'browser-automated';
 *
 * const runner = new NaturalLanguageTestRunner({ screenshotOnFailure: true });
 *
 * const result = await runner.runOne({
 *   name: 'Google search',
 *   url: 'https://www.google.com',
 *   steps: [
 *     { instruction: 'Search for "agent-browser"' },
 *     { instruction: 'Click the first search result', assertion: 'A page other than Google should have loaded' },
 *   ],
 * });
 *
 * console.log(result.passed ? 'PASS' : 'FAIL');
 * ```
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
   * Run a single test case and return its result.
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
              // Screenshot is best-effort — don't mask the original failure.
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
   * Run multiple test cases and return a summary.
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

/** Replace characters that are invalid in file names with underscores. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}
