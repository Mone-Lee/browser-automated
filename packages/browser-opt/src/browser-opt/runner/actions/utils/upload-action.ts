/**
 * browser-opt 上传动作执行器，负责定位上传控件、准备本地文件并下发 upload。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from '#browser-core/agent';
import type {
  BrowserOptFailureKind,
  DeterministicAction,
  SnapshotEvidence,
  DeterministicExecutionOptions,
} from '../../../type.js';
import { findUploadRef } from '../../../utils.js';
import { captureTransientSnapshot } from '../../evidence.js';

interface UploadDomTarget {
  selector: string;
  scrollSelector?: string;
}

interface BatchUploadDomTarget {
  selectors: string[];
  scrollSelector?: string;
}

interface UploadState {
  found?: boolean;
  pending?: boolean;
  failed?: boolean;
  completed?: boolean;
  completedCount?: number;
  inputFilesCount?: number;
  failureMessage?: string;
}

/** 执行上传动作，先展示可见上传区域，再使用快照 ref、隐藏 input 或长表单搜索结果上传。 */
export async function executeUploadAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'upload' }>,
  snapshot: SnapshotEvidence,
  outputDir: string,
  options: DeterministicExecutionOptions,
): Promise<string> {
  const sources = action.sources ?? [action.source];
  if (sources.length > 1) {
    return executeBatchUploadAction(agent, action.field, sources, outputDir, action.rowNumber);
  }

  const searchOutput: string[] = [];
  let ref = action.rowNumber ? null : findUploadRef(snapshot, action.field);
  let scrollTarget = ref;
  if (!ref) {
    const domTarget = findHiddenUploadInputSelector(agent, action.field, action.rowNumber);
    if (domTarget) {
      ref = domTarget.selector;
      scrollTarget = domTarget.scrollSelector ?? null;
      searchOutput.push(`upload dom selector ${domTarget.selector}`);
    }
  }

  if (!ref && revealTableUploadInput(agent, action.field, action.rowNumber)) {
    const rowLabel = action.rowNumber ? `第 ${action.rowNumber} 行 ` : '';
    searchOutput.push(`upload reveal table input ${rowLabel}${action.field}`);
    for (let attempt = 1; attempt <= 10 && !ref; attempt += 1) {
      agent.waitMs(100);
      const domTarget = findHiddenUploadInputSelector(agent, action.field, action.rowNumber);
      if (domTarget) {
        ref = domTarget.selector;
        scrollTarget = domTarget.scrollSelector ?? null;
        searchOutput.push(`upload dynamic input ${attempt} ${domTarget.selector}`);
      }
    }
  }

  if (!ref && !action.rowNumber && options.allowViewportSearch) {
    const scrolled = searchUploadInLongForm(agent, action.field);
    if (scrolled) {
      ref = scrolled.ref;
      scrollTarget = scrolled.ref;
      searchOutput.push(...scrolled.logs);
    }
  }

  if (!ref) {
    const rowLabel = action.rowNumber ? `第 ${action.rowNumber} 行 ` : '';
    throw new Error(`无法找到上传控件：${rowLabel}${action.field}；DOM诊断：${diagnoseUploadTarget(agent, action.field, action.rowNumber)}`);
  }

  if (scrollTarget) {
    agent.scrollIntoView(scrollTarget);
  }
  const filePath = await prepareUploadFile(sources[0], outputDir);
  const output = agent.upload(ref, [filePath]);
  const completionOutput = waitForUploadCompletion(agent, action.field, action.rowNumber, ref, snapshot);
  return [
    ...searchOutput,
    `upload @${ref} ${filePath}`,
    output,
    completionOutput,
  ].filter(Boolean).join('\n').trim();
}

