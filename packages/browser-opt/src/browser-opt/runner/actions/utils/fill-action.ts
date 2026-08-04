/**
 * browser-opt 输入动作执行器，负责定位输入框并处理登录页阻塞的 handoff。
 */
import type { BrowserAgent } from '@browser-automated/browser-core/agent';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { findTextboxRef } from '../../../utils.js';
import { buildLoginHandoffActionOutput, isLoginLikeSnapshot } from '../../handoff.js';
import { fillFieldScopedDomTarget } from './dom-action.js';

/** 执行输入动作，登录页阻塞时转为 handoff，避免误报找不到业务字段。 */
export function executeFillAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'fill' }>,
  snapshot: SnapshotEvidence,
): string {
  const ref = findTextboxRef(snapshot, action.field);
  if (!ref) {
    if (isLoginLikeSnapshot(snapshot)) {
      return buildLoginHandoffActionOutput(
        agent,
        `当前页面仍在登录页，无法继续填写“${action.field}”，请先完成登录后再继续自动化。`,
      );
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
