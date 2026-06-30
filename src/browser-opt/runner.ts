/**
 * browser-opt 负责通过 agent-browser 执行自然语言浏览器流程，并在 M1 阶段
 * 保持严格的证据采集闭环，默认显示并保留真实浏览器但不打开 agent-browser 截图面板。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserAgent, createBrowserAgent, type BrowserAgentFactory } from '../core/agent.js';
import type { AgentOptions } from '../core/types.js';
import type {
  BrowserOptReport,
  BrowserOptRunResult,
  BrowserOptRunnerOptions,
  BrowserOptStepExecutionOptions,
  BrowserOptStepResult,
  SnapshotEvidence,
} from './type.js';
import {
  browserOptTemplate,
  countSnapshotNodes,
  extractBrowserOptUrl,
  findClickableRef,
  findTextboxRef,
  isVerificationStep,
  parseDeterministicAction,
  renderMarkdownReport,
  resolveOutputDir,
  snapshotText,
  splitBrowserOptSteps,
  summarizeJsonResult,
  summarizeSnapshot,
  verifyStep,
} from './utils.js';

export {
  browserOptTemplate,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from './utils.js';

// 统一管理执行循环与报告产物，调用方只需要提供自然语言流程和可选运行参数。
export class BrowserOptRunner {
  private readonly agentFactory: (options?: AgentOptions) => BrowserAgent;

  /** 注入可替换的 agent 工厂，便于真实运行与单测共用一套 runner。 */
  constructor(agentFactory: BrowserAgentFactory = createBrowserAgent) {
    this.agentFactory = agentFactory;
  }

  /** 执行完整的 browser-opt 流程，产出报告、截图、日志与 PASS/FAIL 结论。 */
  async run(flow: string, options: BrowserOptRunnerOptions = {}): Promise<BrowserOptRunResult> {
    const url = extractBrowserOptUrl(flow);
    if (!url) {
      throw new Error(`无法从自然语言流程中提取 URL。\n\n${browserOptTemplate()}`);
    }

    const steps = splitBrowserOptSteps(flow);
    if (steps.length === 0) {
      throw new Error(`自然语言流程为空，请使用通用测试模板。\n\n${browserOptTemplate()}`);
    }

    const startedAt = new Date();
    const outputDir = resolveOutputDir(flow, options.outputDir, startedAt);
    fs.mkdirSync(outputDir, { recursive: true });

    const logs: string[] = [];
    const screenshots: string[] = [];
    const stepResults: BrowserOptStepResult[] = [];
    let fatalError: string | undefined;
    const agent = this.agentFactory({
      profile: options.profile ?? 'Default',
      liveViewport: options.liveViewport ?? true,
      openLiveDashboard: false,
      timeout: options.timeout,
    });

    try {
      logs.push(`open: ${url}`);
      agent.open(url);

      const openSnapshotPath = path.join(outputDir, '00-open.snapshot.json');
      const openScreenshotPath = path.join(outputDir, '00-open.png');
      const openSnapshot = captureSnapshot(agent, openSnapshotPath);
      agent.screenshot(openScreenshotPath);
      screenshots.push(openScreenshotPath);
      logs.push(`snapshot: ${openSnapshotPath}`);
      logs.push(`screenshot: ${openScreenshotPath}`);
      logs.push(`page-state: ${summarizeSnapshot(openSnapshot)}`);

      for (let index = 0; index < steps.length; index++) {
        const result = await executeStep(agent, outputDir, index + 1, steps[index], {
          useAgentChat: options.useAgentChat ?? false,
        });
        stepResults.push(result);
        screenshots.push(result.beforeScreenshotPath, result.afterScreenshotPath);
        logs.push(...result.logs);

        if (!result.passed) {
          break;
        }
      }
    } catch (err) {
      fatalError = err instanceof Error ? err.message : String(err);
      logs.push(`fatal: ${fatalError}`);
    } finally {
      if (options.closeOnComplete ?? false) {
        agent.close();
      }
    }

    const endedAt = new Date();
    const passed = !fatalError && stepResults.length === steps.length && stepResults.every((step) => step.passed);
    const reportJsonPath = path.join(outputDir, 'report.json');
    const reportMarkdownPath = path.join(outputDir, 'report.md');
    const logPath = path.join(outputDir, 'run.log');
    const report: BrowserOptReport = {
      status: passed ? 'PASS' : 'FAIL',
      url,
      flow,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      outputDir,
      reportJsonPath,
      reportMarkdownPath,
      logPath,
      screenshots,
      logs,
      steps: stepResults,
    };

    fs.writeFileSync(logPath, logs.join('\n'));
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(reportMarkdownPath, renderMarkdownReport(report));

    return {
      passed,
      report,
    };
  }
}

