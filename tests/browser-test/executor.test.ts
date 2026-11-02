/** 用内存浏览器与脚本化模型验证执行器的门禁、证据完整性、预算与入口处理，不依赖真实浏览器。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeStep, runFeature,
  type AtomicAction, type BrowserPort, type ExecutionContext, type ModelClient, type Observation, type ObservationCapture, type ObservationTarget, type SemanticStep,
} from '../../packages/browser-test/dist/index.js';

interface Page {
  url: string;
  text: string;
  targets: Array<Pick<ObservationTarget, 'role' | 'name'>>;
  capture: Partial<ObservationCapture>;
}

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

/** 内存浏览器：open 会跳到 pages 中登记的页面，未登记的地址保持原页面，并记录所有动作。 */
function fakePort(initial: Page, pages: Record<string, Page> = {}) {
  let page = initial;
  const performed: AtomicAction[] = [];
  const port: BrowserPort = {
    observe(id) {
      const targets = page.targets.map((item, index) => ({ id: `t${index + 1}`, ref: `e${index + 1}`, visible: true, ...item }));
      return {
        id, capturedAt: '', url: page.url, targets,
        capture: { probeFailed: false, textTruncated: false, targetsTruncated: false, rowsTruncated: false, ...page.capture },
        evidence: [
          { id: `${id}-targets`, kind: 'page', source: 'snapshot-targets', actual: targets },
          { id: `${id}-url`, kind: 'page', source: 'url', actual: page.url },
          { id: `${id}-text`, kind: 'page', source: 'body-text', actual: page.text },
          { id: `${id}-rows`, kind: 'page', source: 'table-rows', actual: [] },
        ],
      } as Observation;
    },
    act(action) {
      performed.push(action);
      if (action.type === 'open' && pages[action.url]) page = pages[action.url];
      return 'ok';
    },
    async handoff() { return true; },
    close() {},
  };
  return { port, performed };
}

/** 脚本化模型：解释请求返回固定意图，决策请求依次返回给定的决定（自动补上最新观测编号）。 */
function scriptedModel(intent: unknown, decisions: Array<Record<string, unknown>> = []): ModelClient {
  const queue = [...decisions];
  return {
    async json(system, input) {
      if (system.includes('解释为测试意图')) return intent;
      const next = queue.shift() ?? { kind: 'blocked', reasonCode: '脚本已耗尽' };
      return { reason: 'test', ...next, observationId: (input as { observation: { observationId: string } }).observation.observationId };
    },
  };
}

function context(port: BrowserPort, model: ModelClient | undefined, limits: Partial<ExecutionContext['limits']> = {}): ExecutionContext {
  return {
    port, model, file: 'a.feature', scenario: 's', shotsDir: join(tmpdir(), 'shots'), trace: () => undefined,
    observations: new Map(), counters: { observation: 0 }, limits: { maxActions: 10, stepMs: 60_000, maxRounds: 20, ...limits },
  };
}

const step = (semantic: SemanticStep['semantic'], text: string): SemanticStep => ({ keyword: semantic, semantic, text, line: 3 });
const intentOf = (kind: string, conditions: unknown[]) => ({ kind, scope: { description: '范围' }, conditions });
const home: Page = { url: 'https://example.com/', text: '首页', targets: [], capture: {} };

