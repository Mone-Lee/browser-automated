/**
 * browser-opt 日期选择动作工具，负责 DatePicker 类控件的日期归一化、填充、面板兜底和结果确认。
 */
import type { BrowserAgent } from '../../../../core/agent.js';
import type { DeterministicAction, SnapshotEvidence } from '../../../type.js';
import { findTextboxRef } from '../../../utils.js';
import { captureTransientSnapshot } from '../../evidence.js';

/** 判断 select-option 动作是否应交给日期控件处理，并返回归一化后的 YYYY-MM-DD。 */
export function resolveDateSelectOption(action: Extract<DeterministicAction, { type: 'select-option' }>): string | null {
  const normalizedDate = normalizeDateOption(action.option);
  return normalizedDate && isDateField(action.field) ? normalizedDate : null;
}

/** 执行 DatePicker 选择动作，优先直接填充，失败时再尝试 DOM setter 和面板点击。 */
export function executeDateSelectOptionAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
  snapshot: SnapshotEvidence,
  normalizedDate: string,
): string {
  const datePickerOutput = fillDatePickerTarget(agent, action, snapshot, normalizedDate);
  if (datePickerOutput) {
    return datePickerOutput;
  }
  throw new Error(`无法设置日期字段：${action.field ?? '日期'} -> ${action.option}（已转换为 ${normalizedDate}）`);
}

/** 校验 DatePicker 选择结果，避免把不可选日期或临时输入态误判成已提交。 */
export function verifyDateSelectOptionActionEffect(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
  afterSnapshot: SnapshotEvidence,
  normalizedDate: string,
): { passed: boolean; message: string } {
  if (isDatePickerConfirmDisabled(afterSnapshot.text)) {
    return { passed: false, message: formatDateUnavailableMessage(action.field, normalizedDate) };
  }
  if (inspectDateCellAvailability(agent, normalizedDate) === false) {
    return { passed: false, message: formatDateUnavailableMessage(action.field, normalizedDate) };
  }
  const domState = verifyDatePickerDomValue(agent, action.field, normalizedDate);
  if (domState === true) {
    return { passed: true, message: `已确认日期字段：${action.field}=${normalizedDate}` };
  }
  if (isSelectedValueVisible(afterSnapshot.text, action.field, normalizedDate)) {
    return { passed: true, message: `已确认页面显示日期值：${action.field}=${normalizedDate}` };
  }
  return { passed: false, message: `动作后未确认日期字段：${action.field}=${normalizedDate}` };
}

/** DatePicker 不是普通选项控件，先归一化日期并直接输入，最后才兜底点击面板。 */
function fillDatePickerTarget(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'select-option' }>,
  snapshot: SnapshotEvidence,
  normalizedDate: string,
): string | null {
  const ref = action.field ? findTextboxRef(snapshot, action.field) : null;
  const candidates = buildDateInputCandidates(normalizedDate, action.field);
  if (ref) {
    for (const candidate of candidates) {
      const output = agent.fill(ref, candidate);
      commitDatePickerDomValue(agent, action.field);
      agent.waitMs(300);
      const confirmation = confirmDatePickerValue(agent, action.field, normalizedDate);
      if (confirmation.unavailable) {
        throw new Error(formatDateUnavailableMessage(action.field, normalizedDate));
      }
      if (confirmation.confirmed) {
        return `datepicker fill @${ref} ${action.field}=${candidate}\n${output}`.trim();
      }
    }
  }

  for (const candidate of candidates) {
    const output = fillDatePickerDomTarget(agent, action.field, candidate, normalizedDate);
    if (output) {
      return output;
    }
  }

  if (ref) {
    const output = selectDatePickerPanelTarget(agent, ref, action.field, normalizedDate);
    if (output) {
      return output;
    }
  }

  return null;
}