/** 执行单个步骤，负责前后快照、动作重试、验证和步骤级日志记录。 */
async function executeStep(
  agent: BrowserAgent,
  outputDir: string,
  index: number,
  instruction: string,
  options: BrowserOptStepExecutionOptions,
): Promise<BrowserOptStepResult> {
  const prefix = String(index).padStart(2, '0');
  const beforeSnapshotPath = path.join(outputDir, `${prefix}-before.snapshot.json`);
  const afterSnapshotPath = path.join(outputDir, `${prefix}-after.snapshot.json`);
  const retrySnapshotPath = path.join(outputDir, `${prefix}-retry.snapshot.json`);
  const beforeScreenshotPath = path.join(outputDir, `${prefix}-before.png`);
  const afterScreenshotPath = path.join(outputDir, `${prefix}-after.png`);
  const logs: string[] = [];

  const beforeSnapshot = captureSnapshot(agent, beforeSnapshotPath);
  let actionSnapshot = beforeSnapshot;
  agent.screenshot(beforeScreenshotPath);
  logs.push(`step ${index}: ${instruction}`);
  logs.push(`before-state: ${summarizeSnapshot(beforeSnapshot)}`);
  logs.push(`before-screenshot: ${beforeScreenshotPath}`);
  logs.push(`thinking: 当前页面状态已记录，下一步执行确定性动作或验证。`);

  let attempts = 0;
  let actionOutput = '';
  let actionError: string | undefined;

  while (attempts < 2) {
    attempts += 1;
    try {
      if (!isVerificationStep(instruction)) {
        if (options.useAgentChat) {
          const chat = agent.chatJson(instruction);
          actionOutput = summarizeJsonResult(chat);
          logs.push(`attempt ${attempts}: agent-browser chat --json`);
          if (chat.parseError) {
            logs.push(`attempt ${attempts}: chat JSON parse fallback: ${chat.parseError}`);
          }
        } else {
          const deterministic = executeDeterministicInstruction(agent, instruction, actionSnapshot);
          if (!deterministic) {
            throw new Error('无法将步骤解析为确定性命令。请把步骤写成访问 URL、字段输入“值”、点击“按钮文案”或验证页面包含“文本”；如需旧模式可加 --agent-chat。');
          }
          actionOutput = deterministic;
          logs.push(`attempt ${attempts}: deterministic agent-browser command`);
        }
      } else {
        logs.push(`attempt ${attempts}: verification-only step, no chat action`);
      }
      actionError = undefined;
      break;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
      logs.push(`attempt ${attempts}: action failed: ${actionError}`);
      if (attempts < 2) {
        const retrySnapshot = captureSnapshot(agent, retrySnapshotPath);
        actionSnapshot = retrySnapshot;
        logs.push(`retry-snapshot: ${retrySnapshotPath}`);
        logs.push(`retry-state: ${summarizeSnapshot(retrySnapshot)}`);
      }
    }
  }

  const afterSnapshot = captureSnapshot(agent, afterSnapshotPath);
  agent.screenshot(afterScreenshotPath);
  logs.push(`after-state: ${summarizeSnapshot(afterSnapshot)}`);
  logs.push(`after-screenshot: ${afterScreenshotPath}`);

  if (actionError) {
    return {
      index,
      instruction,
      passed: false,
      attempts,
      beforeSnapshotPath,
      afterSnapshotPath,
      beforeScreenshotPath,
      afterScreenshotPath,
      actionOutput,
      error: actionError,
      logs,
    };
  }

  const verification = verifyStep(instruction, afterSnapshot);
  if (!verification.passed) {
    logs.push(`verification failed: ${verification.message}`);
  } else {
    logs.push(`verification passed: ${verification.message}`);
  }

  return {
    index,
    instruction,
    passed: verification.passed,
    attempts,
    beforeSnapshotPath,
    afterSnapshotPath,
    beforeScreenshotPath,
    afterScreenshotPath,
    actionOutput,
    verification: verification.message,
    error: verification.passed ? undefined : verification.message,
    logs,
  };
}

/** 将自然语言动作直接映射到确定性命令，避免默认依赖 agent-browser chat。 */
function executeDeterministicInstruction(
  agent: BrowserAgent,
  instruction: string,
  snapshot: SnapshotEvidence,
): string | null {
  const action = parseDeterministicAction(instruction);
  if (!action) {
    return null;
  }

  if (action.type === 'open') {
    return agent.open(action.url);
  }

  if (action.type === 'fill') {
    const ref = findTextboxRef(snapshot, action.field);
    if (!ref) {
      throw new Error(`无法找到输入框：${action.field}`);
    }
    const output = agent.fill(ref, action.value);
    return `fill @${ref} ${JSON.stringify(action.value)}\n${output}`.trim();
  }

  if (action.type === 'click') {
    const ref = findClickableRef(snapshot, action.target);
    if (!ref) {
      throw new Error(`无法找到可点击元素：${action.target}`);
    }
    const output = agent.click(ref);
    return `click @${ref}\n${output}`.trim();
  }

  return null;
}

/** 采集一份机器可读快照并同时落盘，供动作匹配与报告复用。 */
function captureSnapshot(agent: BrowserAgent, filePath: string): SnapshotEvidence {
  const output = agent.snapshotJson();
  fs.writeFileSync(filePath, JSON.stringify(output.data ?? { raw: output.raw, parseError: output.parseError }, null, 2));
  return {
    output,
    text: snapshotText(output),
    nodeCount: countSnapshotNodes(output.data),
  };
}
