/**
 * browser-opt 选项选择动作执行器，负责下拉、单选、复选和 switch 的确定性选择流程。
 */
import type { BrowserAgent } from '#browser-core/agent';
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
  if (option.alreadySelected && isSwitchSelectable(option.role)) {
    const domState = action.field ? verifySwitchDomState(agent, action.field, action.option) : null;
    if (domState === true) {
      return `selection skipped: ${fieldLabel} 已是 ${action.option}`;
    }
    option = { ...option, alreadySelected: false };
  }

  const switchDomTarget = action.field && (isSwitchSelectable(option.role) || snapshotHasSwitchField(snapshot, action.field))
    ? clickSwitchDomTarget(agent, action.field, action.option)
    : null;
  if (switchDomTarget) {
    return switchDomTarget;
  }

  const hasExpandableField = Boolean(findSelectableFieldRef(searchSnapshot, action.field));
  const shouldSearchNativeDom = /radio|checkbox/i.test(option.role ?? '') || !hasExpandableField;
  const nativeSelectableDomTarget = shouldSearchNativeDom
    ? clickNativeSelectableDomTarget(agent, action)
    : null;
  if (nativeSelectableDomTarget) {
    return nativeSelectableDomTarget;
  }

  if (option.alreadySelected && action.mode !== 'deselect') {
    return `selection skipped: ${fieldLabel} 已是 ${action.option}`;
  }
  if (!option.alreadySelected && action.mode === 'deselect' && option.ref) {
    return `selection skipped: ${fieldLabel} 已取消 ${action.option}`;
  }

  const searchOutput: string[] = [];
  const dropdownDomTarget = action.field ? clickDropdownDomTarget(agent, action.field, action.option) : { attempted: false, output: null };
  if (dropdownDomTarget.output) {
    return dropdownDomTarget.output;
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

  if (/radio|checkbox/i.test(option.role ?? '')) {
    const revealedNativeTarget = clickNativeSelectableDomTarget(agent, action);
    if (revealedNativeTarget) {
      return [...searchOutput, revealedNativeTarget].filter(Boolean).join('\n').trim();
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

  if (action.mode === 'exclusive' && /checkbox/i.test(option.role ?? '')) {
    throw new Error(`无法可靠执行“仅勾选”：未能在 DOM 中确认 ${fieldLabel} 的复选框分组`);
  }

  const output = agent.click(option.ref);
  const dropdownCleanup = isDropdownOption(option.role) ? dismissActiveDropdown(agent) : null;
  return [
    ...searchOutput,
    `${formatSelectableActionName(option.role)} @${option.ref} ${fieldLabel}=${action.option}`,
    output,
    dropdownCleanup,
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
  if ((isSwitchSelectable(selected.role) || snapshotHasSwitchField(afterSnapshot, action.field)) && action.field) {
    const domState = verifySwitchDomState(agent, action.field, action.option);
    if (domState === true) {
      return { passed: true, message: `已确认开关状态：${action.field}=${action.option}` };
    }
    if (domState === false) {
      return { passed: false, message: `DOM 确认开关未达到目标状态：${action.field}=${action.option}` };
    }
    return { passed: false, message: `无法可靠确认开关状态：${action.field}=${action.option}` };
  }

  if (/radio|checkbox/i.test(selected.role ?? '') || action.mode === 'deselect' || action.mode === 'exclusive') {
    const domState = verifyNativeSelectableDomState(agent, action);
    if (domState === true) {
      const intent = action.mode === 'exclusive' ? '仅勾选' : action.mode === 'deselect' ? '取消勾选' : '勾选';
      return { passed: true, message: `已通过 DOM 确认${intent}状态：${action.field ?? '选项'}=${action.option}` };
    }
    if (domState === false || action.mode === 'deselect' || action.mode === 'exclusive') {
      return { passed: false, message: `DOM 确认复选状态未达到目标：${action.field ?? '选项'}=${action.option}` };
    }
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

/**
 * radio/checkbox 可能位于当前交互快照之外，直接从完整 DOM 按字段和选项定位真实 label。
 * 定位成功后先滚入视口再点击，既覆盖长表单，也避免无障碍 ref 指向隐藏 input。
 */
function clickNativeSelectableDomTarget(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
): string | null {
  const field = action.field;
  const option = action.option;
  const mode = action.mode ?? 'select';
  const script = `(() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, '').trim();
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const target = normalize(${JSON.stringify(option)});
  const field = normalize(${JSON.stringify(field)});
  const mode = ${JSON.stringify(mode)};
  const candidates = [...document.querySelectorAll('label')]
    .map((label) => ({
      label,
      input: label.querySelector('input[type="radio"], input[type="checkbox"]'),
    }))
    .filter(({ label, input }) => input && isVisible(label) && normalize(label.textContent) === target);
  if (candidates.length === 0) {
    return JSON.stringify({ matchedCount: 0, clicked: false });
  }

  const fieldNodes = field
    ? [...document.querySelectorAll('label, [class*="label"], [class*="form-item"], [class*="formItem"], dt, th')]
      .filter((element) => isVisible(element) && normalize(element.textContent).includes(field))
    : [];
  const distance = (left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return Math.abs((a.left + a.right - b.left - b.right) / 2)
      + Math.abs((a.top + a.bottom - b.top - b.bottom) / 2);
  };
  const scoped = candidates
    .map((candidate) => ({
      ...candidate,
      fieldDistance: fieldNodes.length > 0
        ? Math.min(...fieldNodes.map((fieldNode) => distance(fieldNode, candidate.label)))
        : 0,
    }))
    .sort((a, b) => a.fieldDistance - b.fieldDistance);
  if (scoped.length > 1 && (!field || scoped[0].fieldDistance === scoped[1].fieldDistance)) {
    return JSON.stringify({ matchedCount: scoped.length, clicked: false, ambiguous: true });
  }

  const { label, input } = scoped[0];
  if (!input || input.disabled) {
    return JSON.stringify({ matchedCount: scoped.length, clicked: false, disabled: Boolean(input?.disabled) });
  }
  label.scrollIntoView({ block: 'center', inline: 'nearest' });
  const group = (() => {
    let current = label.parentElement;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const checkboxes = [...current.querySelectorAll('input[type="checkbox"]')].filter((item) => !item.disabled);
      if (checkboxes.includes(input) && checkboxes.length > 1 && (!field || normalize(current.textContent).includes(field))) {
        return checkboxes;
      }
    }
    return [input];
  })();
  const clickInputLabel = (targetInput) => {
    const targetLabel = targetInput.closest('label') || document.querySelector('label[for="' + CSS.escape(targetInput.id) + '"]');
    (targetLabel || targetInput).click();
  };
  let clickCount = 0;
  if (mode === 'exclusive') {
    if (input.type !== 'checkbox' || group.length < 2) {
      return JSON.stringify({ matchedCount: scoped.length, clicked: false, groupFound: false });
    }
    for (const sibling of group) {
      if (sibling !== input && sibling.checked) {
        clickInputLabel(sibling);
        clickCount += 1;
      }
    }
  }
  const desiredChecked = mode !== 'deselect';
  if (input.checked !== desiredChecked) {
    clickInputLabel(input);
    clickCount += 1;
  }
  const otherSelectedCount = group.filter((item) => item !== input && item.checked).length;
  const reached = input.checked === desiredChecked && (mode !== 'exclusive' || otherSelectedCount === 0);
  return JSON.stringify({
    matchedCount: scoped.length,
    clicked: clickCount > 0,
    checked: input.checked,
    alreadySelected: clickCount === 0 && reached,
    groupFound: group.length > 1,
    otherSelectedCount,
    reached,
  });
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    const reached = parsed.reached ?? (mode === 'select' && parsed.checked === true);
    if (reached !== true) {
      return null;
    }
    // 页面异步水合期间，复选框可能会先短暂显示为未选中，再恢复到真实已选状态。
    // 已达到目标时仍等待一次重渲染并复查(parseEvalJson)，避免把水合瞬间的未选中误判为需要继续点击。
    if (parsed.alreadySelected === true) {
      agent.waitMs(300);
      revealNativeSelectableDomTarget(agent, field, option);
      agent.waitMs(200);
      const settled = parseEvalJson(agent.evaluate(script));
      if (settled.clicked === true && settled.reached === true) {
        agent.waitMs(300);
        revealNativeSelectableDomTarget(agent, field, option);
        agent.waitMs(200);
        return `selectable dom ${mode} ${field ?? '选项'}=${option}`;
      }
      if (settled.alreadySelected !== true || settled.reached !== true) {
        return null;
      }
      return `selectable dom revealed: ${field ?? '选项'} 已达到 ${option}`;
    }
    if (parsed.clicked === true) {
      agent.waitMs(300);
      revealNativeSelectableDomTarget(agent, field, option);
      agent.waitMs(200);
      return `selectable dom ${mode} ${field ?? '选项'}=${option}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** 组件状态更新可能触发表单重渲染并复位滚动位置，动作完成后重新把目标控件滚入视口。 */
function revealNativeSelectableDomTarget(agent: BrowserAgent, field: string | null, option: string): boolean {
  const script = `(() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, '').trim();
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const target = normalize(${JSON.stringify(option)});
  const field = normalize(${JSON.stringify(field)});
  const candidates = [...document.querySelectorAll('label')]
    .filter((label) => label.querySelector('input[type="radio"], input[type="checkbox"]'))
    .filter(isVisible)
    .filter((label) => normalize(label.textContent) === target);
  if (candidates.length === 0) return JSON.stringify({ revealed: false });
  const fieldNodes = field
    ? [...document.querySelectorAll('label, [class*="label"], [class*="form-item"], [class*="formItem"], dt, th')]
      .filter((element) => isVisible(element) && normalize(element.textContent).includes(field))
    : [];
  const distance = (left, right) => {
    const a = left.getBoundingClientRect();
    const b = right.getBoundingClientRect();
    return Math.abs((a.left + a.right - b.left - b.right) / 2)
      + Math.abs((a.top + a.bottom - b.top - b.bottom) / 2);
  };
  const targetLabel = candidates
    .map((label) => ({
      label,
      fieldDistance: fieldNodes.length > 0 ? Math.min(...fieldNodes.map((fieldNode) => distance(fieldNode, label))) : 0,
    }))
    .sort((a, b) => a.fieldDistance - b.fieldDistance)[0]?.label;
  if (!targetLabel) return JSON.stringify({ revealed: false });
  targetLabel.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  return JSON.stringify({ revealed: true });
})()`;

  try {
    return parseEvalJson(agent.evaluate(script)).revealed === true;
  } catch {
    return false;
  }
}

/** 直接读取 DOM 中目标复选框及同组状态，验证“取消”与“仅勾选”的最终语义。 */
function verifyNativeSelectableDomState(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
): boolean | null {
  const script = `(() => {
  const normalize = (value) => (value || '').replace(/\\s+/g, '').trim();
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const target = normalize(${JSON.stringify(action.option)});
  const field = normalize(${JSON.stringify(action.field)});
  const mode = ${JSON.stringify(action.mode ?? 'select')};
  const candidates = [...document.querySelectorAll('label')]
    .map((label) => ({ label, input: label.querySelector('input[type="radio"], input[type="checkbox"]') }))
    .filter(({ label, input }) => input && isVisible(label) && normalize(label.textContent) === target);
  if (candidates.length !== 1) return JSON.stringify({ found: false });
  const { label, input } = candidates[0];
  let group = [input];
  for (let current = label.parentElement, depth = 0; current && depth < 8; current = current.parentElement, depth += 1) {
    const checkboxes = [...current.querySelectorAll('input[type="checkbox"]')].filter((item) => !item.disabled);
    if (checkboxes.includes(input) && checkboxes.length > 1 && (!field || normalize(current.textContent).includes(field))) {
      group = checkboxes;
      break;
    }
  }
  const desiredChecked = mode !== 'deselect';
  const otherSelectedCount = group.filter((item) => item !== input && item.checked).length;
  return JSON.stringify({
    found: true,
    reached: input.checked === desiredChecked && (mode !== 'exclusive' || group.length > 1 && otherSelectedCount === 0),
  });
})()`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    return parsed.found === true && typeof parsed.reached === 'boolean' ? parsed.reached : null;
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
    if (!opened.found) {
      return { attempted: false, output: null };
    }
    if (opened.opened === false) {
      return { attempted: true, output: null };
    }

    agent.waitMs(300);
    const clickScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.clickVisibleOption(${JSON.stringify(option)}));
})()`;
    const clicked = parseEvalJson(agent.evaluate(clickScript));
    if (clicked.clicked !== true) {
      const searchScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.searchActiveDropdown(${JSON.stringify(option)}));
})()`;
      const searched = parseEvalJson(agent.evaluate(searchScript));
      if (searched.searched === true) {
        agent.waitMs(500);
        const retryClickScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.clickVisibleOption(${JSON.stringify(option)}));
})()`;
        Object.assign(clicked, parseEvalJson(agent.evaluate(retryClickScript)));
      }
    }
    if (clicked.clicked !== true) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const scrollScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.scrollActiveDropdown(${JSON.stringify(option)}));
})()`;
        const scrolled = parseEvalJson(agent.evaluate(scrollScript));
        Object.assign(clicked, scrolled);
        if (scrolled.clicked === true || scrolled.scrolled !== true) {
          break;
        }
        agent.waitMs(200);
      }
    }
    if (clicked.clicked === true) {
      agent.waitMs(300);
      const selectedText = clicked.selectedText ? ` (${clicked.selectedText})` : '';
      const dropdownCleanup = dismissActiveDropdown(agent);
      return {
        attempted: true,
        output: [`select dom click ${field}=${option}${selectedText}`, dropdownCleanup].filter(Boolean).join('\n'),
      };
    }
    return { attempted: true, output: null };
  } catch (error) {
    if (error instanceof Error && error.message === '选中选项后下拉层仍未收起') {
      throw error;
    }
    return { attempted: true, output: null };
  }
}

