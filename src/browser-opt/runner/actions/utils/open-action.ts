/**
 * browser-opt 打开页面动作执行器，负责处理重复打开跳过和实际 open 命令下发。
 */
import type { BrowserAgent } from '../../../../core/agent.js';
import type { DeterministicAction, DeterministicExecutionOptions } from '../../../type.js';
import { normalizeUrlForCompare } from '../../evidence.js';

/** 执行打开页面动作，避免重复打开 runner 已初始化的目标地址。 */
export function executeOpenAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'open' }>,
  options: DeterministicExecutionOptions,
): string {
  if (options.alreadyOpenedUrl && normalizeUrlForCompare(action.url) === normalizeUrlForCompare(options.alreadyOpenedUrl)) {
    return `open skipped: ${action.url} 已由 runner 初始化打开`;
  }

  return agent.open(action.url);
}
