/** 验证 browser-test 对真实 XMind 编号、运行阻塞和证据判定的关键约束。 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseXmind, importXmind } from '../../packages/browser-test/src/importer.js';
import { Store, writeJson } from '../../packages/browser-test/src/store.js';
import { addAssertion, addEvidence, prepare, report, review } from '../../packages/browser-test/src/runner.js';
import { decide } from '../../packages/browser-test/src/jev.js';
import type { Project, TestCase } from '../../packages/browser-test/src/types.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function topic(id: string, title: string, children: unknown[] = []): unknown {
  return { id, title, ...(children.length ? { children: { attached: children } } : {}) };
}

function caseTopic(id: string, title: string): unknown {
  return topic(id, title, [
    topic(`${id}-g`, '前置条件：存在专用测试数据'),
    topic(`${id}-w`, '操作步骤：1.进入页面；2.点击状态'),
    topic(`${id}-t`, '预期结果：1.跳转详情页；2.展示审核状态'),
  ]);
}

function xmindBytes(cases: unknown[]): Uint8Array {
  const sheets = [{ id: 'sheet', title: '测试用例', rootTopic: topic('root', '测试用例', [topic('module', '中台-商品管理 > 资质审核', cases)]) }];
  return zipSync({ 'content.json': strToU8(JSON.stringify(sheets)), 'content.xml': strToU8('<warning>不要执行</warning>') });
}

function project(caseId: string): Project {
  return {
    schemaVersion: 1,
    id: 'fengqun',
    description: '测试项目',
    systems: {
      oms: { aliases: ['OMS'], baseUrl: 'https://test-oms.example.com', repository: '../oms', localUrl: null, roles: ['supplier'] },
      ecmiddle: { aliases: ['中台'], baseUrl: 'https://test-middle.example.com', repository: '../middle', localUrl: null, roles: ['auditor'] },
    },
    pages: { audit: { system: 'ecmiddle', route: '/#/audit', source: 'route.ts', apis: [] } },
    bindings: { [caseId]: {
      contexts: [{ system: 'ecmiddle', role: 'auditor', page: 'audit' }],
      testData: { brandId: 'test-brand-1' }, preparation: '查询并核验专用品牌', cleanup: '只读，无需恢复', allowMutations: false, requiresLive: false,
    } },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.AI_GATEWAY_API_KEY;
});

describe('XMind 导入', () => {
  it('识别纯数字和模块字母编号，并保留来源原文', () => {
    const catalog = parseXmind(xmindBytes([caseTopic('a', 'TC‑001 基础场景'), caseTopic('b', 'TC‑Z002 工单场景')]), 'source', 'cases.xmind');
    expect(catalog.cases).toHaveLength(2);
    expect(catalog.cases[1]).toMatchObject({ nodeId: 'b', system: 'ecmiddle', supported: true });
    expect(catalog.cases[0].when).toEqual(['进入页面', '点击状态']);
    expect(catalog.cases[0].then.map(item => item.text)).toEqual(['跳转详情页', '展示审核状态']);
    expect(catalog.cases[0].original.then).toBe('预期结果：1.跳转详情页；2.展示审核状态');
  });

  it('重复导入保持稳定 ID，并报告来源变化', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'cases.xmind');
    const store = new Store(path.join(directory, '.browser-test'));
    fs.writeFileSync(file, xmindBytes([caseTopic('a', 'TC‑001 原标题')]));
    const first = importXmind(store, file, 'source');
    fs.writeFileSync(file, xmindBytes([caseTopic('a', 'TC‑001 新标题')]));
    const second = importXmind(store, file, 'source');
    expect(first.added).toHaveLength(1);
    expect(second.added).toHaveLength(0);
    expect(second.changed).toEqual(first.added);
  });
});

describe('证据与报告', () => {
  function createRun() {
    const directory = temporaryDirectory();
    const store = new Store(path.join(directory, '.browser-test'));
    const catalog = parseXmind(xmindBytes([caseTopic('a', 'TC‑001 验证场景')]), 'source', 'cases.xmind');
    writeJson(store.catalogPath('source'), catalog);
    return { store, run: prepare(store, project(catalog.cases[0].id), 'source', catalog.cases[0].id, 'live') };
  }

  it('未提供前置证据时报告阻塞，不产生空通过', () => {
    const { store, run } = createRun();
    const result = report(store, run);
    expect(result.status).toBe('BLOCKED');
    expect(result.targets.every(target => target.status === 'BLOCKED')).toBe(true);
  });

  it('确定性失败不可被 Jev 待复核结论覆盖', async () => {
    const { store, run } = createRun();
    const evidence = addEvidence(store, run, 'ecmiddle', 'external', '实际页面观测', { text: '仍停留在列表页', url: 'https://test-middle.example.com/#/list' });
    const failed = addAssertion(store, run, 'then-1', [evidence.id], { kind: 'text', expected: '跳转详情页', absent: false });
    expect(failed.status).toBe('FAIL');
    process.env.AI_GATEWAY_API_KEY = 'test-key';
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers: { result: { type: 'noul', noul: 0.99 } } }), { status: 200 }));
    const suggestion = await decide(store, run, { target: 'then-1', evidence: [evidence.id] }, fetcher as typeof fetch);
    expect(suggestion.status).toBe('REVIEW');
    expect(report(store, run).status).toBe('FAIL');
  });

  it('Jev 建议经具体人工复核后才能通过对应目标', async () => {
    const { store, run } = createRun();
    const evidence = addEvidence(store, run, 'ecmiddle', 'external', '实际页面观测', { text: '页面展示审核状态', url: 'https://test-middle.example.com/#/detail' });
    process.env.AI_GATEWAY_API_KEY = 'test-key';
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers: { result: { type: 'noul', noul: 0.93 } } }), { status: 200 }));
    const suggestion = await decide(store, run, { target: 'then-2', evidence: [evidence.id] }, fetcher as typeof fetch);
    expect(suggestion.status).toBe('REVIEW');
    const confirmed = review(store, run, suggestion.id, true, '测试员A', '现场确认审核状态与专用数据一致');
    expect(confirmed.status).toBe('PASS');
    expect(report(store, run).targets.find(target => target.target === 'then-2')?.status).toBe('PASS');
  });
});