/** 直接输入失败时再点击面板；该路径避免作为主流程，以免跨月跨年翻页过脆。 */
function selectDatePickerPanelTarget(
  agent: BrowserAgent,
  ref: string,
  field: string | null,
  expectedDate: string,
): string | null {
  const openOutput = agent.click(ref);
  agent.waitMs(300);
  const script = `(() => {
  const dateHelper = ${datePickerDomHelperSource()};
  const result = dateHelper.clickDateCell(${JSON.stringify(expectedDate)});
  if (!result.clicked) {
    return JSON.stringify(result);
  }
  const okButton = [...document.querySelectorAll('.ant-picker-ok button, .ant-picker-footer button')]
    .find((button) => dateHelper.browserOptDateVisible(button) && !button.disabled && /确|ok/i.test(button.textContent || ''));
  if (okButton) {
    okButton.click();
    result.okClicked = true;
  }
  return JSON.stringify(result);
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.clicked !== true) {
      return null;
    }
    agent.waitMs(500);
    const confirmation = confirmDatePickerValue(agent, field, expectedDate);
    if (confirmation.unavailable) {
      throw new Error(formatDateUnavailableMessage(field, expectedDate));
    }
    if (confirmation.confirmed) {
      return [
        `datepicker open @${ref}`,
        openOutput,
        `datepicker panel click ${field ?? '日期'}=${expectedDate}`,
      ].filter(Boolean).join('\n').trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** 有些 DatePicker 无法被 ref fill 稳定控制，使用原生 setter 作为二级兜底。 */
function fillDatePickerDomTarget(
  agent: BrowserAgent,
  field: string | null,
  value: string,
  expectedDate: string,
): string | null {
  const script = `(() => {
  const dateHelper = ${datePickerDomHelperSource()};
  const input = dateHelper.findDateInputByField(${JSON.stringify(field)});
  if (!input || input.disabled) {
    return JSON.stringify({ found: Boolean(input), filled: false, disabled: Boolean(input?.disabled), readOnly: Boolean(input?.readOnly) });
  }
  input.focus();
  dateHelper.setNativeInputValue(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.blur();
  return JSON.stringify({ found: true, filled: true, value: input.value });
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (parsed.filled === true) {
      agent.waitMs(300);
      const confirmation = confirmDatePickerValue(agent, field, expectedDate);
      if (confirmation.unavailable) {
        throw new Error(formatDateUnavailableMessage(field, expectedDate));
      }
      if (confirmation.confirmed) {
        return `datepicker dom fill ${field ?? '日期'}=${value}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** ref fill 后补一次 Enter/blur，触发 rc-picker 对输入内容的解析和提交。 */
function commitDatePickerDomValue(agent: BrowserAgent, field: string | null): void {
  const script = `(() => {
  const dateHelper = ${datePickerDomHelperSource()};
  const input = dateHelper.findDateInputByField(${JSON.stringify(field)}) || document.activeElement;
  if (!input) {
    return JSON.stringify({ found: false });
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.blur?.();
  return JSON.stringify({ found: true, value: input.value || '' });
})()
`;

  try {
    agent.evaluate(script);
  } catch {
    // 提交动作只是增强兜底，失败时继续让后续验证决定是否成功。
  }
}

/** 日期受控组件的 DOM value 可能读不到，补充 transient snapshot 作为动作内确认。 */
function confirmDatePickerValue(
  agent: BrowserAgent,
  field: string | null,
  expectedDate: string,
): { confirmed: boolean; unavailable: boolean } {
  if (inspectDatePickerCommitAvailability(agent) === false) {
    return { confirmed: false, unavailable: true };
  }

  if (inspectDateCellAvailability(agent, expectedDate) === false) {
    return { confirmed: false, unavailable: true };
  }

  if (verifyDatePickerDomValue(agent, field, expectedDate) === true) {
    return { confirmed: true, unavailable: false };
  }

  const snapshot = captureTransientSnapshot(agent);
  if (isDatePickerConfirmDisabled(snapshot.text)) {
    return { confirmed: false, unavailable: true };
  }
  return { confirmed: isSelectedValueVisible(snapshot.text, field, expectedDate), unavailable: false };
}

/** 日期时间控件的确认按钮不可用时，输入框里的临时值不能作为已提交结果。 */
function inspectDatePickerCommitAvailability(agent: BrowserAgent): boolean | null {
  const script = `(() => {
  const dateHelper = ${datePickerDomHelperSource()};
  return JSON.stringify(dateHelper.inspectDatePickerCommitButton());
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (!parsed.found) {
      return null;
    }
    return parsed.disabled !== true;
  } catch {
    return null;
  }
}

/** 如果 DatePicker 面板能看到目标日期且它被禁用，则即使 input 短暂显示该值也不能判成功。 */
function inspectDateCellAvailability(agent: BrowserAgent, expectedDate: string): boolean | null {
  const script = `(() => {
  const dateHelper = ${datePickerDomHelperSource()};
  return JSON.stringify(dateHelper.inspectDateCell(${JSON.stringify(expectedDate)}));
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (!parsed.found) {
      return null;
    }
    return parsed.disabled !== true;
  } catch {
    return null;
  }
}

/** 直接读取 DatePicker input 的值，弥补 snapshot 对受控日期组件状态表达不足的问题。 */
function verifyDatePickerDomValue(agent: BrowserAgent, field: string | null, expectedDate: string): boolean | null {
  const script = `(() => {
  const dateHelper = ${datePickerDomHelperSource()};
  const input = dateHelper.findDateInputByField(${JSON.stringify(field)});
  if (!input) {
    return JSON.stringify({ found: false, value: null });
  }
  return JSON.stringify({ found: true, value: input.value || input.getAttribute('value') || '' });
})()
`;

  try {
    const parsed = parseEvalJson(agent.evaluate(script));
    if (!parsed.found || typeof parsed.value !== 'string') {
      return null;
    }
    return parsed.value.includes(expectedDate);
  } catch {
    return null;
  }
}

function parseEvalJson(raw: string): {
  found?: boolean;
  clicked?: boolean;
  filled?: boolean;
  value?: string | null;
  okClicked?: boolean;
  disabled?: boolean;
  reason?: string;
  readOnly?: boolean;
} {
  const decoded = JSON.parse(raw.trim()) as unknown;
  return typeof decoded === 'string'
    ? JSON.parse(decoded) as ReturnType<typeof parseEvalJson>
    : decoded as ReturnType<typeof parseEvalJson>;
}

/** 返回在页面上下文执行的日期控件定位和赋值工具源码，优先按表单 label 关联 input。 */
function datePickerDomHelperSource(): string {
  return `
(() => {
const normalizeBrowserOptDateText = (value) => String(value || '').replace(/[\\s：:，,。；*]/g, '').toLowerCase();
const browserOptDateVisible = (element) => {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
};
const browserOptDateInputs = (root = document) => [...root.querySelectorAll('input')]
  .filter((input) => browserOptDateVisible(input))
  .filter((input) => {
    const text = normalizeBrowserOptDateText([input.placeholder, input.id, input.name, input.getAttribute('aria-label')].join(' '));
    const className = String(input.closest('.ant-picker, .datepicker, .date-picker')?.className || '');
    return input.type === 'date' || text.includes('日期') || text.includes('时间') || text.includes('date') || text.includes('time') || className.includes('picker');
  });
function findDateInputByField(field) {
  const fieldText = normalizeBrowserOptDateText(field);
  if (fieldText) {
    const labels = [...document.querySelectorAll('label')]
      .filter((label) => browserOptDateVisible(label))
      .filter((label) => normalizeBrowserOptDateText([label.textContent, label.title, label.getAttribute('for')].join(' ')).includes(fieldText));
    for (const label of labels) {
      const forId = label.getAttribute('for');
      const byId = forId ? document.getElementById(forId) : null;
      if (byId?.tagName === 'INPUT' && browserOptDateVisible(byId)) {
        return byId;
      }
      const formItem = label.closest('.ant-form-item, .form-item, [class*="form-item"]');
      const scoped = formItem ? browserOptDateInputs(formItem)[0] : null;
      if (scoped) {
        return scoped;
      }
    }
  }
  return browserOptDateInputs()[0] || null;
}
function setNativeInputValue(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
    return;
  }
  input.value = value;
}
function clickDateCell(expectedDate) {
  const inspected = inspectDateCell(expectedDate);
  if (!inspected.found) {
    return { clicked: false, reason: 'date cell not found' };
  }
  if (inspected.disabled) {
    return { clicked: false, disabled: true, reason: 'date cell disabled' };
  }
  inspected.clickable.click();
  return { clicked: true, selectedDate: expectedDate };
}
function inspectDateCell(expectedDate) {
  const dayText = String(Number(expectedDate.slice(8, 10)));
  const candidates = [
    ...document.querySelectorAll(
      '.ant-picker-cell[title], td[title], [data-date], .ant-picker-cell-inner, [role="gridcell"]'
    ),
  ].filter((element) => browserOptDateVisible(element));
  const exact = candidates.find((element) => {
    const title = element.getAttribute('title') || element.closest('[title]')?.getAttribute('title') || '';
    const dataDate = element.getAttribute('data-date') || element.closest('[data-date]')?.getAttribute('data-date') || '';
    return title === expectedDate || dataDate === expectedDate;
  });
  const fallback = exact || candidates.find((element) => {
    const cell = element.closest('.ant-picker-cell');
    const className = String(cell?.className || element.className || '');
    if (className.includes('ant-picker-cell-disabled') || className.includes('ant-picker-cell-in-view') === false) {
      return false;
    }
    return normalizeBrowserOptDateText(element.textContent) === dayText;
  });
  if (!fallback) {
    return { found: false, disabled: false, reason: 'date cell not found' };
  }
  const cell = fallback.closest('.ant-picker-cell') || fallback;
  const className = String(cell.className || fallback.className || '');
  const disabled = className.includes('ant-picker-cell-disabled')
    || fallback.getAttribute('aria-disabled') === 'true'
    || fallback.closest('[aria-disabled="true"]') !== null;
  const clickable = fallback.querySelector?.('.ant-picker-cell-inner') || fallback;
  return { found: true, disabled, clickable };
}
function inspectDatePickerCommitButton() {
  const buttons = [...document.querySelectorAll('.ant-picker-ok button, .ant-picker-footer button')]
    .filter((button) => browserOptDateVisible(button) && /确|ok/i.test(button.textContent || ''));
  if (buttons.length === 0) {
    return { found: false, disabled: false };
  }
  const button = buttons[0];
  return { found: true, disabled: Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true') };
}
return {
  browserOptDateVisible,
  clickDateCell,
  findDateInputByField,
  inspectDateCell,
  inspectDatePickerCommitButton,
  setNativeInputValue,
};
})()
`;
}

/** 日期字段通常会被自然语言写成“直播时间选择明天”，这里保守限制只接管日期/时间类字段。 */
function isDateField(field: string | null): boolean {
  return Boolean(field && /日期|时间|日程|开播|直播时间|date|time/i.test(field));
}

/** 时间类 DatePicker 常要求完整时间格式；日期类则先尝试纯日期。 */
function buildDateInputCandidates(date: string, field: string | null): string[] {
  return [isTimeLikeDateField(field) ? `${date} 00:00:00` : date];
}

/** 字段名含“时间/time”时更可能是 DateTimePicker。 */
function isTimeLikeDateField(field: string | null): boolean {
  return Boolean(field && /时间|开播|time/i.test(field));
}

/** 将常见中文和数字日期描述转成 DatePicker 默认可接受的 YYYY-MM-DD。 */
function normalizeDateOption(option: string, baseDate = new Date()): string | null {
  const trimmed = option.trim();
  const relativeDays: Record<string, number> = {
    今天: 0,
    今日: 0,
    明天: 1,
    明日: 1,
    后天: 2,
    大后天: 3,
  };
  if (Object.hasOwn(relativeDays, trimmed)) {
    return formatDate(addDays(baseDate, relativeDays[trimmed] ?? 0));
  }

  const explicit = parseExplicitDate(trimmed, baseDate);
  return explicit ? formatDate(explicit) : null;
}

/** 解析 7.1、0701、7月1日、2026-7-1、20260701 等常见口语日期。 */
function parseExplicitDate(input: string, baseDate: Date): Date | null {
  const normalized = input
    .replace(/[号日]/g, '')
    .replace(/年|\/|\.|-/g, '-')
    .replace(/月/g, '-')
    .trim();
  const compact = input.replace(/[^\d]/g, '');
  const currentYear = baseDate.getFullYear();

  const ymd = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    return createValidDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  }

  const md = normalized.match(/^(\d{1,2})-(\d{1,2})$/);
  if (md) {
    return createFutureBiasedDate(currentYear, Number(md[1]), Number(md[2]), baseDate);
  }

  if (/^\d{8}$/.test(compact)) {
    return createValidDate(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)), Number(compact.slice(6, 8)));
  }

  if (/^\d{4}$/.test(compact)) {
    return createFutureBiasedDate(currentYear, Number(compact.slice(0, 2)), Number(compact.slice(2, 4)), baseDate);
  }

  return null;
}

/** 没写年份的日期用于预约场景时，如果已过去则自动滚到下一年。 */
function createFutureBiasedDate(year: number, month: number, day: number, baseDate: Date): Date | null {
  const date = createValidDate(year, month, day);
  if (!date) {
    return null;
  }

  const baseDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  return date < baseDay ? createValidDate(year + 1, month, day) : date;
}

/** 严格构造日期，避免 2 月 31 日被 JS 自动进位后误认为合法输入。 */
function createValidDate(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/** 按 AntD DatePicker 默认格式输出日期。 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 基于本地时区做自然日加减，避免毫秒相加遇到夏令时边界产生偏移。 */
function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
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

/** AntD DateTimePicker 面板还开着且“确定”禁用时，当前日期值只是临时输入态。 */
function isDatePickerConfirmDisabled(text: string): boolean {
  return /button\s+"(?:确\s*定|ok)"\s+\[[^\]]*disabled/i.test(text);
}

/** 统一不可选日期的用户侧提示，避免报告里出现“已显示但未提交”的误导信息。 */
function formatDateUnavailableMessage(field: string | null, date: string): string {
  return `日期不可选：${field ?? '日期'}=${date}`;
}

/** 归一化页面可见文案，减少空白和标点对选择结果确认的影响。 */
function normalizeVisibleText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[：:，,。；"'‘’“”]/g, '').trim();
}