/** 上传动作必须在目标字段内形成文件、预览或组件成功态，不能只依赖 upload 命令返回。 */
export function verifyUploadActionEffect(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'upload' }>,
  beforeSnapshot: SnapshotEvidence,
  afterSnapshot: SnapshotEvidence,
  actionOutput: string,
): { passed: boolean; message: string; failureKind?: BrowserOptFailureKind } {
  const expectedCount = action.sources?.length ?? 1;
  const state = getUploadState(agent, action.field, action.rowNumber, expectedCount);
  const rowLabel = action.rowNumber ? `第 ${action.rowNumber} 行` : '';
  const target = `${rowLabel}${action.field}`;

  if (state.failed) {
    const detail = state.failureMessage ? `：${state.failureMessage}` : '';
    return {
      passed: false,
      message: `目标字段显示上传失败：${target}${detail}`,
      failureKind: state.failureMessage ? 'business-validation' : 'execution',
    };
  }
  if (state.completed && (state.completedCount ?? expectedCount) >= expectedCount) {
    return { passed: true, message: `已确认上传成功：${target}` };
  }
  if (actionOutput.includes('upload snapshot settled')
    || snapshotShowsUploadCompletion(beforeSnapshot, afterSnapshot, action.field)) {
    return { passed: true, message: `已通过上传槽位替换和新增预览确认上传成功：${target}` };
  }
  const normalizedSnapshot = afterSnapshot.text.replace(/\s+/g, '');
  const escapedField = action.field.replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasExplicitSuccess = new RegExp(
    `(?:${escapedField}.{0,80}(?:上传成功|上传完成|预览)|(?:上传成功|上传完成|预览).{0,80}${escapedField})`,
  ).test(normalizedSnapshot);
  if (hasExplicitSuccess) {
    return { passed: true, message: `已通过页面状态确认上传成功：${target}` };
  }

  return { passed: false, message: `未在目标字段检测到上传成功状态：${target}` };
}

/** 批量上传前滚动字段容器一次，再按 input 的 DOM 顺序逐槽位绑定图片。 */
async function executeBatchUploadAction(
  agent: BrowserAgent,
  field: string,
  sources: string[],
  outputDir: string,
  rowNumber?: number,
): Promise<string> {
  const { selectors, scrollSelector } = findBatchUploadInputSelectors(agent, field, sources.length, rowNumber);
  if (selectors.length < sources.length) {
    throw new Error(`上传槽位不足：${field}需要 ${sources.length} 个，找到 ${selectors.length} 个`);
  }

  if (scrollSelector) {
    agent.scrollIntoView(scrollSelector);
  }
  const filePaths = await Promise.all(sources.map((source) => prepareUploadFile(source, outputDir)));
  const output: string[] = [`upload batch slots ${selectors.join(', ')}`];
  for (const [index, filePath] of filePaths.entries()) {
    const selector = selectors[index];
    output.push(
      `upload slot ${index + 1} @${selector} ${filePath}`,
      agent.upload(selector, [filePath]),
      waitForUploadCompletion(agent, field, rowNumber, selector),
    );
  }
  return output.filter(Boolean).join('\n').trim();
}

/** 上传命令返回后等待目标字段出现明确成功态，并兼容只写入文件但未触发组件事件的页面。 */
function waitForUploadCompletion(
  agent: BrowserAgent,
  field: string,
  rowNumber: number | undefined,
  ref: string,
  beforeSnapshot?: SnapshotEvidence,
): string {
  const waitLogs: string[] = [];
  let inputChangeAttempted = false;
  agent.waitMs(300);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const state = getUploadState(agent, field, rowNumber, 1);
    if (state.failed) {
      if (state.failureMessage) {
        throw new Error(`页面业务校验拒绝：${field}（${state.failureMessage}）`);
      }
      throw new Error(`上传失败：${field}`);
    }
    if (state.completed === true) {
      return [...waitLogs, `upload settled ${field}`].join('\n');
    }
    if (!inputChangeAttempted && state.pending !== true) {
      inputChangeAttempted = true;
      const notification = notifyUploadInputChange(agent, ref);
      if (notification.dispatched === true) {
        waitLogs.push(`upload notify input change ${field} files=${notification.files ?? 0}`);
        agent.waitMs(300);
        continue;
      }
    }
    if (beforeSnapshot) {
      const currentSnapshot = captureTransientSnapshot(agent);
      if (snapshotShowsUploadCompletion(beforeSnapshot, currentSnapshot, field)) {
        return [...waitLogs, `upload snapshot settled ${field}`].join('\n');
      }
    }

    waitLogs.push(`upload wait ${attempt} ${field}`);
    agent.waitMs(500);
  }

  throw new Error(`等待上传完成超时：${field}`);
}

