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
  reached?: boolean;
  changed?: boolean;
  opened?: boolean;
  kind?: string;
}

interface FieldScopedSelectionOutput {
  dropdownOpened: boolean;
  output: string | null;
}

export function clickFieldScopedDomTarget(
  agent: BrowserAgent,
  field: string,
  target: string,
  rowNumber?: number,
): string | null {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.clickFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(target)}${rowArgument}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.found && parsed.clicked) {
      agent.waitMs(300);
      const clickedText = parsed.targetText ? ` (${parsed.targetText.trim()})` : '';
      const rowLabel = rowNumber ? `第 ${rowNumber} 行 ` : '';
      return `click dom ${rowLabel}${field} -> ${target}${clickedText}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** 未提供列名时在指定数据行内查找唯一目标，适用于“点击第 N 行删除按钮”这类表达。 */
export function clickTableRowDomTarget(agent: BrowserAgent, target: string, rowNumber: number): string | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.clickTableRowTarget(${JSON.stringify(target)}, ${rowNumber}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.found && parsed.clicked) {
      agent.waitMs(300);
      return `click dom 第 ${rowNumber} 行 -> ${target}`;
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
  rowNumber?: number,
): string | null {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.fillFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(value)}, ${preserveFocus}${rowArgument}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.found && parsed.filled) {
      agent.waitMs(300);
      const rowLabel = rowNumber ? `第 ${rowNumber} 行 ` : '';
      return `fill dom ${rowLabel}${field} ${JSON.stringify(value)}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** 读取字段对应输入控件的真实 DOM 值，供 snapshot 未暴露值时做后置校验。 */
export function readFieldScopedDomValue(agent: BrowserAgent, field: string, rowNumber?: number): string | null {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.readFieldScopedValue(${JSON.stringify(field)}${rowArgument}));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return parsed.found && typeof parsed.value === 'string' ? parsed.value : null;
  } catch {
    return null;
  }
}

/** 在指定表格行列内处理开关、单复选框或打开下拉框，避免同列多行控件串位。 */
export function selectFieldScopedDomTarget(
  agent: BrowserAgent,
  field: string,
  option: string,
  rowNumber: number,
  mode: 'select' | 'deselect' | 'exclusive' = 'select',
): FieldScopedSelectionOutput | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.selectFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(option)}, ${rowNumber}, ${JSON.stringify(mode)}, false));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.opened) {
      agent.waitMs(300);
      return { dropdownOpened: true, output: null };
    }
    if (parsed.reached) {
      agent.waitMs(parsed.changed ? 300 : 0);
      const verb = parsed.changed ? 'select dom' : 'selection skipped';
      return { dropdownOpened: false, output: `${verb} 第 ${rowNumber} 行 ${field}=${option}` };
    }
    return null;
  } catch {
    return null;
  }
}

