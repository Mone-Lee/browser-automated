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
import { executeUploadAction } from './utils/upload-action.js';

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

  if (action.type === 'click') {
    return executeClickAction(agent, action, snapshot);
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
  afterSnapshot: SnapshotEvidence,
): { passed: boolean; message: string } {
  if (action.type === 'fill') {
    return verifyFillActionEffect(action, afterSnapshot);
  }

  if (action.type === 'select-option') {
    return verifySelectOptionActionEffect(agent, action, afterSnapshot);
  }

  return { passed: true, message: '动作步骤已完成，已重新 snapshot。' };
}
