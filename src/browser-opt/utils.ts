/**
 * browser-opt 工具函数文件，集中承载自然语言解析、snapshot 文本处理、
 * 节点匹配、验证判断和报告渲染等无状态逻辑，让 runner 只负责执行编排。
 */
import * as path from 'node:path';
import type { AgentBrowserJsonResult } from '../core/agent.js';
import type {
  BrowserOptReport,
  BrowserOptStepResult,
  DeterministicAction,
  SnapshotEvidence,
  SnapshotNode,
} from './type.js';

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), '.browser-opt', 'artifacts');
const URL_RE = /https?:\/\/[^\s。，、，)）"'‘’“”]+/i;
const QUOTED_VALUE_RE = /["“‘']([^"”’']+)["”’']/;
const SELECTABLE_VERB_RE = /选择|选中|勾选|勾上|设置为|设置成|切换为|切换成|切到|改为|改成|调整为|调整成|设为|设成|置为|置成|变更为|变更成|变为|变成|select|check|toggle/i;

/** 从自然语言描述中提取第一个 URL，作为 browser-opt 的起始页面。 */
export function extractBrowserOptUrl(text: string): string | null {
  const match = normalizeBrowserOptFlowText(text).match(URL_RE);
  return match ? match[0] : null;
}

/** 把自然语言流程拆成顺序步骤，优先识别编号目标，无法识别时回退为单步骤。 */
export function splitBrowserOptSteps(text: string): string[] {
  const lines = normalizeBrowserOptFlowText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const numbered = lines
    .map((line) => line.match(/^(?:目标[:：]\s*)?(\d+)[\.)、]\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[2]))
    .map((match) => match[2].trim())
    .filter(Boolean);

  if (numbered.length > 0) {
    return numbered;
  }

  const compactLines = lines.filter((line) => !/^目标[:：]?$/.test(line));
  const looseSteps = compactLines
    .flatMap((line) => line.split(/(?<=[。；;])\s*/))
    .map((line) => line.replace(/[。；;]$/g, '').trim())
    .filter(Boolean)
    .flatMap((line) => splitCompoundSelectableStep(line));

  if (looseSteps.length > 1) {
    const actionable = looseSteps.filter((step) => parseDeterministicAction(step) || isVerificationStep(step));
    return actionable.length > 0 ? actionable : looseSteps;
  }

  const compact = compactLines
    .filter((line) => !/^目标[:：]?$/.test(line))
    .join('\n')
    .trim();
  return compact ? [compact] : [];
}

/** 将“字段选择 A 和 B”拆成两条独立选择步骤，避免只执行最后一个选项。 */
function splitCompoundSelectableStep(instruction: string): string[] {
  const verb = instruction.match(SELECTABLE_VERB_RE);
  const quoted = extractQuotedSegments(instruction);
  if (!verb || quoted.length < 2) {
    return [instruction];
  }

  const field = parseSelectableFieldName(instruction, quoted[0]);
  if (!field) {
    return [instruction];
  }

  const betweenOptions = instruction.slice(quoted[0].index + quoted[0].value.length, quoted[1].index);
  if (!/[和及、,，]/.test(betweenOptions)) {
    return [instruction];
  }

  return quoted.map((segment) => `${field}选择“${segment.value}”`);
}

/** 从自然语言步骤中提炼结构化动作，供确定性执行层消费。 */
export function parseDeterministicAction(instruction: string): DeterministicAction | null {
  const normalized = cleanInstructionPrefix(normalizeBrowserOptFlowText(instruction));
  const url = normalized.match(URL_RE)?.[0];
  if (url && /访问|打开|open|goto|navigate/i.test(normalized)) {
    return { type: 'open', url };
  }

  if (/handoff|人工|手动|操作人员/.test(normalized) && /上传|选择.*(?:图片|文件|封面)/.test(normalized)) {
    return { type: 'handoff', message: normalized };
  }

  if (url && isUploadInstruction(normalized)) {
    return {
      type: 'upload',
      field: parseUploadFieldName(normalized) ?? '文件',
      source: url,
    };
  }

  const quoted = normalized.match(QUOTED_VALUE_RE)?.[1]?.trim();
  if (quoted && /输入|填写|填入|type|fill/i.test(normalized)) {
    return {
      type: 'fill',
      field: parseFieldName(normalized) ?? '文本',
      value: quoted,
    };
  }

  const selectableTarget = parseSelectableTarget(normalized);
  if (selectableTarget) {
    return {
      type: 'select-option',
      field: selectableTarget.field,
      option: selectableTarget.option,
    };
  }

  if (/点击|单击|click|tap|press/i.test(normalized)) {
    const target = quoted
      ?? normalized
        .replace(/点击|单击|click|tap|press/gi, '')
        .replace(/[。；，,]/g, '')
        .trim();
    return { type: 'click', target: target || '按钮' };
  }

  const expectedText = parseExpectedText(normalized);
  if (expectedText && isVerificationStep(normalized)) {
    return { type: 'assert-text', text: expectedText };
  }

  return null;
}