describe('入口步骤', () => {
  it('入口地址之外的前提仍需核验：落在登录页时不能直接 PASS', async () => {
    const { port } = fakePort(home, { 'https://example.com/products': { url: 'https://example.com/login', text: '请登录', targets: [], capture: {} } });
    const model = scriptedModel(
      intentOf('login', [{ id: 'c1', expected: '已登录', evidenceKind: 'page', rule: { type: 'text-absent', text: '请登录' } }]),
      [{ kind: 'check', conditionIds: ['c1'] }, { kind: 'blocked', reasonCode: '仍在登录页' }],
    );
    const result = await executeStep(step('Given', '已登录并打开 https://example.com/products 且存在商品'), context(port, model));
    expect(result.execution === 'executed' && result.status).toBe('BLOCKED');
  });

  it('只有入口地址时核验 origin 后 PASS，origin 不符则 BLOCKED', async () => {
    const ok = await executeStep(step('Given', '打开 https://example.com/list'), context(fakePort(home).port, scriptedModel(intentOf('entry', []))));
    expect(ok.execution === 'executed' && ok.status).toBe('PASS');
    const moved = fakePort(home, { 'https://example.com/list': { url: 'https://sso.other.com/', text: '', targets: [], capture: {} } });
    const bad = await executeStep(step('Given', '打开 https://example.com/list'), context(moved.port, scriptedModel(intentOf('entry', []))));
    expect(bad.execution === 'executed' && bad.status).toBe('BLOCKED');
  });

  it('动作预算为 0 或时间预算耗尽时 BLOCKED，且预算为 0 时不打开页面', async () => {
    const noBudget = fakePort(home);
    const first = await executeStep(step('Given', '打开 https://example.com/'), context(noBudget.port, scriptedModel(intentOf('entry', [])), { maxActions: 0 }));
    expect(first.execution === 'executed' && first.status).toBe('BLOCKED');
    expect(noBudget.performed).toEqual([]);
    const slow = await executeStep(step('Given', '打开 https://example.com/'), context(fakePort(home).port, scriptedModel(intentOf('entry', [])), { stepMs: 1 }));
    expect(slow.execution === 'executed' && slow.status).toBe('BLOCKED');
  });

  it('同一场景切换到不同应用入口时 BLOCKED，并且不执行任何步骤', async () => {
    const { port, performed } = fakePort(home);
    const feature = { title: 't', file: 'a.feature', scenarios: [{ title: '跨应用', line: 1, steps: [
      { keyword: 'Given' as const, text: '打开 https://a.example.com/', line: 2 },
      { keyword: 'And' as const, text: '打开 https://b.example.com/', line: 3 },
    ] }] };
    const directory = mkdtempSync(join(tmpdir(), 'bt-run-'));
    directories.push(directory);
    const { result } = await runFeature(feature, { port, model: scriptedModel(intentOf('entry', [])), digest: 'x', runsDirectory: directory, featureArgument: 'a.feature' });
    expect(result.status).toBe('BLOCKED');
    expect(performed).toEqual([]);
  });
});

describe('写操作门禁', () => {
  const deletePage: Page = { url: 'https://example.com/', text: '列表', targets: [{ role: 'button', name: '页面名称' }, { role: 'searchbox', name: '搜索' }], capture: {} };

  it('含写操作语义的步骤不能用 Enter 触发', async () => {
    const { port, performed } = fakePort(deletePage);
    const model = scriptedModel(intentOf('interaction', [{ id: 'c1', expected: '已删除', evidenceKind: 'page' }]), [{ kind: 'act', action: { type: 'press', key: 'Enter' } }]);
    const result = await executeStep({ ...step('When', '删除该商品'), keyword: 'When' }, { ...context(port, model), entryUrl: 'https://example.com/' });
    expect(result.execution === 'executed' && result.status).toBe('BLOCKED');
    expect(performed).toEqual([]);
  });

  it('没有先填写输入框时 Enter 被拒绝，填写搜索框后允许', async () => {
    const rejected = fakePort(deletePage);
    await executeStep(step('When', '查看列表'), { ...context(rejected.port, scriptedModel(intentOf('interaction', [{ id: 'c1', expected: '完成', evidenceKind: 'page' }]), [{ kind: 'act', action: { type: 'press', key: 'Enter' } }])), entryUrl: 'https://example.com/' });
    expect(rejected.performed).toEqual([]);

    const allowed = fakePort(deletePage);
    await executeStep(step('When', '搜索商品'), { ...context(allowed.port, scriptedModel(intentOf('interaction', [{ id: 'c1', expected: '完成', evidenceKind: 'page' }]), [
      { kind: 'act', action: { type: 'fill', targetId: 't2', value: '手机' } },
      { kind: 'act', action: { type: 'press', key: 'Enter' } },
    ])), entryUrl: 'https://example.com/' });
    expect(allowed.performed.map(item => item.type)).toEqual(['fill', 'press']);
  });
});

