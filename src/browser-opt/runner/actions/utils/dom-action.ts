/**
 * browser-opt DOM 动作兜底工具，负责在 snapshot 信息缺失时按页面真实 DOM
 * 的字段上下文定位控件，并执行点击、输入等通用动作。
 */
import type { BrowserAgent } from '../../../../core/agent.js';

interface FieldScopedDomResult {
  found?: boolean;
  clicked?: boolean;
  filled?: boolean;
  targetText?: string;
}

export function clickFieldScopedDomTarget(agent: BrowserAgent, field: string, target: string): string | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.clickFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(target)}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.found && parsed.clicked) {
      agent.waitMs(300);
      const clickedText = parsed.targetText ? ` (${parsed.targetText.trim()})` : '';
      return `click dom ${field} -> ${target}${clickedText}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function fillFieldScopedDomTarget(agent: BrowserAgent, field: string, value: string): string | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.fillFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(value)}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.found && parsed.filled) {
      agent.waitMs(300);
      return `fill dom ${field} ${JSON.stringify(value)}`;
    }
    return null;
  } catch {
    return null;
  }
}

function parseEvalJson(raw: string): FieldScopedDomResult {
  const decoded = JSON.parse(raw.trim()) as unknown;
  return typeof decoded === 'string'
    ? JSON.parse(decoded) as FieldScopedDomResult
    : decoded as FieldScopedDomResult;
}

/** 返回页面上下文内使用的字段近邻定位工具源码，兼容常见表单和伪控件结构。 */
function fieldScopedDomHelperSource(): string {
  return `
(() => {
const normalize = (value) => String(value || '').replace(/[\\s：:，,。；*"'‘’“”]/g, '').toLowerCase();
const visible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
};
const textOf = (element) => [
  element.textContent,
  element.getAttribute('aria-label'),
  element.getAttribute('placeholder'),
  element.getAttribute('title'),
  element.getAttribute('value'),
].filter(Boolean).join(' ');
const textMatches = (element, text) => normalize(textOf(element)).includes(text);
const disabled = (element) => element.disabled === true || element.getAttribute('aria-disabled') === 'true' || element.matches('[disabled], .disabled, .ant-select-disabled, .is-disabled');
const clickable = (element) => {
  if (disabled(element)) return false;
  const style = window.getComputedStyle(element);
  const role = element.getAttribute('role') || '';
  return element instanceof HTMLButtonElement
    || element instanceof HTMLAnchorElement
    || element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || Boolean(element.onclick)
    || ['button', 'option', 'menuitem', 'menuitemcheckbox', 'checkbox', 'radio', 'switch'].includes(role)
    || element.tabIndex >= 0
    || style.cursor === 'pointer'
    || element.matches('.ant-select, .ant-select-selector, .ant-cascader, .ant-cascader-picker, .el-select, .el-input, .el-input__inner');
};
const inputLike = (element) => {
  if (disabled(element)) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !['hidden', 'file', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(element.type);
  return element.isContentEditable === true;
};
const dispatchMouse = (element) => {
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: (rect.left + rect.right) / 2,
    clientY: (rect.top + rect.bottom) / 2,
  };
  element.dispatchEvent(new MouseEvent('pointerdown', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.dispatchEvent(new MouseEvent('click', init));
};
const dispatchValue = (element, value) => {
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  element.focus?.();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(element, value);
  } else if (element.isContentEditable) {
    element.textContent = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.blur?.();
};
const candidates = () => [...document.body.querySelectorAll('*')].filter((element) => visible(element));
const fieldElements = (field) => {
  const fieldText = normalize(field);
  return candidates()
    .filter((element) => textMatches(element, fieldText))
    .map((element) => ({ element, rect: element.getBoundingClientRect(), textLength: normalize(textOf(element)).length }))
    .sort((a, b) => a.textLength - b.textLength || (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
};
const closestFieldContainer = (element) => element.closest('.ant-form-item, .el-form-item, .form-item, [class*="form-item"], [class*="FormItem"], [class*="field"], [class*="Field"]');
const nearestByPosition = (fields, targets) => {
  const scored = [];
  for (const field of fields) {
    for (const item of targets) {
      const rect = item.element.getBoundingClientRect();
      if (rect.top < field.rect.top - 8) continue;
      const verticalGap = Math.max(0, rect.top - field.rect.bottom);
      if (verticalGap > 260) continue;
      const horizontalGap = Math.abs(rect.left - field.rect.left);
      scored.push({ element: item.element, score: verticalGap * 10 + horizontalGap });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored[0]?.element || null;
};
const scopedTarget = (field, predicate) => {
  const fields = fieldElements(field);
  for (const fieldItem of fields) {
    const container = closestFieldContainer(fieldItem.element);
    const scoped = container ? [...container.querySelectorAll('*')].filter((element) => visible(element) && predicate(element)) : [];
    if (scoped.length > 0) {
      return { element: scoped[0], fields };
    }
  }
  const targets = candidates().filter(predicate).map((element) => ({ element }));
  return { element: nearestByPosition(fields, targets), fields };
};
function clickFieldScopedTarget(field, target) {
  const targetText = normalize(target);
  const result = scopedTarget(field, (element) => clickable(element) && textMatches(element, targetText));
  if (result.element) {
    dispatchMouse(result.element);
    return { found: true, clicked: true, targetText: textOf(result.element) };
  }
  return { found: result.fields.length > 0, clicked: false };
}
function fillFieldScopedTarget(field, value) {
  const result = scopedTarget(field, inputLike);
  if (result.element) {
    dispatchValue(result.element, value);
    return { found: true, filled: true, targetText: textOf(result.element) };
  }
  return { found: result.fields.length > 0, filled: false };
}
return { clickFieldScopedTarget, fillFieldScopedTarget };
})()
`;
}
