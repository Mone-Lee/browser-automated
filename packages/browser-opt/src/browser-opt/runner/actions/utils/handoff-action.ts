/**
 * browser-opt 人工接管动作执行器，负责把 handoff 消息交给 agent-browser。
 */
import type { BrowserAgent } from '@browser-automated/browser-core/agent';
import type { DeterministicAction } from '../../../type.js';

/** 执行人工接管动作，保持输出格式与其他确定性动作一致。 */
export function executeHandoffAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'handoff' }>,
): string {
  const output = agent.handoff(action.message);
  return `handoff ${JSON.stringify(action.message)}\n${output}`.trim();
}
