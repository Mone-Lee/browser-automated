/**
 * browser-opt 工具函数文件，集中承载自然语言解析、snapshot 文本处理、
 * 节点匹配、验证判断和报告渲染等无状态逻辑，让 runner 只负责执行编排。
 */
import * as path from 'node:path';
import type { AgentBrowserJsonResult } from '#browser-core/agent';
import type {
  BrowserOptReport,
  BrowserOptStepResult,
  DeterministicAction,
  SnapshotEvidence,
  SnapshotNode,
} from './type.js';

interface QuotedSegment {
  value: string;
  index: number;
}

interface ClickTarget {
  target: string;
  field?: string | null;
}

interface SnapshotTextLine {
  index: number;
  indent: number;
  node: SnapshotNode;
}

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), '.browser-opt', 'artifacts');
const URL_RE = /https?:\/\/[^\s。，、，)）"'‘’“”]+/i;
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
  const actionText = maskQuotedSegments(normalized);
  const url = normalized.match(URL_RE)?.[0];
  if (url && /访问|打开|open|goto|navigate/i.test(actionText)) {
    return { type: 'open', url };
  }

  if (isInspectInstruction(actionText)) {
    return { type: 'inspect' };
  }

  if (/handoff|人工|手动|操作人员/.test(actionText) && /上传|选择.*(?:图片|文件|封面)/.test(actionText)) {
    return { type: 'handoff', message: normalized };
  }

  if (url && isUploadInstruction(actionText)) {
    return {
      type: 'upload',
      field: parseUploadFieldName(normalized) ?? '文件',
      source: url,
    };
  }

  const tableRowCheckboxCount = parseTableRowCheckboxCount(normalized);
  if (tableRowCheckboxCount !== null) {
    return { type: 'check-table-rows', count: tableRowCheckboxCount };
  }

  const quoted = extractQuotedSegments(normalized);
  const fillVerb = actionText.match(/输入|填写|填入|type|fill/i);
  if (fillVerb && quoted.length > 0) {
    const valueSegment = quoted[quoted.length - 1];
    const fieldSegment = quoted.find((segment) => segment.index < (fillVerb.index ?? 0));
    return {
      type: 'fill',
      field: fieldSegment?.value ?? parseFieldName(normalized) ?? '文本',
      value: valueSegment?.value ?? '',
    };
  }

  if (/点击|单击|click|tap|press/i.test(actionText)) {
    const clickTarget = parseClickTarget(normalized);
    const target = clickTarget?.target
      ?? normalized
        .replace(/点击|单击|click|tap|press/gi, '')
        .replace(/[。；，,]/g, '')
        .trim();
    const action: Extract<DeterministicAction, { type: 'click' }> = { type: 'click', target: target || '按钮' };
    if (clickTarget?.field) {
      action.field = clickTarget.field;
    }
    return action;
  }

  const selectableTarget = SELECTABLE_VERB_RE.test(actionText) ? parseSelectableTarget(normalized) : null;
  if (selectableTarget) {
    return {
      type: 'select-option',
      field: selectableTarget.field,
      option: selectableTarget.option,
      ...(selectableTarget.endOption ? { endOption: selectableTarget.endOption } : {}),
    };
  }

  const expectedText = parseExpectedText(normalized);
  if (expectedText && isVerificationStep(normalized)) {
    return { type: 'assert-text', text: expectedText };
  }

  return null;
}

/** 识别表格或列表中按显示顺序勾选前 N 条数据的集合动作。 */
function parseTableRowCheckboxCount(instruction: string): number | null {
  if (!/(?:表格|列表|数据行)/.test(instruction) || !/(?:勾选|选中|勾上|check)/i.test(instruction)) {
    return null;
  }

  const count = instruction.match(/前\s*(\d+)\s*(?:条|个|行)/)?.[1];
  if (!count) {
    return null;
  }

  const parsed = Number.parseInt(count, 10);
  return parsed > 0 ? parsed : null;
}

/** 判断步骤是否会触发导出、删除或提交等需要前置条件保护的高影响操作。 */
export function isHighImpactInstruction(instruction: string): boolean {
  const action = parseDeterministicAction(instruction);
  return action?.type === 'click' && /导出|删除|提交|发布|保存|确认|支付|退款|上架|下架/.test(instruction);
}