/** 选中下拉项后收起仍可见的活动弹层，避免它遮挡流程中的下一个控件。 */
function dismissActiveDropdown(agent: BrowserAgent): string | null {
  const script = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.dismissActiveDropdown());
})()`;

  let dropdownOpen = false;
  try {
    const dismissed = parseEvalJson(agent.evaluate(script));
    if (dismissed.dismissed !== true) {
      return null;
    }
    agent.waitMs(300);
    const verifyScript = `(() => {
  const selectHelper = ${dropdownDomHelperSource()};
  return JSON.stringify(selectHelper.hasVisibleDropdown());
})()`;
    const verified = parseEvalJson(agent.evaluate(verifyScript));
    dropdownOpen = verified.dropdownOpen === true;
  } catch {
    return null;
  }

  if (dropdownOpen) {
    throw new Error('选中选项后下拉层仍未收起');
  }
  return 'dismiss active dropdown';
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
  const script = `(() => {
  const switchHelper = ${switchDomHelperSource()};
  const result = switchHelper.findSwitchByField(${JSON.stringify(field)}, ${JSON.stringify(option)});
  if (!result.found || !result.switchId || typeof result.desiredChecked !== 'boolean') {
    return JSON.stringify(result);
  }
  if (result.checked === result.desiredChecked) {
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
    const desiredChecked = parsed.desiredChecked ?? parsed.desired;
    if (!parsed.found) {
      return null;
    }
    if (typeof desiredChecked !== 'boolean') {
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
  const script = `(() => {
  const switchHelper = ${switchDomHelperSource()};
  const result = switchHelper.findSwitchByField(${JSON.stringify(field)}, ${JSON.stringify(option)});
  return JSON.stringify(result);
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    const desiredChecked = parsed.desiredChecked ?? parsed.desired;
    if (!parsed.found || typeof parsed.checked !== 'boolean' || typeof desiredChecked !== 'boolean') {
      return null;
    }
    return parsed.checked === desiredChecked;
  } catch {
    return null;
  }
}

function parseEvalJson(raw: string): {
  found?: boolean;
  checked?: boolean | null;
  desired?: boolean | null;
  desiredChecked?: boolean | null;
  clicked?: boolean;
  switchId?: string;
  matchedCount?: number;
  disabled?: boolean;
  ambiguous?: boolean;
  alreadySelected?: boolean;
  groupFound?: boolean;
  otherSelectedCount?: number;
  reached?: boolean;
  revealed?: boolean;
  opened?: boolean;
  selectedText?: string;
  searched?: boolean;
  scrolled?: boolean;
  dismissed?: boolean;
  dropdownOpen?: boolean;
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
  element.scrollIntoView({ block: 'center', inline: 'nearest' });
  element.focus?.();
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: (rect.left + rect.right) / 2,
    clientY: (rect.top + rect.bottom) / 2,
  };
  const PointerEventCtor = window.PointerEvent || MouseEvent;
  element.dispatchEvent(new PointerEventCtor('pointerdown', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new PointerEventCtor('pointerup', init));
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
const browserOptInputValue = (element, value) => {
  element.focus?.();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value.slice(-1) || 'a' }));
  element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: value.slice(-1) || 'a' }));
};
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
function searchActiveDropdown(option) {
  const active = document.querySelector('[data-browser-opt-active-select="true"]');
  const containers = browserOptDropdownContainers().map((item) => item.element);
  const input = active?.querySelector('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled)')
    || containers.map((container) => container.querySelector('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled)')).find(Boolean)
    || document.activeElement;
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
    return { searched: false };
  }
  if (input.readOnly || input.disabled) {
    return { searched: false };
  }
  browserOptInputValue(input, option);
  return { searched: true };
}
function scrollActiveDropdown(option) {
  const clicked = clickVisibleOption(option);
  if (clicked.clicked) {
    return clicked;
  }
  const active = document.querySelector('[data-browser-opt-active-select="true"]');
  const activeRect = active?.getBoundingClientRect();
  const root = browserOptDropdownContainers()
    .map((item) => ({ ...item, distance: activeRect ? browserOptCenterDistance(activeRect, item.rect) : 0 }))
    .sort((a, b) => a.distance - b.distance)[0]?.element;
  if (!root) {
    return { found: false, clicked: false, scrolled: false };
  }
  const preferred = root.querySelector('.rc-virtual-list-holder, .ant-select-dropdown-menu, .el-scrollbar__wrap');
  const candidates = [preferred, root, ...root.querySelectorAll('[role="listbox"], [class*="virtual-list"], [class*="scroll"]')]
    .filter((element, index, items) => element instanceof HTMLElement && items.indexOf(element) === index)
    .filter((element) => element.scrollHeight > element.clientHeight + 1);
  const scrollable = candidates[0];
  if (!scrollable) {
    return { found: false, clicked: false, scrolled: false };
  }
  const previousTop = scrollable.scrollTop;
  const maxTop = Math.max(scrollable.scrollHeight - scrollable.clientHeight, 0);
  scrollable.scrollTop = Math.min(previousTop + Math.max(Math.floor(scrollable.clientHeight * 0.8), 120), maxTop);
  scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
  return {
    found: false,
    clicked: false,
    scrolled: scrollable.scrollTop > previousTop,
    reachedEnd: scrollable.scrollTop >= maxTop,
  };
}
function dismissActiveDropdown() {
  const containers = browserOptDropdownContainers();
  if (containers.length === 0) {
    document.querySelectorAll('[data-browser-opt-active-select="true"]').forEach((element) => element.removeAttribute('data-browser-opt-active-select'));
    return { found: false, dismissed: false };
  }
  const active = document.querySelector('[data-browser-opt-active-select="true"]');
  const focused = active?.querySelector('input:not([type="hidden"]), textarea, [tabindex]') || document.activeElement;
  if (focused instanceof HTMLElement) {
    focused.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' }));
    focused.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' }));
    focused.blur();
  }
  active?.removeAttribute('data-browser-opt-active-select');
  return { found: true, dismissed: true };
}
function hasVisibleDropdown() {
  return { dropdownOpen: browserOptDropdownContainers().length > 0 };
}
return { openDropdownByField, clickVisibleOption, searchActiveDropdown, scrollActiveDropdown, dismissActiveDropdown, hasVisibleDropdown };
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
  if (aria === 'true' || aria === '1') return true;
  if (aria === 'false' || aria === '0') return false;
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
const browserOptSwitchDesiredState = (element, option) => {
  const optionText = normalizeBrowserOptText(option);
  const checkedText = normalizeBrowserOptText(element.querySelector('.ant-switch-inner-checked, [class*="inner-checked"]')?.textContent || '');
  const uncheckedText = normalizeBrowserOptText(element.querySelector('.ant-switch-inner-unchecked, [class*="inner-unchecked"]')?.textContent || '');
  if (checkedText && (checkedText.includes(optionText) || optionText.includes(checkedText))) return true;
  if (uncheckedText && (uncheckedText.includes(optionText) || optionText.includes(uncheckedText))) return false;
  if (/^(是|开|开启|打开|启用|true|yes|on)$/i.test(String(option || '').trim())) return true;
  if (/^(否|关|关闭|停用|禁用|false|no|off)$/i.test(String(option || '').trim())) return false;
  return null;
};
const browserOptSwitches = () => [...document.querySelectorAll('[role="switch"], .ant-switch, button')]
  .filter((element) => browserOptVisible(element) && (element.getAttribute('role') === 'switch' || String(element.className || '').includes('switch')));
function findSwitchByField(field, option) {
  const fieldText = normalizeBrowserOptText(field);
  const labels = [...document.querySelectorAll('body *')]
    .filter((element) => browserOptVisible(element) && normalizeBrowserOptText(element.textContent).includes(fieldText))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
  const switches = browserOptSwitches().map((element, index) => {
    const id = 'browser-opt-switch-' + index;
    element.setAttribute('data-browser-opt-switch-id', id);
    return {
      element,
      id,
      rect: element.getBoundingClientRect(),
      checked: browserOptSwitchState(element),
      desiredChecked: browserOptSwitchDesiredState(element, option),
    };
  });
  for (const label of labels) {
    const sameRow = switches
      .map((item) => {
        const verticalOverlap = Math.min(label.rect.bottom, item.rect.bottom) - Math.max(label.rect.top, item.rect.top);
        const yDistance = Math.abs((label.rect.top + label.rect.bottom) / 2 - (item.rect.top + item.rect.bottom) / 2);
        const xDistance = Math.abs((label.rect.left + label.rect.right) / 2 - (item.rect.left + item.rect.right) / 2);
        return { ...item, verticalOverlap, yDistance, xDistance };
      })
      .filter((item) => item.checked !== null && item.desiredChecked !== null && (item.verticalOverlap > 0 || item.yDistance < Math.max(label.rect.height, item.rect.height)))
      .sort((a, b) => a.yDistance - b.yDistance || a.xDistance - b.xDistance);
    const target = sameRow[0];
    if (target) {
      return { found: true, checked: target.checked, desiredChecked: target.desiredChecked, switchId: target.id };
    }
  }
  return { found: false, checked: null, desiredChecked: null };
}
return { findSwitchByField };
})()
`;
}

function isSwitchSelectable(role: string | null): boolean {
  return Boolean(role && /switch/i.test(role));
}

/** 只有明确来自下拉列表的 option 才执行弹层收尾，避免影响单选和复选控件。 */
function isDropdownOption(role: string | null): boolean {
  return Boolean(role && /option/i.test(role));
}

/** 只有 snapshot 明确把字段暴露为 switch 时，才启用开关 DOM 兜底，避免大表单误碰邻近控件。 */
function snapshotHasSwitchField(snapshot: SnapshotEvidence, field: string | null): boolean {
  if (!field) {
    return false;
  }

  const normalizedField = normalizeVisibleText(field);
  const lines = snapshot.text.split('\n');
  return lines.some((line, index) => {
    const parsed = parseSnapshotRoleAndLabel(line);
    if (!parsed) {
      return false;
    }

    const normalizedLabel = normalizeVisibleText(parsed.label);
    if (/switch/i.test(parsed.role) && normalizedLabel.includes(normalizedField)) {
      return true;
    }
    if (!isFieldLabelSnapshotLine(parsed, normalizedField)) {
      return false;
    }

    return lines
      .slice(index + 1, index + 5)
      .some((followingLine) => /-\s*switch\s+"/i.test(followingLine));
  });
}

/** 解析 snapshot 文本中的角色和标签，供本文件做局部语义判断。 */
function parseSnapshotRoleAndLabel(line: string): { role: string; label: string } | null {
  const match = line.match(/-\s*([A-Za-z]+)\s+"([^"]*)"/);
  return match?.[1]
    ? { role: match[1], label: match[2] ?? '' }
    : null;
}

/** 只把短字段标签视为 switch 锚点，避免整页容器文本把普通下拉误判为开关。 */
function isFieldLabelSnapshotLine(parsed: { role: string; label: string }, normalizedField: string): boolean {
  if (!/StaticText|LabelText|label|text|generic/i.test(parsed.role)) {
    return false;
  }

  const normalizedLabel = normalizeVisibleText(parsed.label);
  return normalizedLabel.includes(normalizedField) && normalizedLabel.length <= normalizedField.length + 8;
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
