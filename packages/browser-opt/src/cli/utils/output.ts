/**
 * 统一管理 browser-opt CLI 的结果输出，避免命令编排代码夹杂大量控制台细节。
 * 该文件只保留 browser-opt 自己会用到的展示逻辑，不再耦合 browser-e2e 文案。
 */
import type { BrowserOptRunResult } from '../../browser-opt/type.js';
import { collectFailedBrowserOptSteps, formatBrowserOptStepStatus } from '../../browser-opt/utils.js';

export function printBrowserOptResult(result: BrowserOptRunResult): void {
  if (result.passed) {
    console.log('执行成功');
    return;
  }

  const { report } = result;
  console.log(`Status: ${report.status}`);
  if (report.handoffTriggered) {
    console.log('Handoff: 已触发，请在浏览器中完成登录后输入 done 继续。');
  }
  console.log(`Report JSON: ${report.reportJsonPath}`);
  console.log(`Report Markdown: ${report.reportMarkdownPath}`);
  console.log(`Log: ${report.logPath}`);

  const failedSteps = collectFailedBrowserOptSteps(report);
  console.log('Failed steps:');
  if (failedSteps.length === 0) {
    console.log('  - n/a');
  } else {
    for (const step of failedSteps) {
      console.log(`  - ${step.index}. ${step.instruction}`);
      console.log(`    Reason: ${step.error ?? step.verification ?? '未知原因'}`);
    }
  }

  console.log('Skipped steps:');
  const skippedSteps = report.skippedSteps ?? [];
  if (skippedSteps.length === 0) {
    console.log('  - n/a');
  } else {
    for (const step of skippedSteps) {
      console.log(`  - ${step.index}. ${step.instruction}`);
      console.log(`    Reason: ${step.reason}`);
    }
  }

  console.log('Evidence screenshots:');
  for (const screenshot of report.screenshots) {
    console.log(`  - ${screenshot}`);
  }

  console.log('Detailed log:');
  for (const log of report.logs) {
    console.log(`  ${log}`);
  }

  for (const step of report.steps) {
    const mark = formatBrowserOptStepStatus(step);
    console.log(`${mark} ${step.index}. ${step.instruction}`);
    if (step.handoffTriggered && step.verification) {
      console.log(`  Handoff: ${step.verification}`);
    }
    if (step.error) {
      console.log(`  Error: ${step.error}`);
    }
  }
}
