/**
 * browser-opt 选项选择动作执行器，负责下拉、单选、复选和 switch 的确定性选择流程。
 */
import type { BrowserAgent } from '@browser-automated/browser-core/agent';
import type { DeterministicAction, SnapshotEvidence, DeterministicExecutionOptions } from '../../../type.js';
import {
  findSelectableFieldRef,
  findSelectableOption,
} from '../../../utils.js';
import { captureTransientSnapshot } from '../../evidence.js';
import {
  executeDateSelectOptionAction,
  resolveDateSelectOption,
  verifyDateSelectOptionActionEffect,
} from './date-action.js';

/** 执行选项选择动作，包含 switch、原生单选复选框和长表单滚动搜索兜底。 */
export function executeSelectOptionAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
  snapshot: SnapshotEvidence,
  options: DeterministicExecutionOptions,
): string {
  const normalizedDate = resolveDateSelectOption(action);
  if (normalizedDate) {
    return executeDateSelectOptionAction(agent, action, snapshot, normalizedDate);
  }

  let option = findSelectableOption(snapshot, action.field, action.option);
  let searchSnapshot = snapshot;
  const fieldLabel = action.field ?? '选项';
  if (option.alreadySelected) {
    if (!isSwitchSelectable(option.role)) {
      return `selection skipped: ${fieldLabel} 已是 ${action.option}`;
    }

    const domState = action.field ? verifySwitchDomState(agent, action.field, action.option) : null;
    if (domState === true) {
      return `selection skipped: ${fieldLabel} 已是 ${action.option}`;
    }
    option = { ...option, alreadySelected: false };
  }

  const switchDomTarget = isSwitchSelectable(option.role) && action.field
    ? clickSwitchDomTarget(agent, action.field, action.option)
    : null;
  if (switchDomTarget) {
    return switchDomTarget;
  }

  const nativeSelectableDomTarget = clickNativeSelectableDomTarget(agent, option.role, action.option);
  if (nativeSelectableDomTarget) {
    return nativeSelectableDomTarget;
  }

  const searchOutput: string[] = [];
  const dropdownDomTarget = action.field ? clickDropdownDomTarget(agent, action.field, action.option) : { attempted: false, output: null };
  if (dropdownDomTarget.output) {
    return dropdownDomTarget.output;
  }
  if (dropdownDomTarget.attempted && !option.ref && findSelectableFieldRef(searchSnapshot, action.field)) {
    throw new Error(`无法通过 DOM 安全选择下拉选项：${fieldLabel} -> ${action.option}`);
  }

  if (!option.ref) {
    const fieldRef = findSelectableFieldRef(searchSnapshot, action.field);
    if (fieldRef) {
      searchOutput.push(`open select @${fieldRef}\n${agent.click(fieldRef)}`.trim());
      agent.waitMs(300);
      const openedSnapshot = captureTransientSnapshot(agent);
      option = findSelectableOption(openedSnapshot, null, action.option);
    }
  }

  if (!option.ref && action.field && options.allowViewportSearch) {
    const scrolled = searchSelectableInLongForm(agent, action);
    if (scrolled) {
      searchSnapshot = scrolled.snapshot;
      option = scrolled.option;
      searchOutput.push(...scrolled.logs);
    }
  }

  if (!option.ref) {
    const fieldRef = findSelectableFieldRef(searchSnapshot, action.field);
    if (fieldRef) {
      searchOutput.push(`open select @${fieldRef}\n${agent.click(fieldRef)}`.trim());
      agent.waitMs(300);
      const openedSnapshot = captureTransientSnapshot(agent);
      option = findSelectableOption(openedSnapshot, null, action.option);
    }
  }

  if (!option.ref) {
    throw new Error(`无法找到选项：${fieldLabel} -> ${action.option}`);
  }

  const output = agent.click(option.ref);
  return [
    ...searchOutput,
    `${formatSelectableActionName(option.role)} @${option.ref} ${fieldLabel}=${action.option}`,
    output,
  ].filter(Boolean).join('\n').trim();
}

