/**
 * browser-opt runner 入口，负责完整流程编排、报告落盘与对外工具再导出。
 * 具体步骤执行、确定性动作、证据采集和接管恢复逻辑分别放在同级分类文件中。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserAgent, createBrowserAgent, type BrowserAgentFactory } from '#browser-core/agent';
import type { AgentOptions } from '#browser-core';
import type {
  BrowserOptReport,
  BrowserOptRunResult,
  BrowserOptRunnerOptions,
  BrowserOptSkippedStep,
  BrowserOptStepResult,
  SnapshotEvidence,
} from '../type.js';
import {
  browserOptTemplate,
  extractBrowserOptUrl,
  findTextboxRef,
  isHighImpactInstruction,
  renderMarkdownReport,
  resolveOutputDir,
  splitBrowserOptSteps,
  summarizeSnapshot,
} from '../utils.js';
import { captureSettledSnapshot, isAboutBlankOpen } from './evidence.js';
import {
  resumeFromHandoff,
  saveAuthenticatedHandoffState,
  saveAuthState,
  isLoginLikeSnapshot,
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
    const skippedSteps: BrowserOptSkippedStep[] = [];
    let handoffTriggered = false;
    let fatalError: string | undefined;
    let authStateFallbackUsed = false;
    let hasBlockingFailedStep = false;
    logAuthStateMode(logs, options);
    const openedWithProfile = Boolean(options.profile && !options.statePath);
    let agent = this.agentFactory({
      namespace: 'browser-opt',
      sessionId: options.sessionId,
      profile: options.profile,
      sessionName: options.sessionName,
      reuseRunningBrowser: options.reuseRunningBrowser ?? false,
      liveViewport: options.liveViewport ?? true,
      openLiveDashboard: false,
      timeout: options.timeout,
    });

    try {
      // 先在空白页显式恢复 state，确保业务页首批鉴权请求发出前 cookies 与 storage 已经就位。
      if (options.statePath) {
        logs.push('auth-state-stage-open: about:blank');
        agent.open('about:blank');
        try {
          const loadOutput = agent.stateLoad(options.statePath);
          logs.push(`auth-state-load: ${options.statePath}`);
          if (loadOutput.trim()) {
            logs.push(`auth-state-load-output: ${loadOutput.trim()}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logs.push(`auth-state-load-failed: ${message}`);
        }
      }

      logs.push(`open: ${url}`);
      agent.open(url);

      const openSnapshotPath = path.join(outputDir, '00-open.snapshot.json');
      const openScreenshotPath = path.join(outputDir, '00-open.png');
      let openSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs, {
        reloadAfterBlank: true,
        targetUrl: url,
      });
      agent.screenshot(openScreenshotPath);
      screenshots.push(openScreenshotPath);
      logs.push(`snapshot: ${openSnapshotPath}`);
      logs.push(`screenshot: ${openScreenshotPath}`);
      logs.push(`page-state: ${summarizeSnapshot(openSnapshot)}`);

      /** state 失效时只允许切换一次 profile 窗口，后续自动化与 handoff 固定复用该窗口。 */
      const retryAuthStateFallback = (): BrowserAgent | null => {
        if (!options.statePath || !options.authStateFallbackProfile || authStateFallbackUsed) {
          return null;
        }

        authStateFallbackUsed = true;
        logs.push(`auth-state-fallback: state 登录态疑似失效，切换到 profile ${options.authStateFallbackProfile}。`);
        agent.close();
        const fallbackAgent = this.agentFactory({
          namespace: 'browser-opt',
          profile: options.authStateFallbackProfile,
          sessionName: options.sessionName,
          reuseRunningBrowser: options.reuseRunningBrowser ?? false,
          liveViewport: options.liveViewport ?? true,
          openLiveDashboard: false,
          timeout: options.timeout,
        });
        agent = fallbackAgent;

        try {
          logs.push(`fallback-open: ${url}`);
          fallbackAgent.open(url);
          const fallbackSnapshotPath = path.join(outputDir, '00-profile-fallback.snapshot.json');
          const fallbackScreenshotPath = path.join(outputDir, '00-profile-fallback.png');
          const fallbackSnapshot = captureSettledSnapshot(fallbackAgent, fallbackSnapshotPath, logs, {
            reloadAfterBlank: true,
            targetUrl: url,
          });
          fallbackAgent.screenshot(fallbackScreenshotPath);
          screenshots.push(fallbackScreenshotPath);
          logs.push(`fallback-snapshot: ${fallbackSnapshotPath}`);
          logs.push(`fallback-screenshot: ${fallbackScreenshotPath}`);
          logs.push(`fallback-page-state: ${summarizeSnapshot(fallbackSnapshot)}`);
          openSnapshot = fallbackSnapshot;
          revealProfileLoginSuggestions(fallbackAgent, fallbackSnapshot, logs);
          if (!isAboutBlankOpen(fallbackAgent, fallbackSnapshot)
            && !shouldTriggerLoginHandoff(flow, url, fallbackSnapshot)
            && options.authStateSavePath) {
            saveAuthState(fallbackAgent, options.authStateSavePath, logs);
          }
          return fallbackAgent;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logs.push(`auth-state-fallback-failed: ${message}`);
          return fallbackAgent;
        }
      };

      if (isAboutBlankOpen(agent, openSnapshot)) {
        retryAuthStateFallback();
      }
      if (isAboutBlankOpen(agent, openSnapshot)) {
        throw new Error('浏览器页面未成功打开：当前会话持续停留在 about:blank，且没有可恢复的业务页或登录页。');
      }

      if (openedWithProfile) {
        saveProfileAuthState(agent, options.authStateSavePath, logs, openSnapshot);
      }

      if (shouldTriggerLoginHandoff(flow, url, openSnapshot)) {
        retryAuthStateFallback();
      }
      if (isAboutBlankOpen(agent, openSnapshot)) {
        throw new Error('profile fallback 打开目标页面后仍停留在 about:blank。');
      }

      if (shouldTriggerLoginHandoff(flow, url, openSnapshot)) {
        const handoff = triggerLoginHandoff(agent, logs, '初始化打开目标页面后检测到登录页跳转');
        handoffTriggered = true;
        const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff);
        if (resumed) {
          handoffTriggered = false;
          const resumedSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs);
          agent.screenshot(openScreenshotPath);
          saveAuthenticatedHandoffState(agent, options.authStateSavePath, logs, resumedSnapshot);
          logs.push(`resume-snapshot: ${openSnapshotPath}`);
          logs.push(`resume-screenshot: ${openScreenshotPath}`);
          logs.push(`resume-state: ${summarizeSnapshot(resumedSnapshot)}`);
        }
      }

      for (let index = 0; index < steps.length && !handoffTriggered; index++) {
        if (hasBlockingFailedStep && isHighImpactInstruction(steps[index])) {
          fatalError = `已阻止高影响步骤 ${index + 1}：前置步骤失败，未执行“${steps[index]}”。`;
          skippedSteps.push({
            index: index + 1,
            instruction: steps[index],
            reason: '前置步骤失败，已阻止高影响操作',
          });
          logs.push(`high-impact-action-blocked: ${fatalError}`);
          break;
        }

        const result = await executeStep(agent, outputDir, index + 1, steps[index], {
          useAgentChat: options.useAgentChat ?? false,
          alreadyOpenedUrl: index === 0 ? url : undefined,
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
        if (!result.passed && !result.handoffTriggered) {
          if (result.failureKind === 'business-validation') {
            logs.push(`business-validation-non-blocking: 步骤 ${index + 1} 由页面业务规则拒绝，允许继续执行后续操作。`);
          } else {
            hasBlockingFailedStep = true;
          }
          if (isHighImpactInstruction(steps[index])) {
            fatalError = `高影响步骤 ${index + 1} 执行失败，已停止后续操作。`;
            logs.push(`high-impact-action-failed: ${fatalError}`);
            break;
          }
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
      skippedSteps,
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

/** 记录本轮浏览器登录态来源，便于排查默认 state 与 profile 导入是否命中。 */
function logAuthStateMode(logs: string[], options: BrowserOptRunnerOptions): void {
  if (options.statePath) {
    const fallback = options.authStateFallbackProfile ? `, fallback-profile=${options.authStateFallbackProfile}` : '';
    logs.push(`auth-state-mode: state ${options.statePath}${fallback}`);
    return;
  }
  if (options.profile) {
    const saveTarget = options.authStateSavePath ? `, save=${options.authStateSavePath}` : '';
    logs.push(`auth-state-mode: profile-import ${options.profile}${saveTarget}`);
  }
}

/** profile 作为唯一主 agent 首次打开后固化 state；登录页或空白页不保存无效状态。 */
function saveProfileAuthState(
  agent: BrowserAgent,
  authStateSavePath: string | undefined,
  logs: string[],
  snapshot: SnapshotEvidence,
): void {
  if (!authStateSavePath) {
    return;
  }
  if (isLoginLikeSnapshot(snapshot) || snapshot.nodeCount === 0) {
    logs.push('auth-state-profile-save-skipped: profile 页面尚未确认处于可复用登录态。');
    return;
  }
  saveAuthState(agent, authStateSavePath, logs);
}

/** profile 登录页进入 handoff 前聚焦凭据输入框，让 Chrome 展开已保存的账号密码候选。 */
function revealProfileLoginSuggestions(agent: BrowserAgent, snapshot: SnapshotEvidence, logs: string[]): void {
  if (!isLoginLikeSnapshot(snapshot)) {
    return;
  }

  const credentialFields = ['账号', '手机号', '用户名', '邮箱', 'email', 'username', '密码', 'password'];
  const ref = credentialFields
    .map((field) => findTextboxRef(snapshot, field))
    .find((candidate): candidate is string => Boolean(candidate))
    ?? findTextboxRef(snapshot, '输入框');
  if (!ref) {
    logs.push('profile-password-suggestions-skipped: 登录页未找到可聚焦的账号或密码输入框。');
    return;
  }

  try {
    agent.click(ref);
    logs.push(`profile-password-suggestions: 已聚焦登录输入框 @${ref}，等待 Chrome 展开已保存的账号密码候选。`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs.push(`profile-password-suggestions-failed: ${message}`);
  }
}