/** 将 CLI 或上层封装传入的字面量换行还原，避免 "\\n2." 被当作字段名。 */
function normalizeBrowserOptFlowText(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r/g, '\n');
}

/** 清理步骤前缀中的编号和多余空白，让动作解析只面对业务语义。 */
function cleanInstructionPrefix(instruction: string): string {
  return instruction
    .replace(/^\s*(?:目标[:：]\s*)?\d+[\.)、]\s*/, '')
    .trim();
}

/** 识别带远程 URL 的图片/文件上传描述，兼容省略“上传”动词的口语写法。 */
function isUploadInstruction(instruction: string): boolean {
  return /上传|upload/i.test(instruction)
    || /(?:图片|文件|封面)\s*(?:来源|地址|链接|url)\s*(?:为|是|:|：)?/i.test(instruction)
    || /(?:来源|地址|链接|url)\s*(?:为|是|:|：)?\s*https?:\/\/.+(?:图片|文件|封面)/i.test(instruction)
    || /(?:使用|用|从)\s*https?:\/\/.+(?:作为|当作|设置为|设为).*(?:图片|文件|封面)/i.test(instruction);
}

/** 从上传步骤中提取字段名，优先识别引号中的控件名称。 */
function parseUploadFieldName(instruction: string): string | null {
  const quoted = instruction.match(/["“‘']([^"”’']+)["”’']/)?.[1]?.trim();
  if (quoted && !URL_RE.test(quoted)) {
    return quoted;
  }

  const beforeSource = instruction.split(URL_RE)[0]?.trim() ?? instruction;
  const afterSource = instruction.split(URL_RE).slice(1).join(' ').trim();
  const candidates = [
    beforeSource.match(/(?:自动)?上传\s*([^，,。；\n]+?)(?:，|,|图片来源|文件来源|来源|地址|链接|url|$)/i)?.[1],
    beforeSource.match(/^([^，,。；\n]+?)(?:，|,)?\s*(?:图片|文件|封面)\s*(?:来源|地址|链接|url)\s*(?:为|是|:|：)?/i)?.[1],
    beforeSource.match(/(?:为|给|将|把)\s*([^，,。；\n]+?)\s*(?:使用|用|从)?\s*$/i)?.[1],
    afterSource.match(/(?:作为|当作|设置为|设为)\s*([^，,。；\n]+?)(?:图片|文件|封面)?(?:，|,|。|；|$)/i)?.[1],
  ];

  for (const candidate of candidates) {
    const cleaned = cleanUploadFieldName(candidate ?? '');
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

/** 清理上传字段名外围的动作词和来源提示，保留页面控件文案。 */
function cleanUploadFieldName(value: string): string | null {
  const cleaned = value
    .replace(/^["“‘']|["”’']$/g, '')
    .replace(/^(请|自动|帮我|给我|将|把|为|给)\s*/, '')
    .replace(/(?:的)?(?:图片|文件|封面)?\s*(?:来源|地址|链接|url)\s*(?:为|是|:|：)?$/i, '')
    .replace(/(封面)(?:图片|图)$/i, '$1')
    .replace(/[：:，,。；]$/g, '')
    .trim();

  return cleaned || null;
}

/** 从“字段输入值”类语句中提取字段名，兼容常见中文口语写法。 */
function parseFieldName(instruction: string): string | null {
  const beforeVerb = instruction.match(/^(.+?)(?:输入|填写|填入|type|fill)/i)?.[1]?.trim();
  if (beforeVerb) {
    const cleaned = beforeVerb.replace(/^(在|向|给)\s*/, '').replace(/[：:，,。；]$/g, '').trim();
    if (cleaned) {
      return cleaned;
    }
  }

  const afterVerb = instruction.match(/(?:在|向|给)\s*([^，,。；\n]+?)(?:中|里|内)?(?:输入|填写|填入)/i)?.[1]?.trim();
  return afterVerb || null;
}

interface QuotedSegment {
  value: string;
  index: number;
}

/** 从“字段选择选项”类语句中同时提取字段名和选项，避免把字段误当成选项。 */
function parseSelectableTarget(instruction: string): { field: string | null; option: string } | null {
  const verb = instruction.match(SELECTABLE_VERB_RE);
  if (!verb) {
    return parseLooseSelectableTarget(instruction);
  }

  const quoted = extractQuotedSegments(instruction);
  if (quoted.length >= 2) {
    return {
      field: quoted[0].value,
      option: quoted[1].value,
    };
  }

  const quotedValueIsField = quoted[0] && quoted[0].index < (verb.index ?? 0);
  const option = quotedValueIsField ? parseUnquotedSelectableOption(instruction) : quoted[0]?.value ?? parseUnquotedSelectableOption(instruction);
  if (!option) {
    return null;
  }

  return {
    field: quotedValueIsField ? cleanSelectableText(quoted[0].value) : parseSelectableFieldName(instruction, quoted[0]) ?? null,
    option,
  };
}

/** 提取中英文引号里的片段，并保留位置供字段名解析避开选项片段。 */
function extractQuotedSegments(instruction: string): QuotedSegment[] {
  const matches = instruction.matchAll(/["“‘']([^"”’']+)["”’']/g);
  return [...matches]
    .map((match) => ({ value: match[1]?.trim() ?? '', index: match.index ?? 0 }))
    .filter((segment) => Boolean(segment.value));
}

/** 从没有引号的选择语句中提取目标选项，作为口语化步骤的兜底。 */
function parseUnquotedSelectableOption(instruction: string): string | null {
  const afterVerb = instruction.match(new RegExp(`(?:${SELECTABLE_VERB_RE.source})\\s*([^，,。；\\n]+)`, 'i'))?.[1]?.trim();
  if (!afterVerb) {
    return null;
  }

  return cleanSelectableText(afterVerb.replace(/^(为|成|到)\s*/, ''));
}

/** 从“字段选择选项”类语句中提取字段名，支持单选、多选和开关式配置。 */
function parseSelectableFieldName(instruction: string, quotedOption?: QuotedSegment): string | null {
  const beforeVerb = instruction.match(new RegExp(`^(.+?)(?:${SELECTABLE_VERB_RE.source})`, 'i'))?.[1]?.trim();
  if (beforeVerb) {
    const cleaned = cleanSelectableText(beforeVerb.replace(/^(将|把|在|为|给)\s*/, ''));
    if (cleaned) {
      return cleaned;
    }
  }

  const beforeQuotedOption = quotedOption ? instruction.slice(0, quotedOption.index) : instruction;
  const afterVerb = beforeQuotedOption.match(new RegExp(`(?:在|为|给)\\s*([^，,。；\\n]+?)(?:中|里|内)?(?:${SELECTABLE_VERB_RE.source})`, 'i'))?.[1]?.trim();
  return cleanSelectableText(afterVerb ?? '');
}

/** 为不完全命中标准动词的选择语句提供保守兜底，尽量提炼出“字段 -> 值”。 */
function parseLooseSelectableTarget(instruction: string): { field: string | null; option: string } | null {
  const looseVerb = instruction.match(/(.+?)(?:改为|改成|调整为|调整成|设为|设成|置为|置成|变更为|变更成|变为|变成|切到)\s*([^，,。；\n]+)/i);
  if (!looseVerb?.[1] || !looseVerb[2]) {
    return null;
  }

  const field = cleanSelectableText(looseVerb[1].replace(/^(将|把|在|为|给)\s*/, ''));
  const option = cleanSelectableText(looseVerb[2]);
  return field && option ? { field, option } : null;
}

/** 清理字段名和选项值外围的语气词、引号和标点，保留真实业务文案。 */
function cleanSelectableText(value: string): string | null {
  const cleaned = value
    .replace(/^\s*(?:目标[:：]\s*)?\d+[\.)、]\s*/, '')
    .replace(/^["“‘']|["”’']$/g, '')
    .replace(/^(为|成|到)\s*/, '')
    .replace(/[：:，,。；]$/g, '')
    .trim();

  return cleaned || null;
}

/** 在当前快照中优先查找文本框，再按字段名做最佳匹配。 */
export function findTextboxRef(snapshot: SnapshotEvidence, field: string): string | null {
  const nodes = getSnapshotNodes(snapshot).filter((node) => isTextboxRole(node.role));
  const matchedRef = findBestNodeRef(nodes, field);
  if (matchedRef || isGenericTextboxField(field)) {
    return matchedRef ?? nodes[0]?.ref ?? null;
  }

  return null;
}

/** 在当前快照中查找可点击元素，并按目标文案做最佳匹配。 */
export function findClickableRef(snapshot: SnapshotEvidence, target: string): string | null {
  const nodes = getSnapshotNodes(snapshot).filter((node) => !isTextboxRole(node.role));
  return findBestNodeRef(nodes, target) ?? nodes[0]?.ref ?? null;
}

/** 查找单选或多选选项，优先点击 label，并在已选中时短路为完成。 */
export function findSelectableOption(
  snapshot: SnapshotEvidence,
  field: string | null,
  option: string,
): { ref: string | null; alreadySelected: boolean; role: string | null } {
  const scoped = findScopedOptionLabel(snapshot.text, field, option);
  if (scoped) {
    return scoped;
  }

  const nodes = getSnapshotNodes(snapshot);
  const switchControl = findScopedSwitchControl(snapshot.text, field, nodes, option);
  if (switchControl) {
    return switchControl;
  }

  const selectable = findBestNode(nodes.filter((node) => isSelectableRole(node.role)), option);
  if (selectable?.checked) {
    return { ref: selectable.ref, alreadySelected: true, role: selectable.role };
  }

  const label = findBestNode(nodes.filter((node) => isClickableLabelRole(node.role)), option);
  if (label) {
    return { ref: label.ref, alreadySelected: false, role: label.role };
  }

  if (selectable && !selectable.disabled) {
    return { ref: selectable.ref, alreadySelected: false, role: selectable.role };
  }

  return { ref: null, alreadySelected: false, role: null };
}

/** 查找可展开选择项的字段控件，供下拉选项尚未渲染时先打开选项面板。 */
export function findSelectableFieldRef(snapshot: SnapshotEvidence, field: string | null): string | null {
  if (!field) {
    return null;
  }

  const scoped = findScopedSelectableFieldRef(snapshot.text, field);
  if (scoped) {
    return scoped;
  }

  const nodes = getSnapshotNodes(snapshot).filter((node) => isExpandableSelectRole(node.role));
  return findBestNodeRef(nodes, field);
}

/** 查找上传控件，只返回快照中可确认的真实文件输入，避免把上传按钮误当成 input。 */
export function findUploadRef(snapshot: SnapshotEvidence, field: string): string | null {
  const nodes = getSnapshotNodes(snapshot);
  const fileInputs = nodes.filter((node) => isFileInputRole(node.role, node.label));
  return findBestNodeRef(fileInputs, field) ?? fileInputs[0]?.ref ?? null;
}

/** 在候选节点集合里做一次精确优先、字符兜底的模糊匹配。 */
function findBestNodeRef(nodes: SnapshotNode[], target: string): string | null {
  return findBestNode(nodes, target)?.ref ?? null;
}

/** 在候选节点集合里返回最佳匹配节点，供需要读取选中状态的场景复用。 */
function findBestNode(nodes: SnapshotNode[], target: string): SnapshotNode | null {
  const normalizedTarget = normalizeMatchText(target);
  if (!normalizedTarget) {
    return null;
  }

  const exact = nodes.find((node) => {
    const label = normalizeMatchText(node.label);
    if (!label) {
      return false;
    }
    return label.includes(normalizedTarget) || normalizedTarget.includes(label);
  });
  if (exact) {
    return exact;
  }

  const targetChars = [...normalizedTarget];
  const partial = nodes.find((node) => {
    const label = normalizeMatchText(node.label);
    if (!label) {
      return false;
    }
    return targetChars.length > 1 && targetChars.every((char) => label.includes(char));
  });

  return partial ?? null;
}

/** 把 JSON refs 和 snapshot 文本中的节点信息统一归并成可匹配的节点列表。 */
function getSnapshotNodes(snapshot: SnapshotEvidence): SnapshotNode[] {
  const refs = findObjectProperty(snapshot.output.data, 'refs');
  const nodes: SnapshotNode[] = [];

  if (refs) {
    for (const [ref, value] of Object.entries(refs)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const role = findFirstStringProperty(value, ['role', 'type']) ?? '';
      const label = findFirstStringProperty(value, ['name', 'label', 'text', 'title', 'placeholder', 'ariaLabel', 'value']) ?? '';
      nodes.push({ ref, role, label });
    }
  }

  const fromText = snapshot.text
    .split('\n')
    .map((line) => parseSnapshotLine(line))
    .filter((node): node is SnapshotNode => Boolean(node));

  return mergeSnapshotNodes([...nodes, ...fromText]);
}

/** 从 snapshot 的单行文本中解析出一个节点定义，作为 refs 缺失时的兜底来源。 */
function parseSnapshotLine(line: string): SnapshotNode | null {
  const match = line.match(/-\s*([A-Za-z]+)\s+"([^"]*)"\s+\[([^\]]+)\]/);
  const ref = match?.[3]?.match(/(?:^|,\s*)ref=([^,\]\s]+)/)?.[1];
  if (match?.[1] && ref) {
    return {
      role: match[1],
      label: match[2] ?? '',
      ref,
      checked: /(?:^|,\s*)checked=true(?:,|$)/.test(match[3]),
      disabled: /(?:^|,\s*)disabled(?:,|$)/.test(match[3]),
    };
  }

  return null;
}

/** 以 ref 合并节点，保留 JSON refs 的基础信息和文本快照里的状态属性。 */
function mergeSnapshotNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const merged = new Map<string, SnapshotNode>();
  for (const node of nodes) {
    const current = merged.get(node.ref);
    if (!current) {
      merged.set(node.ref, node);
      continue;
    }

    merged.set(node.ref, {
      ref: node.ref,
      role: current.role || node.role,
      label: current.label || node.label,
      checked: current.checked ?? node.checked,
      disabled: current.disabled ?? node.disabled,
    });
  }

  return [...merged.values()];
}

/** 判断某个角色是否可以视为文本输入控件。 */
function isTextboxRole(role: string): boolean {
  return /textbox|input|searchbox|combobox|textarea/i.test(role);
}

/** 识别 radio、checkbox 等可选择控件。 */
function isSelectableRole(role: string): boolean {
  return /radio|checkbox|switch|option/i.test(role);
}

/** 识别可展开的选择字段，如 select、combobox 以及常见伪下拉按钮。 */
function isExpandableSelectRole(role: string): boolean {
  return /combobox|select|listbox|button/i.test(role);
}

/** 单独识别 switch，便于按布尔目标状态切换。 */
function isSwitchRole(role: string): boolean {
  return /switch/i.test(role);
}

/** 识别常见 UI 库中包裹 radio/checkbox 的可点击 label。 */
function isClickableLabelRole(role: string): boolean {
  return /labeltext|label/i.test(role);
}

/** 只有用户没有给出具体字段名时，才允许回退到页面上的第一个输入框。 */
function isGenericTextboxField(field: string): boolean {
  return /^(文本|内容|输入框|搜索框|textbox|input|search)$/i.test(field.trim());
}

/** 识别 snapshot 中可能代表文件上传的输入控件。 */
function isFileInputRole(role: string, label: string): boolean {
  return /file/i.test(role) || (/input/i.test(role) && /上传|upload|选择文件|choose\s+file/i.test(label));
}

/** 归一化待匹配文本，减少空格和中英文标点对匹配结果的干扰。 */
function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[：:，,。；"'‘’“”]/g, '').trim();
}

/** 识别“是/否、开/关”这类布尔型目标值，供 switch 切换场景复用。 */
function isBooleanLikeOption(option: string): boolean {
  return /^(是|否|开|关|开启|关闭|打开|启用|停用|true|false|yes|no|on|off)$/i.test(option.trim());
}

/** 将自然语言里的开关目标状态归一化为 checked 布尔值。 */
function inferDesiredChecked(option: string): boolean {
  return /^(是|开|开启|打开|启用|true|yes|on)$/i.test(option.trim());
}

/** 基于文本快照顺序，在同一组选项附近寻找目标选项，弥补 refs 缺少字段名的问题。 */
function findScopedOptionLabel(
  text: string,
  field: string | null,
  option: string,
): { ref: string | null; alreadySelected: boolean; role: string | null } | null {
  const lines = text.split('\n');
  const normalizedField = normalizeMatchText(field ?? '');
  const normalizedOption = normalizeMatchText(option);
  const fieldIndex = normalizedField
    ? lines.findIndex((line) => normalizeMatchText(line).includes(normalizedField))
    : -1;
  const startIndex = fieldIndex >= 0 ? fieldIndex + 1 : 0;
  const endIndex = fieldIndex >= 0 ? findSelectableScopeEnd(lines, startIndex) : lines.length;

  for (let index = startIndex; index < endIndex; index += 1) {
    const parsed = parseSnapshotLine(lines[index]);
    if (!parsed) {
      continue;
    }

    if (isClickableLabelRole(parsed.role) && normalizeMatchText(parsed.label).includes(normalizedOption)) {
      const child = parseSnapshotLine(lines[index + 1] ?? '');
      if (child?.disabled && !child.checked) {
        index += 1;
        continue;
      }
      return {
        ref: child && !child.disabled ? child.ref : parsed.ref,
        alreadySelected: child?.checked ?? false,
        role: child?.role ?? parsed.role,
      };
    }

    if (isSelectableRole(parsed.role) && normalizeMatchText(parsed.label).includes(normalizedOption)) {
      if (parsed.disabled && !parsed.checked) {
        continue;
      }
      return {
        ref: parsed.ref,
        alreadySelected: parsed.checked ?? false,
        role: parsed.role,
      };
    }
  }

  return null;
}

/** 针对单个 switch 控件，按目标状态判断是否需要点击，而不是要求页面出现同名选项文案。 */
function findScopedSwitchControl(
  text: string,
  field: string | null,
  nodes: SnapshotNode[],
  option: string,
): { ref: string | null; alreadySelected: boolean; role: string | null } | null {
  if (!field || !isBooleanLikeOption(option)) {
    return null;
  }

  const lines = text.split('\n');
  const normalizedField = normalizeMatchText(field);
  const fieldIndex = normalizedField
    ? lines.findIndex((line) => normalizeMatchText(line).includes(normalizedField))
    : -1;
  if (fieldIndex < 0) {
    return null;
  }

  const desiredChecked = inferDesiredChecked(option);
  const endIndex = findSelectableScopeEnd(lines, fieldIndex + 1);
  for (let index = fieldIndex; index < endIndex; index += 1) {
    const parsed = parseSnapshotLine(lines[index]);
    if (!parsed || !isSwitchRole(parsed.role)) {
      continue;
    }

    const merged = nodes.find((node) => node.ref === parsed.ref) ?? parsed;
    return {
      ref: merged.ref,
      alreadySelected: merged.checked === desiredChecked,
      role: merged.role,
    };
  }

  return null;
}

/** 在字段文案后面的短范围内寻找下拉控件，适配字段名和控件值分离的表单布局。 */
function findScopedSelectableFieldRef(text: string, field: string): string | null {
  const lines = text.split('\n');
  const normalizedField = normalizeMatchText(field);
  const fieldIndex = lines.findIndex((line) => normalizeMatchText(line).includes(normalizedField));
  if (fieldIndex < 0) {
    return null;
  }

  for (let index = fieldIndex + 1; index < Math.min(lines.length, fieldIndex + 6); index += 1) {
    const parsed = parseSnapshotLine(lines[index]);
    if (parsed && isExpandableSelectRole(parsed.role) && !parsed.disabled) {
      return parsed.ref;
    }
  }

  return null;
}

/** 字段命中后只在紧邻的可选择控件区域内查找，遇到下一个非选项节点即停止。 */
function findSelectableScopeEnd(lines: string[], startIndex: number): number {
  let hasSeenOption = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const parsed = parseSnapshotLine(lines[index]);
    if (!parsed) {
      continue;
    }

    if (isClickableLabelRole(parsed.role) || isSelectableRole(parsed.role)) {
      hasSeenOption = true;
      continue;
    }

    if (hasSeenOption) {
      return index;
    }
  }

  return lines.length;
}

/** 在未知深度的对象里递归查找首个可用字符串字段。 */
function findFirstStringProperty(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === 'string') {
      return record[key] as string;
    }
  }

  for (const entry of Object.values(record)) {
    const found = findFirstStringProperty(entry, keys);
    if (found) {
      return found;
    }
  }

  return null;
}

