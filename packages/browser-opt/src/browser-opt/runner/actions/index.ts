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

interface ClickDomVerificationResult {
  matched: number;
  active: boolean;
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
    if (changed) {
      return { passed: true, message: '点击后页面状态已发生变化。' };
    }

    const domVerified = verifyClickActionEffectViaDom(agent, action.target);
    return domVerified.active
      ? { passed: true, message: `点击后已通过 DOM 确认目标进入激活态：${action.target}` }
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

/** 比较点击前后页面语义时忽略每次 snapshot 都可能变化的临时 ref。 */
function normalizeSnapshotForComparison(text: string): string {
  return text
    .replace(/\s*\[ref=[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 当 snapshot 文本前后相同但页面存在页签/导航高亮变化时，补充读取真实 DOM 激活态避免误判。 */
function verifyClickActionEffectViaDom(agent: BrowserAgent, target: string): ClickDomVerificationResult {
  const targetLiteral = JSON.stringify(target);
  const script = `(() => {
    const normalize = (value) => String(value || '')
      .replace(/\\s+/g, '')
      .replace(/[：:]/g, '')
      .toLowerCase();
    const target = normalize(${targetLiteral});
    if (!target) {
      return JSON.stringify({ matched: 0, active: false });
    }
    const selector = [
      'a',
      'button',
      '[role="tab"]',
      '[role="link"]',
      '[role="button"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[aria-controls]',
      '[aria-selected]',
      '[aria-current]',
      '.ant-tabs-tab',
      '.el-tabs__item',
      '[tabindex]',
    ].join(',');
    const matches = [...document.querySelectorAll(selector)].filter((element) => {
      const text = normalize(
        element.textContent
        || element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.getAttribute('value')
        || '',
      );
      return text && (text.includes(target) || target.includes(text));
    });
    const activeLike = /(^|[\\s_-])(active|selected|current|checked|open)([\\s_-]|$)/i;
    const isActive = (element) => {
      if (!(element instanceof Element)) {
        return false;
      }
      const scope = [element, element.parentElement, element.closest('[role="tablist"], .ant-tabs, .el-tabs, nav')].filter(Boolean);
      return scope.some((candidate) => {
        if (!(candidate instanceof Element)) {
          return false;
        }
        if (
          candidate.getAttribute('aria-selected') === 'true'
          || candidate.getAttribute('aria-current') === 'page'
          || candidate.getAttribute('aria-current') === 'true'
          || candidate.getAttribute('aria-pressed') === 'true'
          || candidate.getAttribute('aria-expanded') === 'true'
          || candidate.getAttribute('aria-checked') === 'true'
          || candidate.getAttribute('data-state') === 'active'
          || candidate.getAttribute('data-status') === 'active'
        ) {
          return true;
        }
        const tokens = [
          candidate.className,
          candidate.getAttribute('data-state'),
          candidate.getAttribute('data-status'),
        ].filter(Boolean).join(' ');
        return activeLike.test(tokens);
      });
    };
    return JSON.stringify({
      matched: matches.length,
      active: matches.some((element) => isActive(element)),
    });
  })()`;

  return parseClickDomVerification(agent.evaluate(script));
}

/** 宽容解析 eval 输出，避免浏览器侧异常把点击验证直接打崩。 */
function parseClickDomVerification(raw: string): ClickDomVerificationResult {
  try {
    const decoded = JSON.parse(raw.trim()) as unknown;
    const parsed = (typeof decoded === 'string'
      ? JSON.parse(decoded)
      : decoded) as Partial<ClickDomVerificationResult>;
    return {
      matched: typeof parsed.matched === 'number' ? parsed.matched : 0,
      active: parsed.active === true,
    };
  } catch {
    return { matched: 0, active: false };
  }
}