/** 上传组件达到数量上限后可能移除 file input，以槽位文案消失且预览操作增加作为替代成功证据。 */
function snapshotShowsUploadCompletion(
  beforeSnapshot: SnapshotEvidence,
  afterSnapshot: SnapshotEvidence,
  field: string,
): boolean {
  const normalize = (value: string) => value.replace(/[\s：:，,。；*"'‘’“”]/g, '').toLowerCase();
  const target = normalize(field);
  if (!target || !normalize(beforeSnapshot.text).includes(target) || normalize(afterSnapshot.text).includes(target)) {
    return false;
  }

  return countSnapshotUploadPreviewActions(afterSnapshot.text) > countSnapshotUploadPreviewActions(beforeSnapshot.text);
}

/** 统计上传预览常见的查看、预览与删除操作，用数量变化避免依赖某个组件库的 class。 */
function countSnapshotUploadPreviewActions(text: string): number {
  return text.split('\n').filter((line) => (
    /^\s*-\s+(?:button|link)\s+["“](?:delete|删除|eye|查看|预览)["”]/i.test(line)
  )).length;
}

/** 仅对已注入文件的隐藏 input 补发原生事件，解决部分 Ant Upload 未响应 CDP 文件写入的问题。 */
function notifyUploadInputChange(agent: BrowserAgent, ref: string): { dispatched?: boolean; files?: number } {
  if (!ref.startsWith('[') && !ref.startsWith('#') && !ref.startsWith('.')) {
    return { dispatched: false };
  }

  const script = `(() => {
  const input = document.querySelector(${JSON.stringify(ref)});
  if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.files?.length) {
    return JSON.stringify({ dispatched: false, files: input instanceof HTMLInputElement ? input.files?.length || 0 : 0 });
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return JSON.stringify({ dispatched: true, files: input.files.length });
})()`;

  try {
    return parseEvalJson(agent.evaluate(script));
  } catch {
    return { dispatched: false };
  }
}

/** 统一读取字段级上传状态，供等待逻辑和最终效果校验复用。 */
function getUploadState(agent: BrowserAgent, field: string, rowNumber: number | undefined, expectedCount: number): UploadState {
  const rowArgument = rowNumber ? `, ${rowNumber}` : ', null';
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  return JSON.stringify(uploadHelper.getUploadStateByField(${JSON.stringify(field)}${rowArgument}, ${expectedCount}));
})()`;
  return parseEvalJson(agent.evaluate(script));
}

/** Ant Upload 等组件会隐藏真实 file input，同时返回用于滚动的可见字段容器。 */
function findHiddenUploadInputSelector(agent: BrowserAgent, field: string, rowNumber?: number): UploadDomTarget | null {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  const result = uploadHelper.findUploadInputByField(${JSON.stringify(field)}${rowArgument});
  return JSON.stringify(result);
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return parsed.found && parsed.selector
      ? { selector: parsed.selector, scrollSelector: parsed.scrollSelector }
      : null;
  } catch {
    return null;
  }
}

/** 表格上传组件可能在点击单元格入口后才创建 file input，按列头定位首行入口并触发一次。 */
function revealTableUploadInput(agent: BrowserAgent, field: string, rowNumber?: number): boolean {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  return JSON.stringify(uploadHelper.revealTableUploadInputByField(${JSON.stringify(field)}${rowArgument}));
})()`;

  try {
    return parseEvalJson(agent.evaluate(script)).revealed === true;
  } catch {
    return false;
  }
}

/** 上传定位最终失败时记录表头、数据行和 file input 的真实结构，避免仅凭快照反复猜测。 */
function diagnoseUploadTarget(agent: BrowserAgent, field: string, rowNumber?: number): string {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  return JSON.stringify(uploadHelper.diagnoseUploadByField(${JSON.stringify(field)}${rowArgument}));
})()`;

  try {
    return JSON.stringify(parseEvalJson(agent.evaluate(script)).diagnostic ?? {});
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** 批量上传前一次性标记字段内的全部目标 input，确保素材与槽位按页面顺序一一对应。 */
function findBatchUploadInputSelectors(
  agent: BrowserAgent,
  field: string,
  count: number,
  rowNumber?: number,
): BatchUploadDomTarget {
  const rowArgument = rowNumber ? `, ${rowNumber}` : '';
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  const result = uploadHelper.findUploadInputsByField(${JSON.stringify(field)}, ${count}${rowArgument});
  return JSON.stringify(result);
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return { selectors: parsed.selectors ?? [], scrollSelector: parsed.scrollSelector };
  } catch {
    return { selectors: [] };
  }
}

/** 返回在页面上下文执行的上传控件定位工具源码，兼容隐藏 input[type=file]。 */
function uploadDomHelperSource(): string {
  return `
