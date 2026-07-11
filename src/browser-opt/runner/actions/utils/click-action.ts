/**
 * browser-opt 点击动作执行器，负责从当前快照定位可点击元素并下发 click。
 */
import type { BrowserAgent } from '../../../../core/agent.js';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { findClickableRef } from '../../../utils.js';

/** 执行点击动作，只负责从当前快照定位可点击元素并下发 click。 */
export function executeClickAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'click' }>,
  snapshot: SnapshotEvidence,
): string {
  const ref = findClickableRef(snapshot, action.target);
  if (!ref) {
    throw new Error(`无法找到可点击元素：${action.target}`);
  }

  const output = agent.click(ref);
  return `click @${ref}\n${output}`.trim();
}
