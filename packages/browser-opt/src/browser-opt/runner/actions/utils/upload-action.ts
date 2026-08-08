/**
 * browser-opt 上传动作执行器，负责定位上传控件、准备本地文件并下发 upload。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from '#browser-core/agent';
import type { DeterministicAction, SnapshotEvidence, DeterministicExecutionOptions } from '../../../type.js';
import { findUploadRef } from '../../../utils.js';
import { captureTransientSnapshot } from '../../evidence.js';

/** 执行上传动作，优先使用快照 ref，再用隐藏 input 和长表单滚动搜索兜底。 */
export async function executeUploadAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'upload' }>,
  snapshot: SnapshotEvidence,
  outputDir: string,
  options: DeterministicExecutionOptions,
): Promise<string> {
  let ref = findUploadRef(snapshot, action.field);
  const searchOutput: string[] = [];
  if (!ref) {
    const domTarget = findHiddenUploadInputSelector(agent, action.field);
    if (domTarget) {
      ref = domTarget.selector;
      searchOutput.push(`upload dom selector ${domTarget.selector}`);
    }
  }

  if (!ref && options.allowViewportSearch) {
    const scrolled = searchUploadInLongForm(agent, action.field);
    if (scrolled) {
      ref = scrolled.ref;
      searchOutput.push(...scrolled.logs);
    }
  }

  if (!ref) {
    throw new Error(`无法找到上传控件：${action.field}`);
  }

  const filePath = await prepareUploadFile(action.source, outputDir);
  const output = agent.upload(ref, [filePath]);
  const completionOutput = waitForUploadCompletion(agent, action.field);
  return [
    ...searchOutput,
    `upload @${ref} ${filePath}`,
    output,
    completionOutput,
  ].filter(Boolean).join('\n').trim();
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

/** Ant Upload 等组件会隐藏真实 file input，snapshot 缺失时改用 DOM 字段邻近关系定位。 */
function findHiddenUploadInputSelector(agent: BrowserAgent, field: string): { selector: string } | null {
  const script = `(() => {
  const uploadHelper = ${uploadDomHelperSource()};
  const result = uploadHelper.findUploadInputByField(${JSON.stringify(field)});
  return JSON.stringify(result);
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return parsed.found && parsed.selector ? { selector: parsed.selector } : null;
  } catch {
    return null;
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
function findUploadInputByField(field) {
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
  const best = candidates[0];
  if (!best || best.score <= 0) {
    if (inputs.length === 1) {
      inputs[0].setAttribute('data-browser-opt-upload-id', 'browser-opt-upload-0');
      return { found: true, selector: '[data-browser-opt-upload-id="browser-opt-upload-0"]', fallbackSingleInput: true };
    }
    return { found: false, count: inputs.length };
  }
  const id = 'browser-opt-upload-' + best.index;
  best.input.setAttribute('data-browser-opt-upload-id', id);
  return { found: true, selector: '[data-browser-opt-upload-id="' + id + '"]', matchedText: best.text };
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
return { findUploadInputByField, getUploadStateByField };
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

function parseEvalJson(raw: string): { found?: boolean; selector?: string; pending?: boolean; failed?: boolean } {
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
