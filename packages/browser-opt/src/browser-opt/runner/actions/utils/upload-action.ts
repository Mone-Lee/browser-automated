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

  if (!ref && options.allowViewportSearch) {
    const scrolled = searchUploadInLongForm(agent, action.field);
    if (scrolled) {
      ref = scrolled.ref;
      scrollTarget = scrolled.ref;
      searchOutput.push(...scrolled.logs);
    }
  }

  if (!ref) {
    throw new Error(`无法找到上传控件：${action.field}`);
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
const browserOptUploadContext = (input, fieldText) => {
  const chain = browserOptUploadAncestorChain(input);
  const directMatch = chain
    .map((element, depth) => ({ element, depth, text: normalizeBrowserOptUploadText(element.textContent || '') }))
    .find((item) => item.text.includes(fieldText));
  if (directMatch) {
    return { text: directMatch.text, depth: directMatch.depth, source: 'ancestor' };
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
return { findUploadInputByField, findUploadInputsByField, getUploadStateByField };
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
