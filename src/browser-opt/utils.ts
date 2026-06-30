/**
 * browser-opt 工具函数文件，集中承载自然语言解析、snapshot 文本处理、
 * 节点匹配、验证判断和报告渲染等无状态逻辑，让 runner 只负责执行编排。
 */
import * as path from 'node:path';
import type { AgentBrowserJsonResult } from '../core/agent.js';
import type {
  BrowserOptReport,
  DeterministicAction,
  SnapshotEvidence,
  SnapshotNode,
} from './type.js';

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'artifacts', 'browser-opt');
const URL_RE = /https?:\/\/[^\s。，、，)）]+/i;
const QUOTED_VALUE_RE = /["“]([^"”]+)["”]/;

/** 从自然语言描述中提取第一个 URL，作为 browser-opt 的起始页面。 */
export function extractBrowserOptUrl(text: string): string | null {
  const match = text.match(URL_RE);
  return match ? match[0] : null;
}

/** 把自然语言流程拆成顺序步骤，优先识别编号目标，无法识别时回退为单步骤。 */
export function splitBrowserOptSteps(text: string): string[] {
  const lines = text
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

  const compact = lines
    .filter((line) => !/^目标[:：]?$/.test(line))
    .join('\n')
    .trim();
  return compact ? [compact] : [];
}

/** 从自然语言步骤中提炼结构化动作，供确定性执行层消费。 */
export function parseDeterministicAction(instruction: string): DeterministicAction | null {
  const normalized = instruction.replace(/^\d+[\.)、]\s*/, '').trim();
  const url = normalized.match(URL_RE)?.[0];
  if (url && /访问|打开|open|goto|navigate/i.test(normalized)) {
    return { type: 'open', url };
  }

  const quoted = normalized.match(QUOTED_VALUE_RE)?.[1]?.trim();
  if (quoted && /输入|填写|填入|type|fill/i.test(normalized)) {
    return {
      type: 'fill',
      field: parseFieldName(normalized) ?? '文本',
      value: quoted,
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

/** 在当前快照中优先查找文本框，再按字段名做最佳匹配。 */
export function findTextboxRef(snapshot: SnapshotEvidence, field: string): string | null {
  const nodes = getSnapshotNodes(snapshot).filter((node) => isTextboxRole(node.role));
  return findBestNodeRef(nodes, field) ?? nodes[0]?.ref ?? null;
}

/** 在当前快照中查找可点击元素，并按目标文案做最佳匹配。 */
export function findClickableRef(snapshot: SnapshotEvidence, target: string): string | null {
  const nodes = getSnapshotNodes(snapshot).filter((node) => !isTextboxRole(node.role));
  return findBestNodeRef(nodes, target) ?? nodes[0]?.ref ?? null;
}

/** 在候选节点集合里做一次精确优先、字符兜底的模糊匹配。 */
function findBestNodeRef(nodes: SnapshotNode[], target: string): string | null {
  const normalizedTarget = normalizeMatchText(target);
  if (!normalizedTarget) {
    return null;
  }

  const exact = nodes.find((node) => {
    const label = normalizeMatchText(node.label);
    return label.includes(normalizedTarget) || normalizedTarget.includes(label);
  });
  if (exact) {
    return exact.ref;
  }

  const targetChars = [...normalizedTarget];
  const partial = nodes.find((node) => {
    const label = normalizeMatchText(node.label);
    return targetChars.length > 1 && targetChars.every((char) => label.includes(char));
  });

  return partial?.ref ?? null;
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
  const match = line.match(/(textbox|button|link|generic|input)[^\n"]*"([^"]*)"[^\n]*\[ref=([^\]]+)\]/i);
  if (match?.[1] && match[3]) {
    return {
      role: match[1],
      label: match[2] ?? '',
      ref: match[3],
    };
  }

  return null;
}

/** 以 ref 去重节点，避免 JSON refs 与文本回退结果重复。 */
function mergeSnapshotNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.ref)) {
      return false;
    }
    seen.add(node.ref);
    return true;
  });
}

/** 判断某个角色是否可以视为文本输入控件。 */
function isTextboxRole(role: string): boolean {
  return /textbox|input|searchbox|combobox|textarea/i.test(role);
}

/** 归一化待匹配文本，减少空格和中英文标点对匹配结果的干扰。 */
function normalizeMatchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[：:，,。；"'“”]/g, '').trim();
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
  return /验证|断言|检查|确认|verify|assert|expect|should|包含|存在|至少\s*\d+/i.test(instruction);
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
  const quoted = instruction.match(/["“]([^"”]+)["”]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const contains = instruction.match(/(?:包含|看到|显示|contains?|include[s]?)\s*([^。；\n]+)/i);
  if (contains?.[1]) {
    return contains[1].replace(/至少\s*\d+.*$/, '').trim();
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

/** 把执行报告渲染成 Markdown，方便直接在本地阅读和附带截图证据。 */
export function renderMarkdownReport(report: BrowserOptReport): string {
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
    '## Steps',
  ];

  for (const step of report.steps) {
    lines.push(
      '',
      `### ${step.passed ? 'PASS' : 'FAIL'} ${step.index}. ${step.instruction}`,
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
