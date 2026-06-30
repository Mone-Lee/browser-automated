/**
 * 覆盖 browser-opt 在 M1 阶段的自然语言执行闭环，以及不启动真实浏览器时的
 * 证据报告生成行为。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserOptRunner,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from '../../src/browser-opt/runner.js';
import type { BrowserAgent } from '../../src/core/agent.js';
import type { AgentOptions } from '../../src/core/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-test-'));
  tempDirs.push(dir);
  return dir;
}

function snapshotJson(text: string, refs: Record<string, unknown> = { e1: { role: 'button', name: 'Submit' } }) {
  return {
    raw: JSON.stringify({ success: true, data: { snapshot: text, refs } }),
    data: {
      success: true,
      data: {
        snapshot: text,
        refs,
      },
    },
  };
}

function buildAgent(options: {
  snapshots?: ReturnType<typeof snapshotJson>[];
  chat?: () => { raw: string; data: unknown | null; parseError?: string };
} = {}): BrowserAgent {
  const snapshots = options.snapshots ?? [
    snapshotJson('home page', { e1: { role: 'textbox', name: 'Search' } }),
    snapshotJson('home page before', { e1: { role: 'textbox', name: 'Search' } }),
    snapshotJson('home page after contains agent-browser', { e1: { role: 'link', name: 'agent-browser' } }),
  ];

  return {
    open: vi.fn(() => 'opened'),
    snapshotJson: vi.fn(() => snapshots.shift() ?? snapshotJson('fallback')),
    screenshot: vi.fn((filePath?: string) => {
      if (filePath) {
        fs.writeFileSync(filePath, 'png');
      }
      return filePath ?? '/tmp/screenshot.png';
    }),
    fill: vi.fn(() => 'filled'),
    click: vi.fn(() => 'clicked'),
    chatJson: vi.fn(options.chat ?? (() => ({ raw: '{"success":true}', data: { success: true } }))),
    close: vi.fn(() => {}),
  } as unknown as BrowserAgent;
}

function makeFactory(agent: BrowserAgent, capturedOptions: AgentOptions[] = []) {
  return (options?: AgentOptions) => {
    capturedOptions.push(options ?? {});
    return agent;
  };
}

describe('browser-opt parsing', () => {
  it('extracts URL from natural-language flow', () => {
    expect(extractBrowserOptUrl('测试 https://example.com 的搜索功能')).toBe('https://example.com');
  });

  it('splits numbered target steps', () => {
    const steps = splitBrowserOptSteps(`测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 验证页面包含 "Example"。`);

    expect(steps).toEqual(['打开首页。', '验证页面包含 "Example"。']);
  });

  it('uses the whole text as one step when no numbered steps exist', () => {
    expect(splitBrowserOptSteps('测试 https://example.com 并验证首页')).toEqual([
      '测试 https://example.com 并验证首页',
    ]);
  });
});

describe('BrowserOptRunner', () => {
  it('runs open, snapshot, screenshot, chat, re-snapshot, screenshot and writes reports', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('before snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('after snapshot with Example', { e1: { role: 'heading', name: 'Example' } }),
      ],
    });
    const capturedOptions: AgentOptions[] = [];
    const runner = new BrowserOptRunner(makeFactory(agent, capturedOptions));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。', {
      outputDir,
      profile: 'Work',
    });

    expect(result.passed).toBe(true);
    expect(capturedOptions[0]).toEqual(expect.objectContaining({
      profile: 'Work',
      liveViewport: true,
      openLiveDashboard: false,
    }));
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('https://example.com');
    expect((agent.snapshotJson as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    expect((agent.screenshot as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    expect((agent.chatJson as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((agent.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(fs.existsSync(result.report.reportJsonPath)).toBe(true);
    expect(fs.existsSync(result.report.reportMarkdownPath)).toBe(true);
    expect(result.report.status).toBe('PASS');
    expect(result.report.screenshots).toEqual([
      expect.stringContaining('00-open.png'),
      expect.stringContaining('01-before.png'),
      expect.stringContaining('01-after.png'),
    ]);
  });

  it('closes the browser session only when requested', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('before snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('after snapshot with Example', { e1: { role: 'heading', name: 'Example' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。', {
      outputDir,
      closeOnComplete: true,
    });

    expect(result.passed).toBe(true);
    expect((agent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('executes field input steps with deterministic fill commands by default', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before visit'),
        snapshotJson('after visit'),
        snapshotJson('before input', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('after 安选公开直播自动化', { e2: { role: 'textbox', name: '直播间名称' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('执行创建安选公开直播流程：\n1. 访问https://test-live.ifengqun.com/live/create?time=2\n2. 直播间名称输入“安选公开直播自动化”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('https://test-live.ifengqun.com/live/create?time=2');
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e2', '安选公开直播自动化');
    expect((agent.chatJson as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[1].logs.join('\n')).toContain('deterministic agent-browser command');
  });

  it('executes natural-language action steps with agent-browser chat JSON when requested', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before'),
        snapshotJson('after'),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 点击搜索按钮。', {
      outputDir,
      useAgentChat: true,
    });

    expect(result.passed).toBe(true);
    expect((agent.chatJson as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('点击搜索按钮。');
    expect(result.report.steps[0].logs.join('\n')).toContain('agent-browser chat --json');
  });

  it('verifies at least N elements using snapshot refs', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before'),
        snapshotJson('after', {
          e1: { role: 'link', name: 'one' },
          e2: { role: 'link', name: 'two' },
          e3: { role: 'link', name: 'three' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证搜索结果页面是否包含至少 3 个结果项。', {
      outputDir,
    });

    expect(result.passed).toBe(true);
    expect(result.report.steps[0].verification).toContain('>= 3');
  });

  it('re-snapshots and retries once when an action fails', async () => {
    const outputDir = makeTempDir();
    const chat = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('stale ref');
      })
      .mockReturnValueOnce({ raw: '{"success":true}', data: { success: true } });
    const agent = buildAgent({
      chat,
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before'),
        snapshotJson('retry'),
        snapshotJson('after'),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 点击第一个结果。', {
      outputDir,
      useAgentChat: true,
    });

    expect(result.passed).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect((agent.snapshotJson as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(4);
    expect(result.report.steps[0].attempts).toBe(2);
    expect(result.report.steps[0].logs.join('\n')).toContain('retry-snapshot');
  });

  it('returns FAIL and reports verification errors', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before'),
        snapshotJson('after without expected text'),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Dashboard"。', {
      outputDir,
    });
    const report = JSON.parse(fs.readFileSync(result.report.reportJsonPath, 'utf-8')) as { status: string };

    expect(result.passed).toBe(false);
    expect(report.status).toBe('FAIL');
    expect(result.report.steps[0].error).toContain('页面未包含文本');
  });

  it('throws a template error when no URL can be extracted', async () => {
    const runner = new BrowserOptRunner(makeFactory(buildAgent()));

    await expect(runner.run('测试搜索功能')).rejects.toThrow('通用测试模板');
  });
});
