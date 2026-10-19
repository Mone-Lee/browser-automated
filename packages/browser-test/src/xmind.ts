/** 读取现代 XMind 压缩包，按字段标记或嵌套布局提取用例，保留原文与识别依据。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { XMindCase, XMindImport, XMindNode } from './types.js';

type Section = 'preconditions' | 'steps' | 'expectedResults';

const sectionNames: Record<string, Section> = {
  '前置条件': 'preconditions', '前提条件': 'preconditions',
  '操作': 'steps', '步骤': 'steps', '操作步骤': 'steps', '测试步骤': 'steps',
  '预期': 'expectedResults', '预期结果': 'expectedResults', '预期输出': 'expectedResults',
};

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${location} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, location: string): string {
  if (typeof value !== 'string') throw new Error(`${location} 必须是字符串`);
  return value;
}

/** 支持独立分组名以及冒号、制表符分隔的同行内容，输出始终保留完整原文。 */
function section(node: XMindNode): Section | undefined {
  const name = node.title.trim().split(/[：:\t]/, 1)[0].trim();
  return Object.hasOwn(sectionNames, name) ? sectionNames[name] : undefined;
}

/** 递归保留各类子主题、原始属性和路径；格式错误携带位置，避免静默丢弃内容。 */
function parseNode(value: unknown, file: string, sheetId: string, path: string[], ids: Set<string>, depth = 0): XMindNode {
  if (depth > 256) throw new Error('XMind 主题层级超过 256 层');
  const raw = object(value, `画布 ${sheetId} 的主题`);
  const id = string(raw.id, '主题 id');
  if (!id || ids.has(id)) throw new Error(`画布 ${sheetId} 的主题 ID 为空或重复：${id}`);
  ids.add(id);
  const title = string(raw.title, `主题 ${id} 的 title`);
  const node: XMindNode = {
    id, title, path: [...path, title], source: { file, sheetId, nodeId: id }, children: {}, raw,
  };
  if (raw.children !== undefined) {
    for (const [kind, children] of Object.entries(object(raw.children, `主题 ${id} 的 children`))) {
      if (!Array.isArray(children)) throw new Error(`主题 ${id} 的 children.${kind} 必须是数组`);
      Object.defineProperty(node.children, kind, {
        value: children.map(child => parseNode(child, file, sheetId, node.path, ids, depth + 1)),
        enumerable: true,
      });
    }
  }
  return node;
}

/** 优先识别明确字段；前置条件及操作子树共同存在时识别嵌套布局，不提取或生成业务用例编号。 */
function collectCases(node: XMindNode, result: XMindImport): void {
  const attached = node.children.attached ?? [];
  const sections: Pick<XMindCase, Section> = { preconditions: [], steps: [], expectedResults: [] };
  for (const child of attached) {
    const key = section(child);
    if (key) sections[key].push(child);
  }
  let structure: XMindCase['structure'] = 'sections';
  if (!sections.steps.length && !sections.expectedResults.length && sections.preconditions.length) {
    const steps = attached.filter(child => !section(child));
    if (steps.some(step => step.children.attached?.length)) {
      structure = 'nested';
      sections.steps = steps;
      sections.expectedResults = steps.flatMap(step => step.children.attached ?? []);
      if (steps.some(step => !step.children.attached?.length)) {
        result.warnings.push({ source: node.source, message: '嵌套用例中部分操作没有直属预期节点，原文已保留，需人工确认。' });
      }
    }
  }
  if (sections.steps.length || sections.expectedResults.length) {
    result.cases.push({ title: node.title, source: node.source, modulePath: node.path.slice(0, -1), node, structure, ...sections });
    if (!sections.steps.length || !sections.expectedResults.length) {
      result.warnings.push({ source: node.source, message: '用例缺少操作或预期分组，原文已保留，需人工确认。' });
    }
    for (const [kind, children] of Object.entries(node.children)) {
      if (kind !== 'attached') for (const child of children) collectCases(child, result);
    }
    return;
  }
  const children = Object.values(node.children).flat();
  if (!children.length) {
    result.warnings.push({ source: node.source, message: '无法明确识别用例结构，节点已保留在主题树中，需人工确认。' });
  }
  for (const child of children) collectCases(child, result);
}

/** 只读取指定文件的 content.json，不解压到磁盘，也不访问业务仓库或配置文件。 */
export async function importXMind(filename: string): Promise<XMindImport> {
  const file = resolve(filename);
  try {
    const archive = await readFile(file);
    let legacy = false;
    const entries = unzipSync(archive, { filter(entry) {
      if (entry.name === 'content.xml') legacy = true;
      if (entry.name !== 'content.json') return false;
      if (entry.originalSize > 32 * 1024 * 1024) throw new Error('content.json 超过 32 MiB 限制');
      return true;
    } });
    if (!entries['content.json']) {
      throw new Error(legacy ? '暂不支持旧版 content.xml，请用新版 XMind 另存后导入' : '压缩包缺少 content.json');
    }
    const content: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entries['content.json']));
    if (!Array.isArray(content) || !content.length) throw new Error('content.json 必须是非空画布数组');
    const result: XMindImport = { file, sheets: [], cases: [], warnings: [] };
    const sheetIds = new Set<string>();
    for (const value of content) {
      const sheet = object(value, '画布');
      const id = string(sheet.id, '画布 id');
      if (!id || sheetIds.has(id)) throw new Error(`画布 ID 为空或重复：${id}`);
      sheetIds.add(id);
      const title = string(sheet.title, `画布 ${id} 的 title`);
      const root = parseNode(sheet.rootTopic, file, id, [], new Set());
      result.sheets.push({ id, title, root });
      collectCases(root, result);
    }
    return result;
  } catch (error) {
    throw new Error(`无法导入 XMind ${file}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
