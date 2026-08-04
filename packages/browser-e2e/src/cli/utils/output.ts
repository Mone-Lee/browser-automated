/**
 * 统一管理 browser-e2e CLI 的结果输出，让执行编排逻辑只关心流程本身。
 * 该文件只暴露 browser-e2e 当前需要的打印函数，不再耦合 browser-opt 输出。
 */
import type { BrowserE2ETriggerResult } from '../../browser-e2e/test-reuse/types.js';

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
