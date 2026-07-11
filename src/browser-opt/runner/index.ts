/**
 * browser-opt runner 入口，负责完整流程编排、报告落盘与对外工具再导出。
 * 具体步骤执行、确定性动作、证据采集和接管恢复逻辑分别放在同级分类文件中。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserAgent, createBrowserAgent, type BrowserAgentFactory } from '../../core/agent.js';
import type { AgentOptions } from '../../core/types.js';
import type {
  BrowserOptReport,
  BrowserOptRunResult,
  BrowserOptRunnerOptions,
  BrowserOptStepResult,
} from '../type.js';
import {
  browserOptTemplate,
  extractBrowserOptUrl,
  renderMarkdownReport,
  resolveOutputDir,
  splitBrowserOptSteps,
  summarizeSnapshot,
} from '../utils.js';
import { captureSettledSnapshot } from './evidence.js';
import {
  resumeFromHandoff,
  saveAuthenticatedHandoffState,
  saveAuthState,
  shouldTriggerLoginHandoff,
  triggerLoginHandoff,
} from './handoff.js';
import { executeStep } from './step-executor.js';

export {
  browserOptTemplate,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from '../utils.js';

export class BrowserOptRunner {
  private readonly agentFactory: (options?: AgentOptions) => BrowserAgent;

  /** 注入可替换的 agent 工厂，便于真实运行与单测共用一套 runner。 */
  constructor(agentFactory: BrowserAgentFactory = createBrowserAgent) {
    this.agentFactory = agentFactory;
  }

  /** 执行完整的 browser-opt 流程，产出报告、截图、日志与 PASS/FAIL/HANDOFF 结论。 */
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
    let handoffTriggered = false;
    let initialOpenCanBeReused = true;
    let fatalError: string | undefined;
    let authStateFallbackUsed = false;
    let agent = this.agentFactory({
      profile: options.profile,
      sessionName: options.sessionName,
      statePath: options.statePath,
      reuseRunningBrowser: options.reuseRunningBrowser ?? false,
      liveViewport: options.liveViewport ?? true,
      openLiveDashboard: false,
      timeout: options.timeout,
    });

    try {
      logs.push(`open: ${url}`);
      agent.open(url);

      const openSnapshotPath = path.join(outputDir, '00-open.snapshot.json');
      const openScreenshotPath = path.join(outputDir, '00-open.png');
      let openSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs);
      agent.screenshot(openScreenshotPath);
      screenshots.push(openScreenshotPath);
      logs.push(`snapshot: ${openSnapshotPath}`);
      logs.push(`screenshot: ${openScreenshotPath}`);
      logs.push(`page-state: ${summarizeSnapshot(openSnapshot)}`);

      /**
       * state 已存在但运行中被登录页拦截时，最多回退一次到对应 profile 重新导入。
       * 普通 Chrome 不一定开放 CDP 调试端口，因此这里不走 focused-browser 复用。
       */
      const retryAuthStateFallback = (): BrowserAgent | null => {
        const canFallbackAuthState = options.statePath && options.authStateFallbackProfile;
        if (!canFallbackAuthState || authStateFallbackUsed) {
          return null;
        }

        authStateFallbackUsed = true;
        logs.push(`auth-state-fallback: state 登录态疑似失效，改用 profile ${options.authStateFallbackProfile} 重新导入。`);
        agent.close();
        agent = this.agentFactory({
          profile: options.authStateFallbackProfile,
          sessionName: options.sessionName,
          reuseRunningBrowser: options.reuseRunningBrowser ?? false,
          liveViewport: options.liveViewport ?? true,
          openLiveDashboard: false,
          timeout: options.timeout,
        });
        logs.push(`fallback-open: ${url}`);
        agent.open(url);
        openSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs);
        agent.screenshot(openScreenshotPath);
        logs.push(`fallback-snapshot: ${openSnapshotPath}`);
        logs.push(`fallback-screenshot: ${openScreenshotPath}`);
        logs.push(`fallback-page-state: ${summarizeSnapshot(openSnapshot)}`);
        if (!shouldTriggerLoginHandoff(flow, url, openSnapshot) && options.authStateSavePath) {
          saveAuthState(agent, options.authStateSavePath, logs);
        }
        return shouldTriggerLoginHandoff(flow, url, openSnapshot) ? null : agent;
      };

      if (shouldTriggerLoginHandoff(flow, url, openSnapshot)) {
        retryAuthStateFallback();
      }

      if (shouldTriggerLoginHandoff(flow, url, openSnapshot)) {
        const handoff = triggerLoginHandoff(agent, logs, '初始化打开目标页面后检测到登录页跳转');
        handoffTriggered = true;
        const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff);
        if (resumed) {
          handoffTriggered = false;
          initialOpenCanBeReused = false;
          const resumedSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs);
          agent.screenshot(openScreenshotPath);
          saveAuthenticatedHandoffState(agent, options.authStateSavePath, logs, resumedSnapshot);
          logs.push(`resume-snapshot: ${openSnapshotPath}`);
          logs.push(`resume-screenshot: ${openScreenshotPath}`);
          logs.push(`resume-state: ${summarizeSnapshot(resumedSnapshot)}`);
        }
      }

      for (let index = 0; index < steps.length && !handoffTriggered; index++) {
        const result = await executeStep(agent, outputDir, index + 1, steps[index], {
          useAgentChat: options.useAgentChat ?? false,
          alreadyOpenedUrl: index === 0 && initialOpenCanBeReused ? url : undefined,
          authStateSavePath: options.authStateSavePath,
          retryAuthStateFallback,
          handoff: options.handoff,
        });
        stepResults.push(result);
        screenshots.push(result.beforeScreenshotPath, result.afterScreenshotPath);
        logs.push(...result.logs);
        if (result.handoffTriggered) {
          handoffTriggered = true;
        }

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
    if (passed && options.authStateSavePath) {
      saveAuthState(agent, options.authStateSavePath, logs);
    }
    const status = passed ? 'PASS' : handoffTriggered ? 'HANDOFF' : 'FAIL';
    const reportJsonPath = path.join(outputDir, 'report.json');
    const reportMarkdownPath = path.join(outputDir, 'report.md');
    const logPath = path.join(outputDir, 'run.log');
    const report: BrowserOptReport = {
      status,
      handoffTriggered,
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
