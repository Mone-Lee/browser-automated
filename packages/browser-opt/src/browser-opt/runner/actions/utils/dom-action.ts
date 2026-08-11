/**
 * browser-opt DOM 动作兜底工具，负责在 snapshot 信息缺失时按页面真实 DOM
 * 的字段上下文定位控件，并执行点击、输入等通用动作。
 */
import type { BrowserAgent } from '#browser-core/agent';

interface FieldScopedDomResult {
  found?: boolean;
  clicked?: boolean;
  filled?: boolean;
  targetText?: string;
  value?: string;
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

export function fillFieldScopedDomTarget(
  agent: BrowserAgent,
  field: string,
  value: string,
  preserveFocus = false,
): string | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.fillFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(value)}, ${preserveFocus}));
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

/** 读取字段对应输入控件的真实 DOM 值，供 snapshot 未暴露值时做后置校验。 */
export function readFieldScopedDomValue(agent: BrowserAgent, field: string): string | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.readFieldScopedValue(${JSON.stringify(field)}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return parsed.found && typeof parsed.value === 'string' ? parsed.value : null;
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
const dispatchValue = (element, value, keepFocus = false) => {
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  // Ant 虚拟表格的表头与表体使用独立滚动容器，scrollIntoView 后显式同步表头避免视觉与列映射错位。
  const virtualTable = element.closest('.ant-table-virtual');
  const virtualBody = element.closest('.ant-table-tbody-virtual-holder');
  const virtualHeader = virtualTable?.querySelector('.ant-table-header');
  if (virtualBody && virtualHeader) {
    virtualHeader.scrollLeft = virtualBody.scrollLeft;
  }
  element.focus?.();
  const preserveFocus = Boolean(element.closest('[role="combobox"], .ant-select, .el-select'));
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter?.call(element, value);
  } else if (element.isContentEditable) {
    element.textContent = value;
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  if (!preserveFocus && !keepFocus) {
    element.blur?.();
  }
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
const actionableDescendants = (root, predicate) => [...root.querySelectorAll('*')].filter((element) => visible(element) && predicate(element));
const tableComponentRoot = (header) => header.closest('.ant-table, .el-table, [role="table"], [role="grid"]')
  || header.closest('table')?.parentElement;
const tableRows = (root) => root ? [...root.querySelectorAll('tbody tr, [role="row"], .ant-table-tbody-virtual-holder-inner .ant-table-row')] : [];
const tableRowCells = (row) => [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"], :scope > .ant-table-cell')];
const horizontalOverlap = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
const tableCellIdentities = (cell) => {
  const identities = [];
  for (const name of ['data-column-key', 'data-field', 'data-prop', 'data-index', 'aria-colindex']) {
    const value = cell.getAttribute(name);
    if (value) identities.push(name + '=' + value);
  }
  for (const token of cell.classList || []) {
    if (/column|(^|[-_])col([-_]|\\d)|cell[-_]\\d/i.test(token) && !/^(ant-table-cell|el-table__cell)$/.test(token)) {
      identities.push('class=' + token);
    }
  }
  const table = cell.closest('table');
  const index = cell.cellIndex;
  const col = table && index >= 0 ? table.querySelectorAll('colgroup col')[index] : null;
  if (col) {
    for (const name of ['name', 'class', 'data-column-key', 'data-index']) {
      const value = col.getAttribute(name);
      if (value) identities.push('col-' + name + '=' + value);
    }
  }
  return [...new Set(identities)];
};
const targetInside = (cell, predicate) => {
  if (!cell) return null;
  if (visible(cell) && predicate(cell)) return cell;
  return actionableDescendants(cell, predicate)[0] || null;
};
const tableColumnTarget = (fieldElement, predicate) => {
  const header = fieldElement.closest('th, td')
    || (fieldElement.getAttribute('role') === 'columnheader' ? fieldElement : null);
  if (!header) return null;
  const component = tableComponentRoot(header);
  const headerRect = header.getBoundingClientRect();
  const rows = tableRows(component);
  const headerCells = [...(header.parentElement?.children || [])];
  const columnIndex = header.cellIndex >= 0 ? header.cellIndex : headerCells.indexOf(header);

  // Ant 虚拟表格保留完整列顺序但表头、表体滚动位置可能短暂不同，必须优先按稳定列序号定位。
  if (component?.matches('.ant-table-virtual') && columnIndex >= 0) {
    for (const row of rows) {
      const target = targetInside(tableRowCells(row)[columnIndex], predicate);
      if (target) return target;
    }
  }
  const headerIdentities = tableCellIdentities(header);
  const identityTargets = headerIdentities.length === 0 ? [] : rows
    .flatMap((row) => tableRowCells(row)
      .filter((cell) => tableCellIdentities(cell).some((identity) => headerIdentities.includes(identity)))
      .map((cell) => ({ target: targetInside(cell, predicate), rowTop: row.getBoundingClientRect().top })))
    .filter((item) => item.target)
    .sort((a, b) => a.rowTop - b.rowTop);
  if (identityTargets.length > 0) return identityTargets[0].target;

  // 滚动表格常把表头和表体拆成不同 table，并额外渲染固定列副本；按屏幕横坐标映射才能避免列序号漂移。
  const sameTextHeaders = component ? [...component.querySelectorAll('thead th, thead td, [role="columnheader"]')]
    .filter((item) => normalize(textOf(item)) === normalize(textOf(header))) : [];
  const geometricTargets = sameTextHeaders.length > 1 ? [] : rows
    .flatMap((row) => tableRowCells(row)
      .map((cell) => ({ cell, rowTop: row.getBoundingClientRect().top, overlap: horizontalOverlap(headerRect, cell.getBoundingClientRect()) })))
    .filter((item) => item.overlap > 0)
    .map((item) => ({ ...item, target: targetInside(item.cell, predicate) }))
    .filter((item) => item.target)
    .sort((a, b) => b.overlap - a.overlap || a.rowTop - b.rowTop);
  if (geometricTargets.length > 0) return geometricTargets[0].target;

  if (columnIndex < 0) return null;
  const ownTable = header.closest('table');
  const indexedRows = ownTable?.querySelector('tbody tr') ? [...ownTable.querySelectorAll('tbody tr')] : rows;
  for (const row of indexedRows) {
    const cell = tableRowCells(row)[columnIndex];
    if (!cell) continue;
    const target = targetInside(cell, predicate);
    if (target) return target;
  }
  return null;
};
const collectSiblingScope = (element) => {
  const scope = [];
  let current = element;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (visible(current)) {
      scope.push(current);
    }

    const parent = current.parentElement;
    if (!parent) break;
    const siblings = [...parent.children];
    const currentIndex = siblings.indexOf(current);
    for (let offset = 1; offset <= 2; offset += 1) {
      const previous = siblings[currentIndex - offset];
      const next = siblings[currentIndex + offset];
      if (previous && visible(previous)) scope.push(previous);
      if (next && visible(next)) scope.push(next);
    }
    current = parent;
  }
  return [...new Set(scope)];
};
const structurallyScopedTargets = (fieldElement, predicate) => {
  for (const root of collectSiblingScope(fieldElement)) {
    if (predicate(root)) {
      return root;
    }

    const descendant = actionableDescendants(root, predicate)[0];
    if (descendant) {
      return descendant;
    }
  }
  return null;
};
const scopedTarget = (field, predicate) => {
  const fields = fieldElements(field);
  const tableFields = fields.filter((fieldItem) => fieldItem.element.closest('th, [role="columnheader"]'));
  for (const fieldItem of tableFields.length > 0 ? tableFields : fields) {
    const tableTarget = tableColumnTarget(fieldItem.element, predicate);
    if (tableTarget) {
      return { element: tableTarget, fields };
    }
    // 列头定位失败时不能退化为普通近邻搜索，否则会把值写入相邻列并造成同源校验假阳性。
    if (fieldItem.element.closest('th, [role="columnheader"]')) {
      continue;
    }

    const container = closestFieldContainer(fieldItem.element);
    const scoped = container ? [...container.querySelectorAll('*')].filter((element) => visible(element) && predicate(element)) : [];
    if (scoped.length > 0) {
      return { element: scoped[0], fields };
    }

    const structural = structurallyScopedTargets(fieldItem.element, predicate);
    if (structural) {
      return { element: structural, fields };
    }
  }
  return { element: null, fields };
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
function fillFieldScopedTarget(field, value, preserveFocus) {
  const result = scopedTarget(field, inputLike);
  if (result.element) {
    dispatchValue(result.element, value, preserveFocus);
    return { found: true, filled: true, targetText: textOf(result.element) };
  }
  return { found: result.fields.length > 0, filled: false };
}
function readFieldScopedValue(field) {
  const result = scopedTarget(field, inputLike);
  if (!result.element) {
    return { found: false };
  }
  const value = result.element instanceof HTMLInputElement || result.element instanceof HTMLTextAreaElement
    ? result.element.value
    : result.element.textContent || '';
  return { found: true, value };
}
return { clickFieldScopedTarget, fillFieldScopedTarget, readFieldScopedValue };
})()
`;
}