/** 判断一条自然语言步骤是否主要承担验证职责。 */
export function isVerificationStep(instruction: string): boolean {
  return /验证|断言|检查|verify|assert|expect|should|包含|存在|至少\s*\d+/i.test(instruction);
}

/** 对步骤执行后的页面状态做验证，生成可直接写入报告的结果说明。 */
export function verifyStep(instruction: string, snapshot: SnapshotEvidence): { passed: boolean; message: string } {
  if (!isVerificationStep(instruction)) {
    return { passed: true, message: '非验证步骤，已完成动作并重新 snapshot。' };
  }

  const atLeastCount = parseAtLeastCount(instruction);
  if (atLeastCount !== null) {
    const passed = snapshot.nodeCount >= atLeastCount;
    return {
      passed,
      message: passed
        ? `元素数量 ${snapshot.nodeCount} >= ${atLeastCount}`
        : `元素数量 ${snapshot.nodeCount} < ${atLeastCount}`,
    };
  }

  const expectedText = parseExpectedText(instruction);
  if (expectedText) {
    const passed = normalizedIncludes(snapshot.text, expectedText);
    return {
      passed,
      message: passed
        ? `页面包含文本：${expectedText}`
        : `页面未包含文本：${expectedText}`,
    };
  }

  if (/存在|visible|exists?|出现/i.test(instruction)) {
    return snapshot.nodeCount > 0
      ? { passed: true, message: `存在可交互元素，数量：${snapshot.nodeCount}` }
      : { passed: false, message: '未发现可交互元素。' };
  }

  return snapshot.text.trim()
    ? { passed: true, message: '验证步骤已执行，页面 snapshot 非空。' }
    : { passed: false, message: '验证步骤执行后页面 snapshot 为空。' };
}

