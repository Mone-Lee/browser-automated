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
} from '../../src/browser-opt/runner/index.js';
import { parseDeterministicAction } from '../../src/browser-opt/utils.js';
import type { BrowserAgent } from '../../src/core/agent.js';
import type { AgentOptions } from '../../src/core/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
  evaluate?: (script: string) => string;
  getUrl?: () => string;
  getTabs?: () => Array<{ active: boolean; tabId: string; title: string; type: string; url: string }>;
} = {}): BrowserAgent {
  const snapshots = options.snapshots ?? [
    snapshotJson('home page', { e1: { role: 'textbox', name: 'Search' } }),
    snapshotJson('home page before', { e1: { role: 'textbox', name: 'Search' } }),
    snapshotJson('home page after contains agent-browser', { e1: { role: 'link', name: 'agent-browser' } }),
  ];

  return {
    open: vi.fn(() => 'opened'),
    reload: vi.fn(() => 'reloaded'),
    getSessionId: vi.fn(() => 'browser-opt-test-session'),
    getUrl: vi.fn(options.getUrl ?? (() => 'https://example.com')),
    getTabs: vi.fn(options.getTabs ?? (() => [])),
    switchTab: vi.fn(() => 'switched'),
    snapshotJson: vi.fn(() => snapshots.shift() ?? snapshotJson('fallback')),
    screenshot: vi.fn((filePath?: string) => {
      if (filePath) {
        fs.writeFileSync(filePath, 'png');
      }
      return filePath ?? '/tmp/screenshot.png';
    }),
    fill: vi.fn(() => 'filled'),
    click: vi.fn(() => 'clicked'),
    upload: vi.fn(() => 'uploaded'),
    handoff: vi.fn(() => 'HANDOFF: waiting'),
    resume: vi.fn(() => 'RESUME_FALLBACK: continuing session browser-opt-test-session without an explicit resume command.'),
    stateSave: vi.fn(() => 'state saved'),
    stateLoad: vi.fn(() => 'state loaded'),
    scroll: vi.fn(() => 'scrolled'),
    evaluate: vi.fn(options.evaluate ?? (() => JSON.stringify({ found: true, checked: true, desired: true }))),
    chatJson: vi.fn(options.chat ?? (() => ({ raw: '{"success":true}', data: { success: true } }))),
    waitMs: vi.fn(() => 'waited'),
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

  it('splits flows that contain escaped newline literals', () => {
    const steps = splitBrowserOptSteps('测试 https://example.com 的页面。\\n\\n目标：\\n1. 打开页面。\\n2. 售后周期选择第一个选项。');

    expect(steps).toEqual(['打开页面。', '售后周期选择第一个选项。']);
  });

  it('uses the whole text as one step when no numbered steps exist', () => {
    expect(splitBrowserOptSteps('测试 https://example.com 并验证首页')).toEqual([
      '测试 https://example.com 并验证首页',
    ]);
  });

  it('splits unnumbered multiline operation flows into executable steps', () => {
    const steps = splitBrowserOptSteps(`我要求打开页面https://example.com/add?type=2。
三品一械选择“是”。
商品标签选择“商品重构”。
售后服务选择“支持7天无理由退换”和“上门安装”`);

    expect(steps).toEqual([
      '我要求打开页面https://example.com/add?type=2',
      '三品一械选择“是”',
      '商品标签选择“商品重构”',
      '售后服务选择“支持7天无理由退换”',
      '售后服务选择“上门安装”',
    ]);
  });

  it('recognizes image URL source descriptions as upload actions without requiring the upload verb', () => {
    expect(parseDeterministicAction('直播间分享封面，图片来源为“https://example.com/share.png”')).toEqual({
      type: 'upload',
      field: '直播间分享封面',
      source: 'https://example.com/share.png',
    });

    expect(parseDeterministicAction('直播间封面，图片来源 为“https://example.com/cover.png”')).toEqual({
      type: 'upload',
      field: '直播间封面',
      source: 'https://example.com/cover.png',
    });

    expect(parseDeterministicAction('直播间分享封面，图片来源为‘https://example.com/share.png’')).toEqual({
      type: 'upload',
      field: '直播间分享封面',
      source: 'https://example.com/share.png',
    });

    expect(parseDeterministicAction("自动上传'直播间分享封面'，图片来源 URL 为'https://example.com/share.png'")).toEqual({
      type: 'upload',
      field: '直播间分享封面',
      source: 'https://example.com/share.png',
    });

    expect(parseDeterministicAction('使用 https://example.com/banner.png 作为直播间分享封面图片')).toEqual({
      type: 'upload',
      field: '直播间分享封面',
      source: 'https://example.com/banner.png',
    });
  });

  it('recognizes curly and straight single quotes across deterministic action types', () => {
    expect(parseDeterministicAction('直播间名称输入‘自动化直播间’')).toEqual({
      type: 'fill',
      field: '直播间名称',
      value: '自动化直播间',
    });

    expect(parseDeterministicAction("点击'提交'")).toEqual({
      type: 'click',
      target: '提交',
    });

    expect(parseDeterministicAction('业务类型选择‘安选公开’')).toEqual({
      type: 'select-option',
      field: '业务类型',
      option: '安选公开',
    });

    expect(parseDeterministicAction('\\n2. 售后周期选择第一个选项')).toEqual({
      type: 'select-option',
      field: '售后周期',
      option: '第一个选项',
    });

    expect(parseDeterministicAction('验证页面包含‘Dashboard’')).toEqual({
      type: 'assert-text',
      text: 'Dashboard',
    });
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
      reuseRunningBrowser: false,
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

  it('falls back to the profile when a saved auth state opens on the login page', async () => {
    const outputDir = makeTempDir();
    const authStatePath = path.join(makeTempDir(), 'auth-state.json');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('open snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('before snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('after snapshot with Example', { e1: { role: 'heading', name: 'Example' } }),
      ],
    });
    const capturedOptions: AgentOptions[] = [];
    const runner = new BrowserOptRunner(makeFactory(agent, capturedOptions));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。', {
      outputDir,
      statePath: authStatePath,
      authStateSavePath: authStatePath,
      authStateFallbackProfile: 'Default',
    });

    expect(result.passed).toBe(true);
    expect(capturedOptions[0]).toEqual(expect.objectContaining({ statePath: authStatePath }));
    expect(capturedOptions[1]).toEqual(expect.objectContaining({ profile: 'Default' }));
    expect(capturedOptions[1]).not.toHaveProperty('statePath');
    expect((agent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(result.report.logs.join('\n')).toContain('auth-state-fallback: state 登录态疑似失效，改用 profile Default 重新导入。');
  });

  it('falls back before handoff when auth redirects to login after the initial open snapshot', async () => {
    const outputDir = makeTempDir();
    const authStatePath = path.join(makeTempDir(), 'auth-state.json');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('登录远方的梦想直播平台', { e2: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('创建直播页', { e3: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('创建直播页', { e3: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('after 安选公开直播自动化', { e3: { role: 'textbox', name: '直播间名称' } }),
      ],
    });
    const capturedOptions: AgentOptions[] = [];
    const runner = new BrowserOptRunner(makeFactory(agent, capturedOptions));

    const result = await runner.run('执行创建安选公开直播流程：https://test-live.ifengqun.com/live/create?time=2\n1. 直播间名称输入“安选公开直播自动化”', {
      outputDir,
      statePath: authStatePath,
      authStateSavePath: authStatePath,
      authStateFallbackProfile: 'Default',
    });

    expect(result.passed).toBe(true);
    expect(capturedOptions[1]).toEqual(expect.objectContaining({ profile: 'Default' }));
    expect((agent.handoff as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e3', '安选公开直播自动化');
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authStatePath);
    expect(result.report.logs.join('\n')).toContain('auth-state-fallback: state 登录态疑似失效，改用 profile Default 重新导入。');
  });

  it('uses the current state window for interactive login handoff instead of opening a profile fallback', async () => {
    const outputDir = makeTempDir();
    const authStatePath = path.join(makeTempDir(), 'auth-state.json');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('创建直播页', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('before visit after resume', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('after visit after resume', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('before input', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('after 安选公开直播自动化', { e2: { role: 'textbox', name: '直播间名称' } }),
      ],
    });
    const capturedOptions: AgentOptions[] = [];
    const waitForUserResume = vi.fn(async () => {});
    const runner = new BrowserOptRunner(makeFactory(agent, capturedOptions));

    const result = await runner.run('执行创建安选公开直播流程：\n1. 访问 https://test-live.ifengqun.com/live/create?time=2\n2. 直播间名称输入“安选公开直播自动化”', {
      outputDir,
      statePath: authStatePath,
      authStateSavePath: authStatePath,
      authStateFallbackProfile: 'Default',
      handoff: {
        waitForUserResume,
      },
    });

    expect(result.passed).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).toEqual(expect.objectContaining({ statePath: authStatePath }));
    expect((agent.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.resume as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(waitForUserResume).toHaveBeenCalledTimes(1);
    expect(result.report.logs.join('\n')).not.toContain('auth-state-fallback');
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e2', '安选公开直播自动化');
  });

  it('closes the invalid state window and keeps the profile candidate when it remains blank', async () => {
    const outputDir = makeTempDir();
    const authStatePath = path.join(makeTempDir(), 'auth-state.json');
    const originalAgent = buildAgent({
      snapshots: [
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
      ],
      getUrl: () => 'https://test-live.ifengqun.com/login',
    });
    const blankSnapshot = {
      raw: JSON.stringify({ success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } }),
      data: { success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } },
    };
    const fallbackAgent = buildAgent({
      snapshots: Array.from({ length: 12 }, () => blankSnapshot),
      getUrl: () => 'about:blank',
      getTabs: () => [
        { active: true, tabId: 't1', title: 'about:blank', type: 'page', url: 'about:blank' },
      ],
    });
    const agents = [originalAgent, fallbackAgent];
    const runner = new BrowserOptRunner(() => agents.shift() ?? fallbackAgent);

    const result = await runner.run('测试 https://test-live.ifengqun.com/live/create?time=2。\n\n目标：\n1. 验证页面包含 "创建直播"。', {
      outputDir,
      statePath: authStatePath,
      authStateSavePath: authStatePath,
      authStateFallbackProfile: 'Default',
    });

    expect(result.report.status).toBe('FAIL');
    expect((originalAgent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((originalAgent.handoff as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((fallbackAgent.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((fallbackAgent.handoff as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.screenshots).toEqual([
      path.join(result.report.outputDir, '00-open.png'),
      path.join(result.report.outputDir, '00-profile-fallback.png'),
      path.join(result.report.outputDir, '01-before.png'),
      path.join(result.report.outputDir, '01-after.png'),
    ]);
    expect(result.report.logs.join('\n')).toContain(
      'auth-state-fallback-blank: profile 候选页停留在 about:blank，保留候选窗口供排查。',
    );
  });

  it('waits for handoff in the profile candidate when the candidate opens the login page', async () => {
    const outputDir = makeTempDir();
    const authStatePath = path.join(makeTempDir(), 'auth-state.json');
    const loginSnapshot = snapshotJson('登录远方的梦想直播平台', {
      e1: { role: 'textbox', name: '请输入手机号' },
    });
    const originalAgent = buildAgent({
      snapshots: [loginSnapshot],
      getUrl: () => 'https://test-live.ifengqun.com/login',
    });
    const fallbackAgent = buildAgent({
      snapshots: [loginSnapshot],
      getUrl: () => 'https://test-live.ifengqun.com/login',
    });
    const agents = [originalAgent, fallbackAgent];
    const runner = new BrowserOptRunner(() => agents.shift() ?? fallbackAgent);

    const result = await runner.run('测试 https://test-live.ifengqun.com/live/create?time=2。\n\n目标：\n1. 验证页面包含 "创建直播"。', {
      outputDir,
      statePath: authStatePath,
      authStateSavePath: authStatePath,
      authStateFallbackProfile: 'Default',
    });

    expect(result.report.status).toBe('HANDOFF');
    expect((originalAgent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((originalAgent.handoff as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((fallbackAgent.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((fallbackAgent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
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
    const capturedOptions: AgentOptions[] = [];
    const runner = new BrowserOptRunner(makeFactory(agent, capturedOptions));

    const result = await runner.run('执行创建安选公开直播流程：\n1. 访问https://test-live.ifengqun.com/live/create?time=2\n2. 直播间名称输入‘安选公开直播自动化’', { outputDir });

    expect(result.passed).toBe(true);
    expect(capturedOptions[0]).toEqual(expect.objectContaining({
      reuseRunningBrowser: false,
    }));
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('https://test-live.ifengqun.com/live/create?time=2');
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e2', '安选公开直播自动化');
    expect((agent.chatJson as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].actionOutput).toContain('open skipped');
    expect(result.report.steps[1].logs.join('\n')).toContain('deterministic agent-browser command');
  });

  it('treats an already selected radio option as a completed deterministic action', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- LabelText "开启" [ref=e21] clickable [onclick]',
      '  - radio "开启 " [checked=false, disabled, ref=e31]',
      '- LabelText "关闭" [ref=e22] clickable [onclick]',
      '  - radio "关闭 " [checked=true, disabled, ref=e32]',
    ].join('\n');
    const refs = {
      e21: { role: 'LabelText', name: '开启' },
      e22: { role: 'LabelText', name: '关闭' },
      e31: { role: 'radio', name: '开启  ' },
      e32: { role: 'radio', name: '关闭  ' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before visit'),
        snapshotJson('after visit'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('执行创建安选公开直播流程：\n1. 访问https://test-live.ifengqun.com/live/create?time=2\n2. 是否开启回放选择“关闭”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[1].actionOutput).toContain('selection skipped');
  });

  it('clicks the enabled radio control instead of its accessibility label', async () => {
    const outputDir = makeTempDir();
    const beforeSnapshot = [
      '- LabelText "公开直播" [ref=e31] clickable [cursor:pointer, onclick]',
      '  - radio "公开直播 " [checked=false, ref=e44]',
      '- LabelText "安选直播" [ref=e32] clickable [cursor:pointer, onclick]',
      '  - radio "安选直播 " [checked=false, ref=e45]',
    ].join('\n');
    const afterSnapshot = beforeSnapshot.replace(
      'radio "安选直播 " [checked=false, ref=e45]',
      'radio "安选直播 " [checked=true, ref=e45]',
    );
    const refs = {
      e31: { role: 'LabelText', name: '公开直播' },
      e32: { role: 'LabelText', name: '安选直播' },
      e44: { role: 'radio', name: '公开直播 ' },
      e45: { role: 'radio', name: '安选直播 ' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(beforeSnapshot, refs),
        snapshotJson(afterSnapshot, refs),
      ],
      evaluate: () => JSON.stringify({ matchedCount: 1, clicked: true, checked: true }),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播类型选择“安选直播”', { outputDir });

    expect(result.passed).toBe(true);
    expect(agent.evaluate).toHaveBeenCalled();
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('e45');
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('e32');
  });

  it('selects the enabled repeated radio group without hard-coded field names', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- LabelText "开启" [ref=e21] clickable [onclick]',
      '  - radio "开启 " [checked=false, disabled, ref=e31]',
      '- LabelText "关闭" [ref=e22] clickable [onclick]',
      '  - radio "关闭 " [checked=true, disabled, ref=e32]',
      '- LabelText "开启" [ref=e23] clickable [cursor:pointer, onclick]',
      '  - radio "开启 " [checked=false, ref=e33]',
      '- LabelText "关闭" [ref=e24] clickable [cursor:pointer, onclick]',
      '  - radio "关闭 " [checked=true, ref=e34]',
    ].join('\n');
    const selectedSnapshot = [
      '- LabelText "开启" [ref=e21] clickable [onclick]',
      '  - radio "开启 " [checked=false, disabled, ref=e31]',
      '- LabelText "关闭" [ref=e22] clickable [onclick]',
      '  - radio "关闭 " [checked=true, disabled, ref=e32]',
      '- LabelText "开启" [ref=e23] clickable [cursor:pointer, onclick]',
      '  - radio "开启 " [checked=true, ref=e33]',
      '- LabelText "关闭" [ref=e24] clickable [cursor:pointer, onclick]',
      '  - radio "关闭 " [checked=false, ref=e34]',
    ].join('\n');
    const refs = {
      e21: { role: 'LabelText', name: '开启' },
      e22: { role: 'LabelText', name: '关闭' },
      e23: { role: 'LabelText', name: '开启' },
      e24: { role: 'LabelText', name: '关闭' },
      e31: { role: 'radio', name: '开启  ' },
      e32: { role: 'radio', name: '关闭  ' },
      e33: { role: 'radio', name: '开启  ' },
      e34: { role: 'radio', name: '关闭  ' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(selectedSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 是否显示录播提示文案选择“开启”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e33');
  });

  it('parses quoted field and quoted option separately for select steps', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "分账节点" [ref=f1]',
      '- LabelText "正常结算" [ref=e21] clickable [onclick]',
      '  - radio "正常结算" [checked=true, ref=e31]',
      '- LabelText "已发货结算" [ref=e22] clickable [onclick]',
      '  - radio "已发货结算" [checked=false, ref=e32]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '分账节点' },
      e21: { role: 'LabelText', name: '正常结算' },
      e22: { role: 'LabelText', name: '已发货结算' },
      e31: { role: 'radio', name: '正常结算' },
      e32: { role: 'radio', name: '已发货结算' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 将“分账节点”选择“已发货结算”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e32');
    expect(result.report.steps[0].actionOutput).toContain('分账节点=已发货结算');
    expect(result.report.steps[0].actionOutput).toContain('click @e32');
  });

  it('parses quoted field with an unquoted option for select steps', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "分账节点" [ref=f1]',
      '- LabelText "正常结算" [ref=e21] clickable [onclick]',
      '  - radio "正常结算" [checked=false, ref=e31]',
      '- LabelText "已发货结算" [ref=e22] clickable [onclick]',
      '  - radio "已发货结算" [checked=true, ref=e32]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '分账节点' },
      e21: { role: 'LabelText', name: '正常结算' },
      e22: { role: 'LabelText', name: '已发货结算' },
      e31: { role: 'radio', name: '正常结算' },
      e32: { role: 'radio', name: '已发货结算' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 将“分账节点”选择正常结算', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e31');
  });

  it('parses unquoted field with a quoted option for select steps', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "分账节点" [ref=f1]',
      '- LabelText "正常结算" [ref=e21] clickable [onclick]',
      '  - radio "正常结算" [checked=true, ref=e31]',
      '- LabelText "已发货结算" [ref=e22] clickable [onclick]',
      '  - radio "已发货结算" [checked=false, ref=e32]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '分账节点' },
      e21: { role: 'LabelText', name: '正常结算' },
      e22: { role: 'LabelText', name: '已发货结算' },
      e31: { role: 'radio', name: '正常结算' },
      e32: { role: 'radio', name: '已发货结算' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 分账节点选择“已发货结算”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e32');
  });

  it('parses unquoted field and unquoted option for select steps', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "分账节点" [ref=f1]',
      '- LabelText "正常结算" [ref=e21] clickable [onclick]',
      '  - radio "正常结算" [checked=false, ref=e31]',
      '- LabelText "已发货结算" [ref=e22] clickable [onclick]',
      '  - radio "已发货结算" [checked=true, ref=e32]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '分账节点' },
      e21: { role: 'LabelText', name: '正常结算' },
      e22: { role: 'LabelText', name: '已发货结算' },
      e31: { role: 'radio', name: '正常结算' },
      e32: { role: 'radio', name: '已发货结算' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 分账节点选择正常结算', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e31');
  });

  it('parses generic selectable verbs like 改为 for select steps', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "分账节点" [ref=f1]',
      '- LabelText "正常结算" [ref=e21] clickable [onclick]',
      '  - radio "正常结算" [checked=true, ref=e31]',
      '- LabelText "已发货结算" [ref=e22] clickable [onclick]',
      '  - radio "已发货结算" [checked=false, ref=e32]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '分账节点' },
      e21: { role: 'LabelText', name: '正常结算' },
      e22: { role: 'LabelText', name: '已发货结算' },
      e31: { role: 'radio', name: '正常结算' },
      e32: { role: 'radio', name: '已发货结算' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 分账节点改为已发货结算', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e32');
  });

  it('parses generic selectable verbs like 调整成 for select steps', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "业务类型" [ref=f1]',
      '- LabelText "安选私密" [ref=e21] clickable [onclick]',
      '  - radio "安选私密" [checked=true, ref=e31]',
      '- LabelText "安选公开" [ref=e22] clickable [onclick]',
      '  - radio "安选公开" [checked=false, ref=e32]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '业务类型' },
      e21: { role: 'LabelText', name: '安选私密' },
      e22: { role: 'LabelText', name: '安选公开' },
      e31: { role: 'radio', name: '安选私密' },
      e32: { role: 'radio', name: '安选公开' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 将业务类型调整成“安选公开”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e32');
  });

  it('fills AntD DatePicker when a date field uses relative natural language', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00+08:00'));
    const outputDir = makeTempDir();
    const dateSnapshot = '- textbox "直播时间" [ref=e20]';
    const refs = {
      e20: { role: 'textbox', name: '直播时间', placeholder: '请选择日期' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(dateSnapshot, refs),
        snapshotJson('直播时间 2026-07-15', refs),
      ],
      evaluate: vi.fn().mockReturnValue(JSON.stringify({ found: true, value: '2026-07-15 00:00:00' })),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播时间选择明天', { outputDir });

    expect(result.passed).toBe(true);
    expect(agent.evaluate).toHaveBeenCalled();
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e20', '2026-07-15 00:00:00');
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].actionOutput).toContain('datepicker fill @e20 直播时间=2026-07-15 00:00:00');
    expect(result.report.steps[0].verification).toContain('已确认日期字段：直播时间=2026-07-15');
  });

  it('normalizes compact month-day date descriptions for date fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00+08:00'));
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('- textbox "直播时间" [ref=e20]', {
          e20: { role: 'textbox', name: '直播时间', placeholder: '请选择日期' },
        }),
        snapshotJson('直播时间 2027-07-01', {
          e20: { role: 'textbox', name: '直播时间', value: '2027-07-01' },
        }),
      ],
      evaluate: vi.fn().mockReturnValue(JSON.stringify({ found: true, value: '2027-07-01 00:00:00' })),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播时间选择0701', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e20', '2027-07-01 00:00:00');
    expect(result.report.steps[0].actionOutput).toContain('直播时间=2027-07-01 00:00:00');
  });

  it('does not shorten a time field after the full datetime candidate fails verification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00+08:00'));
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('- textbox "直播时间" [ref=e20]', {
          e20: { role: 'textbox', name: '直播时间', placeholder: '请选择日期' },
        }),
        snapshotJson('直播时间', {
          e20: { role: 'textbox', name: '直播时间', value: '' },
        }),
        snapshotJson('直播时间', {
          e20: { role: 'textbox', name: '直播时间', value: '' },
        }),
      ],
      evaluate: vi.fn().mockReturnValue(JSON.stringify({ found: true, filled: false, value: '' })),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播时间选择明天', { outputDir });

    expect(result.passed).toBe(false);
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e20', '2026-07-15 00:00:00');
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('e20', '2026-07-15 00:00');
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('e20', '2026-07-15');
  });

  it('accepts a date field when transient snapshot shows the filled value', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00+08:00'));
    const outputDir = makeTempDir();
    const refs = {
      e20: { role: 'textbox', name: '直播时间', placeholder: '请选择日期' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('- textbox "直播时间" [ref=e20]', refs),
        snapshotJson('- textbox "* 直播时间 :" [required, ref=e20]: 2026-07-15 00:00:00', refs),
        snapshotJson('- textbox "* 直播时间 :" [required, ref=e20]: 2026-07-15 00:00:00', refs),
      ],
      evaluate: vi.fn().mockReturnValue(JSON.stringify({ found: true, value: '' })),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播时间选择明天', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.report.steps[0].actionOutput).toContain('datepicker fill @e20 直播时间=2026-07-15 00:00:00');
  });

  it('rejects a DatePicker date when the visible date cell is disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00+08:00'));
    const outputDir = makeTempDir();
    const refs = {
      e20: { role: 'textbox', name: '直播时间', placeholder: '请选择日期' },
    };
    const evaluate = vi.fn((script: string) => {
      if (script.includes('const result = clickDateCell')) {
        return JSON.stringify({ clicked: false, disabled: true, reason: 'date cell disabled' });
      }
      if (script.includes('JSON.stringify(dateHelper.inspectDateCell') || script.includes('JSON.stringify(inspectDateCell')) {
        return JSON.stringify({ found: true, disabled: true });
      }
      if (script.includes('setNativeInputValue')) {
        return JSON.stringify({ found: true, filled: true, value: '2026-09-29 00:00:00' });
      }
      return JSON.stringify({ found: true, value: '2026-09-29 00:00:00' });
    });
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('- textbox "直播时间" [ref=e20]', refs),
        snapshotJson('- textbox "* 直播时间 :" [required, ref=e20]: 2026-09-29 00:00:00', refs),
        snapshotJson('- textbox "* 直播时间 :" [required, ref=e20]: 2026-09-29 00:00:00', refs),
      ],
      evaluate,
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播时间选择9月29日', { outputDir });

    expect(result.passed).toBe(false);
    expect(result.report.steps[0].attempts).toBe(1);
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e20', '2026-09-29 00:00:00');
    expect(result.report.steps[0].error).toContain('日期不可选：直播时间=2026-09-29');
    expect(result.report.steps[0].logs.join('\n')).not.toContain('retry-wait');
  });

  it('rejects a DatePicker value when the confirm button stays disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T10:00:00+08:00'));
    const outputDir = makeTempDir();
    const refs = {
      e20: { role: 'textbox', name: '直播时间', placeholder: '请选择日期' },
    };
    const afterSnapshot = [
      '- textbox "* 直播时间 :" [required, ref=e20]: 2026-09-29 00:00:00',
      '- generic "2026年9月一二三四五六日"',
      '  - cell "29" [ref=e196] clickable [onclick]',
      '- button "确 定" [disabled, ref=e166]',
    ].join('\n');
    const evaluate = vi.fn((script: string) => {
      if (script.includes('inspectDatePickerCommitButton')) {
        return JSON.stringify({ found: true, disabled: true });
      }
      if (script.includes('JSON.stringify(dateHelper.inspectDateCell') || script.includes('JSON.stringify(inspectDateCell')) {
        return JSON.stringify({ found: false, disabled: false });
      }
      return JSON.stringify({ found: true, value: '2026-09-29 00:00:00' });
    });
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('- textbox "直播时间" [ref=e20]', refs),
        snapshotJson(afterSnapshot, refs),
        snapshotJson(afterSnapshot, refs),
      ],
      evaluate,
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 直播时间选择9月29日', { outputDir });

    expect(result.passed).toBe(false);
    expect(result.report.steps[0].attempts).toBe(1);
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e20', '2026-09-29 00:00:00');
    expect(result.report.steps[0].error).toContain('日期不可选：直播时间=2026-09-29');
    expect(result.report.steps[0].logs.join('\n')).not.toContain('retry-wait');
  });

  it('limits repeated option matching to the field scope when labels are duplicated', async () => {
    const outputDir = makeTempDir();
    const radioSnapshot = [
      '- StaticText "分账节点" [ref=f1]',
      '- LabelText "正常结算" [ref=e21] clickable [onclick]',
      '  - radio "正常结算" [checked=true, ref=e31]',
      '- LabelText "已发货结算" [ref=e22] clickable [onclick]',
      '  - radio "已发货结算" [checked=false, ref=e32]',
      '- StaticText "配送节点" [ref=f2]',
      '- LabelText "正常结算" [ref=e23] clickable [onclick]',
      '  - radio "正常结算" [checked=false, ref=e33]',
      '- LabelText "已发货结算" [ref=e24] clickable [onclick]',
      '  - radio "已发货结算" [checked=true, ref=e34]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '分账节点' },
      f2: { role: 'StaticText', name: '配送节点' },
      e21: { role: 'LabelText', name: '正常结算' },
      e22: { role: 'LabelText', name: '已发货结算' },
      e23: { role: 'LabelText', name: '正常结算' },
      e24: { role: 'LabelText', name: '已发货结算' },
      e31: { role: 'radio', name: '正常结算' },
      e32: { role: 'radio', name: '已发货结算' },
      e33: { role: 'radio', name: '正常结算' },
      e34: { role: 'radio', name: '已发货结算' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(radioSnapshot, refs),
        snapshotJson(radioSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 将“配送节点”选择“正常结算”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e33');
  });

  it('skips already checked checkbox options without using select semantics', async () => {
    const outputDir = makeTempDir();
    const checkboxSnapshot = [
      '- LabelText "服务协议" [ref=e41] clickable [onclick]',
      '  - checkbox "服务协议" [checked=true, ref=e42]',
    ].join('\n');
    const refs = {
      e41: { role: 'LabelText', name: '服务协议' },
      e42: { role: 'checkbox', name: '服务协议' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(checkboxSnapshot, refs),
        snapshotJson(checkboxSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 勾选“服务协议”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].actionOutput).toContain('selection skipped');
  });

  it('toggles a switch field to the requested yes-no state', async () => {
    const outputDir = makeTempDir();
    const switchSnapshot = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "否" [checked=false, ref=e51]',
    ].join('\n');
    const selectedSnapshot = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "是" [checked=true, ref=e51]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '三品一械' },
      e51: { role: 'switch', name: '否' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(switchSnapshot, refs),
        snapshotJson(selectedSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 三品一械切换为“是”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e51');
    expect(result.report.steps[0].actionOutput).toContain('check @e51');
  });

  it('fails a select action when the post-action snapshot does not confirm the target state', async () => {
    const outputDir = makeTempDir();
    const switchSnapshot = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "否" [checked=false, ref=e51]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '三品一械' },
      e51: { role: 'switch', name: '否' },
    };
    const agent = buildAgent({
      evaluate: () => JSON.stringify({ found: true, checked: false, desired: true }),
      snapshots: [
        snapshotJson('open'),
        snapshotJson(switchSnapshot, refs),
        snapshotJson(switchSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 三品一械切换为“是”', { outputDir });

    expect(result.passed).toBe(false);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e51');
    expect(result.report.steps[0].error).toContain('DOM 确认开关未达到目标状态：三品一械=是');
  });

  it('does not pass a switch selection when DOM state contradicts snapshot checked state', async () => {
    const outputDir = makeTempDir();
    const misleadingSnapshot = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "三品一械 :" [checked=true, ref=e51]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '三品一械' },
      e51: { role: 'switch', name: '三品一械 :' },
    };
    const agent = buildAgent({
      evaluate: () => JSON.stringify({ found: true, checked: false, desired: true }),
      snapshots: [
        snapshotJson('open'),
        snapshotJson(misleadingSnapshot, refs),
        snapshotJson(misleadingSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 三品一械选择“是”', { outputDir });

    expect(result.passed).toBe(false);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e51');
    expect(result.report.steps[0].error).toContain('DOM 确认开关未达到目标状态：三品一械=是');
  });

  it('clicks the switch on the same line as the requested field instead of the next switch', async () => {
    const outputDir = makeTempDir();
    const switchSnapshot = [
      '- switch "三品一械 :" [checked=false, ref=e33]',
      '- switch "贵重物品 :" [checked=false, ref=e34]',
      '- switch "荤素配置 :" [checked=false, ref=e35]',
    ].join('\n');
    const selectedSnapshot = [
      '- switch "三品一械 :" [checked=true, ref=e33]',
      '- switch "贵重物品 :" [checked=false, ref=e34]',
      '- switch "荤素配置 :" [checked=false, ref=e35]',
    ].join('\n');
    const refs = {
      e33: { role: 'switch', name: '三品一械 :' },
      e34: { role: 'switch', name: '贵重物品 :' },
      e35: { role: 'switch', name: '荤素配置 :' },
    };
    const agent = buildAgent({
      evaluate: () => JSON.stringify(JSON.stringify({ found: true, checked: true, desired: true })),
      snapshots: [
        snapshotJson('open'),
        snapshotJson(switchSnapshot, refs),
        snapshotJson(selectedSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 三品一械选择“是”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e33');
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('e34');
  });

  it('scrolls long forms to find a requested switch instead of clicking an unlabeled switch', async () => {
    const outputDir = makeTempDir();
    const currentViewport = [
      '- switch [checked=false, ref=e14]',
      '- switch [checked=false, ref=e15]',
      '- generic "商品标签" [ref=f2]',
    ].join('\n');
    const switchVisible = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "否" [checked=false, ref=e51]',
      '- switch [checked=false, ref=e14]',
    ].join('\n');
    const switchSelected = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "是" [checked=true, ref=e51]',
      '- switch [checked=false, ref=e14]',
    ].join('\n');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(currentViewport, {
          e14: { role: 'switch', name: '' },
          e15: { role: 'switch', name: '' },
          f2: { role: 'generic', name: '商品标签' },
        }),
        snapshotJson(currentViewport, {
          e14: { role: 'switch', name: '' },
          e15: { role: 'switch', name: '' },
          f2: { role: 'generic', name: '商品标签' },
        }),
        snapshotJson(switchVisible, {
          f1: { role: 'StaticText', name: '三品一械' },
          e51: { role: 'switch', name: '否' },
          e14: { role: 'switch', name: '' },
        }),
        snapshotJson(switchSelected, {
          f1: { role: 'StaticText', name: '三品一械' },
          e51: { role: 'switch', name: '是' },
          e14: { role: 'switch', name: '' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 三品一械选择“是”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.scroll as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('up', 900);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e51');
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith('e14');
  });

  it('opens a select field before choosing an option that is not initially rendered', async () => {
    const outputDir = makeTempDir();
    const closedSnapshot = [
      '- StaticText "商品标签" [ref=f1]',
      '- combobox "请选择" [ref=e61]',
    ].join('\n');
    const openedSnapshot = [
      '- option "商品重构" [ref=e62]',
      '- option "新品" [ref=e63]',
    ].join('\n');
    const selectedSnapshot = [
      '- StaticText "商品标签" [ref=f1]',
      '- combobox "商品重构" [ref=e61]',
    ].join('\n');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(closedSnapshot, {
          f1: { role: 'StaticText', name: '商品标签' },
          e61: { role: 'combobox', name: '请选择' },
        }),
        snapshotJson(openedSnapshot, {
          e62: { role: 'option', name: '商品重构' },
          e63: { role: 'option', name: '新品' },
        }),
        snapshotJson(selectedSnapshot, {
          f1: { role: 'StaticText', name: '商品标签' },
          e61: { role: 'combobox', name: '商品重构' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 商品标签选择“商品重构”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(1, 'e61');
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenNthCalledWith(2, 'e62');
    expect(result.report.steps[0].actionOutput).toContain('open select @e61');
  });

  it('uses a DOM dropdown fallback when a field ref click would be unreliable', async () => {
    const outputDir = makeTempDir();
    const closedSnapshot = [
      '- generic "7天" [ref=e10] clickable [cursor:pointer]',
      '  - generic "7天" [ref=e11] clickable [cursor:pointer, onclick]',
      '    - combobox "* 售后周期 :" [expanded=false, required, ref=e12]',
    ].join('\n');
    const selectedSnapshot = [
      '- generic "提货当天" [ref=e10] clickable [cursor:pointer]',
      '  - generic "提货当天" [ref=e11] clickable [cursor:pointer, onclick]',
      '    - combobox "* 售后周期 :" [expanded=false, required, ref=e12]',
    ].join('\n');
    const agent = buildAgent({
      evaluate: (script) => {
        if (script.includes('selectHelper.clickVisibleOption')) {
          return JSON.stringify({ found: true, clicked: true });
        }
        if (script.includes('selectHelper.openDropdownByField')) {
          return JSON.stringify({ found: true, opened: true });
        }
        return JSON.stringify({ found: false });
      },
      snapshots: [
        snapshotJson('open'),
        snapshotJson(closedSnapshot, {
          e10: { role: 'generic', name: '7天' },
          e11: { role: 'generic', name: '7天' },
          e12: { role: 'combobox', name: '* 售后周期 :' },
        }),
        snapshotJson(selectedSnapshot, {
          e10: { role: 'generic', name: '提货当天' },
          e11: { role: 'generic', name: '提货当天' },
          e12: { role: 'combobox', name: '* 售后周期 :' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 售后周期选择"提货当天"', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((agent.evaluate as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(result.report.steps[0].actionOutput).toContain('select dom click 售后周期=提货当天');
  });

  it('selects an ordinal dropdown option without requiring the option text upfront', async () => {
    const outputDir = makeTempDir();
    const closedSnapshot = [
      '- generic "7天" [ref=e10] clickable [cursor:pointer]',
      '  - generic "7天" [ref=e11] clickable [cursor:pointer, onclick]',
      '    - combobox "* 售后周期 :" [expanded=false, required, ref=e12]',
    ].join('\n');
    const selectedSnapshot = [
      '- generic "2天" [ref=e10] clickable [cursor:pointer]',
      '  - generic "2天" [ref=e11] clickable [cursor:pointer, onclick]',
      '    - combobox "* 售后周期 :" [expanded=false, required, ref=e12]',
    ].join('\n');
    const agent = buildAgent({
      evaluate: (script) => {
        if (script.includes('selectHelper.clickVisibleOption')) {
          return JSON.stringify({ found: true, clicked: true, selectedText: '2天' });
        }
        if (script.includes('selectHelper.openDropdownByField')) {
          return JSON.stringify({ found: true, opened: true });
        }
        return JSON.stringify({ found: false });
      },
      snapshots: [
        snapshotJson('open'),
        snapshotJson(closedSnapshot, {
          e10: { role: 'generic', name: '7天' },
          e11: { role: 'generic', name: '7天' },
          e12: { role: 'combobox', name: '* 售后周期 :' },
        }),
        snapshotJson(selectedSnapshot, {
          e10: { role: 'generic', name: '2天' },
          e11: { role: 'generic', name: '2天' },
          e12: { role: 'combobox', name: '* 售后周期 :' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 售后周期选择第一个选项', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].actionOutput).toContain('select dom click 售后周期=第一个选项 (2天)');
    expect(result.report.steps[0].verification).toContain('已确认按位置选择：售后周期=第一个选项');
    const clickScript = (agent.evaluate as ReturnType<typeof vi.fn>).mock.calls
      .map(([script]) => String(script))
      .find((script) => script.includes('selectHelper.clickVisibleOption')) ?? '';
    expect(clickScript).toContain('const scopedRoot = containers[0]?.element');
  });

  it('skips a switch field when it is already in the requested state', async () => {
    const outputDir = makeTempDir();
    const switchSnapshot = [
      '- StaticText "三品一械" [ref=f1]',
      '- switch "是" [checked=true, ref=e51]',
    ].join('\n');
    const refs = {
      f1: { role: 'StaticText', name: '三品一械' },
      e51: { role: 'switch', name: '是' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(switchSnapshot, refs),
        snapshotJson(switchSnapshot, refs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 三品一械切换为“是”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.click as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].actionOutput).toContain('selection skipped');
  });

  it('waits and retries when a dependent select option appears after another field update', async () => {
    const outputDir = makeTempDir();
    const beforeDependentRender = [
      '- StaticText "直播类型" [ref=f1]',
      '- LabelText "公开直播" [ref=e21] clickable [onclick]',
      '  - radio "公开直播" [checked=false, ref=e31]',
      '- LabelText "安选直播" [ref=e22] clickable [onclick]',
      '  - radio "安选直播" [checked=true, ref=e32]',
    ].join('\n');
    const afterDependentRender = [
      beforeDependentRender,
      '- StaticText "业务类型" [ref=f2]',
      '- LabelText "安选私密" [ref=e23] clickable [onclick]',
      '  - radio "安选私密" [checked=true, ref=e33]',
      '- LabelText "安选生鲜" [ref=e24] clickable [onclick]',
      '  - radio "安选生鲜" [checked=false, ref=e34]',
      '- LabelText "安选公开" [ref=e25] clickable [onclick]',
      '  - radio "安选公开" [checked=false, ref=e35]',
    ].join('\n');
    const beforeRefs = {
      f1: { role: 'StaticText', name: '直播类型' },
      e21: { role: 'LabelText', name: '公开直播' },
      e22: { role: 'LabelText', name: '安选直播' },
      e31: { role: 'radio', name: '公开直播' },
      e32: { role: 'radio', name: '安选直播' },
    };
    const afterRefs = {
      ...beforeRefs,
      f2: { role: 'StaticText', name: '业务类型' },
      e23: { role: 'LabelText', name: '安选私密' },
      e24: { role: 'LabelText', name: '安选生鲜' },
      e25: { role: 'LabelText', name: '安选公开' },
      e33: { role: 'radio', name: '安选私密' },
      e34: { role: 'radio', name: '安选生鲜' },
      e35: { role: 'radio', name: '安选公开' },
    };
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson(beforeDependentRender, beforeRefs),
        snapshotJson(afterDependentRender, afterRefs),
        snapshotJson(afterDependentRender, afterRefs),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 业务类型选择“安选公开”', { outputDir });

    expect(result.passed).toBe(true);
    expect((agent.waitMs as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(500);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e35');
    expect(result.report.steps[0].logs.join('\n')).toContain('retry-wait');
  });

  it('waits and retries when the initial open snapshot is still about:blank', async () => {
    const outputDir = makeTempDir();
    const blankSnapshot = {
      raw: JSON.stringify({ success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } }),
      data: { success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } },
    };
    const agent = buildAgent({
      snapshots: [
        blankSnapshot,
        snapshotJson('open snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('open snapshot after reload', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('before snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('after snapshot with Example', { e1: { role: 'heading', name: 'Example' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。', {
      outputDir,
    });

    expect(result.passed).toBe(true);
    expect((agent.waitMs as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(500);
    expect((agent.reload as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.report.logs.join('\n')).toContain('open-wait 1');
    expect(result.report.logs.join('\n')).toContain('open-reload');
  });

  it('waits and retries when the target URL snapshot is still blank', async () => {
    const outputDir = makeTempDir();
    const blankTargetSnapshot = {
      raw: JSON.stringify({
        success: true,
        data: {
          origin: 'https://example.com/#/detail?id=1',
          refs: {},
          snapshot: '(no interactive elements)',
        },
      }),
      data: {
        success: true,
        data: {
          origin: 'https://example.com/#/detail?id=1',
          refs: {},
          snapshot: '(no interactive elements)',
        },
      },
    };
    const agent = buildAgent({
      snapshots: [
        blankTargetSnapshot,
        snapshotJson('Example detail', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('Example detail after reload', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('before snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('after snapshot with Example', { e1: { role: 'heading', name: 'Example' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com/#/detail?id=1。\n\n目标：\n1. 验证页面包含 "Example"。', {
      outputDir,
    });

    expect(result.passed).toBe(true);
    expect((agent.waitMs as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(500);
    expect((agent.reload as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.report.logs.join('\n')).toContain('open-wait 1');
    expect(result.report.logs.join('\n')).toContain('open-reload');
  });

  it('switches from about:blank to a non-empty tab before executing the first step', async () => {
    const outputDir = makeTempDir();
    const blankSnapshot = {
      raw: JSON.stringify({ success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } }),
      data: { success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } },
    };
    const agent = buildAgent({
      snapshots: [
        ...Array.from({ length: 6 }, () => blankSnapshot),
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
      ],
      getUrl: () => 'about:blank',
      getTabs: () => [
        { active: true, tabId: 't1', title: 'about:blank', type: 'page', url: 'about:blank' },
        { active: false, tabId: 't2', title: '远方直播助手', type: 'page', url: 'http://localhost:3301/login' },
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://test-live.ifengqun.com/live/create?time=2。\n\n目标：\n1. 验证页面包含 "创建直播"。', {
      outputDir,
    });

    expect(result.report.status).toBe('HANDOFF');
    expect((agent.switchTab as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('t2');
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.report.logs.join('\n')).toContain('open-tab-recovery: 当前活动页为 about:blank');
  });

  it('fails before business steps when the browser remains on an unrecoverable about:blank page', async () => {
    const outputDir = makeTempDir();
    const blankSnapshot = {
      raw: JSON.stringify({ success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } }),
      data: { success: true, data: { origin: 'about:blank', refs: {}, snapshot: '(no interactive elements)' } },
    };
    const agent = buildAgent({
      snapshots: Array.from({ length: 12 }, () => blankSnapshot),
      getUrl: () => 'about:blank',
      getTabs: () => [
        { active: true, tabId: 't1', title: 'about:blank', type: 'page', url: 'about:blank' },
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 在“名称”输入“测试”。', {
      outputDir,
    });

    expect(result.passed).toBe(false);
    expect(result.report.status).toBe('FAIL');
    expect(result.report.steps).toHaveLength(0);
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((agent.screenshot as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.report.logs.join('\n')).toContain('浏览器页面未成功打开：当前会话持续停留在 about:blank');
  });

  it('does not fill an unrelated textbox when the requested field is missing on a login page', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('执行创建安选公开直播流程：\n1. 访问 https://test-live.ifengqun.com/live/create?time=2\n2. 直播间名称输入“安选公开直播自动化”', {
      outputDir,
      authStateSavePath: path.join(makeTempDir(), 'auth-state.json'),
    });

    expect(result.passed).toBe(false);
    expect(result.report.status).toBe('HANDOFF');
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.handoffTriggered).toBe(true);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.logs.join('\n')).toContain('初始化打开目标页面后检测到登录页跳转');
  });

  it('renders step-level login handoff as HANDOFF in markdown report', async () => {
    const outputDir = makeTempDir();
    const authStateSavePath = path.join(makeTempDir(), 'auth-state.json');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('登录远方的梦想直播平台', { e2: { role: 'textbox', name: '请输入手机号' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com/live/create。\n\n目标：\n1. 验证页面包含 "Dashboard"。', {
      outputDir,
      authStateSavePath,
    });
    const markdown = fs.readFileSync(result.report.reportMarkdownPath, 'utf-8');

    expect(result.passed).toBe(false);
    expect(result.report.status).toBe('HANDOFF');
    expect(result.report.steps[0].handoffTriggered).toBe(true);
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(markdown).toContain('### HANDOFF 1. 验证页面包含 "Dashboard"。');
    expect(markdown).not.toContain('### FAIL 1. 验证页面包含 "Dashboard"。');
  });

  it('resumes after login handoff when the caller provides a resume hook', async () => {
    const outputDir = makeTempDir();
    const authStateSavePath = path.join(makeTempDir(), 'auth-state.json');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('登录远方的梦想直播平台', { e1: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('创建直播页', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('before visit after resume', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('after visit after resume', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('before input', { e2: { role: 'textbox', name: '直播间名称' } }),
        snapshotJson('after 安选公开直播自动化', { e2: { role: 'textbox', name: '直播间名称' } }),
      ],
    });
    const onHandoffRequired = vi.fn(async () => {});
    const waitForUserResume = vi.fn(async () => {});
    const onHandoffCompleted = vi.fn(async () => {});
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('执行创建安选公开直播流程：\n1. 访问 https://test-live.ifengqun.com/live/create?time=2\n2. 直播间名称输入“安选公开直播自动化”', {
      outputDir,
      authStateSavePath,
      handoff: {
        onHandoffRequired,
        waitForUserResume,
        onHandoffCompleted,
      },
    });

    expect(result.passed).toBe(true);
    expect(result.report.status).toBe('PASS');
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.resume as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(waitForUserResume).toHaveBeenCalledTimes(1);
    expect(onHandoffRequired).toHaveBeenCalledTimes(1);
    expect(onHandoffCompleted).toHaveBeenCalledTimes(1);
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authStateSavePath);
    expect(result.report.logs.findIndex((log) => log.startsWith('auth-state-save:')))
      .toBeLessThan(result.report.logs.findIndex((log) => log.startsWith('resume-snapshot:')));
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.fill as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e2', '安选公开直播自动化');
  });

  it('waits for step-level login recovery to leave the login page before saving auth state', async () => {
    const outputDir = makeTempDir();
    const authStateSavePath = path.join(makeTempDir(), 'auth-state.json');
    const agent = buildAgent({
      snapshots: [
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('登录远方的梦想直播平台', { e2: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('登录远方的梦想直播平台', { e2: { role: 'textbox', name: '请输入手机号' } }),
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('创建直播页', { e1: { role: 'heading', name: '创建直播' } }),
      ],
    });
    const waitForUserResume = vi.fn(async () => {});
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com/live/create。\n\n目标：\n1. 验证页面包含 "Dashboard"。', {
      outputDir,
      authStateSavePath,
      handoff: {
        waitForUserResume,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.report.status).toBe('FAIL');
    expect(waitForUserResume).toHaveBeenCalledTimes(1);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.resume as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.waitMs as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(500);
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authStateSavePath);
    expect((agent.snapshotJson as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(7);
  });

  it('saves auth state at the end when a save path is provided', async () => {
    const outputDir = makeTempDir();
    const authStateSavePath = path.join(makeTempDir(), 'auth-state.json');
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
      authStateSavePath,
    });

    expect(result.passed).toBe(true);
    expect((agent.stateSave as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(authStateSavePath);
    expect(result.report.logs.join('\n')).toContain(`auth-state-save: ${authStateSavePath}`);
  });

  it('passes the auth state path into the agent when a state path is provided', async () => {
    const outputDir = makeTempDir();
    const authStatePath = path.join(makeTempDir(), 'auth-state.json');
    const capturedOptions: AgentOptions[] = [];
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('before snapshot', { e1: { role: 'heading', name: 'Example' } }),
        snapshotJson('after snapshot with Example', { e1: { role: 'heading', name: 'Example' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent, capturedOptions));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。', {
      outputDir,
      statePath: authStatePath,
    });

    expect(result.passed).toBe(true);
    expect(capturedOptions[0]).toEqual(expect.objectContaining({ statePath: authStatePath }));
    expect((agent.stateLoad as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((agent.open as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('https://example.com');
  });

  it('keeps ordinary action failures as normal errors instead of handoff', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('before input', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('after input', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('retry input', { e1: { role: 'heading', name: '创建直播' } }),
        snapshotJson('after retry', { e1: { role: 'heading', name: '创建直播' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('执行创建安选公开直播流程：https://example.com/live/create\n1. 直播间名称输入“安选公开直播自动化”', {
      outputDir,
    });

    expect(result.passed).toBe(false);
    expect(result.report.handoffTriggered).not.toBe(true);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].error).toContain('无法找到输入框：直播间名称');
  });

  it('downloads URL images and uploads them with deterministic upload commands', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload', { e3: { role: 'file', name: '直播间分享封面' } }),
        snapshotJson('after upload with 封面预览', { e3: { role: 'file', name: '直播间分享封面' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/live/create。\n\n目标：\n1. 自动上传“直播间分享封面”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。',
      { outputDir },
    );

    const uploadCalls = (agent.upload as ReturnType<typeof vi.fn>).mock.calls;
    const uploadedPath = uploadCalls[0]?.[1]?.[0] as string;
    expect(result.passed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png');
    expect(uploadCalls[0]?.[0]).toBe('e3');
    expect(uploadedPath).toContain(path.join('uploads', '82243689cae75e27b3867a5cbdd4292b.png'));
    expect(fs.readFileSync(uploadedPath, 'utf-8')).toBe('image-bytes');
    expect(result.report.steps[0].actionOutput).toContain('upload @e3');
  });

  it('uploads images from source-only natural language descriptions', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload', { e3: { role: 'file', name: '直播间分享封面' } }),
        snapshotJson('after upload with 封面预览', { e3: { role: 'file', name: '直播间分享封面' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/live/create。\n\n目标：\n1. 直播间分享封面，图片来源为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。',
      { outputDir },
    );

    expect(result.passed).toBe(true);
    expect((agent.upload as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'e3',
      [expect.stringContaining(path.join('uploads', '82243689cae75e27b3867a5cbdd4292b.png'))],
    );
  });

  it('does not include curly single quotes in image URLs', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload', { e3: { role: 'file', name: '直播间分享封面' } }),
        snapshotJson('after upload with 封面预览', { e3: { role: 'file', name: '直播间分享封面' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/live/create。\n\n目标：\n1. 直播间分享封面，图片来源为‘https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png’。',
      { outputDir },
    );

    expect(result.passed).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png');
  });

  it('uploads through a hidden file input selector when the accessibility snapshot omits it', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload with visible Ant Upload but no file ref', { e1: { role: 'heading', name: '基础信息' } }),
        snapshotJson('after upload with 封面预览', { e1: { role: 'heading', name: '基础信息' } }),
      ],
      evaluate: () => JSON.stringify({
        found: true,
        selector: '[data-browser-opt-upload-id="browser-opt-upload-0"]',
      }),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/live/create。\n\n目标：\n1. 自动上传“直播间分享封面”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。',
      { outputDir },
    );

    expect(result.passed).toBe(true);
    expect(agent.evaluate).toHaveBeenCalled();
    expect((agent.upload as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '[data-browser-opt-upload-id="browser-opt-upload-0"]',
      [expect.stringContaining(path.join('uploads', '82243689cae75e27b3867a5cbdd4292b.png'))],
    );
    expect(result.report.steps[0].actionOutput).toContain('upload dom selector [data-browser-opt-upload-id="browser-opt-upload-0"]');
  });

  it('uses the hidden file input when Ant Upload exposes only a visible upload button', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload with Ant Upload button', {
          e142: { role: 'button', name: '上传商品白底图' },
        }),
        snapshotJson('after upload with 商品白底图预览', {
          e142: { role: 'button', name: '上传商品白底图' },
        }),
      ],
      evaluate: () => JSON.stringify({
        found: true,
        selector: '[data-browser-opt-upload-id="browser-opt-upload-0"]',
      }),
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/goods/create。\n\n目标：\n1. 自动上传“商品白底图”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。',
      { outputDir },
    );

    expect(result.passed).toBe(true);
    expect((agent.upload as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '[data-browser-opt-upload-id="browser-opt-upload-0"]',
      [expect.stringContaining(path.join('uploads', '82243689cae75e27b3867a5cbdd4292b.png'))],
    );
    expect((agent.upload as ReturnType<typeof vi.fn>)).not.toHaveBeenCalledWith(
      'e142',
      expect.anything(),
    );
  });

  it('hands off after upload when the page enters an image crop workflow', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload', { e3: { role: 'file', name: '商品白底图' } }),
        snapshotJson('82243689cae75e27b3867a5cbdd4292b.png 558 x 180 待处理 跳过 裁切 保存并上传 (0/1)', {
          e4: { role: 'button', name: '裁切' },
          e5: { role: 'button', name: '保存并上传' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/goods/create。\n\n目标：\n1. 自动上传“商品白底图”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。\n2. 商品标题输入“芝麻丸礼盒1.25kg/1盒”。',
      { outputDir },
    );

    expect(result.passed).toBe(false);
    expect(result.report.status).toBe('HANDOFF');
    expect(result.report.steps).toHaveLength(1);
    expect(result.report.steps[0].handoffTriggered).toBe(true);
    expect(result.report.steps[0].verification).toContain('上传“商品白底图”后页面进入图片裁剪或确认上传流程');
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '上传“商品白底图”后页面进入图片裁剪或确认上传流程。请在浏览器中完成裁剪、确认上传，然后继续当前 browser-opt 流程。',
    );
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('waits briefly after upload for a delayed image crop workflow before continuing', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload', { e3: { role: 'file', name: '商品白底图' } }),
        snapshotJson('after upload before crop appears', {
          e6: { role: 'textbox', name: '商品标题' },
        }),
        snapshotJson('82243689cae75e27b3867a5cbdd4292b.png 待处理 跳过 裁切 保存并上传 (0/1)', {
          e4: { role: 'button', name: '裁切' },
          e5: { role: 'button', name: '保存并上传' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/goods/create。\n\n目标：\n1. 自动上传“商品白底图”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。\n2. 商品标题输入“芝麻丸礼盒1.25kg/1盒”。',
      { outputDir },
    );

    expect(result.report.status).toBe('HANDOFF');
    expect((agent.waitMs as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(500);
    expect(result.report.steps[0].logs.join('\n')).toContain('upload-postprocess-wait 1');
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('recognizes alternate upload post-process wording as handoff', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload', { e3: { role: 'file', name: '商品白底图' } }),
        snapshotJson('主图 编辑图片 调整图片 预览 确定使用 重新上传', {
          e4: { role: 'button', name: '确定使用' },
        }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/goods/create。\n\n目标：\n1. 自动上传“商品白底图”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。\n2. 商品标题输入“芝麻丸礼盒1.25kg/1盒”。',
      { outputDir },
    );

    expect(result.report.status).toBe('HANDOFF');
    expect((agent.fill as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('keeps URL download errors when hidden upload lookup is retried', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('missing', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);
    let evalCalls = 0;
    const evaluate = vi.fn((script: string) => {
      evalCalls += 1;
      if (evalCalls > 1 && script.trimStart().startsWith('const normalizeBrowserOptUploadText')) {
        throw new Error('Identifier has already been declared');
      }
      return JSON.stringify({
        found: true,
        selector: '[data-browser-opt-upload-id="browser-opt-upload-0"]',
      });
    });
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload with visible Ant Upload but no file ref', { e1: { role: 'heading', name: '基础信息' } }),
        snapshotJson('retry upload with visible Ant Upload but no file ref', { e1: { role: 'heading', name: '基础信息' } }),
        snapshotJson('after failed upload', { e1: { role: 'heading', name: '基础信息' } }),
      ],
      evaluate,
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/live/create。\n\n目标：\n1. 自动上传“直播间分享封面”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。',
      { outputDir },
    );

    expect(result.passed).toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect((agent.upload as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(result.report.steps[0].error).toBe('下载上传文件失败：404 Not Found');
    expect(result.report.steps[0].logs.join('\n')).not.toContain('无法找到上传控件');
  });

  it('scrolls long forms to find upload controls outside the current snapshot', async () => {
    const outputDir = makeTempDir();
    const fetchMock = vi.fn(async () => new Response('image-bytes', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before upload without control', { e1: { role: 'heading', name: '基础信息' } }),
        snapshotJson('retry upload without control', { e1: { role: 'heading', name: '直播配置' } }),
        snapshotJson('scrolled upload control', { e3: { role: 'file', name: '直播间分享封面' } }),
        snapshotJson('after upload with 封面预览', { e3: { role: 'file', name: '直播间分享封面' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run(
      '测试 https://example.com/live/create。\n\n目标：\n1. 自动上传“直播间分享封面”，图片来源 URL 为“https://stantic.ifengqun.com/front/fq-ecmiddle-sys/upload/82243689cae75e27b3867a5cbdd4292b.png”。',
      { outputDir },
    );

    expect(result.passed).toBe(true);
    expect((agent.scroll as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('up', 900);
    expect((agent.upload as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      'e3',
      [expect.stringContaining(path.join('uploads', '82243689cae75e27b3867a5cbdd4292b.png'))],
    );
    expect(result.report.steps[0].actionOutput).toContain('scroll up 900');
    expect(result.report.steps[0].attempts).toBe(2);
  });

  it('hands off manual production upload steps to the operator', async () => {
    const outputDir = makeTempDir();
    const onHandoffRequired = vi.fn();
    const waitForUserResume = vi.fn();
    const onHandoffCompleted = vi.fn();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before manual upload'),
        snapshotJson('after manual upload with preview'),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('操作 https://example.com/live/create。\n\n目标：\n1. handoff 给操作人员：请手动选择“直播间分享封面”的本地真实图片，并在裁剪/确认完成后恢复自动化。', {
      outputDir,
      handoff: {
        onHandoffRequired,
        waitForUserResume,
        onHandoffCompleted,
      },
    });

    expect(result.passed).toBe(true);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('handoff 给操作人员：请手动选择“直播间分享封面”的本地真实图片，并在裁剪/确认完成后恢复自动化。');
    expect(onHandoffRequired).toHaveBeenCalledTimes(1);
    expect(waitForUserResume).toHaveBeenCalledTimes(1);
    expect((agent.resume as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(onHandoffCompleted).toHaveBeenCalledTimes(1);
    expect(result.report.steps[0].actionOutput).toContain('handoff');
    expect(result.report.steps[0].logs.join('\n')).toContain('resume: RESUME_FALLBACK');
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

  it('keeps verification active for compound action and assertion steps', async () => {
    const outputDir = makeTempDir();
    const agent = buildAgent({
      snapshots: [
        snapshotJson('open'),
        snapshotJson('before click', { e1: { role: 'button', name: '提交' } }),
        snapshotJson('after click without success text', { e1: { role: 'button', name: '提交' } }),
      ],
    });
    const runner = new BrowserOptRunner(makeFactory(agent));

    const result = await runner.run('测试 https://example.com。\n\n目标：\n1. 点击“提交”并验证页面包含“成功”。', {
      outputDir,
    });

    expect(result.passed).toBe(false);
    expect((agent.click as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('e1');
    expect(result.report.steps[0].error).toContain('页面未包含文本：成功');
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
