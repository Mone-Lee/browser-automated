/**
 * browser-opt 负责通过 agent-browser 执行自然语言浏览器流程，并在 M1 阶段
 * 保持严格的证据采集闭环，默认显示并保留真实浏览器但不打开 agent-browser 截图面板。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserAgent, createBrowserAgent, type BrowserAgentFactory } from '../core/agent.js';
import type { AgentOptions } from '../core/types.js';
import type {
  BrowserOptHandoffOptions,
  BrowserOptHandoffContext,
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
  findSelectableOption,
  findTextboxRef,
  findUploadRef,
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
    let handoffTriggered = false;
    let fatalError: string | undefined;
    const agent = this.agentFactory({
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
      const openSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs);
      agent.screenshot(openScreenshotPath);
      screenshots.push(openScreenshotPath);
      logs.push(`snapshot: ${openSnapshotPath}`);
      logs.push(`screenshot: ${openScreenshotPath}`);
      logs.push(`page-state: ${summarizeSnapshot(openSnapshot)}`);

      if (shouldTriggerLoginHandoff(flow, url, openSnapshot)) {
        const handoff = triggerLoginHandoff(agent, logs, '初始化打开目标页面后检测到登录页跳转');
        handoffTriggered = true;
        const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff, options.authStateSavePath);
        if (resumed) {
          handoffTriggered = false;
          const resumedSnapshot = captureSettledSnapshot(agent, openSnapshotPath, logs);
          agent.screenshot(openScreenshotPath);
          logs.push(`resume-snapshot: ${openSnapshotPath}`);
          logs.push(`resume-screenshot: ${openScreenshotPath}`);
          logs.push(`resume-state: ${summarizeSnapshot(resumedSnapshot)}`);
        } else {
          fatalError = handoff.message;
        }
      } else if (options.authStateSavePath) {
        saveAuthState(agent, options.authStateSavePath, logs);
      }

      for (let index = 0; index < steps.length && !handoffTriggered; index++) {
        const result = await executeStep(agent, outputDir, index + 1, steps[index], {
          useAgentChat: options.useAgentChat ?? false,
          alreadyOpenedUrl: index === 0 ? url : undefined,
          authStateSavePath: options.authStateSavePath,
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
    const reportJsonPath = path.join(outputDir, 'report.json');
    const reportMarkdownPath = path.join(outputDir, 'report.md');
    const logPath = path.join(outputDir, 'run.log');
    const report: BrowserOptReport = {
      status: passed ? 'PASS' : 'FAIL',
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
  const parsedAction = parseDeterministicAction(instruction);

  while (attempts < 2) {
    attempts += 1;
    try {
      if (!isVerificationStep(instruction) || (parsedAction && parsedAction.type !== 'assert-text')) {
        if (options.useAgentChat) {
          const chat = agent.chatJson(instruction);
          actionOutput = summarizeJsonResult(chat);
          logs.push(`attempt ${attempts}: agent-browser chat --json`);
          if (chat.parseError) {
            logs.push(`attempt ${attempts}: chat JSON parse fallback: ${chat.parseError}`);
          }
        } else {
          const deterministic = await executeDeterministicInstruction(agent, instruction, actionSnapshot, outputDir, {
            alreadyOpenedUrl: options.alreadyOpenedUrl,
          });
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
        agent.waitMs(500);
        logs.push(`retry-wait: 等待联动渲染或异步状态更新后重新获取页面。`);
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

  if (isHandoffActionOutput(actionOutput) && parsedAction?.type !== 'handoff') {
    const verification = extractHandoffMessage(actionOutput) ?? '已触发人工接管。';
    const handoff = buildHandoffContext(agent, verification, actionOutput);
    logs.push(`verification paused: ${verification}`);
    const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff, options.authStateSavePath);
    if (resumed) {
      return executeStep(agent, outputDir, index, instruction, {
        ...options,
        alreadyOpenedUrl: undefined,
      });
    }
    return {
      index,
      instruction,
      passed: false,
      handoffTriggered: true,
      attempts,
      beforeSnapshotPath,
      afterSnapshotPath,
      beforeScreenshotPath,
      afterScreenshotPath,
      actionOutput,
      verification,
      logs,
    };
  }

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

  if (parsedAction && parsedAction.type !== 'assert-text' && !isVerificationStep(instruction)) {
    const verification = '动作步骤已完成，已重新 snapshot。';
    logs.push(`verification passed: ${verification}`);
    return {
      index,
      instruction,
      passed: true,
      attempts,
      beforeSnapshotPath,
      afterSnapshotPath,
      beforeScreenshotPath,
      afterScreenshotPath,
      actionOutput,
      verification,
      logs,
    };
  }

  const verification = verifyStep(instruction, afterSnapshot);
  if (!verification.passed) {
    if (shouldTriggerLoginHandoff(instruction, options.alreadyOpenedUrl, afterSnapshot)) {
      const handoff = triggerLoginHandoff(agent, logs, `步骤 ${index} 验证时检测到登录页跳转`);
      const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff, options.authStateSavePath);
      if (resumed) {
        return executeStep(agent, outputDir, index, instruction, {
          ...options,
          alreadyOpenedUrl: undefined,
        });
      }
      return {
        index,
        instruction,
        passed: false,
        handoffTriggered: true,
        attempts,
        beforeSnapshotPath,
        afterSnapshotPath,
        beforeScreenshotPath,
        afterScreenshotPath,
        actionOutput: [actionOutput, handoff.output].filter(Boolean).join('\n').trim(),
        verification: handoff.message,
        logs,
      };
    }
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
async function executeDeterministicInstruction(
  agent: BrowserAgent,
  instruction: string,
  snapshot: SnapshotEvidence,
  outputDir: string,
  options: { alreadyOpenedUrl?: string } = {},
): Promise<string | null> {
  const action = parseDeterministicAction(instruction);
  if (!action) {
    return null;
  }

  if (action.type === 'open') {
    if (options.alreadyOpenedUrl && normalizeUrlForCompare(action.url) === normalizeUrlForCompare(options.alreadyOpenedUrl)) {
      return `open skipped: ${action.url} 已由 runner 初始化打开`;
    }
    return agent.open(action.url);
  }

  if (action.type === 'fill') {
    const ref = findTextboxRef(snapshot, action.field);
    if (!ref) {
      if (isLoginLikeSnapshot(snapshot)) {
        return buildLoginHandoffActionOutput(
          agent,
          `当前页面仍在登录页，无法继续填写“${action.field}”，请先完成登录后再继续自动化。`,
        );
      }
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

  if (action.type === 'select-option') {
    const option = findSelectableOption(snapshot, action.field, action.option);
    const fieldLabel = action.field ?? '选项';
    if (option.alreadySelected) {
      return `selection skipped: ${fieldLabel} 已是 ${action.option}`;
    }
    if (!option.ref) {
      throw new Error(`无法找到选项：${fieldLabel} -> ${action.option}`);
    }
    const output = agent.click(option.ref);
    return `${formatSelectableActionName(option.role)} @${option.ref} ${fieldLabel}=${action.option}\n${output}`.trim();
  }

  if (action.type === 'upload') {
    const ref = findUploadRef(snapshot, action.field);
    if (!ref) {
      throw new Error(`无法找到上传控件：${action.field}`);
    }
    const filePath = await prepareUploadFile(action.source, outputDir);
    const output = agent.upload(ref, [filePath]);
    return `upload @${ref} ${filePath}\n${output}`.trim();
  }

  if (action.type === 'handoff') {
    const output = agent.handoff(action.message);
    return `handoff ${JSON.stringify(action.message)}\n${output}`.trim();
  }

  return null;
}

/** 根据控件角色生成 agent-browser 已支持的动作名称，报告文本需与实际命令集一致。 */
function formatSelectableActionName(role: string | null): string {
  if (role && /checkbox|switch/i.test(role)) {
    return 'check';
  }

  return 'click';
}