/** 从自然语言断言中提取“至少 N 个元素”这类数量约束。 */
function parseAtLeastCount(instruction: string): number | null {
  const match = instruction.match(/(?:至少|不少于|>=|at\s+least)\s*(\d+)/i);
  return match?.[1] ? Number(match[1]) : null;
}

/** 从自然语言断言中提取预期文本，兼容引号和“包含/显示”类说法。 */
function parseExpectedText(instruction: string): string | null {
  const contains = instruction.match(/(?:包含|看到|显示|contains?|include[s]?)\s*([^。；\n]+)/i);
  if (contains?.[1]) {
    return contains[1]
      .replace(/至少\s*\d+.*$/, '')
      .replace(/^["“‘']|["”’']$/g, '')
      .trim();
  }

  const quoted = instruction.match(QUOTED_VALUE_RE);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  return null;
}

/** 用大小写不敏感的方式比较文本包含关系。 */
function normalizedIncludes(source: string, expected: string): boolean {
  return source.toLowerCase().includes(expected.toLowerCase());
}

/** 优先从 JSON 结构提取 snapshot 文本，提取不到时回退到原始输出。 */
export function snapshotText(output: AgentBrowserJsonResult): string {
  if (typeof output.data === 'object' && output.data !== null) {
    const snapshot = findStringProperty(output.data, 'snapshot');
    if (snapshot) {
      return snapshot;
    }
  }

  return output.raw;
}

/** 在任意嵌套对象中递归查找指定 key 对应的字符串值。 */
function findStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string') {
    return record[key] as string;
  }

  for (const entry of Object.values(record)) {
    const found = findStringProperty(entry, key);
    if (found) {
      return found;
    }
  }

  return null;
}