/** 识别明确要求打开当前页面开发者工具的中英文表达，避免把普通“检查页面”误判为 inspect。 */
function isInspectInstruction(instruction: string): boolean {
  if (/^inspect(?:\s+(?:the\s+)?(?:current\s+)?page)?[。.!！]?$/i.test(instruction)) {
    return true;
  }

  return /开发者工具|开发人员工具|(?:chrome\s*)?devtools/i.test(instruction)
    && /打开|启动|调起|唤起|显示|open|launch|start/i.test(instruction);
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

/** 动作分类时遮蔽引号内的字段和值，避免字段名中的“填写、选择、点击”等词被当成真实动词。 */
function maskQuotedSegments(instruction: string): string {
  return instruction.replace(/["“‘'][^"”’']+["”’']/g, (segment) => ' '.repeat(segment.length));
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

/** 从“字段选择选项”类语句中同时提取字段名和选项，并保留日期范围的结束值。 */
function parseSelectableTarget(instruction: string): { field: string | null; option: string; endOption?: string } | null {
  const verb = maskQuotedSegments(instruction).match(SELECTABLE_VERB_RE);
  if (!verb) {
    return parseLooseSelectableTarget(instruction);
  }

  const quoted = extractQuotedSegments(instruction);
  if (quoted.length >= 2) {
    const quotedField = quoted[0].index < (verb.index ?? 0);
    const option = quoted[quotedField ? 1 : 0];
    const rangeEnd = quoted[quotedField ? 2 : 1];
    const rangeSeparator = rangeEnd
      ? instruction.slice(option.index + option.value.length + 2, rangeEnd.index)
      : '';
    return {
      field: quotedField ? quoted[0].value : parseSelectableFieldName(instruction, option) ?? null,
      option: option.value,
      ...(rangeEnd && /(?:到|至|~|～|-)/.test(rangeSeparator) ? { endOption: rangeEnd.value } : {}),
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

/** 从点击语句中提取真实点击目标，多引号场景优先识别“字段下方的入口”这类入口文案。 */
function parseClickTarget(instruction: string): ClickTarget | null {
  const quoted = extractQuotedSegments(instruction);
  if (quoted.length === 0) {
    return null;
  }

  if (quoted.length === 1) {
    return { target: quoted[0].value };
  }

  const lastQuoted = quoted[quoted.length - 1];
  if (!lastQuoted) {
    return quoted[0] ? { target: quoted[0].value } : null;
  }

  const lastQuotedEnd = lastQuoted.index + lastQuoted.value.length + 2;
  const beforeLastQuoted = instruction.slice(0, lastQuoted.index);
  const afterLastQuoted = instruction.slice(lastQuotedEnd);
  if (
    /(?:下方|上方|左侧|右侧|旁边|附近|内部|里面|里|中|内|显示|文案|占位|字段|区域)的?$/.test(beforeLastQuoted)
    || /^(?:入口|按钮|控件|区域|输入区域|输入框|下拉框|下拉入口|面板|弹窗|选项)/.test(afterLastQuoted)
  ) {
    return { target: lastQuoted.value, field: quoted[0]?.value ?? null };
  }

  return quoted[0] ? { target: quoted[0].value } : null;
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

/** 读取指定输入框在 snapshot 中暴露的当前值；无法定位或快照未暴露值时返回 null。 */
export function readTextboxValue(snapshot: SnapshotEvidence, field: string): string | null {
  const ref = findTextboxRef(snapshot, field);
  if (!ref) {
    return null;
  }

  const line = snapshot.text
    .split('\n')
    .find((candidate) => candidate.includes(`ref=${ref}`) && /^\s*-\s*(?:textbox|searchbox|combobox|input|textarea)\b/i.test(candidate));
  if (!line) {
    return null;
  }

  const metadataEnd = line.lastIndexOf(']');
  if (metadataEnd < 0) {
    return null;
  }

  const separator = line.slice(metadataEnd + 1).match(/^\s*:\s?(.*)$/);
  return separator ? separator[1] ?? '' : null;
}

/** 在当前快照中查找可点击元素，并按目标文案做最佳匹配。 */
export function findClickableRef(snapshot: SnapshotEvidence, target: string, field?: string | null): string | null {
  const nodes = getSnapshotNodes(snapshot).filter((node) => !node.disabled && !isTextboxRole(node.role) && isClickableNode(node));
  if (field) {
    return findFollowingClickableRef(snapshot.text, field, target) ?? findUniqueNodeRef(nodes, target);
  }

  return findBestNodeRef(nodes, target) ?? findFollowingClickableRef(snapshot.text, target);
}

/** 查找单选或多选选项，优先点击 label，并在已选中时短路为完成。 */
export function findSelectableOption(
  snapshot: SnapshotEvidence,
  field: string | null,
  option: string,
): { ref: string | null; alreadySelected: boolean; role: string | null } {
  const hasExpandableField = Boolean(field && findScopedSelectableFieldRef(snapshot.text, field));
  const scoped = findScopedOptionLabel(snapshot.text, field, option);
  if (scoped && (!hasExpandableField || /option/i.test(scoped.role ?? ''))) {
    return scoped;
  }

  const nodes = getSnapshotNodes(snapshot);
  const switchControl = hasExpandableField ? null : findScopedSwitchControl(snapshot.text, field, nodes, option);
  if (switchControl) {
    return switchControl;
  }

  const dropdownOption = findBestNode(nodes.filter((node) => /option/i.test(node.role)), option);
  if (dropdownOption?.checked) {
    return { ref: dropdownOption.ref, alreadySelected: true, role: dropdownOption.role };
  }
  if (dropdownOption && !dropdownOption.disabled) {
    return { ref: dropdownOption.ref, alreadySelected: false, role: dropdownOption.role };
  }

  if (hasExpandableField) {
    return { ref: null, alreadySelected: false, role: null };
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

/** 只有目标文案在可点击节点中唯一出现时才兜底，避免多个“请选择”时误点第一个。 */
function findUniqueNodeRef(nodes: SnapshotNode[], target: string): string | null {
  const matches = findMatchingNodes(nodes, target);
  return matches.length === 1 ? matches[0]?.ref ?? null : null;
}

/** 在候选节点集合里返回最佳匹配节点，供需要读取选中状态的场景复用。 */
function findBestNode(nodes: SnapshotNode[], target: string): SnapshotNode | null {
  return findMatchingNodes(nodes, target)[0] ?? null;
}

/** 返回所有匹配目标文案的候选节点，保持 snapshot 原始顺序。 */
function findMatchingNodes(nodes: SnapshotNode[], target: string): SnapshotNode[] {
  const normalizedTarget = normalizeMatchText(target);
  if (!normalizedTarget) {
    return [];
  }

  const exact = nodes.filter((node) => {
    const label = normalizeMatchText(node.label);
    if (!label) {
      return false;
    }
    return label.includes(normalizedTarget) || normalizedTarget.includes(label);
  });
  if (exact.length > 0) {
    return exact.sort((a, b) => rankNodeMatch(a, normalizedTarget) - rankNodeMatch(b, normalizedTarget));
  }

  const targetChars = [...normalizedTarget];
  return nodes.filter((node) => {
    const label = normalizeMatchText(node.label);
    if (!label) {
      return false;
    }
    return targetChars.length > 1 && targetChars.every((char) => label.includes(char));
  }).sort((a, b) => rankNodeMatch(a, normalizedTarget) - rankNodeMatch(b, normalizedTarget));
}

/** 匹配多个节点时优先选更具体的短标签，避免点到包含整段弹窗文本的大容器。 */
function rankNodeMatch(node: SnapshotNode, normalizedTarget: string): number {
  const label = normalizeMatchText(node.label);
  const lengthPenalty = Math.max(0, label.length - normalizedTarget.length);
  const exactBonus = label === normalizedTarget ? -1000 : 0;
  return exactBonus + lengthPenalty;
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
      clickable: /(?:^|,\s*)clickable(?:,|$)/.test(match[3]) || /\sclickable(?:\s|$|\[)/.test(line),
      checked: /(?:^|,\s*)checked=true(?:,|$)/.test(match[3]),
      disabled: /(?:^|,\s*)disabled(?:,|$)/.test(match[3]),
    };
  }

  return null;
}

/** 文案本身不可点时，在其后续兄弟或子节点中寻找第一个可点击元素。 */
function findFollowingClickableRef(text: string, anchorTarget: string, followingTarget?: string): string | null {
  const normalizedAnchorTarget = normalizeMatchText(anchorTarget);
  if (!normalizedAnchorTarget) {
    return null;
  }

  const lines = parseSnapshotTextLines(text);
  for (const line of lines) {
    const label = normalizeMatchText(line.node.label);
    if (!label || !label.includes(normalizedAnchorTarget)) {
      continue;
    }

    // 目标文案已经属于交互节点时，不再把后续无关控件当作它的点击入口。
    if (isClickableNode(line.node)) {
      continue;
    }

    const following = findFirstFollowingClickableLine(lines, line, followingTarget);
    if (following) {
      return following.node.ref;
    }
  }

  return null;
}

/** 解析带缩进的 snapshot 行，供局部邻近匹配保持在同一结构块内。 */
function parseSnapshotTextLines(text: string): SnapshotTextLine[] {
  return text
    .split('\n')
    .map((line, index) => {
      const node = parseSnapshotLine(line);
      if (!node) {
        return null;
      }

      return {
        index,
        indent: line.match(/^\s*/)?.[0].length ?? 0,
        node,
      };
    })
    .filter((line): line is SnapshotTextLine => Boolean(line));
}

/** 从目标文案之后查找子级或紧邻同级 clickable，越过目标结构块后停止。 */
function findFirstFollowingClickableLine(
  lines: SnapshotTextLine[],
  anchor: SnapshotTextLine,
  followingTarget?: string,
): SnapshotTextLine | null {
  const normalizedFollowingTarget = normalizeMatchText(followingTarget ?? '');
  for (const line of lines) {
    if (line.index <= anchor.index) {
      continue;
    }

    if (line.indent < anchor.indent) {
      break;
    }

    if (!line.node.disabled && isClickableNode(line.node) && !isTextboxRole(line.node.role) && matchesOptionalTarget(line.node, normalizedFollowingTarget)) {
      return line;
    }

    if (line.indent === anchor.indent) {
      const descendant = findFirstDescendantClickableLine(lines, line, normalizedFollowingTarget);
      if (descendant) {
        return descendant;
      }
      break;
    }
  }

  return null;
}

/** 同级容器本身不可点时，继续在这个兄弟节点的子树里寻找目标控件。 */
function findFirstDescendantClickableLine(
  lines: SnapshotTextLine[],
  root: SnapshotTextLine,
  normalizedFollowingTarget: string,
): SnapshotTextLine | null {
  for (const line of lines) {
    if (line.index <= root.index) {
      continue;
    }

    if (line.indent <= root.indent) {
      break;
    }

    if (!line.node.disabled && isClickableNode(line.node) && !isTextboxRole(line.node.role) && matchesOptionalTarget(line.node, normalizedFollowingTarget)) {
      return line;
    }
  }

  return null;
}

/** 带上下文点击时，需要后续可点击节点匹配入口文案；未指定入口时接受第一个。 */
function matchesOptionalTarget(node: SnapshotNode, normalizedTarget: string): boolean {
  if (!normalizedTarget) {
    return true;
  }

  const label = normalizeMatchText(node.label);
  return Boolean(label) && (label.includes(normalizedTarget) || normalizedTarget.includes(label));
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
      clickable: current.clickable ?? node.clickable,
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

/** 判断节点是否可直接点击，refs 缺少 clickable 时按常见交互角色保守推断。 */
function isClickableNode(node: SnapshotNode): boolean {
  return Boolean(node.clickable) || /button|link|menuitem|tab|option|radio|checkbox|switch|labeltext|label/i.test(node.role);
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

/** 在字段文案后面的子级或紧邻同级里寻找下拉控件，适配水平和上下表单布局。 */
function findScopedSelectableFieldRef(text: string, field: string): string | null {
  const lines = text.split('\n');
  const normalizedField = normalizeMatchText(field);
  const fieldCandidate = lines
    .map((line, index) => ({ index, parsed: parseSnapshotLine(line), indent: line.match(/^\s*/)?.[0].length ?? 0 }))
    .filter((item): item is { index: number; parsed: SnapshotNode; indent: number } => {
      const label = normalizeMatchText(item.parsed?.label ?? '');
      return Boolean(label) && label.includes(normalizedField);
    })
    .sort((a, b) => rankNodeMatch(a.parsed, normalizedField) - rankNodeMatch(b.parsed, normalizedField))[0];
  if (!fieldCandidate) {
    return null;
  }

  if (isExpandableSelectRole(fieldCandidate.parsed.role) && !fieldCandidate.parsed.disabled) {
    return fieldCandidate.parsed.ref;
  }

  for (let index = fieldCandidate.index + 1; index < Math.min(lines.length, fieldCandidate.index + 6); index += 1) {
    const indent = lines[index]?.match(/^\s*/)?.[0].length ?? 0;
    const parsed = parseSnapshotLine(lines[index]);
    if (parsed && indent <= fieldCandidate.indent && !isExpandableSelectRole(parsed.role)) {
      const descendant = findFirstDescendantSelectableRef(lines, index);
      if (descendant) {
        return descendant;
      }
      break;
    }
    if (parsed && isExpandableSelectRole(parsed.role) && !parsed.disabled) {
      return parsed.ref;
    }
  }

  return null;
}

/** 同级容器本身不是下拉时，在该兄弟节点的子树里继续寻找下拉控件。 */
function findFirstDescendantSelectableRef(lines: string[], rootIndex: number): string | null {
  const rootIndent = lines[rootIndex]?.match(/^\s*/)?.[0].length ?? 0;
  for (let index = rootIndex + 1; index < lines.length; index += 1) {
    const indent = lines[index]?.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= rootIndent) {
      break;
    }

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
  const normalized = instruction.replace(
    /^\s*(?:仅当|如果|若)?(?:上述|前置|上一步)?验证通过后[，,]?\s*/,
    '',
  );
  return /验证|断言|检查|verify|assert|expect|should|包含|存在|至少\s*\d+/i.test(normalized);
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
  const quoted = extractQuotedSegments(instruction);
  const lastQuoted = quoted[quoted.length - 1];
  if (lastQuoted) {
    return lastQuoted.value;
  }

  const contains = instruction.match(/(?:包含|看到|显示|contains?|include[s]?)\s*([^。；\n]+)/i);
  if (contains?.[1]) {
    return contains[1]
      .replace(/至少\s*\d+.*$/, '')
      .replace(/^["“‘']|["”’']$/g, '')
      .trim();
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
