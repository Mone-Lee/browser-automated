/**
 * browser-opt 确定性动作执行器，负责把结构化动作落到 agent-browser 命令。
 * 这里集中处理控件查找、长表单搜索、开关 DOM 兜底和上传素材准备。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from '../../core/agent.js';
import type { DeterministicAction, SnapshotEvidence } from '../type.js';
import {
  findClickableRef,
  findSelectableFieldRef,
  findSelectableOption,
  findTextboxRef,
  findUploadRef,
  parseDeterministicAction,
} from '../utils.js';
import { captureTransientSnapshot, normalizeUrlForCompare } from './evidence.js';
import { buildLoginHandoffActionOutput, isLoginLikeSnapshot } from './handoff.js';

/** 将自然语言动作直接映射到确定性命令，避免默认依赖 agent-browser chat。 */
export async function executeDeterministicInstruction(
  agent: BrowserAgent,
  instruction: string,
  snapshot: SnapshotEvidence,
  outputDir: string,
  options: { alreadyOpenedUrl?: string; allowViewportSearch?: boolean } = {},
): Promise<string | null> {
  const action = parseDeterministicAction(instruction);
  if (!action) {
    return null;
  }

  if (action.type === 'open') {
    if (options.alreadyOpenedUrl && normalizeUrlForCompare(action.url) === normalizeUrlForCompare(options.alreadyOpenedUrl)) {
      return `open skipped: ${action.url} 已由 runner 初始化打开`;
    }
    return agent.open(action.url);
  }

  if (action.type === 'fill') {
    const ref = findTextboxRef(snapshot, action.field);
    if (!ref) {
      if (isLoginLikeSnapshot(snapshot)) {
        return buildLoginHandoffActionOutput(
          agent,
          `当前页面仍在登录页，无法继续填写“${action.field}”，请先完成登录后再继续自动化。`,
        );
      }
      throw new Error(`无法找到输入框：${action.field}`);
    }
    const output = agent.fill(ref, action.value);
    return `fill @${ref} ${JSON.stringify(action.value)}\n${output}`.trim();
  }

  if (action.type === 'click') {
    const ref = findClickableRef(snapshot, action.target);
    if (!ref) {
      throw new Error(`无法找到可点击元素：${action.target}`);
    }
    const output = agent.click(ref);
    return `click @${ref}\n${output}`.trim();
  }

  if (action.type === 'select-option') {
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

  if (action.type === 'upload') {
    const ref = findUploadRef(snapshot, action.field);
    if (!ref) {
      throw new Error(`无法找到上传控件：${action.field}`);
    }
    const filePath = await prepareUploadFile(action.source, outputDir);
    const output = agent.upload(ref, [filePath]);
    return `upload @${ref} ${filePath}\n${output}`.trim();
  }

  if (action.type === 'handoff') {
    const output = agent.handoff(action.message);
    return `handoff ${JSON.stringify(action.message)}\n${output}`.trim();
  }

  return null;
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
  const script = `${switchDomHelperSource()}
(() => {
  const result = findSwitchByField(${JSON.stringify(field)});
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

/** 对确定性动作做后置状态确认，防止命令发出但页面没有完成目标状态时误报成功。 */
export function verifyDeterministicActionEffect(
  agent: BrowserAgent,
  action: DeterministicAction,
  afterSnapshot: SnapshotEvidence,
): { passed: boolean; message: string } {
  if (action.type !== 'select-option') {
    return { passed: true, message: '动作步骤已完成，已重新 snapshot。' };
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

  return { passed: false, message: `动作后未确认目标已选中：${action.field ?? '选项'}=${action.option}` };
}

/** switch 的 accessibility checked 在部分业务页不可靠，单独走 DOM 近邻状态确认。 */
function verifySwitchDomState(agent: BrowserAgent, field: string, option: string): boolean | null {
  const desiredChecked = /^(是|开|开启|打开|启用|true|yes|on)$/i.test(option.trim());
  const script = `${switchDomHelperSource()}
(() => {
  const result = findSwitchByField(${JSON.stringify(field)});
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
} {
  const decoded = JSON.parse(raw.trim()) as unknown;
  return typeof decoded === 'string'
    ? JSON.parse(decoded) as ReturnType<typeof parseEvalJson>
    : decoded as ReturnType<typeof parseEvalJson>;
}

/** 返回在页面上下文执行的 switch 定位工具源码，按字段同一行最近 switch 选择目标。 */
function switchDomHelperSource(): string {
  return `
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

/** 归一化页面可见文案，减少空白和标点对选择结果确认的影响。 */
function normalizeVisibleText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[：:，,。；"'“”]/g, '').trim();
}

/** 根据控件角色生成 agent-browser 已支持的动作名称，报告文本需与实际命令集一致。 */
function formatSelectableActionName(role: string | null): string {
  if (role && /checkbox|switch/i.test(role)) {
    return 'check';
  }

  return 'click';
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