/** 统计快照中的可引用节点数量，兼容 refs 和文本两种来源。 */
export function countSnapshotNodes(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  const record = value as Record<string, unknown>;
  const refs = findObjectProperty(record, 'refs');
  if (refs) {
    return Object.keys(refs).length;
  }

  const snapshot = findStringProperty(record, 'snapshot');
  if (snapshot) {
    return snapshot.split('\n').filter((line) => /\[ref=|@[a-z]\d+/i.test(line)).length;
  }

  return 0;
}

/** 在任意嵌套对象中递归查找指定 key 对应的对象值。 */
function findObjectProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) {
    return record[key] as Record<string, unknown>;
  }

  for (const entry of Object.values(record)) {
    const found = findObjectProperty(entry, key);
    if (found) {
      return found;
    }
  }

  return null;
}

/** 把 chat 的 JSON 结果整理成适合写进日志和报告的单段文本。 */
export function summarizeJsonResult(result: AgentBrowserJsonResult): string {
  if (result.data !== null) {
    return JSON.stringify(result.data);
  }

  return result.raw.trim();
}

/** 为日志生成一段简短的页面状态摘要，避免整份 snapshot 直接灌入日志。 */
export function summarizeSnapshot(snapshot: SnapshotEvidence): string {
  const text = snapshot.text.replace(/\s+/g, ' ').trim();
  const preview = text.length > 160 ? `${text.slice(0, 160)}...` : text;
  return `nodes=${snapshot.nodeCount}; text="${preview}"`;
}

