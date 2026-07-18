/**
 * browser-opt 步骤执行器，负责单步骤的快照、动作、验证和接管恢复闭环。
 * 该文件只处理步骤级生命周期，避免主 runner 混入具体交互细节。
 */
import * as path from 'node:path';
import type { BrowserAgent } from '../../core/agent.js';
import type { BrowserOptStepExecutionOptions, BrowserOptStepResult } from '../type.js';
import {
  isVerificationStep,
  parseDeterministicAction,
  summarizeJsonResult,
  summarizeSnapshot,
  verifyStep,
} from '../utils.js';
import { executeDeterministicInstruction, verifyDeterministicActionEffect } from './actions/index.js';
import { captureSettledSnapshot, captureSnapshot, captureTransientSnapshot } from './evidence.js';
import {
  extractHandoffMessage,
  isHandoffActionOutput,
  resumeFromHandoff,
  saveAuthenticatedHandoffState,
  shouldTriggerLoginHandoff,
  shouldTriggerUploadPostProcessHandoff,
  triggerLoginHandoff,
  triggerUploadPostProcessHandoff,
  buildHandoffContext,
} from './handoff.js';

/** 执行单个步骤，负责前后快照、动作重试、验证和步骤级日志记录。 */
export async function executeStep(
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

  if (shouldTriggerLoginHandoff(instruction, options.alreadyOpenedUrl, beforeSnapshot)) {
    const fallbackAgent = options.retryAuthStateFallback?.();
    if (fallbackAgent) {
      logs.push(`auth-state-fallback-retry: 步骤 ${index} 执行前检测到登录页跳转`);
      return executeStep(fallbackAgent, outputDir, index, instruction, {
        ...options,
        alreadyOpenedUrl: undefined,
      });
    }

    const handoff = triggerLoginHandoff(agent, logs, `步骤 ${index} 执行前检测到登录页跳转`);
    const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff);
    if (resumed) {
      const resumedSnapshot = captureTransientSnapshot(agent);
      saveAuthenticatedHandoffState(agent, options.authStateSavePath, logs, resumedSnapshot);
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
      attempts: 0,
      beforeSnapshotPath,
      afterSnapshotPath,
      beforeScreenshotPath,
      afterScreenshotPath,
      actionOutput: handoff.output,
      verification: handoff.message,
      logs,
    };
  }

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
            allowViewportSearch: attempts > 1,
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
      if (isTerminalActionError(actionError)) {
        logs.push(`terminal-failure: ${actionError}`);
        break;
      }
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

  if (isHandoffActionOutput(actionOutput)) {
    const verification = extractHandoffMessage(actionOutput) ?? '已触发人工接管。';
    if (parsedAction?.type !== 'handoff') {
      const fallbackAgent = options.retryAuthStateFallback?.();
      if (fallbackAgent) {
        logs.push(`auth-state-fallback-retry: ${verification}`);
        return executeStep(fallbackAgent, outputDir, index, instruction, {
          ...options,
          alreadyOpenedUrl: undefined,
        });
      }
    }

    const handoff = buildHandoffContext(agent, verification, actionOutput);
    logs.push(`verification paused: ${verification}`);
    const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff);

    if (!resumed) {
      const afterSnapshot = captureSnapshot(agent, afterSnapshotPath);
      agent.screenshot(afterScreenshotPath);
      logs.push(`after-state: ${summarizeSnapshot(afterSnapshot)}`);
      logs.push(`after-screenshot: ${afterScreenshotPath}`);
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

    if (parsedAction?.type !== 'handoff') {
      const resumedSnapshot = captureTransientSnapshot(agent);
      saveAuthenticatedHandoffState(agent, options.authStateSavePath, logs, resumedSnapshot);
      return executeStep(agent, outputDir, index, instruction, {
        ...options,
        alreadyOpenedUrl: undefined,
      });
    }
  }

  let afterSnapshot = captureActionAfterSnapshot(agent, parsedAction?.type ?? null, afterSnapshotPath, logs);
  agent.screenshot(afterScreenshotPath);
  logs.push(`after-state: ${summarizeSnapshot(afterSnapshot)}`);
  logs.push(`after-screenshot: ${afterScreenshotPath}`);

  if (!actionError && parsedAction?.type === 'upload' && shouldTriggerUploadPostProcessHandoff(afterSnapshot)) {
    const handoff = triggerUploadPostProcessHandoff(agent, logs, parsedAction.field);
    const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff);

    if (!resumed) {
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

    afterSnapshot = captureSnapshot(agent, afterSnapshotPath);
    agent.screenshot(afterScreenshotPath);
    logs.push(`resume-snapshot: ${afterSnapshotPath}`);
    logs.push(`resume-state: ${summarizeSnapshot(afterSnapshot)}`);
    logs.push(`resume-screenshot: ${afterScreenshotPath}`);
    actionOutput = [actionOutput, handoff.output].filter(Boolean).join('\n').trim();
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
    const actionVerification = verifyDeterministicActionEffect(agent, parsedAction, afterSnapshot);
    if (!actionVerification.passed) {
      logs.push(`verification failed: ${actionVerification.message}`);
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
        verification: actionVerification.message,
        error: actionVerification.message,
        logs,
      };
    }

    const verification = actionVerification.message;
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
      const fallbackAgent = options.retryAuthStateFallback?.();
      if (fallbackAgent) {
        logs.push(`auth-state-fallback-retry: 步骤 ${index} 验证时检测到登录页跳转`);
        return executeStep(fallbackAgent, outputDir, index, instruction, {
          ...options,
          alreadyOpenedUrl: undefined,
        });
      }
      const handoff = triggerLoginHandoff(agent, logs, `步骤 ${index} 验证时检测到登录页跳转`);
      const resumed = await resumeFromHandoff(agent, logs, handoff, options.handoff);
      if (resumed) {
        const resumedSnapshot = captureTransientSnapshot(agent);
        saveAuthenticatedHandoffState(agent, options.authStateSavePath, logs, resumedSnapshot);
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

/** 确定性动作已确认业务上不可达时不再重试，避免把不可选状态误当异步未完成。 */
function isTerminalActionError(message: string): boolean {
  return message.startsWith('日期不可选：');
}

/** 上传动作后图片裁剪弹层可能异步出现，短暂轮询后再交给 handoff 探测。 */
function captureActionAfterSnapshot(
  agent: BrowserAgent,
  actionType: string | null,
  afterSnapshotPath: string,
  logs: string[],
): ReturnType<typeof captureSnapshot> {
  if (actionType === 'open') {
    return captureSettledSnapshot(agent, afterSnapshotPath, logs);
  }

  let snapshot = captureSnapshot(agent, afterSnapshotPath);
  if (actionType !== 'upload' || shouldTriggerUploadPostProcessHandoff(snapshot)) {
    return snapshot;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    agent.waitMs(500);
    logs.push(`upload-postprocess-wait ${attempt}: 等待上传后的裁剪或确认弹层渲染。`);
    snapshot = captureSnapshot(agent, afterSnapshotPath);
    if (shouldTriggerUploadPostProcessHandoff(snapshot)) {
      break;
    }
  }

  return snapshot;
}
