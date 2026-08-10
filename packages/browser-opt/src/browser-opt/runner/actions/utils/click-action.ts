/**
 * browser-opt 点击动作执行器，负责从当前快照定位可点击元素并下发 click。
 */
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { findClickableRef } from '../../../utils.js';
import { captureTransientSnapshot } from '../../evidence.js';
import { clickFieldScopedDomTarget } from './dom-action.js';

/** 点击前按需滚动目标；“下一步”类过渡按钮会等待离开当前页面并在异步门禁期间重试。 */
export function executeClickAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'click' }>,
  snapshot: SnapshotEvidence,
): string {
  const ref = findClickableRef(snapshot, action.target, action.field);
  if (ref) {
    agent.scrollIntoView(ref);
    const output = agent.click(ref);
    if (isPageTransitionClick(action.target)) {
      return waitForPageTransition(agent, action, ref, output);
    }
    return `click @${ref}\n${output}`.trim();
  }

  const domOutput = action.field ? clickFieldScopedDomTarget(agent, action.field, action.target) : null;
  if (domOutput) {
    return domOutput;
  }

  const scopedTarget = action.field ? `${action.field} -> ${action.target}` : action.target;
  throw new Error(`无法找到可点击元素：${scopedTarget}`);
}

/** 图片检测等异步门禁会让“下一步”首次点击无效，按钮仍存在时等待后重试。 */
function waitForPageTransition(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'click' }>,
  initialRef: string,
  initialOutput: string,
): string {
  const outputs = [`click @${initialRef}`, initialOutput];
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    agent.waitMs(1000);
    const snapshot = captureTransientSnapshot(agent);
    const ref = findClickableRef(snapshot, action.target, action.field);
    if (!ref) {
      outputs.push(`page transition confirmed after ${attempt}s`);
      return outputs.filter(Boolean).join('\n').trim();
    }
    agent.scrollIntoView(ref);
    outputs.push(`page transition retry ${attempt} @${ref}`, agent.click(ref));
  }

  throw new Error(`点击后未进入下一页面：${action.target}（等待 15 秒后按钮仍存在）`);
}

function isPageTransitionClick(target: string): boolean {
  return /下一步|继续下一步|进入下一步|next/i.test(target);
}
