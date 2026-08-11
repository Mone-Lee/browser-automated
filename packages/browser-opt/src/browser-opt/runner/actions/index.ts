/**
 * browser-opt 确定性动作执行器，负责解析自然语言动作并分发到对应 action handler。
 */
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence, DeterministicExecutionOptions } from '../../type.js';
import { parseDeterministicAction } from '../../utils.js';
import { executeClickAction } from './utils/click-action.js';
import { executeFillAction, verifyFillActionEffect } from './utils/fill-action.js';
import { executeHandoffAction } from './utils/handoff-action.js';
import { executeOpenAction } from './utils/open-action.js';
import { executeSelectOptionAction, verifySelectOptionActionEffect } from './utils/select-option-action.js';
import { executeTableRowCheckboxAction, verifyTableRowCheckboxActionEffect } from './utils/table-row-checkbox-action.js';
import { executeUploadAction, verifyUploadActionEffect } from './utils/upload-action.js';
import { captureTransientSnapshot } from '../evidence.js';

export interface ReconcileActionResult {
  applicable: boolean;
  passed: boolean;
  changed: boolean;
  output?: string;
  message?: string;
}

/** 将自然语言动作直接映射到确定性命令，避免默认依赖 agent-browser chat。 */
export async function executeDeterministicInstruction(
  agent: BrowserAgent,
  instruction: string,
  snapshot: SnapshotEvidence,
  outputDir: string,
  options: DeterministicExecutionOptions = {},
): Promise<string | null> {
  const action = parseDeterministicAction(instruction);
  if (!action) {
    return null;
  }

  if (action.type === 'open') {
    return executeOpenAction(agent, action, options);
  }

  if (action.type === 'inspect') {
    return agent.inspect();
  }

  if (action.type === 'fill') {
    return executeFillAction(agent, action, snapshot);
  }

  if (action.type === 'press-key') {
    return agent.press(action.key);
  }

  if (action.type === 'click') {
    return executeClickAction(agent, action, snapshot);
  }

  if (action.type === 'check-table-rows') {
    return executeTableRowCheckboxAction(agent, action, snapshot);
  }

  if (action.type === 'select-option') {
    return executeSelectOptionAction(agent, action, snapshot, options);
  }

  if (action.type === 'upload') {
    return executeUploadAction(agent, action, snapshot, outputDir, options);
  }

  if (action.type === 'handoff') {
    return executeHandoffAction(agent, action);
  }

  return null;
}

/** 对确定性动作做后置状态确认，防止命令发出但页面没有完成目标状态时误报成功。 */
export function verifyDeterministicActionEffect(
  agent: BrowserAgent,
  action: DeterministicAction,
  beforeSnapshot: SnapshotEvidence,
  afterSnapshot: SnapshotEvidence,
  actionOutput: string,
): { passed: boolean; message: string } {
  if (action.type === 'open' || action.type === 'press-key') {
    return { passed: true, message: '该动作不要求页面效果校验。' };
  }

  if (action.type === 'fill') {
    return verifyFillActionEffect(agent, action, afterSnapshot);
  }

  if (action.type === 'select-option') {
    return verifySelectOptionActionEffect(agent, action, afterSnapshot);
  }

  if (action.type === 'check-table-rows') {
    return verifyTableRowCheckboxActionEffect(action, afterSnapshot);
  }

  if (action.type === 'upload') {
    return verifyUploadActionEffect(agent, action, afterSnapshot);
  }

  if (action.type === 'click') {
    const changed = normalizeSnapshotForComparison(beforeSnapshot.text)
      !== normalizeSnapshotForComparison(afterSnapshot.text);
    return changed
      ? { passed: true, message: '点击后页面状态已发生变化。' }
      : { passed: false, message: `点击后页面状态未发生变化：${action.target}` };
  }

  if (action.type === 'inspect') {
    const passed = actionOutput.trim().length > 0;
    return passed
      ? { passed: true, message: '开发者工具命令已返回执行结果。' }
      : { passed: false, message: '开发者工具命令未返回执行结果。' };
  }

  if (action.type === 'handoff') {
    const passed = actionOutput.trim().length > 0;
    return passed
      ? { passed: true, message: '人工接管已完成并恢复原流程。' }
      : { passed: false, message: '人工接管动作未返回执行结果。' };
  }

  if (action.type === 'assert-text') {
    return { passed: false, message: '文本断言未进入专用验证流程。' };
  }

  return { passed: false, message: '动作缺少执行后校验。' };
}

/** 提交前复核可幂等重放的表单状态，并只在页面已回退时重新执行对应输入或选择。 */
export async function reconcileDeterministicInstruction(
  agent: BrowserAgent,
  instruction: string,
  snapshot: SnapshotEvidence,
  outputDir: string,
): Promise<ReconcileActionResult> {
  const action = parseDeterministicAction(instruction);
  if (!action || (action.type !== 'fill' && action.type !== 'select-option')) {
    return { applicable: false, passed: true, changed: false };
  }

  const current = verifyDeterministicActionEffect(agent, action, snapshot, snapshot, '');
  if (current.passed) {
    return { applicable: true, passed: true, changed: false, message: current.message };
  }

  try {
    const output = await executeDeterministicInstruction(agent, instruction, snapshot, outputDir, {
      allowViewportSearch: true,
    });
    if (!output) {
      return { applicable: true, passed: false, changed: false, message: '无法重新执行确定性动作' };
    }
    const settledSnapshot = captureTransientSnapshot(agent);
    const verified = verifyDeterministicActionEffect(agent, action, snapshot, settledSnapshot, output);
    return {
      applicable: true,
      passed: verified.passed,
      changed: true,
      output,
      message: verified.message,
    };
  } catch (error) {
    return {
      applicable: true,
      passed: false,
      changed: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 比较点击前后页面语义时忽略每次 snapshot 都可能变化的临时 ref。 */
function normalizeSnapshotForComparison(text: string): string {
  return text
    .replace(/\s*\[ref=[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
