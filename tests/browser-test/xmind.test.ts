/** 验证 XMind 导入保留原文与来源，并在独立目录通过 CLI 完成无配置验收。 */
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { importXMind } from '../../packages/browser-test/dist/index.js';

const directories: string[] = [];
const cli = resolve('packages/browser-test/dist/cli/browser-test.js');
const topic = (id: string, title: string, attached?: unknown[]) => ({ id, title, ...(attached ? { children: { attached } } : {}) });
const originalText = '  已登录应用 A\n打开 https://example.com/#/list  ';
const caseNode = {
  ...topic('case-1', '列表展示', [
    topic('pre', '前置条件：', [topic('pre-1', originalText)]),
    topic('steps', '操作步骤', [topic('step-1', '查看列表')]),
    topic('expected', '预期结果', [topic('expect-1', '展示“名称”'), topic('expect-2', '存在【新增】按钮')]),
  ]),
  notes: { plain: { content: '备注\n不改写' } }, labels: ['TC-001'],
};
const content = [{ id: 'sheet-1', title: '测试用例', rootTopic: topic('root', '商品管理', [caseNode]) }];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function archive(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-test-xmind-'));
  directories.push(dir);
  const file = join(dir, '中文 用例.xmind');
  writeFileSync(file, zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)]))));
  return file;
}

function fixture(value: unknown = content): string {
  return archive({ 'content.json': JSON.stringify(value) });
}

describe('XMind 无配置导入', () => {
  it('保留原文、层级、节点 ID、属性和来源，不编造业务编号', async () => {
    const file = fixture();
    const result = await importXMind(file);
    expect(result.cases).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(result.cases[0]).toMatchObject({
      title: '列表展示', modulePath: ['商品管理'],
      source: { file, sheetId: 'sheet-1', nodeId: 'case-1' },
      node: { raw: caseNode, path: ['商品管理', '列表展示'] },
    });
    expect(result.cases[0].preconditions[0].children.attached[0].title).toBe(originalText);
    expect(result.cases[0].expectedResults[0].children.attached.map(node => node.title)).toEqual(['展示“名称”', '存在【新增】按钮']);
    expect(result.cases[0]).not.toHaveProperty('caseId');
  });

  it('遍历多画布与自由主题，相同标题按来源区分', async () => {
    const second = { id: 'sheet-2', title: '其他画布', rootTopic: {
      id: 'root', title: '其他模块', children: { detached: [caseNode] },
    } };
    const result = await importXMind(fixture([...content, second]));
    expect(result.cases.map(item => item.source.sheetId)).toEqual(['sheet-1', 'sheet-2']);
    expect(result.sheets[1].root.children.detached[0].raw).toEqual(caseNode);
  });

  it('无法识别的结构保留原文并提示，不把普通叶节点当作用例', async () => {
    const raw = topic('root', '待确认', [topic('leaf', '随意结构')]);
    const result = await importXMind(fixture([{ id: 'sheet', title: '', rootTopic: raw }]));
    expect(result.cases).toEqual([]);
    expect(result.sheets[0].root.raw).toEqual(raw);
    expect(result.warnings[0].source.nodeId).toBe('leaf');
  });

  it('不完整用例仍可导入并提示缺少的分组', async () => {
    const root = topic('case', '缺少预期', [topic('steps', '操作', [topic('step', '查看')])]);
    const result = await importXMind(fixture([{ id: 'sheet', title: '', rootTopic: root }]));
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].expectedResults).toEqual([]);
    expect(result.warnings[0].message).toContain('缺少操作或预期');
  });

  it.each([
    [{ 'content.xml': '<xmap-content />' }, '旧版 content.xml'],
    [{ 'other.json': '{}' }, '缺少 content.json'],
    [{ 'content.json': '{' }, '无法导入 XMind'],
    [{ 'content.json': '{}' }, '非空画布数组'],
    [{ 'content.json': '[]' }, '非空画布数组'],
  ])('拒绝不支持或损坏的文档 %j', async (entries, message) => {
    await expect(importXMind(archive(entries as Record<string, string>))).rejects.toThrow(message);
  });

  it('拒绝缺失节点 ID、重复 ID 和非法子节点', async () => {
    for (const root of [
      { title: '无 ID' },
      topic('same', '根', [topic('same', '重复')]),
      { id: 'root', title: '根', children: { attached: {} } },
    ]) {
      await expect(importXMind(fixture([{ id: 'sheet', title: '', rootTopic: root }]))).rejects.toThrow('无法导入 XMind');
    }
  });

  it('拒绝非 ZIP 与不存在的文件', async () => {
    const file = fixture();
    writeFileSync(file, '不是压缩包');
    await expect(importXMind(file)).rejects.toThrow('无法导入 XMind');
    await expect(importXMind(`${file}.missing`)).rejects.toThrow('无法导入 XMind');
  });

  it('从仅含 XMind 的目录输出列表和 JSON，不产生配置或其他文件', () => {
    const file = fixture();
    const cwd = directories.at(-1)!;
    const args = [cli, 'xmind', 'list', '--xmind', file];
    const listed = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('识别 1 条用例');
    expect(listed.stdout).toContain('#case-1');
    const json = spawnSync(process.execPath, [...args, '--json'], { cwd, encoding: 'utf8' });
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).cases[0].node.raw).toEqual(caseNode);
    expect(readdirSync(cwd)).toEqual(['中文 用例.xmind']);
  });

  it.each([['run'], ['xmind', 'list'], ['xmind', 'list', '--unknown'], ['xmind', 'list', '--xmind', '/missing.xmind']])('CLI 对无效输入返回 2：%j', (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).not.toBe('');
  });
});
