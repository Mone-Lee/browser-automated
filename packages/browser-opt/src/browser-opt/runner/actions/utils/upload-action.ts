/**
 * browser-opt 上传动作执行器，负责定位上传控件、准备本地文件并下发 upload。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence, DeterministicExecutionOptions } from '../../../type.js';
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
    return executeBatchUploadAction(agent, action.field, sources, outputDir);
  }

  let ref = findUploadRef(snapshot, action.field);
  let scrollTarget = ref;
  const searchOutput: string[] = [];
  if (!ref) {
    const domTarget = findHiddenUploadInputSelector(agent, action.field);
    if (domTarget) {
      ref = domTarget.selector;
      scrollTarget = domTarget.scrollSelector ?? null;
      searchOutput.push(`upload dom selector ${domTarget.selector}`);
    }
  }

  if (!ref && revealTableUploadInput(agent, action.field)) {
    searchOutput.push(`upload reveal table input ${action.field}`);
    agent.waitMs(300);
    const domTarget = findHiddenUploadInputSelector(agent, action.field);
    if (domTarget) {
      ref = domTarget.selector;
      scrollTarget = domTarget.scrollSelector ?? null;
      searchOutput.push(`upload dom selector ${domTarget.selector}`);
    }
  }

  if (!ref && options.allowViewportSearch) {
    const scrolled = searchUploadInLongForm(agent, action.field);
    if (scrolled) {
      ref = scrolled.ref;
      scrollTarget = scrolled.ref;
      searchOutput.push(...scrolled.logs);
    }
  }

  if (!ref) {
    throw new Error(`无法找到上传控件：${action.field}；DOM诊断：${diagnoseUploadTarget(agent, action.field)}`);
  }

  if (scrollTarget) {
    agent.scrollIntoView(scrollTarget);
  }
  const filePath = await prepareUploadFile(sources[0], outputDir);
  const output = agent.upload(ref, [filePath]);
  const completionOutput = waitForUploadCompletion(agent, action.field);
  return [
    ...searchOutput,
    `upload @${ref} ${filePath}`,
    output,
    completionOutput,
  ].filter(Boolean).join('\n').trim();
}

/** 批量上传前滚动字段容器一次，再按 input 的 DOM 顺序逐槽位绑定图片。 */
async function executeBatchUploadAction(
  agent: BrowserAgent,
  field: string,
  sources: string[],
  outputDir: string,
): Promise<string> {
  const { selectors, scrollSelector } = findBatchUploadInputSelectors(agent, field, sources.length);
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
      waitForUploadCompletion(agent, field),
    );
  }
  return output.filter(Boolean).join('\n').trim();
}

/** 上传命令返回后等待字段作用域内的加载态消失，避免后续步骤操作尚未就绪的表单。 */
function waitForUploadCompletion(agent: BrowserAgent, field: string): string {
  const waitLogs: string[] = [];
  agent.waitMs(300);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  return JSON.stringify(uploadHelper.getUploadStateByField(${JSON.stringify(field)}));
})()`;
    const state = parseEvalJson(agent.evaluate(script));
    if (state.failed) {
      throw new Error(`上传失败：${field}`);
    }
    if (state.pending !== true) {
      return [...waitLogs, `upload settled ${field}`].join('\n');
    }

    waitLogs.push(`upload wait ${attempt} ${field}`);
    agent.waitMs(500);
  }

  throw new Error(`等待上传完成超时：${field}`);
}

/** Ant Upload 等组件会隐藏真实 file input，同时返回用于滚动的可见字段容器。 */
function findHiddenUploadInputSelector(agent: BrowserAgent, field: string): UploadDomTarget | null {
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  const result = uploadHelper.findUploadInputByField(${JSON.stringify(field)});
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
function revealTableUploadInput(agent: BrowserAgent, field: string): boolean {
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  return JSON.stringify(uploadHelper.revealTableUploadInputByField(${JSON.stringify(field)}));
})()`;

  try {
    return parseEvalJson(agent.evaluate(script)).revealed === true;
  } catch {
    return false;
  }
}