/** 生成本次运行的输出目录，确保时间戳与流程名可以共同区分不同执行。 */
export function resolveOutputDir(flow: string, outputRoot: string | undefined, startedAt: Date): string {
  const root = outputRoot ? path.resolve(outputRoot) : DEFAULT_OUTPUT_ROOT;
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return path.join(root, `${timestamp}-${slugify(flow)}`);
}

/** 把自然语言流程压缩成适合作为目录名的短 slug。 */
function slugify(value: string): string {
  const ascii = value
    .replace(URL_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ascii || 'browser-opt-flow';
}

/** 统一步骤级展示状态，避免人工接管在报告明细里继续显示成普通失败。 */
export function formatBrowserOptStepStatus(step: BrowserOptStepResult): 'PASS' | 'FAIL' | 'HANDOFF' {
  if (step.handoffTriggered) {
    return 'HANDOFF';
  }

  return step.passed ? 'PASS' : 'FAIL';
}

/** 汇总普通失败步骤，供报告和 CLI 在流程结束后集中展示失败原因。 */
export function collectFailedBrowserOptSteps(report: BrowserOptReport): BrowserOptStepResult[] {
  return report.steps.filter((step) => !step.passed && !step.handoffTriggered);
}

/** 把执行报告渲染成 Markdown，方便直接在本地阅读和附带截图证据。 */
export function renderMarkdownReport(report: BrowserOptReport): string {
  const failedSteps = collectFailedBrowserOptSteps(report);
  const lines = [
    `# Browser Opt Report: ${report.status}`,
    '',
    `- URL: ${report.url}`,
    `- Started: ${report.startedAt}`,
    `- Duration: ${report.durationMs}ms`,
    `- Evidence directory: ${report.outputDir}`,
    `- Log file: ${report.logPath}`,
    '',
    '## Evidence Screenshots',
    ...report.screenshots.map((screenshot) => `- ${screenshot}`),
    '',
    '## Failed Steps',
    ...(failedSteps.length > 0
      ? failedSteps.map((step) => `- ${step.index}. ${step.instruction}: ${step.error ?? step.verification ?? '未知原因'}`)
      : ['- n/a']),
    '',
    '## Steps',
  ];

  for (const step of report.steps) {
    lines.push(
      '',
      `### ${formatBrowserOptStepStatus(step)} ${step.index}. ${step.instruction}`,
      `- Attempts: ${step.attempts}`,
      `- Before screenshot: ${step.beforeScreenshotPath}`,
      `- After screenshot: ${step.afterScreenshotPath}`,
      `- Verification: ${step.verification ?? 'n/a'}`,
      `- Error: ${step.error ?? 'n/a'}`,
      '',
      '```text',
      ...step.logs,
      '```',
    );
  }

  lines.push('', '## Detailed Logs', '```text', ...report.logs, '```', '');
  return lines.join('\n');
}

/** 返回 browser-opt 的通用输入模板，供 CLI 报错和首轮使用提示复用。 */
export function browserOptTemplate(): string {
  return `通用测试模板：
你是一个专业的自动化测试 Agent 执行以下测试用例：

网站：{URL}
测试用例：{描述，如 "用户注册流程"}

预期结果：
1. {步骤1}
2. {步骤2}
...

自然语言流程示例：
测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 在搜索框输入 "agent-browser"。
3. 点击搜索按钮。
4. 验证搜索结果页面是否包含至少 3 个结果项。
5. 点击第一个结果，验证跳转正确。`;
}