/** 从指定表格单元格读取选择类控件状态，确保后置校验不引用其他数据行。 */
export function verifyFieldScopedDomSelection(
  agent: BrowserAgent,
  field: string,
  option: string,
  rowNumber: number,
  mode: 'select' | 'deselect' | 'exclusive' = 'select',
): boolean | null {
  const script = `(() => {
  const helper = ${fieldScopedDomHelperSource()};
  return JSON.stringify(helper.selectFieldScopedTarget(${JSON.stringify(field)}, ${JSON.stringify(option)}, ${rowNumber}, ${JSON.stringify(mode)}, true));
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return typeof parsed.reached === 'boolean' ? parsed.reached : null;
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
const switchLike = (element) => element.matches('[role="switch"], .ant-switch, [class*="switch"]') && !disabled(element);
const selectLike = (element) => element.matches('select:not(:disabled), .ant-select:not(.ant-select-disabled), .el-select:not(.is-disabled), [role="combobox"]');
const choiceInput = (element, optionText) => {
  const input = element.matches('input[type="radio"], input[type="checkbox"]')
    ? element
    : element.querySelector?.('input[type="radio"], input[type="checkbox"]');
  if (!input || disabled(input)) return null;
  const label = element.closest('label') || input.closest('label') || (input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null);
  const text = normalize(textOf(label || element));
  return text && (text.includes(optionText) || optionText.includes(text)) ? { input, label } : null;
};
const switchState = (element) => {
  const aria = element.getAttribute('aria-checked');
  if (aria === 'true' || aria === '1') return true;
  if (aria === 'false' || aria === '0') return false;
  if (typeof element.checked === 'boolean') return element.checked;
  const className = String(element.className || '');
  if (element.classList.contains('ant-switch-checked') || element.classList.contains('is-checked') || className.includes('switch-checked')) return true;
  return false;
};
const desiredSwitchState = (option) => {
  const text = normalize(option);
  if (/^(是|开|开启|打开|启用|展示|true|yes|on)$/.test(text)) return true;
  if (/^(否|关|关闭|停用|禁用|不展示|false|no|off)$/.test(text)) return false;
  return null;
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
const tableRows = (root) => root
  ? [...root.querySelectorAll('tbody tr, [role="row"], .ant-table-tbody-virtual-holder-inner .ant-table-row')]
    .filter((row) => !row.closest('thead') && !row.querySelector(':scope > [role="columnheader"]'))
  : [];
const tableRowCells = (row) => [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"], :scope > .ant-table-cell')];
const tableRowGroups = (rows) => {
  const groups = [];
  for (const row of [...rows].sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)) {
    const top = row.getBoundingClientRect().top;
    const group = groups.find((item) => Math.abs(item.top - top) <= 2);
    if (group) {
      group.rows.push(row);
    } else {
      groups.push({ top, rows: [row] });
    }
  }
  return groups.map((group) => group.rows);
};
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
const tableColumnTarget = (fieldElement, predicate, rowNumber) => {
  const header = fieldElement.closest('th, td')
    || (fieldElement.getAttribute('role') === 'columnheader' ? fieldElement : null);
  if (!header) return null;
  const component = tableComponentRoot(header);
  const headerRect = header.getBoundingClientRect();
  const rows = tableRows(component);
  const targetRows = rowNumber ? tableRowGroups(rows)[rowNumber - 1] || [] : rows;
  const headerCells = [...(header.parentElement?.children || [])];
  const columnIndex = header.cellIndex >= 0 ? header.cellIndex : headerCells.indexOf(header);

  // Ant 虚拟表格保留完整列顺序但表头、表体滚动位置可能短暂不同，必须优先按稳定列序号定位。
  if (component?.matches('.ant-table-virtual') && columnIndex >= 0) {
    for (const row of targetRows) {
      const target = targetInside(tableRowCells(row)[columnIndex], predicate);
      if (target) return target;
    }
  }
  const headerIdentities = tableCellIdentities(header);
  const identityTargets = headerIdentities.length === 0 ? [] : targetRows
    .flatMap((row) => tableRowCells(row)
      .filter((cell) => tableCellIdentities(cell).some((identity) => headerIdentities.includes(identity)))
      .map((cell) => ({ target: targetInside(cell, predicate), rowTop: row.getBoundingClientRect().top })))
    .filter((item) => item.target)
    .sort((a, b) => a.rowTop - b.rowTop);
  if (identityTargets.length > 0) return identityTargets[0].target;

  // 滚动表格常把表头和表体拆成不同 table，并额外渲染固定列副本；按屏幕横坐标映射才能避免列序号漂移。
  const sameTextHeaders = component ? [...component.querySelectorAll('thead th, thead td, [role="columnheader"]')]
    .filter((item) => normalize(textOf(item)) === normalize(textOf(header))) : [];
  const geometricTargets = sameTextHeaders.length > 1 ? [] : targetRows
    .flatMap((row) => tableRowCells(row)
      .map((cell) => ({ cell, rowTop: row.getBoundingClientRect().top, overlap: horizontalOverlap(headerRect, cell.getBoundingClientRect()) })))
    .filter((item) => item.overlap > 0)
    .map((item) => ({ ...item, target: targetInside(item.cell, predicate) }))
    .filter((item) => item.target)
    .sort((a, b) => b.overlap - a.overlap || a.rowTop - b.rowTop);
  if (geometricTargets.length > 0) return geometricTargets[0].target;

  if (columnIndex < 0) return null;
  const ownTable = header.closest('table');
  const ownRows = ownTable?.querySelector('tbody tr') ? [...ownTable.querySelectorAll('tbody tr')] : [];
  const indexedRows = rowNumber
    ? (ownRows.length > 0 ? [ownRows[rowNumber - 1]].filter(Boolean) : targetRows)
    : (ownRows.length > 0 ? ownRows : rows);
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
const scopedTarget = (field, predicate, rowNumber = null) => {
  const fields = fieldElements(field);
  const tableFields = fields.filter((fieldItem) => fieldItem.element.closest('th, [role="columnheader"]'));
  for (const fieldItem of tableFields.length > 0 ? tableFields : fields) {
    const tableTarget = tableColumnTarget(fieldItem.element, predicate, rowNumber);
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
function clickFieldScopedTarget(field, target, rowNumber = null) {
  const targetText = normalize(target);
  const result = scopedTarget(field, (element) => clickable(element) && textMatches(element, targetText), rowNumber);
  if (result.element) {
    dispatchMouse(result.element);
    return { found: true, clicked: true, targetText: textOf(result.element) };
  }
  return { found: result.fields.length > 0, clicked: false };
}
function clickTableRowTarget(target, rowNumber) {
  const targetText = normalize(target);
  const rootSelector = '.ant-table, .el-table, [role="table"], [role="grid"], table';
  const roots = [...document.querySelectorAll(rootSelector)]
    .filter((root) => !root.parentElement?.closest(rootSelector));
  const targets = roots.flatMap((root) => {
    const rows = tableRowGroups(tableRows(root))[rowNumber - 1] || [];
    return rows.flatMap((row) => [row, ...row.querySelectorAll('*')])
      .filter((element) => visible(element) && clickable(element) && textMatches(element, targetText));
  });
  const targetElement = targets
    .sort((left, right) => normalize(textOf(left)).length - normalize(textOf(right)).length)[0];
  if (!targetElement) return { found: false, clicked: false };
  dispatchMouse(targetElement);
  return { found: true, clicked: true, targetText: textOf(targetElement) };
}
function fillFieldScopedTarget(field, value, preserveFocus, rowNumber = null) {
  const result = scopedTarget(field, inputLike, rowNumber);
  if (result.element) {
    dispatchValue(result.element, value, preserveFocus);
    return { found: true, filled: true, targetText: textOf(result.element) };
  }
  return { found: result.fields.length > 0, filled: false };
}
function readFieldScopedValue(field, rowNumber = null) {
  const result = scopedTarget(field, inputLike, rowNumber);
  if (!result.element) {
    return { found: false };
  }
  const value = result.element instanceof HTMLInputElement || result.element instanceof HTMLTextAreaElement
    ? result.element.value
    : result.element.textContent || '';
  return { found: true, value };
}
function selectFieldScopedTarget(field, option, rowNumber, mode = 'select', verifyOnly = false) {
  const optionText = normalize(option);
  const result = scopedTarget(field, (element) => switchLike(element) || selectLike(element) || Boolean(choiceInput(element, optionText)), rowNumber);
  if (!result.element) return { found: false };

  const switchElement = result.element.closest('[role="switch"], .ant-switch, [class*="switch"]');
  if (switchElement && switchLike(switchElement)) {
    const desired = desiredSwitchState(option);
    if (desired === null) return { found: true, kind: 'switch' };
    const before = switchState(switchElement);
    if (!verifyOnly && before !== desired) dispatchMouse(switchElement);
    const reached = verifyOnly ? before === desired : switchState(switchElement) === desired;
    return { found: true, kind: 'switch', reached, changed: !verifyOnly && before !== desired };
  }

  const choice = choiceInput(result.element, optionText);
  if (choice) {
    const desired = mode !== 'deselect';
    const cell = choice.input.closest('td, th, [role="cell"], [role="gridcell"], .ant-table-cell');
    const group = cell ? [...cell.querySelectorAll('input[type="checkbox"]')].filter((input) => !disabled(input)) : [choice.input];
    let changed = false;
    if (!verifyOnly && mode === 'exclusive') {
      for (const sibling of group) {
        if (sibling !== choice.input && sibling.checked) {
          (sibling.closest('label') || sibling).click();
          changed = true;
        }
      }
    }
    if (!verifyOnly && choice.input.checked !== desired) {
      (choice.label || choice.input).click();
      changed = true;
    }
    const reached = choice.input.checked === desired
      && (mode !== 'exclusive' || group.filter((input) => input !== choice.input && input.checked).length === 0);
    return { found: true, kind: choice.input.type, reached, changed };
  }

  const selectElement = result.element.closest('select, .ant-select, .el-select, [role="combobox"]');
  if (!selectElement) return { found: true };
  const values = [
    selectElement instanceof HTMLSelectElement ? selectElement.selectedOptions?.[0]?.textContent || selectElement.value : '',
    selectElement.querySelector('input:not([type="hidden"])')?.value,
    selectElement.querySelector('.ant-select-selection-item, .el-input__inner, [class*="singleValue"]')?.textContent,
  ].map(normalize).filter(Boolean);
  if (verifyOnly) {
    return { found: true, kind: 'dropdown', reached: values.some((value) => value === optionText) };
  }
  if (selectElement instanceof HTMLSelectElement) {
    const nativeOption = [...selectElement.options].find((item) => normalize(item.textContent || item.value) === optionText);
    if (!nativeOption) return { found: true, kind: 'dropdown', reached: false };
    selectElement.value = nativeOption.value;
    selectElement.dispatchEvent(new Event('input', { bubbles: true }));
    selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, kind: 'dropdown', reached: true, changed: true };
  }
  document.querySelectorAll('[data-browser-opt-active-select="true"]').forEach((element) => element.removeAttribute('data-browser-opt-active-select'));
  selectElement.setAttribute('data-browser-opt-active-select', 'true');
  dispatchMouse(selectElement.querySelector('.ant-select-selector, .el-input, [role="combobox"]') || selectElement);
  return { found: true, kind: 'dropdown', opened: true };
}
return { clickFieldScopedTarget, clickTableRowTarget, fillFieldScopedTarget, readFieldScopedValue, selectFieldScopedTarget };
})()
`;
}
