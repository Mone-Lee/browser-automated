/**
 * browser-opt 输入动作执行器，负责定位输入框并处理登录页阻塞的 handoff。
 */
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { findTextboxRef, readTextboxValue } from '../../../utils.js';
import { captureTransientSnapshot } from '../../evidence.js';
import { buildLoginHandoffActionOutput, isLoginLikeSnapshot } from '../../handoff.js';
import { fillFieldScopedDomTarget, readFieldScopedDomValue } from './dom-action.js';

/** 执行输入动作，登录页阻塞时转为 handoff，避免误报找不到业务字段。 */
export function executeFillAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'fill' }>,
  snapshot: SnapshotEvidence,
): string {
  let ref = findTextboxRef(snapshot, action.field);
  if (!ref) {
    if (isLoginLikeSnapshot(snapshot)) {
      return buildLoginHandoffActionOutput(
        agent,
        `当前页面仍在登录页，无法继续填写“${action.field}”，请先完成登录后再继续自动化。`,
      );
    }

    agent.waitMs(500);
    const settledSnapshot = captureTransientSnapshot(agent);
    ref = findTextboxRef(settledSnapshot, action.field);
    if (ref) {
      const output = agent.fill(ref, action.value);
      return `fill delayed @${ref} ${JSON.stringify(action.value)}\n${output}`.trim();
    }

    const domOutput = fillFieldScopedDomTarget(agent, action.field, action.value);
    if (domOutput) {
      return domOutput;
    }

    throw new Error(`无法找到输入框：${action.field}`);
  }

  const output = agent.fill(ref, action.value);
  return `fill @${ref} ${JSON.stringify(action.value)}\n${output}`.trim();
}

/** 确认目标输入框已写入预期值，避免命令成功返回但受控表单没有接收输入时误报通过。 */
export function verifyFillActionEffect(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'fill' }>,
  afterSnapshot: SnapshotEvidence,
): { passed: boolean; message: string } {
  const actualValue = readTextboxValue(afterSnapshot, action.field);
  if (actualValue === action.value) {
    return { passed: true, message: `已确认输入值：${action.field}=${action.value}` };
  }

  if (actualValue === null) {
    const domValue = readFieldScopedDomValue(agent, action.field);
    if (domValue === action.value) {
      return { passed: true, message: `已通过 DOM 确认输入值：${action.field}=${action.value}` };
    }

    const domDescription = domValue === null ? 'DOM 也未定位到该输入框' : `DOM 实际值为${JSON.stringify(domValue)}`;
    return {
      passed: false,
      message: `动作后未确认输入值：${action.field}=${action.value}（snapshot 未暴露该输入框的值，${domDescription}）`,
    };
  }

  return {
    passed: false,
    message: `动作后未确认输入值：${action.field}=${action.value}（实际值为${JSON.stringify(actualValue)}）`,
  };
}