/** 上传定位最终失败时记录表头、数据行和 file input 的真实结构，避免仅凭快照反复猜测。 */
function diagnoseUploadTarget(agent: BrowserAgent, field: string): string {
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  return JSON.stringify(uploadHelper.diagnoseUploadByField(${JSON.stringify(field)}));
})()`;

  try {
    return JSON.stringify(parseEvalJson(agent.evaluate(script)).diagnostic ?? {});
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

/** 批量上传前一次性标记字段内的全部目标 input，确保素材与槽位按页面顺序一一对应。 */
function findBatchUploadInputSelectors(agent: BrowserAgent, field: string, count: number): BatchUploadDomTarget {
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  const result = uploadHelper.findUploadInputsByField(${JSON.stringify(field)}, ${count});
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
const browserOptUploadTableRows = (root) => root ? [...root.querySelectorAll('tbody tr, [role="row"], .ant-table-tbody-virtual-holder-inner .ant-table-row')] : [];
const browserOptUploadRowCells = (row) => [...row.querySelectorAll(':scope > td, :scope > th, :scope > [role="cell"], :scope > [role="gridcell"], :scope > .ant-table-cell')];
const browserOptUploadHorizontalOverlap = (left, right) => Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
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
function findUploadInputsByField(field, limit) {
  const fieldText = normalizeBrowserOptUploadText(field);
  const inputs = [...document.querySelectorAll('input[type="file"]')];
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
  const selectors = selected.slice(0, limit).map((candidate) => {
    const id = 'browser-opt-upload-' + candidate.index;
    candidate.input.setAttribute('data-browser-opt-upload-id', id);
    return '[data-browser-opt-upload-id="' + id + '"]';
  });
  const firstSelected = selected[0];
  const scrollElement = firstSelected
    ? browserOptUploadAncestorChain(firstSelected.input)
      .find((element) => browserOptUploadVisible(element) && normalizeBrowserOptUploadText(element.textContent || '').includes(fieldText))
      || browserOptUploadAncestorChain(firstSelected.input).find((element) => browserOptUploadVisible(element))
    : null;
  let scrollSelector;
  if (scrollElement) {
    const scrollId = 'browser-opt-upload-scroll-' + firstSelected.index;
    scrollElement.setAttribute('data-browser-opt-upload-scroll-target', scrollId);
    scrollSelector = '[data-browser-opt-upload-scroll-target="' + scrollId + '"]';
  }
  return { found: selectors.length > 0, selectors, count: selected.length, scrollSelector };
}
function findUploadInputByField(field) {
  const result = findUploadInputsByField(field, 1);
  return result.found
    ? { found: true, selector: result.selectors[0], count: result.count, scrollSelector: result.scrollSelector }
    : result;
}
function getUploadStateByField(field) {
  const target = findUploadInputByField(field);
  if (!target.found || !target.selector) {
    return { found: false, pending: false, failed: false };
  }
  const input = document.querySelector(target.selector);
  if (!input) {
    return { found: false, pending: false, failed: false };
  }
  const fieldText = normalizeBrowserOptUploadText(field);
  const scope = browserOptUploadAncestorChain(input)
    .find((element) => normalizeBrowserOptUploadText(element.textContent || '').includes(fieldText))
    || input.parentElement;
  if (!scope) {
    return { found: true, pending: false, failed: false };
  }
  const visibleMatches = (selectors) => [...scope.querySelectorAll(selectors)].filter(browserOptUploadVisible);
  const failed = visibleMatches([
    '.ant-upload-list-item-error',
    '.ant-progress-status-exception',
    '.el-upload-list__item.is-fail',
    '[class*="upload-error"]',
    '[class*="upload-fail"]'
  ].join(',')).length > 0;
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
  return { found: true, pending, failed };
}
function revealTableUploadInputByField(field) {
  const fieldText = normalizeBrowserOptUploadText(field);
  const headers = [...document.querySelectorAll('thead th, thead td, [role="columnheader"]')]
    .filter((element) => browserOptUploadVisible(element))
    .filter((element) => normalizeBrowserOptUploadText(element.textContent || '').includes(fieldText));
  for (const header of headers) {
    const component = browserOptUploadTableRoot(header);
    const headerRect = header.getBoundingClientRect();
    const rows = browserOptUploadTableRows(component);
    const headerIdentities = browserOptUploadCellIdentities(header);
    const identityCells = headerIdentities.length === 0 ? [] : rows
      .flatMap((row) => browserOptUploadRowCells(row)
        .filter((cell) => browserOptUploadCellIdentities(cell).some((identity) => headerIdentities.includes(identity))));
    const sameTextHeaders = component ? [...component.querySelectorAll('thead th, thead td, [role="columnheader"]')]
      .filter((item) => normalizeBrowserOptUploadText(item.textContent || '') === normalizeBrowserOptUploadText(header.textContent || '')) : [];
    const geometricCells = sameTextHeaders.length > 1 ? [] : rows
      .flatMap((row) => browserOptUploadRowCells(row)
        .map((cell) => ({ cell, rowTop: row.getBoundingClientRect().top, overlap: browserOptUploadHorizontalOverlap(headerRect, cell.getBoundingClientRect()) })))
      .filter((item) => item.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.rowTop - b.rowTop)
      .map((item) => item.cell);
    const headerCells = [...(header.parentElement?.children || [])];
    const columnIndex = header.cellIndex >= 0 ? header.cellIndex : headerCells.indexOf(header);
    const ownTable = header.closest('table');
    const indexedRows = ownTable?.querySelector('tbody tr') ? [...ownTable.querySelectorAll('tbody tr')] : rows;
    const indexedCells = columnIndex < 0 ? [] : indexedRows
      .map((row) => browserOptUploadRowCells(row)[columnIndex]).filter(Boolean);
    for (const cell of [...new Set([...identityCells, ...geometricCells, ...indexedCells])]) {
      const candidates = [...cell.querySelectorAll('button, label, [role="button"], [class*="upload"], [onclick]')]
        .filter((element) => browserOptUploadVisible(element))
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return aRect.width * aRect.height - bRect.width * bRect.height;
        });
      const trigger = candidates[0] || (browserOptUploadVisible(cell) ? cell : null);
      if (!trigger) continue;
      trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
      trigger.click();
      return { found: true, revealed: true };
    }
  }
  return { found: false, revealed: false };
}
function diagnoseUploadByField(field) {
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
  const inputs = [...document.querySelectorAll('input[type="file"]')].map((input) => {
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
  revealed?: boolean;
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