describe('断言证据', () => {
  const thenStep = step('Then', '页面不显示“错误”');
  const absent = [{ id: 'c1', expected: '不显示错误', evidenceKind: 'page', rule: { type: 'text-absent', text: '错误' } }];
  const check = [{ kind: 'check', conditionIds: ['c1'] }];

  it('data 条件即使附带页面规则也不会 PASS', async () => {
    const model = scriptedModel(intentOf('assertion', [{ id: 'c1', expected: '数据库存在记录', evidenceKind: 'data', rule: { type: 'text-present', text: '首页' } }]), check);
    const result = await executeStep(step('Then', '数据库存在记录'), context(fakePort(home).port, model));
    expect(result.execution === 'executed' && result.status).toBe('BLOCKED');
  });

  it('visual 条件没有视觉证据时 BLOCKED', async () => {
    const model = scriptedModel(intentOf('assertion', [{ id: 'c1', expected: '按钮并存且不遮挡', evidenceKind: 'visual' }]), check);
    const result = await executeStep(step('Then', '按钮并存且不遮挡'), context(fakePort(home).port, model));
    expect(result.execution === 'executed' && result.status).toBe('BLOCKED');
  });

  it('正文采集失败时，“不存在/存在”都不能判定为 PASS/FAIL', async () => {
    const failed: Page = { url: 'https://example.com/', text: '', targets: [{ role: 'button', name: '查询' }], capture: { probeFailed: true } };
    const absentResult = await executeStep(thenStep, context(fakePort(failed).port, scriptedModel(intentOf('assertion', absent), check)));
    expect(absentResult.execution === 'executed' && absentResult.status).toBe('BLOCKED');
    const present = [{ id: 'c1', expected: '显示欢迎', evidenceKind: 'page', rule: { type: 'text-present', text: '欢迎' } }];
    const presentResult = await executeStep(step('Then', '页面显示“欢迎”'), context(fakePort(failed).port, scriptedModel(intentOf('assertion', present), check)));
    expect(presentResult.execution === 'executed' && presentResult.status).toBe('BLOCKED');
  });

  it('正文被截断时不能判定“不存在”，但截断范围内已出现的内容仍可判 FAIL', async () => {
    const truncated: Page = { url: 'https://example.com/', text: '很长的正文', targets: [], capture: { textTruncated: true } };
    const passResult = await executeStep(thenStep, context(fakePort(truncated).port, scriptedModel(intentOf('assertion', absent), check)));
    expect(passResult.execution === 'executed' && passResult.status).toBe('BLOCKED');
    const hit = await executeStep(thenStep, context(fakePort({ ...truncated, text: '出现错误' }).port, scriptedModel(intentOf('assertion', absent), check)));
    expect(hit.execution === 'executed' && hit.status).toBe('FAIL');
  });

  it('完整采集下“不存在”判 PASS', async () => {
    const result = await executeStep(thenStep, context(fakePort(home).port, scriptedModel(intentOf('assertion', absent), check)));
    expect(result.execution === 'executed' && result.status).toBe('PASS');
  });
});

describe('动作追溯', () => {
  it('动作记录保留所引用目标的名称与 ref', async () => {
    const page: Page = { url: 'https://example.com/', text: '列表', targets: [{ role: 'button', name: '查询' }], capture: {} };
    const model = scriptedModel(intentOf('interaction', [{ id: 'c1', expected: '完成', evidenceKind: 'page' }]), [{ kind: 'act', action: { type: 'click', targetId: 't1' } }]);
    const result = await executeStep(step('When', '点击查询'), { ...context(fakePort(page).port, model), entryUrl: 'https://example.com/' });
    expect(result.execution === 'executed' && result.actions[0].target).toEqual({ id: 't1', role: 'button', name: '查询', ref: 'e1' });
  });
});