(() => {
const normalizeBrowserOptUploadText = (value) => String(value || '').replace(/[\\s：:，,。；*"'‘’“”]/g, '').toLowerCase();
const browserOptUploadVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
};
const browserOptUploadStableSelector = (element, attribute, prefix) => {
  const existingId = element.getAttribute(attribute);
  const existingSelector = existingId ? '[' + attribute + '="' + existingId + '"]' : '';
  if (existingSelector && document.querySelectorAll(existingSelector).length === 1) {
    return existingSelector;
  }
  const root = document.documentElement;
  const sequence = Number(root.getAttribute('data-browser-opt-upload-sequence') || '0') + 1;
  root.setAttribute('data-browser-opt-upload-sequence', String(sequence));
  const id = prefix + sequence;
  element.setAttribute(attribute, id);
  return '[' + attribute + '="' + id + '"]';
};
const browserOptUploadAncestorChain = (element) => {
  const chain = [];
  let current = element;
  for (let depth = 0; current && depth < 12; depth += 1) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
};
const browserOptUploadTableRoot = (element) => element.closest('.ant-table, .el-table, [role="table"], [role="grid"]')
  || element.closest('table')?.parentElement;
const browserOptUploadTableRows = (root) => root
  ? [...root.querySelectorAll('tbody tr, [role="row"], .ant-table-tbody-virtual-holder-inner .ant-table-row')]
    .filter((row) => !row.closest('thead') && !row.querySelector(':scope > [role="columnheader"]'))
  : [];
const browserOptUploadRowCells = (row) => [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"], :scope > .ant-table-cell')];
const browserOptUploadVisibleDescendants = (root, selector) => [...root.querySelectorAll(selector)].filter(browserOptUploadVisible);
const browserOptUploadRowGroups = (rows) => {
  const groups = [];
  for (const row of [...rows].sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)) {
    const top = row.getBoundingClientRect().top;
    const group = groups.find((item) => Math.abs(item.top - top) <= 2);
    if (group) group.rows.push(row);
    else groups.push({ top, rows: [row] });
  }
  return groups.map((group) => group.rows);
};
const browserOptUploadMatchesRow = (element, rowNumber) => {
  if (!rowNumber) return true;
  const row = element.closest('tbody tr, [role="row"], .ant-table-row');
  const root = row ? browserOptUploadTableRoot(row) : null;
  const targetRows = root ? browserOptUploadRowGroups(browserOptUploadTableRows(root))[rowNumber - 1] || [] : [];
  return Boolean(row && targetRows.includes(row));
};
const browserOptUploadHorizontalOverlap = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
const browserOptUploadSyncVirtualHeader = (element) => {
  const virtualTable = element.closest('.ant-table-virtual');
  const virtualBody = element.closest('.ant-table-tbody-virtual-holder');
  const virtualHeader = virtualTable?.querySelector('.ant-table-header');
  if (virtualBody && virtualHeader) {
    virtualHeader.scrollLeft = virtualBody.scrollLeft;
  }
};
const browserOptUploadCellIdentities = (cell) => {
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
const browserOptUploadInputsInside = (cell) => {
  if (!cell) return [];
  const inputs = [
    ...(cell.matches('input[type="file"]') ? [cell] : []),
    ...cell.querySelectorAll('input[type="file"]'),
  ];
  return [...new Set(inputs)];
};
const browserOptUploadTableColumnCells = (header, rowNumber) => {
  const component = browserOptUploadTableRoot(header);
  if (!component) return [];
  browserOptUploadSyncVirtualHeader(component);
  const headerRect = header.getBoundingClientRect();
  const rows = browserOptUploadTableRows(component);
  const targetRows = rowNumber ? browserOptUploadRowGroups(rows)[rowNumber - 1] || [] : rows;
  const headerCells = [...(header.parentElement?.children || [])];
  const columnIndex = header.cellIndex >= 0 ? header.cellIndex : headerCells.indexOf(header);

  if (component.matches('.ant-table-virtual') && columnIndex >= 0) {
    const exactCells = targetRows.map((row) => browserOptUploadRowCells(row)[columnIndex]).filter(Boolean);
    if (exactCells.length > 0) return exactCells;
  }

  const headerIdentities = browserOptUploadCellIdentities(header);
  const identityCells = headerIdentities.length === 0 ? [] : targetRows
    .flatMap((row) => browserOptUploadRowCells(row)
      .filter((cell) => browserOptUploadCellIdentities(cell).some((identity) => headerIdentities.includes(identity))));
  if (identityCells.length > 0) return identityCells;

  const sameTextHeaders = [...component.querySelectorAll('thead th, thead td, [role="columnheader"]')]
    .filter((item) => normalizeBrowserOptUploadText(item.textContent || '') === normalizeBrowserOptUploadText(header.textContent || ''));
  const geometricCells = sameTextHeaders.length > 1 ? [] : targetRows
    .flatMap((row) => browserOptUploadRowCells(row)
      .map((cell) => ({ cell, rowTop: row.getBoundingClientRect().top, overlap: browserOptUploadHorizontalOverlap(headerRect, cell.getBoundingClientRect()) })))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.rowTop - b.rowTop)
    .map((item) => item.cell);
  if (geometricCells.length > 0) return geometricCells;

  if (columnIndex < 0) return [];
  const ownTable = header.closest('table');
  const ownRows = ownTable?.querySelector('tbody tr') ? [...ownTable.querySelectorAll('tbody tr')] : [];
  const indexedRows = rowNumber
    ? (ownRows.length > 0 ? [ownRows[rowNumber - 1]].filter(Boolean) : targetRows)
    : (ownRows.length > 0 ? ownRows : rows);
  return indexedRows.map((row) => browserOptUploadRowCells(row)[columnIndex]).filter(Boolean);
};
const browserOptUploadFieldHeaders = (field) => [...document.querySelectorAll('thead th, thead td, [role="columnheader"]')]
  .filter((element) => browserOptUploadVisible(element))
  .filter((element) => normalizeBrowserOptUploadText(element.textContent || '').includes(normalizeBrowserOptUploadText(field)));
const browserOptUploadHeadersForCell = (cell) => {
  const root = browserOptUploadTableRoot(cell);
  if (!root) return [];
  const cellRect = cell.getBoundingClientRect();
  const identities = browserOptUploadCellIdentities(cell);
  const headers = [...root.querySelectorAll('thead th, thead td, [role="columnheader"]')]
    .filter((header) => browserOptUploadVisible(header));
  if (root.matches('.ant-table-virtual')) {
    const row = cell.closest('.ant-table-row');
    const columnIndex = row ? browserOptUploadRowCells(row).indexOf(cell) : -1;
    const header = columnIndex >= 0 ? headers[columnIndex] : null;
    if (header) return [header];
  }
  const identityHeaders = identities.length === 0 ? [] : headers
    .filter((header) => browserOptUploadCellIdentities(header).some((identity) => identities.includes(identity)));
  if (identityHeaders.length > 0) return identityHeaders;
  return headers
    .map((header) => ({ header, overlap: browserOptUploadHorizontalOverlap(header.getBoundingClientRect(), cellRect) }))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((item) => item.header);
};
const browserOptUploadContext = (input, fieldText) => {
  const chain = browserOptUploadAncestorChain(input);
  const cell = input.closest('td, th, [role="cell"], [role="gridcell"], .ant-table-cell');
  const table = cell?.closest('table');
  if (cell) {
    const geometricHeader = browserOptUploadHeadersForCell(cell)
      .find((header) => normalizeBrowserOptUploadText(header.textContent || '').includes(fieldText));
    if (geometricHeader) {
      return { text: normalizeBrowserOptUploadText(geometricHeader.textContent || ''), depth: 0.125, source: 'table-geometry' };
    }
  }

  const directMatch = chain
    .map((element, depth) => ({ element, depth, text: normalizeBrowserOptUploadText(element.textContent || '') }))
    .find((item) => item.text.includes(fieldText));
  if (directMatch) {
    return { text: directMatch.text, depth: directMatch.depth, source: 'ancestor' };
  }

  if (cell && table) {
    const headerRows = [...table.querySelectorAll('thead tr')];
    const headerCells = headerRows.length > 0
      ? [...headerRows[headerRows.length - 1].querySelectorAll('th, td')]
      : [];
    const header = headerCells[cell.cellIndex];
    const headerText = normalizeBrowserOptUploadText(header?.textContent || '');
    if (headerText.includes(fieldText)) {
      return { text: headerText, depth: 0.25, source: 'table-header' };
    }
  }

  for (const item of chain.map((element, depth) => ({ element, depth }))) {
    const siblings = [item.element.previousElementSibling, item.element.nextElementSibling]
      .filter(Boolean)
      .map((element) => normalizeBrowserOptUploadText(element.textContent || ''));
    const siblingText = siblings.find((text) => text.includes(fieldText));
    if (siblingText) {
      return { text: siblingText, depth: item.depth + 0.5, source: 'sibling' };
    }

    const parent = item.element.parentElement;
    const parentText = normalizeBrowserOptUploadText(parent?.textContent || '');
    const className = String(parent?.className || '');
    if (/ant-form-item|form-item|field|row|item/i.test(className) && parentText.includes(fieldText)) {
      return { text: parentText, depth: item.depth + 1, source: 'form-item' };
    }
  }

  return { text: normalizeBrowserOptUploadText(chain.map((element) => element.textContent || '').join(' ')), depth: 99, source: 'none' };
};
function findUploadInputsByField(field, limit, rowNumber = null) {
  const fieldText = normalizeBrowserOptUploadText(field);
  const tableCandidates = [];
  for (const header of browserOptUploadFieldHeaders(field)) {
    for (const cell of browserOptUploadTableColumnCells(header, rowNumber)) {
      for (const input of browserOptUploadInputsInside(cell).filter((candidate) => browserOptUploadMatchesRow(candidate, rowNumber))) {
        tableCandidates.push({ input, cell });
      }
    }
  }
  const revealedCells = [...document.querySelectorAll('[data-browser-opt-upload-target-field]')]
    .filter((cell) => cell.getAttribute('data-browser-opt-upload-target-field') === fieldText)
    .filter((cell) => !rowNumber || cell.getAttribute('data-browser-opt-upload-target-row') === String(rowNumber));
  const revealedInputs = [...document.querySelectorAll('input[type="file"]')]
    .filter((input) => !input.hasAttribute('data-browser-opt-upload-before-reveal'));
  if (revealedCells.length === 1 && revealedInputs.length === 1) {
    tableCandidates.push({ input: revealedInputs[0], cell: revealedCells[0] });
  }
  if (tableCandidates.length > 0) {
    const uniqueTableCandidates = [...new Map(tableCandidates.map((item) => [item.input, item])).values()];
    const selectors = uniqueTableCandidates.slice(0, limit).map((candidate) => browserOptUploadStableSelector(
      candidate.input,
      'data-browser-opt-upload-id',
      'browser-opt-upload-',
    ));
    const scrollCell = uniqueTableCandidates[0]?.cell;
    let scrollSelector;
    if (scrollCell) {
      scrollSelector = browserOptUploadStableSelector(
        scrollCell,
        'data-browser-opt-upload-scroll-target',
        'browser-opt-upload-scroll-',
      );
    }
    return { found: selectors.length > 0, selectors, count: uniqueTableCandidates.length, scrollSelector };
  }
  const inputs = [...document.querySelectorAll('input[type="file"]')]
    .filter((input) => browserOptUploadMatchesRow(input, rowNumber));
  const candidates = inputs.map((input, index) => {
    const chain = browserOptUploadAncestorChain(input);
    const context = browserOptUploadContext(input, fieldText);
    const visibleAncestor = chain.find((element) => browserOptUploadVisible(element));
    const rect = visibleAncestor?.getBoundingClientRect?.();
    const score = context.text.includes(fieldText) ? 3 : fieldText.includes(context.text) && context.text ? 2 : 0;
    return { input, index, text: context.text, depth: context.depth, score, visible: Boolean(rect && rect.width > 0 && rect.height > 0) };
  }).sort((a, b) => b.score - a.score || a.depth - b.depth || Number(b.visible) - Number(a.visible) || a.index - b.index);
  let selected = candidates.filter((candidate) => candidate.score > 0);
  if (selected.length === 0) {
    if (inputs.length === 1) {
      selected = candidates.slice(0, 1);
    } else {
      return { found: false, selectors: [], count: inputs.length };
    }
  }
  const selectors = selected.slice(0, limit).map((candidate) => browserOptUploadStableSelector(
    candidate.input,
    'data-browser-opt-upload-id',
    'browser-opt-upload-',
  ));
  const firstSelected = selected[0];
  const scrollElement = firstSelected
    ? browserOptUploadAncestorChain(firstSelected.input)
      .find((element) => browserOptUploadVisible(element) && normalizeBrowserOptUploadText(element.textContent || '').includes(fieldText))
      || browserOptUploadAncestorChain(firstSelected.input).find((element) => browserOptUploadVisible(element))
    : null;
  let scrollSelector;
  if (scrollElement) {
    scrollSelector = browserOptUploadStableSelector(
      scrollElement,
      'data-browser-opt-upload-scroll-target',
      'browser-opt-upload-scroll-',
    );
  }
  return { found: selectors.length > 0, selectors, count: selected.length, scrollSelector };
}
function findUploadInputByField(field, rowNumber = null) {
  const result = findUploadInputsByField(field, 1, rowNumber);
  return result.found
    ? { found: true, selector: result.selectors[0], count: result.count, scrollSelector: result.scrollSelector }
    : result;
}
function getUploadStateByField(field, rowNumber = null, expectedCount = 1) {
  const targets = findUploadInputsByField(field, expectedCount, rowNumber);
  const tableScopes = browserOptUploadFieldHeaders(field)
    .flatMap((header) => browserOptUploadTableColumnCells(header, rowNumber));
  const uniqueTableScopes = [...new Set(tableScopes)].slice(0, expectedCount);
  const fieldText = normalizeBrowserOptUploadText(field);
  const fieldKey = fieldText.replace(/^上传/, '').replace(/图片/g, '图');
  const visibleErrorMessages = [...document.querySelectorAll([
    '.ant-form-item-explain-error',
    '.ant-form-item-extra',
    '.el-form-item__error',
    '[class*="upload-error"]',
    '[class*="upload-fail"]',
    '[class*="validate"]',
    '[class*="error"]'
  ].join(','))]
    .filter(browserOptUploadVisible)
    .map((element) => String(element.textContent || '').trim())
    .filter(Boolean);
  const failureMessage = visibleErrorMessages.find((message) => {
    const normalized = normalizeBrowserOptUploadText(message).replace(/图片/g, '图');
    return fieldKey && normalized.includes(fieldKey)
      && /上传失败|上传错误|重新上传|不符合|必须|仅支持|格式错误/.test(message);
  });
  if ((!targets.found || targets.selectors.length === 0) && uniqueTableScopes.length === 0) {
    return {
      found: false,
      pending: false,
      failed: Boolean(failureMessage),
      failureMessage,
      inputFilesCount: 0
    };
  }
  const inputs = (targets.selectors || []).map((selector) => document.querySelector(selector)).filter(Boolean);
  const scopes = uniqueTableScopes.length > 0 ? uniqueTableScopes : inputs.map((input) => {
    const chain = browserOptUploadAncestorChain(input);
    return input.closest('td, th, [role="cell"], [role="gridcell"], .ant-table-cell')
      || chain.find((element) => /ant-form-item|form-item|field/i.test(String(element.className || ''))
        && normalizeBrowserOptUploadText(element.textContent || '').includes(fieldText))
      || chain.find((element) => normalizeBrowserOptUploadText(element.textContent || '').includes(fieldText))
      || input.parentElement;
  }).filter(Boolean);
  const states = scopes.map((scope, index) => {
    const input = inputs[index] || inputs.find((candidate) => scope.contains(candidate));
    const visibleMatches = (selectors) => [...scope.querySelectorAll(selectors)].filter(browserOptUploadVisible);
    const failed = Boolean(failureMessage) || visibleMatches([
      '.ant-upload-list-item-error',
      '.ant-progress-status-exception',
      '.el-upload-list__item.is-fail',
      '[class*="upload-error"]',
      '[class*="upload-fail"]'
    ].join(',')).length > 0 || /上传失败|上传错误/.test(scope.textContent || '');
    const pending = visibleMatches([
      '.ant-upload-list-item-uploading',
      '.ant-upload-list-item-progress',
      '.ant-progress-status-active',
      '.ant-spin-spinning',
      '.anticon-loading',
      '.el-loading-mask',
      '.el-icon-loading',
      '[aria-busy="true"]',
      '[class*="uploading"]'
    ].join(',')).length > 0;
    const success = visibleMatches([
      '.ant-upload-list-item-done',
      '.ant-upload-list-item-success',
      '.ant-upload-list-picture-card',
      '.el-upload-list__item.is-success',
      '[class*="upload-success"]',
      '[class*="upload-done"]',
      'img[src]'
    ].join(',')).length > 0;
    // file input 持有文件只表示命令写入成功；必须等上传组件渲染出预览或成功态，才能确认业务上传完成。
    const completed = !pending && !failed && success;
    return { pending, failed, completed, inputFilesCount: input?.files?.length || 0 };
  });
  const completedCount = states.filter((state) => state.completed).length;
  return {
    found: true,
    pending: states.some((state) => state.pending),
    failed: states.some((state) => state.failed),
    failureMessage,
    completed: completedCount >= expectedCount,
    completedCount,
    inputFilesCount: states.reduce((sum, state) => sum + (state.inputFilesCount || 0), 0),
  };
}
function revealTableUploadInputByField(field, rowNumber = null) {
  for (const header of browserOptUploadFieldHeaders(field)) {
    for (const cell of browserOptUploadTableColumnCells(header, rowNumber)) {
      const candidates = browserOptUploadVisibleDescendants(cell, 'button, label, [role="button"], [class*="upload"], [onclick]')
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return aRect.width * aRect.height - bRect.width * bRect.height;
        });
      const trigger = candidates[0] || (browserOptUploadVisible(cell) ? cell : null);
      if (!trigger) continue;
      document.querySelectorAll('[data-browser-opt-upload-before-reveal]').forEach((input) => {
        input.removeAttribute('data-browser-opt-upload-before-reveal');
      });
      document.querySelectorAll('[data-browser-opt-upload-target-field]').forEach((target) => {
        target.removeAttribute('data-browser-opt-upload-target-field');
        target.removeAttribute('data-browser-opt-upload-target-row');
      });
      document.querySelectorAll('input[type="file"]').forEach((input) => {
        input.setAttribute('data-browser-opt-upload-before-reveal', 'true');
      });
      cell.setAttribute('data-browser-opt-upload-target-field', normalizeBrowserOptUploadText(field));
      cell.setAttribute('data-browser-opt-upload-target-row', rowNumber ? String(rowNumber) : '');
      trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
      trigger.click();
      return { found: true, revealed: true };
    }
  }
  return { found: false, revealed: false };
}
function diagnoseUploadByField(field, rowNumber = null) {
  const fieldText = normalizeBrowserOptUploadText(field);
  const headers = [...document.querySelectorAll('thead th, thead td, [role="columnheader"]')]
    .filter((header) => normalizeBrowserOptUploadText(header.textContent || '').includes(fieldText))
    .map((header) => {
      const component = browserOptUploadTableRoot(header);
      const rect = header.getBoundingClientRect();
      return {
        tag: header.tagName,
        className: String(header.className || ''),
        identities: browserOptUploadCellIdentities(header),
        rect: { left: rect.left, right: rect.right, top: rect.top, width: rect.width },
        component: component ? { tag: component.tagName, className: String(component.className || '') } : null,
        rows: browserOptUploadTableRows(component).length,
        ownRows: header.closest('table')?.querySelectorAll('tbody tr').length || 0,
      };
    });
  const inputs = [...document.querySelectorAll('input[type="file"]')]
    .filter((input) => browserOptUploadMatchesRow(input, rowNumber))
    .map((input) => {
    const cell = input.closest('td, th, [role="cell"], [role="gridcell"], .ant-table-cell');
    const context = browserOptUploadContext(input, fieldText);
    return {
      className: String(input.className || ''),
      cellTag: cell?.tagName || null,
      cellClassName: String(cell?.className || ''),
      identities: cell ? browserOptUploadCellIdentities(cell) : [],
      context: { source: context.source, depth: context.depth, matches: context.text.includes(fieldText) },
    };
  });
  return { diagnostic: { headers, inputs, inputCount: inputs.length } };
}
return { findUploadInputByField, findUploadInputsByField, getUploadStateByField, revealTableUploadInputByField, diagnoseUploadByField };
})()
`;
}

/** 长表单上传区常位于当前视口外，按视口上下搜索可上传节点。 */
function searchUploadInLongForm(agent: BrowserAgent, field: string): { ref: string; logs: string[] } | null {
  const logs: string[] = [];
  const moves: Array<{ direction: 'up' | 'down'; amount: number }> = [
    { direction: 'up', amount: 900 },
    { direction: 'down', amount: 900 },
    { direction: 'down', amount: 900 },
    { direction: 'down', amount: 900 },
    { direction: 'down', amount: 900 },
  ];

  for (const move of moves) {
    const output = agent.scroll(move.direction, move.amount);
    logs.push(`scroll ${move.direction} ${move.amount}${output.trim() ? `\n${output.trim()}` : ''}`);
    agent.waitMs(200);
    const snapshot = captureTransientSnapshot(agent);
    const ref = findUploadRef(snapshot, field);
    if (ref) {
      return { ref, logs };
    }
  }

  return null;
}

function parseEvalJson(raw: string): {
  found?: boolean;
  selector?: string;
  selectors?: string[];
  scrollSelector?: string;
  pending?: boolean;
  failed?: boolean;
  completed?: boolean;
  completedCount?: number;
  revealed?: boolean;
  dispatched?: boolean;
  files?: number;
  failureMessage?: string;
  diagnostic?: unknown;
} {
  const decoded = JSON.parse(raw.trim()) as unknown;
  return typeof decoded === 'string'
    ? JSON.parse(decoded) as ReturnType<typeof parseEvalJson>
    : decoded as ReturnType<typeof parseEvalJson>;
}

/** 将远程上传素材下载到本次证据目录，让 agent-browser upload 使用稳定的本地路径。 */
async function prepareUploadFile(source: string, outputDir: string): Promise<string> {
  if (!/^https?:\/\//i.test(source)) {
    return path.resolve(source);
  }

  const uploadsDir = path.join(outputDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const url = new URL(source);
  const basename = path.basename(url.pathname) || 'upload-file';
  const filePath = path.join(uploadsDir, basename);
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`下载上传文件失败：${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
