/**
 * browser-opt 点击动作执行器，负责从当前快照定位可点击元素并下发 click。
 */
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { findClickableRef } from '../../../utils.js';
import { clickFieldScopedDomTarget } from './dom-action.js';

/** 执行点击动作，只负责从当前快照定位可点击元素并下发 click。 */
export function executeClickAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'click' }>,
  snapshot: SnapshotEvidence,
): string {
  const ref = findClickableRef(snapshot, action.target, action.field);
  if (ref) {
    const output = agent.click(ref);
    return `click @${ref}\n${output}`.trim();
  }

  const domOutput = action.field ? clickFieldScopedDomTarget(agent, action.field, action.target) : null;
  if (domOutput) {
    return domOutput;
  }

  const scopedTarget = action.field ? `${action.field} -> ${action.target}` : action.target;
  throw new Error(`无法找到可点击元素：${scopedTarget}`);
}