/** 对选择动作做后置状态确认，防止命令发出但页面没有完成目标状态时误报成功。 */
export function verifySelectOptionActionEffect(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
  afterSnapshot: SnapshotEvidence,
): { passed: boolean; message: string } {
  const normalizedDate = resolveDateSelectOption(action);
  if (normalizedDate) {
    return verifyDateSelectOptionActionEffect(agent, action, afterSnapshot, normalizedDate);
  }

  const selected = findSelectableOption(afterSnapshot, action.field, action.option);
  if (isSwitchSelectable(selected.role) && action.field) {
    const domState = verifySwitchDomState(agent, action.field, action.option);
    if (domState === true) {
      return { passed: true, message: `已确认开关状态：${action.field}=${action.option}` };
    }
    if (domState === false) {
      return { passed: false, message: `DOM 确认开关未达到目标状态：${action.field}=${action.option}` };
    }
    return { passed: false, message: `无法可靠确认开关状态：${action.field}=${action.option}` };
  }

  if (selected.alreadySelected) {
    return { passed: true, message: `已确认选择状态：${action.field ?? '选项'}=${action.option}` };
  }

  if (isSelectedValueVisible(afterSnapshot.text, action.field, action.option)) {
    return { passed: true, message: `已确认页面显示选择值：${action.field ?? '选项'}=${action.option}` };
  }

  if (isOrdinalOptionIntent(action.option) && action.field && isFieldSelectedValueVisible(afterSnapshot.text, action.field)) {
    return { passed: true, message: `已确认按位置选择：${action.field}=${action.option}` };
  }

  return { passed: false, message: `动作后未确认目标已选中：${action.field ?? '选项'}=${action.option}` };
}

