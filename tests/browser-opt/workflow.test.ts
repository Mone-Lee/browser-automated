/**
 * 覆盖 browser-opt Workflow 的项目级保存、格式容错与中文匹配决策。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadBrowserOptWorkflows,
  matchBrowserOptWorkflows,
  normalizeBrowserOptWorkflowQuery,
  renderBrowserOptWorkflowFlow,
  resolveBrowserOptWorkflowDir,
  safeWorkflowId,
  saveBrowserOptWorkflow,
} from '../../packages/browser-opt/dist/browser-opt/workflow/index.js';
import type { BrowserOptWorkflow } from '../../packages/browser-opt/dist/browser-opt/workflow/type.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-workflow-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeSteps(text = '验证页面包含“Example”。'): string[] {
  return [text];
}

function workflow(name: string): BrowserOptWorkflow {
  const now = new Date().toISOString();
  return {
    id: safeWorkflowId(name),
    name,
    target: {
      url: `https://example.com/${encodeURIComponent(name)}`,
    },
    steps: makeSteps(),
    createdAt: now,
    updatedAt: now,
  };
}

describe('browser-opt Workflow store', () => {
  it('resolves the default directory from the caller project', () => {
    expect(resolveBrowserOptWorkflowDir(undefined, '/tmp/example-project')).toBe(
      path.resolve('/tmp/example-project/.browser-opt/workflows'),
    );
  });

  it('saves a Unicode-named Workflow and loads it back', () => {
    const workflowDir = makeTempDir();
    const result = saveBrowserOptWorkflow({
      name: '创建安选公开直播流程',
      flow: '测试 https://example.com/live/create。\n1. 打开页面。\n2. 验证页面包含“Example”。',
      workflowDir,
    });

    expect(result.created).toBe(true);
    expect(path.basename(result.filePath)).toBe('创建安选公开直播流程.json');
    expect(result.workflow.target.url).toBe('https://example.com/live/create');
    expect(result.workflow.steps).toEqual(['验证页面包含“Example”。']);
    expect(result.workflow.filePath).toBe(result.filePath);
    expect(JSON.parse(fs.readFileSync(result.filePath, 'utf-8'))).toEqual(expect.not.objectContaining({ version: expect.anything() }));
    expect(loadBrowserOptWorkflows(workflowDir).workflows).toEqual([result.workflow]);
  });

  it('rejects duplicate names unless force is explicit and preserves createdAt', () => {
    const workflowDir = makeTempDir();
    const first = saveBrowserOptWorkflow({
      name: '登录流程',
      flow: '测试 https://example.com/login。\n1. 验证页面包含“Login”。',
      workflowDir,
    });

    expect(() => saveBrowserOptWorkflow({
      name: '登录流程',
      flow: '测试 https://example.com/login。\n1. 验证页面包含“Updated”。',
      workflowDir,
    })).toThrow('已存在');

    const updated = saveBrowserOptWorkflow({
      name: '登录流程',
      flow: '测试 https://example.com/login。\n1. 验证页面包含“Updated”。',
      workflowDir,
      force: true,
    });
    expect(updated.created).toBe(false);
    expect(updated.workflow.createdAt).toBe(first.workflow.createdAt);
    expect(updated.workflow.steps[0]).toContain('Updated');
  });

  it('rejects flows without a URL and skips malformed files while loading', () => {
    const workflowDir = makeTempDir();
    expect(() => saveBrowserOptWorkflow({
      name: '无地址流程',
      flow: '1. 打开页面。',
      workflowDir,
    })).toThrow('必须包含');

    fs.writeFileSync(path.join(workflowDir, 'broken.json'), '{invalid', 'utf-8');
    fs.writeFileSync(path.join(workflowDir, 'missing-url.json'), JSON.stringify({
      id: 'missing-url',
      name: '缺少地址',
      target: {
        url: '',
      },
      steps: ['打开页面。'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), 'utf-8');
    const loaded = loadBrowserOptWorkflows(workflowDir);
    expect(loaded.workflows).toEqual([]);
    expect(loaded.warnings).toHaveLength(2);
  });

  it('loads legacy versioned Workflow files and normalizes them to the current shape', () => {
    const workflowDir = makeTempDir();
    fs.writeFileSync(path.join(workflowDir, '旧流程.json'), JSON.stringify({
      version: 2,
      id: '旧流程',
      name: '旧流程',
      target: {
        url: 'https://example.com/legacy',
      },
      steps: ['打开页面。', '验证页面包含“Example”。'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), 'utf-8');

    const [loaded] = loadBrowserOptWorkflows(workflowDir).workflows;
    expect(loaded).toEqual(expect.not.objectContaining({ version: 2 }));
    expect(loaded.steps).toEqual(['验证页面包含“Example”。']);
  });

  it('renders a structured Workflow back to the runner flow format', () => {
    const rendered = renderBrowserOptWorkflowFlow({
      ...workflow('创建安选公开直播流程'),
      target: {
        url: 'https://example.com/live/create',
      },
      steps: [
        '打开页面。',
        '在“直播间名称”输入“自动化测试直播间”。',
        '点击“提交”按钮。',
      ],
    });

    expect(rendered).toBe([
      '测试 https://example.com/live/create。',
      '1. 在“直播间名称”输入“自动化测试直播间”。',
      '2. 点击“提交”按钮。',
    ].join('\n'));
  });
});

describe('browser-opt Workflow matcher', () => {
  it('normalizes Skill prefixes, intent words, punctuation and whitespace', () => {
    expect(normalizeBrowserOptWorkflowQuery('/browser-opt 请执行 创建安选公开直播流程！')).toBe(
      '创建安选公开直播流程',
    );
  });

  it('directly selects an exact Chinese name match', () => {
    const target = workflow('创建安选公开直播流程');
    const result = matchBrowserOptWorkflows('执行创建安选公开直播流程', [
      workflow('创建安选私域直播流程'),
      target,
    ]);

    expect(result.status).toBe('matched');
    expect(result.matched?.workflow.id).toBe(target.id);
    expect(result.matched?.score).toBe(1);
  });

  it('directly selects the only similar candidate', () => {
    const target = workflow('创建安选公开直播流程');
    const result = matchBrowserOptWorkflows('安选公开直播', [
      target,
      workflow('删除商品流程'),
    ]);

    expect(result.status).toBe('matched');
    expect(result.matched?.workflow.id).toBe(target.id);
  });

  it('does not match a weakly similar workflow directly', () => {
    const result = matchBrowserOptWorkflows('创建安选生鲜直播流程', [
      workflow('创建安选公开直播（测试环境）'),
      workflow('删除商品流程'),
    ]);

    expect(result.status).toBe('not-found');
    expect(result.matched).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.available.map((item) => item.name)).toContain('创建安选公开直播（测试环境）');
  });

  it('returns only the closest three candidates with stable ordering', () => {
    const result = matchBrowserOptWorkflows('创建安选直播流程', [
      workflow('创建安选公开直播流程'),
      workflow('创建安选私域直播流程'),
      workflow('创建安选录播流程'),
      workflow('创建安选直播预告流程'),
      workflow('删除订单流程'),
    ]);

    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
    expect(result.candidates[1].score).toBeGreaterThanOrEqual(result.candidates[2].score);
  });

  it('returns available workflows when no candidate matches', () => {
    const result = matchBrowserOptWorkflows('导出财务报表', [
      workflow('创建直播流程'),
      workflow('删除商品流程'),
    ]);

    expect(result.status).toBe('not-found');
    expect(result.candidates).toEqual([]);
    expect(result.available).toHaveLength(2);
  });
});
