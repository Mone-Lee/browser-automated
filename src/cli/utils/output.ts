/**
 * 统一管理 CLI 输出格式、摘要展示与 usage 文案，避免命令实现中夹杂大量打印细节。
 * 这样既能保持各命令主流程清晰，也方便未来单独调整控制台输出体验。
 */
import type { BrowserOptRunResult } from '../../browser-opt/type.js';
import type { BrowserE2ETriggerResult } from '../../browser-e2e/test-reuse/types.js';
import type { TestRunSummary } from '../../core/types.js';
import { BROWSER_E2E_BIN_USAGE, LEGACY_CLI_USAGE } from './constants.js';

export function printSummary(summary: TestRunSummary): void {
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

export function printUsage(command?: string): void {
  console.log(command === 'browser-e2e-bin' ? BROWSER_E2E_BIN_USAGE : LEGACY_CLI_USAGE);
}

export function printSkillExecutionResult(result: BrowserE2ETriggerResult): void {
  console.log(`Mode: ${result.mode}`);
  if (result.matched) {
    console.log(`Matched test: ${result.matched.test.name} (${result.matched.test.filePath})`);
    console.log(`Match score: ${result.matched.score.toFixed(2)}`);
  }

  console.log(`Passed: ${result.execution.passed ? 'yes' : 'no'}`);
  if ('error' in result.execution && result.execution.error) {
    console.log(`Error: ${result.execution.error}`);
  }

  if ('steps' in result.execution && result.execution.steps && result.execution.steps.length > 0) {
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

  if ('output' in result.execution && result.execution.output) {
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

export function printBrowserOptResult(result: BrowserOptRunResult): void {
  if (result.passed) {
    console.log('执行成功');
    return;
  }

  const { report } = result;
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