/** radio/checkbox 的无障碍 ref 可能指向隐藏 input，文案唯一时改点真实 label 以触发组件事件。 */
function clickNativeSelectableDomTarget(agent: BrowserAgent, role: string | null, option: string): string | null {
  if (!/radio|checkbox/i.test(role ?? '')) {
    return null;
  }

  const script = `(() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, '').trim();
  const target = normalize(${JSON.stringify(option)});
  const labels = [...document.querySelectorAll('label')].filter((label) => normalize(label.textContent) === target);
  if (labels.length !== 1) {
    return JSON.stringify({ matchedCount: labels.length, clicked: false });
  }
  const input = labels[0].querySelector('input[type="radio"], input[type="checkbox"]');
  if (!input || input.disabled) {
    return JSON.stringify({ matchedCount: 1, clicked: false, disabled: Boolean(input?.disabled) });
  }
  labels[0].click();
  return JSON.stringify({ matchedCount: 1, clicked: true, checked: input.checked });
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return parsed.matchedCount === 1 && parsed.clicked === true
      ? `selectable dom click ${option}`
      : null;
  } catch {
    return null;
  }
}

/** 普通下拉优先按 DOM 中字段同组控件和可见弹层选项点击，避开嵌套布局里的 ref 坐标漂移。 */
function clickDropdownDomTarget(agent: BrowserAgent, field: string, option: string): { attempted: boolean; output: string | null } {
  const openScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.openDropdownByField(${JSON.stringify(field)}));
})()`;

  try {
    const opened = parseEvalJson(agent.evaluate(openScript));
    if (typeof opened.opened !== 'boolean') {
      return { attempted: false, output: null };
    }
    if (!opened.found || opened.opened === false) {
      return { attempted: true, output: null };
    }

    agent.waitMs(300);
    const clickScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.clickVisibleOption(${JSON.stringify(option)}));
})()`;
    const clicked = parseEvalJson(agent.evaluate(clickScript));
    if (clicked.clicked === true) {
      agent.waitMs(300);
      const selectedText = clicked.selectedText ? ` (${clicked.selectedText})` : '';
      return { attempted: true, output: `select dom click ${field}=${option}${selectedText}` };
    }
    return { attempted: true, output: null };
  } catch {
    return { attempted: true, output: null };
  }
}

/** 长表单中字段可能不在当前可交互快照里，按视口上下搜索字段和目标选项。 */
function searchSelectableInLongForm(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
): {
  snapshot: SnapshotEvidence;
  option: { ref: string | null; alreadySelected: boolean; role: string | null };
  logs: string[];
} | null {
  const logs: string[] = [];
  const moves: Array<{ direction: 'up' | 'down'; amount: number }> = [
    { direction: 'up', amount: 900 },
    { direction: 'up', amount: 900 },
    { direction: 'down', amount: 900 },
    { direction: 'down', amount: 900 },
    { direction: 'down', amount: 900 },
  ];

  for (const move of moves) {
    const output = agent.scroll(move.direction, move.amount);
    logs.push(`scroll ${move.direction} ${move.amount}${output.trim() ? `\n${output.trim()}` : ''}`);
    agent.waitMs(200);
    const snapshot = captureTransientSnapshot(agent);
    const option = findSelectableOption(snapshot, action.field, action.option);
    if (option.ref || option.alreadySelected || findSelectableFieldRef(snapshot, action.field)) {
      return { snapshot, option, logs };
    }
  }

  return null;
}

/** 对 switch 优先使用 DOM 中字段同一行的最近开关，避免无障碍 ref 指向或 checked 状态失真。 */
function clickSwitchDomTarget(agent: BrowserAgent, field: string, option: string): string | null {
  const desiredChecked = /^(是|开|开启|打开|启用|true|yes|on)$/i.test(option.trim());
  const script = `(() => {
  const switchHelper = ${switchDomHelperSource()};
  const result = switchHelper.findSwitchByField(${JSON.stringify(field)});
  if (!result.found || !result.switchId) {
    return JSON.stringify(result);
  }
  if (result.checked === ${JSON.stringify(desiredChecked)}) {
    return JSON.stringify({ ...result, clicked: false });
  }
  const element = document.querySelector('[data-browser-opt-switch-id="' + result.switchId + '"]');
  if (!element) {
    return JSON.stringify({ ...result, clicked: false, missingElement: true });
  }
  element.click();
  return JSON.stringify({ ...result, clicked: true });
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (!parsed.found) {
      return null;
    }
    if (parsed.clicked === false && parsed.checked === desiredChecked) {
      return `switch dom skipped: ${field} 已是 ${option}`;
    }
    if (parsed.clicked === true) {
      agent.waitMs(300);
      return `switch dom click ${field}=${option}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** switch 的 accessibility checked 在部分业务页不可靠，单独走 DOM 近邻状态确认。 */
function verifySwitchDomState(agent: BrowserAgent, field: string, option: string): boolean | null {
  const desiredChecked = /^(是|开|开启|打开|启用|true|yes|on)$/i.test(option.trim());
  const script = `(() => {
  const switchHelper = ${switchDomHelperSource()};
  const result = switchHelper.findSwitchByField(${JSON.stringify(field)});
  return JSON.stringify({ ...result, desired: ${JSON.stringify(desiredChecked)} });
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (!parsed.found || typeof parsed.checked !== 'boolean') {
      return null;
    }
    return parsed.checked === parsed.desired;
  } catch {
    return null;
  }
}

function parseEvalJson(raw: string): {
  found?: boolean;
  checked?: boolean | null;
  desired?: boolean;
  clicked?: boolean;
  switchId?: string;
  matchedCount?: number;
  disabled?: boolean;
  opened?: boolean;
  selectedText?: string;
} {
  const decoded = JSON.parse(raw.trim()) as unknown;
  return typeof decoded === 'string'
    ? JSON.parse(decoded) as ReturnType<typeof parseEvalJson>
    : decoded as ReturnType<typeof parseEvalJson>;
}

/** 返回在页面上下文执行的下拉定位工具源码，兼容 Ant Design 和常见伪下拉结构。 */
function dropdownDomHelperSource(): string {
  return `
(() => {
const normalizeBrowserOptText = (value) => String(value || '').replace(/[\\s：:，,。；*]/g, '').toLowerCase();
const browserOptVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
};
const browserOptCenterDistance = (a, b) => {
  const ax = (a.left + a.right) / 2;
  const ay = (a.top + a.bottom) / 2;
  const bx = (b.left + b.right) / 2;
  const by = (b.top + b.bottom) / 2;
  return Math.abs(ax - bx) + Math.abs(ay - by);
};
const browserOptDispatchMouse = (element) => {
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: (rect.left + rect.right) / 2,
    clientY: (rect.top + rect.bottom) / 2,
  };
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.dispatchEvent(new MouseEvent('click', init));
};
const browserOptSelects = () => [...document.querySelectorAll([
  '.ant-select:not(.ant-select-disabled)',
  '.el-select:not(.is-disabled)',
  '.ant-cascader-picker:not(.ant-cascader-picker-disabled)',
  '[role="combobox"]:not([aria-disabled="true"])',
  'select:not(:disabled)'
].join(','))].filter(browserOptVisible);
const browserOptClickableSelect = (element) =>
  element.matches('select')
    ? element
    : element.querySelector('.ant-select-selector, .el-input, .ant-cascader-input, [role="combobox"]') || element;
const browserOptDropdownContainers = () => [...document.querySelectorAll([
  '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  '.el-select-dropdown:not([style*="display: none"])',
  '[role="listbox"]'
].join(','))]
  .filter(browserOptVisible)
  .map((element) => ({ element, rect: element.getBoundingClientRect() }));
const browserOptOrdinalIndex = (value) => {
  const normalized = normalizeBrowserOptText(value);
  const exact = normalized.match(/^(?:第)?(\\d+)(?:个|项|个选项|项选项)?$/);
  if (exact) {
    return Math.max(Number(exact[1]) - 1, 0);
  }
  const aliases = [
    ['第一个选项', '第一个', '第一项', '首个', '首项'],
    ['第二个选项', '第二个', '第二项'],
    ['第三个选项', '第三个', '第三项'],
    ['第四个选项', '第四个', '第四项'],
    ['第五个选项', '第五个', '第五项'],
  ].map((items) => items.map(normalizeBrowserOptText));
  const matched = aliases.findIndex((items) => items.includes(normalized));
  if (matched >= 0) return matched;
  if (['最后一个选项', '最后一个', '最后一项', '末项'].map(normalizeBrowserOptText).includes(normalized)) {
    return -1;
  }
  return null;
};
const browserOptOptionCandidates = () => {
  const active = document.querySelector('[data-browser-opt-active-select="true"]');
  const activeRect = active?.getBoundingClientRect();
  const containers = browserOptDropdownContainers()
    .map((item) => ({
      ...item,
      distance: activeRect ? browserOptCenterDistance(activeRect, item.rect) : 0,
    }))
    .sort((a, b) => a.distance - b.distance);
  const scopedRoot = containers[0]?.element;
  if (!scopedRoot) {
    return [];
  }
  return [...scopedRoot.querySelectorAll([
    '.ant-select-item-option',
    '.ant-select-dropdown-menu-item',
    '.el-select-dropdown__item',
    '[role="option"]'
  ].join(','))]
  .filter(browserOptVisible)
  .filter((element) => {
    const ariaDisabled = element.getAttribute('aria-disabled') === 'true';
    const className = String(element.className || '');
    return !ariaDisabled && !className.includes('disabled');
  })
  .map((element) => ({ element, text: normalizeBrowserOptText(element.textContent), rawText: String(element.textContent || '').trim(), rect: element.getBoundingClientRect() }))
  .filter((item) => item.text)
  .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
};
const browserOptClosestFieldContainers = (labelElement) => {
  const containers = [];
  let current = labelElement;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    if (normalizeBrowserOptText(current.textContent).length > 0) {
      containers.push(current);
    }
  }
  return containers
    .filter((element) => browserOptSelects().some((select) => element.contains(select)))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
};
function openDropdownByField(field) {
  const fieldText = normalizeBrowserOptText(field);
  const labels = [...document.querySelectorAll('body *')]
    .filter((element) => browserOptVisible(element) && normalizeBrowserOptText(element.textContent).includes(fieldText))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  const selects = browserOptSelects().map((element) => ({ element, rect: element.getBoundingClientRect() }));
  for (const label of labels) {
    for (const container of browserOptClosestFieldContainers(label.element)) {
      const target = browserOptSelects()
        .filter((select) => container.element.contains(select))
        .map((element) => ({ element, rect: element.getBoundingClientRect(), distance: browserOptCenterDistance(label.rect, element.getBoundingClientRect()) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (target) {
        document.querySelectorAll('[data-browser-opt-active-select="true"]').forEach((element) => element.removeAttribute('data-browser-opt-active-select'));
        target.element.setAttribute('data-browser-opt-active-select', 'true');
        browserOptDispatchMouse(browserOptClickableSelect(target.element));
        return { found: true, opened: true, strategy: 'container' };
      }
    }

    const sameGroup = selects
      .map((item) => {
        const verticalOverlap = Math.min(label.rect.bottom, item.rect.bottom) - Math.max(label.rect.top, item.rect.top);
        const yDistance = Math.abs((label.rect.top + label.rect.bottom) / 2 - (item.rect.top + item.rect.bottom) / 2);
        const rightSide = item.rect.left >= label.rect.left - 4;
        return { ...item, verticalOverlap, yDistance, rightSide, distance: browserOptCenterDistance(label.rect, item.rect) };
      })
      .filter((item) => item.rightSide && (item.verticalOverlap > 0 || item.yDistance < Math.max(label.rect.height, item.rect.height) * 1.5))
      .sort((a, b) => a.yDistance - b.yDistance || a.distance - b.distance);
    const target = sameGroup[0];
    if (target) {
      document.querySelectorAll('[data-browser-opt-active-select="true"]').forEach((element) => element.removeAttribute('data-browser-opt-active-select'));
      target.element.setAttribute('data-browser-opt-active-select', 'true');
      browserOptDispatchMouse(browserOptClickableSelect(target.element));
      return { found: true, opened: true, strategy: 'row' };
    }
  }
  return { found: false, opened: false };
}
function clickVisibleOption(option) {
  const optionText = normalizeBrowserOptText(option);
  const options = browserOptOptionCandidates();
  const ordinalIndex = browserOptOrdinalIndex(option);
  const target = typeof ordinalIndex === 'number'
    ? options[ordinalIndex === -1 ? options.length - 1 : ordinalIndex]
    : options
      .filter((item) => item.text.includes(optionText) || optionText.includes(item.text))
      .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height))[0];
  if (!target) {
    return { found: false, clicked: false };
  }
  browserOptDispatchMouse(target.element);
  return { found: true, clicked: true, selectedText: target.rawText };
}
return { openDropdownByField, clickVisibleOption };
})()
`;
}

/** 返回在页面上下文执行的 switch 定位工具源码，按字段同一行最近 switch 选择目标。 */
function switchDomHelperSource(): string {
  return `
(() => {
const normalizeBrowserOptText = (value) => String(value || '').replace(/[\\s：:，,。；*]/g, '').toLowerCase();
const browserOptVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
};
const browserOptSwitchState = (element) => {
  const aria = element.getAttribute('aria-checked');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (element.checked === true) return true;
  if (element.checked === false) return false;
  const className = String(element.className || '');
  if (element.classList.contains('ant-switch-checked') || element.classList.contains('is-checked') || className.includes('switch-checked')) return true;
  if (element.classList.contains('ant-switch-disabled') && element.classList.contains('ant-switch-checked')) return true;
  const text = normalizeBrowserOptText(element.textContent || '');
  const hasTruthyText = ['是', '开启', '打开', '启用', '展示', 'true', 'yes', 'on'].some((item) => text.includes(item));
  const hasFalsyText = ['否', '关闭', '停用', '禁用', '不展示', 'false', 'no', 'off'].some((item) => text.includes(item));
  if (hasTruthyText && !hasFalsyText) return true;
  if (hasFalsyText && !hasTruthyText) return false;
  return null;
};
const browserOptSwitches = () => [...document.querySelectorAll('[role="switch"], .ant-switch, button')]
  .filter((element) => browserOptVisible(element) && (element.getAttribute('role') === 'switch' || String(element.className || '').includes('switch')));
function findSwitchByField(field) {
  const fieldText = normalizeBrowserOptText(field);
  const labels = [...document.querySelectorAll('body *')]
    .filter((element) => browserOptVisible(element) && normalizeBrowserOptText(element.textContent).includes(fieldText))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  const switches = browserOptSwitches().map((element, index) => {
    const id = 'browser-opt-switch-' + index;
    element.setAttribute('data-browser-opt-switch-id', id);
    return { element, id, rect: element.getBoundingClientRect(), checked: browserOptSwitchState(element) };
  });
  for (const label of labels) {
    const sameRow = switches
      .map((item) => {
        const verticalOverlap = Math.min(label.rect.bottom, item.rect.bottom) - Math.max(label.rect.top, item.rect.top);
        const yDistance = Math.abs((label.rect.top + label.rect.bottom) / 2 - (item.rect.top + item.rect.bottom) / 2);
        const xDistance = Math.abs((label.rect.left + label.rect.right) / 2 - (item.rect.left + item.rect.right) / 2);
        return { ...item, verticalOverlap, yDistance, xDistance };
      })
      .filter((item) => item.checked !== null && (item.verticalOverlap > 0 || item.yDistance < Math.max(label.rect.height, item.rect.height)))
      .sort((a, b) => a.yDistance - b.yDistance || a.xDistance - b.xDistance);
    const target = sameRow[0];
    if (target) {
      return { found: true, checked: target.checked, switchId: target.id };
    }
  }
  return { found: false, checked: null };
}
return { findSwitchByField };
})()
`;
}

function isSwitchSelectable(role: string | null): boolean {
  return Boolean(role && /switch/i.test(role));
}

/** 下拉选择通常会收起选项列表，只保留字段和值文案，因此补充基于页面文案的确认。 */
function isSelectedValueVisible(text: string, field: string | null, option: string): boolean {
  const normalizedText = normalizeVisibleText(text);
  const normalizedOption = normalizeVisibleText(option);
  if (!normalizedOption || !normalizedText.includes(normalizedOption)) {
    return false;
  }

  if (!field) {
    return true;
  }

  return normalizedText.includes(normalizeVisibleText(field));
}

/** 识别“第一个选项/最后一个”这类按位置选择的意图。 */
function isOrdinalOptionIntent(option: string): boolean {
  const normalized = normalizeVisibleText(option);
  return /^(?:第)?\d+(?:个|项|个选项|项选项)?$/.test(normalized)
    || /^(?:第)?[一二三四五六七八九十]+(?:个|项|个选项|项选项)$/.test(normalized)
    || /^(首个|首项|最后一个选项|最后一个|最后一项|末项)$/.test(normalized);
}

/** 位置型选择无法用原始目标文案确认，改看字段附近是否存在具体选择值。 */
function isFieldSelectedValueVisible(text: string, field: string): boolean {
  const lines = text.split('\n');
  const normalizedField = normalizeVisibleText(field);
  const fieldIndex = lines.findIndex((line) => normalizeVisibleText(line).includes(normalizedField));
  if (fieldIndex < 0) {
    return false;
  }

  const start = Math.max(0, fieldIndex - 3);
  const end = Math.min(lines.length, fieldIndex + 4);
  for (let index = start; index < end; index += 1) {
    const match = lines[index]?.match(/-\s*(?:generic|combobox|button)\s+"([^"]+)"/i);
    const value = normalizeVisibleText(match?.[1] ?? '');
    if (value && !value.includes(normalizedField) && !normalizedField.includes(value)) {
      return true;
    }
  }

  return false;
}

/** 归一化页面可见文案，减少空白和标点对选择结果确认的影响。 */
function normalizeVisibleText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[：:，,。；"'‘’“”]/g, '').trim();
}

/** 根据控件角色生成 agent-browser 已支持的动作名称，报告文本需与实际命令集一致。 */
function formatSelectableActionName(role: string | null): string {
  if (role && /checkbox|switch/i.test(role)) {
    return 'check';
  }

  return 'click';
}