/** 将远程上传素材下载到本次证据目录，让 agent-browser upload 使用稳定的本地路径。 */
async function prepareUploadFile(source: string, outputDir: string): Promise<string> {
  if (!/^https?:\/\//i.test(source)) {
    return path.resolve(source);
  }

  const uploadsDir = path.join(outputDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const url = new URL(source);
  const basename = path.basename(url.pathname) || 'upload-file';
  const filePath = path.join(uploadsDir, basename);
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`下载上传文件失败：${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return filePath;
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

/** 打开页面后等待空白初始页退场，避免把 about:blank 误判成目标页面状态。 */
function captureSettledSnapshot(agent: BrowserAgent, filePath: string, logs: string[]): SnapshotEvidence {
  let snapshot = captureSnapshot(agent, filePath);
  for (let attempt = 1; attempt <= 5 && isBlankInitialSnapshot(snapshot); attempt += 1) {
    logs.push(`open-wait ${attempt}: snapshot 仍为空白页，等待页面接管后重试。`);
    agent.waitMs(500);
    snapshot = captureSnapshot(agent, filePath);
  }
  return snapshot;
}

function isBlankInitialSnapshot(snapshot: SnapshotEvidence): boolean {
  const origin = findStringProperty(snapshot.output.data, 'origin');
  return snapshot.nodeCount === 0 && snapshot.text.trim() === '(no interactive elements)' && origin === 'about:blank';
}

function findStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string') {
    return record[key] as string;
  }

  for (const entry of Object.values(record)) {
    const found = findStringProperty(entry, key);
    if (found) {
      return found;
    }
  }

  return null;
}

function normalizeUrlForCompare(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim().replace(/\/$/, '');
  }
}

/** 把 handoff 文案与底层输出组装成统一上下文，供恢复逻辑和 CLI 提示复用。 */
function buildHandoffContext(agent: BrowserAgent, message: string, output: string): BrowserOptHandoffContext {
  return {
    message,
    output,
    sessionId: agent.getSessionId(),
  };
}

/** 用于识别确定性动作返回值里是否已经进入 handoff。 */
function isHandoffActionOutput(actionOutput: string): boolean {
  return actionOutput.startsWith('handoff ');
}

/** 尽量从 handoff 动作日志里还原给用户看的提示文案。 */
function extractHandoffMessage(actionOutput: string): string | null {
  const firstLine = actionOutput.split('\n')[0] ?? '';
  const rawMessage = firstLine.replace(/^handoff\s+/, '').trim();
  if (!rawMessage) {
    return null;
  }

  try {
    return JSON.parse(rawMessage) as string;
  } catch {
    return rawMessage;
  }
}

/**
 * 只有目标并非登录流程、但页面明显停在登录页时，才自动转入 handoff，避免误伤本来就要测登录的场景。
 */
function shouldTriggerLoginHandoff(flowOrInstruction: string, targetUrl: string | undefined, snapshot: SnapshotEvidence): boolean {
  return isLoginLikeSnapshot(snapshot) && !isExpectedLoginFlow(flowOrInstruction, targetUrl);
}

/** 统一生成登录态失效时的 handoff 文案，并把提示写入日志。 */
function triggerLoginHandoff(agent: BrowserAgent, logs: string[], reason: string): BrowserOptHandoffContext {
  const message = `${reason}，疑似登录态已失效。请在浏览器中完成登录，然后重新执行当前 browser-opt 流程。`;
  const output = buildLoginHandoffActionOutput(agent, message);
  logs.push(`handoff: ${message}`);
  logs.push(`handoff-output: ${output}`);
  return buildHandoffContext(agent, message, output);
}

/** 登录页拦截统一走 handoff，而不是把它当成普通动作异常直接抛出。 */
function buildLoginHandoffActionOutput(agent: BrowserAgent, message: string): string {
  const output = agent.handoff(message);
  return `handoff ${JSON.stringify(message)}\n${output}`.trim();
}

/** 粗略识别“本次流程本来就是要去登录页”的场景，避免错误触发 handoff。 */
function isExpectedLoginFlow(flowOrInstruction: string, targetUrl?: string): boolean {
  if (targetUrl && /login|signin|sign-in|auth|oauth|sso/i.test(normalizeUrlForCompare(targetUrl))) {
    return true;
  }

  return /登录页|登录|登陆|sign\s*in|log\s*in|输入密码|验证码|短信码|二次验证/i.test(flowOrInstruction);
}

/** 当调用方提供等待逻辑时，进入 handoff 后暂停等待用户恢复，再继续当前会话。 */
async function resumeFromHandoff(
  agent: BrowserAgent,
  logs: string[],
  handoff: BrowserOptHandoffContext,
  options?: BrowserOptHandoffOptions,
  authStateSavePath?: string,
): Promise<boolean> {
  if (!options?.waitForUserResume) {
    return false;
  }

  await options.onHandoffRequired?.(handoff);
  await options.waitForUserResume(handoff);
  const resumeOutput = agent.resume();
  logs.push(`resume: ${resumeOutput}`);
  if (authStateSavePath) {
    saveAuthState(agent, authStateSavePath, logs);
  }
  await options.onHandoffCompleted?.(handoff);
  return true;
}

/** 保存 cookies 与 storage，失败只记录日志，避免覆盖原本流程的 PASS/FAIL 结论。 */
function saveAuthState(agent: BrowserAgent, authStateSavePath: string, logs: string[]): void {
  try {
    fs.mkdirSync(path.dirname(authStateSavePath), { recursive: true });
    const saveOutput = agent.stateSave(authStateSavePath);
    logs.push(`auth-state-save: ${authStateSavePath}`);
    if (saveOutput.trim()) {
      logs.push(`auth-state-save-output: ${saveOutput.trim()}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs.push(`auth-state-save-failed: ${message}`);
  }
}

function isLoginLikeSnapshot(snapshot: SnapshotEvidence): boolean {
  return /登录|登\s*录|login|请输入手机号|请输入密码/i.test(snapshot.text);
}
