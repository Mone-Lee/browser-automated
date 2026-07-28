/**
 * 覆盖 browser-opt CLI 的用户侧参数处理，并通过桩命令避免真的启动浏览器会话。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printBrowserOptResult } from '../../src/cli/utils/output.js';
import type { BrowserOptRunResult } from '../../src/browser-opt/type.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], env: Record<string, string> = {}, input?: string) {
  const authStateDir = makeTempDir();
  return spawnSync('node', ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf-8',
    input,
    env: {
      ...process.env,
      AGENT_BROWSER_STATE: '',
      BROWSER_OPT_AUTH_STATE_DIR: authStateDir,
      PATH: `${makeTempAgentBrowserBin()}${path.delimiter}${process.env.PATH ?? ''}`,
      ...env,
    },
  });
}

function makeTempAgentBrowserBin(): string {
  const dir = makeTempDir();
  const binPath = path.join(dir, 'agent-browser');
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.AGENT_BROWSER_LOG) fs.appendFileSync(process.env.AGENT_BROWSER_LOG, args.join(' ') + '\\n');
const optionsWithValues = new Set(['--profile', '--session', '--state', '--args', '--output-dir']);
let commandIndex = -1;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (optionsWithValues.has(arg)) {
    i += 1;
    continue;
  }
  if (!arg.startsWith('--')) {
    commandIndex = i;
    break;
  }
}
const command = args[commandIndex];
if (command === 'open') {
  if (process.env.AGENT_BROWSER_STATE_OPEN_MARKER) {
    if (args.includes('--state')) {
      fs.writeFileSync(process.env.AGENT_BROWSER_STATE_OPEN_MARKER, 'state');
    } else if (args.includes('--profile')) {
      fs.rmSync(process.env.AGENT_BROWSER_STATE_OPEN_MARKER, { force: true });
    }
  }
  process.stdout.write('opened');
} else if (command === 'snapshot') {
  const resumed = process.env.AGENT_BROWSER_RESUME_MARKER && fs.existsSync(process.env.AGENT_BROWSER_RESUME_MARKER);
  const stateOpened = process.env.AGENT_BROWSER_STATE_OPEN_MARKER && fs.existsSync(process.env.AGENT_BROWSER_STATE_OPEN_MARKER);
  const loginSnapshot = process.env.AGENT_BROWSER_LOGIN_SNAPSHOT && !resumed && (!process.env.AGENT_BROWSER_LOGIN_SNAPSHOT_STATE_ONLY || stateOpened);
  const snapshotText = loginSnapshot
    ? (process.env.AGENT_BROWSER_LOGIN_SNAPSHOT_TEXT || process.env.AGENT_BROWSER_SNAPSHOT_TEXT || '登录远方的梦想直播平台')
    : (process.env.AGENT_BROWSER_AFTER_RESUME_SNAPSHOT_TEXT || process.env.AGENT_BROWSER_SNAPSHOT_TEXT || 'Example page');
  const snapshotRefs = loginSnapshot
    ? { e1: { role: 'textbox', name: '请输入手机号' } }
    : process.env.AGENT_BROWSER_LIVE_CREATE_SNAPSHOT
      ? { e2: { role: 'textbox', name: '直播间名称' } }
    : { e1: { role: 'heading', name: 'Example' } };
  process.stdout.write(JSON.stringify({ success: true, data: { snapshot: snapshotText, refs: snapshotRefs } }));
} else if (command === 'screenshot') {
  const target = args[args.length - 1];
  if (target && target.endsWith('.png')) fs.writeFileSync(target, 'png');
  process.stdout.write(target || '/tmp/screenshot.png');
} else if (command === 'fill') {
  process.stdout.write('filled');
} else if (command === 'click') {
  process.stdout.write('clicked');
} else if (command === 'handoff') {
  process.stdout.write('handoff requested');
} else if (command === 'resume') {
  if (process.env.AGENT_BROWSER_RESUME_MARKER) fs.writeFileSync(process.env.AGENT_BROWSER_RESUME_MARKER, 'resumed');
  process.stdout.write('resumed');
} else if (command === 'chat') {
  process.stdout.write(JSON.stringify({ success: true, text: 'Done' }));
} else if (command === 'state' && args[commandIndex + 1] === 'save') {
  const target = args[commandIndex + 2];
  if (target) fs.writeFileSync(target, JSON.stringify({ cookies: [], origins: [] }));
  process.stdout.write('state saved');
} else if (command === 'close') {
  process.stdout.write('closed');
} else if (command === 'dashboard' || command === 'stream') {
  process.stdout.write('ok');
} else {
  process.stdout.write('ok');
}
`,
  );
  fs.chmodSync(binPath, 0o755);
  return dir;
}

describe('browser-opt CLI', () => {
  it('saves, lists and matches a project Workflow as JSON', () => {
    const workflowDir = makeTempDir();
    const flow = '测试 https://example.com。\\n\\n目标：\\n1. 验证页面包含 "Example"。';
    const saved = runCli([
      'browser-opt',
      'save',
      '创建安选公开直播流程',
      '--flow',
      flow,
      '--workflow-dir',
      workflowDir,
    ]);

    expect(saved.status).toBe(0);
    expect(saved.stdout).toContain('已保存 Workflow');
    expect(fs.existsSync(path.join(workflowDir, '创建安选公开直播流程.json'))).toBe(true);

    const listed = runCli(['browser-opt', 'list', '--workflow-dir', workflowDir, '--json']);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).workflows[0].name).toBe('创建安选公开直播流程');

    const matched = runCli([
      'browser-opt',
      'match',
      '执行创建安选公开直播流程',
      '--workflow-dir',
      workflowDir,
      '--json',
    ]);
    expect(matched.status).toBe(0);
    expect(JSON.parse(matched.stdout)).toEqual(expect.objectContaining({
      status: 'matched',
      matched: expect.objectContaining({ name: '创建安选公开直播流程', score: 1 }),
    }));
  });

  it('runs an exact saved Workflow through the existing browser runner', () => {
    const workflowDir = makeTempDir();
    const outputDir = makeTempDir();
    const saveResult = runCli([
      'browser-opt',
      'save',
      '示例验证流程',
      '--flow',
      '测试 https://example.com。\\n1. 验证页面包含 "Example"。',
      '--workflow-dir',
      workflowDir,
    ]);
    expect(saveResult.status).toBe(0);

    const result = runCli([
      'browser-opt',
      'run',
      '执行示例验证流程',
      '--workflow-dir',
      workflowDir,
      '--output-dir',
      outputDir,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('执行成功');
  });

  it('runs a selected saved Workflow by stable ID', () => {
    const workflowDir = makeTempDir();
    const outputDir = makeTempDir();
    const saved = runCli([
      'browser-opt',
      'save',
      '按 ID 执行流程',
      '--flow',
      '测试 https://example.com。\\n1. 验证页面包含 "Example"。',
      '--workflow-dir',
      workflowDir,
    ]);
    expect(saved.status).toBe(0);

    const result = runCli([
      'browser-opt',
      'run',
      '--workflow-id',
      '按-ID-执行流程',
      '--workflow-dir',
      workflowDir,
      '--output-dir',
      outputDir,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('执行成功');
  });

  it('keeps an immediate English flow starting with run backward compatible', () => {
    const outputDir = makeTempDir();
    const result = runCli([
      'browser-opt',
      'run https://example.com。\\n1. 验证页面包含 "Example"。',
      '--output-dir',
      outputDir,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('执行成功');
  });

  it('returns three choices without starting a browser for an ambiguous query', () => {
    const workflowDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    for (const name of ['创建安选公开直播流程', '创建安选私域直播流程', '创建安选直播预告流程', '删除订单流程']) {
      const saved = runCli([
        'browser-opt',
        'save',
        name,
        '--flow',
        `测试 https://example.com。\\n1. 验证页面包含 "${name}"。`,
        '--workflow-dir',
        workflowDir,
      ]);
      expect(saved.status).toBe(0);
    }

    const result = runCli([
      'browser-opt',
      'run',
      '创建安选直播流程',
      '--workflow-dir',
      workflowDir,
    ], { AGENT_BROWSER_LOG: commandLog });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain('找到多个相似 Workflow');
    expect((result.stdout.match(/^  \d\./gm) ?? [])).toHaveLength(3);
    expect(fs.existsSync(commandLog)).toBe(false);
  });

  it('rejects overwriting a saved Workflow unless --force is used', () => {
    const workflowDir = makeTempDir();
    const args = [
      'browser-opt',
      'save',
      '重复流程',
      '--flow',
      '测试 https://example.com。\\n1. 验证页面包含 "Example"。',
      '--workflow-dir',
      workflowDir,
    ];
    expect(runCli(args).status).toBe(0);

    const duplicate = runCli(args);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain('已存在');
    expect(runCli([...args, '--force']).status).toBe(0);
  });

  it('prints the template and exits non-zero when no flow is provided', () => {
    const result = runCli(['browser-opt']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('通用测试模板');
    expect(result.stdout).toContain('自然语言流程示例');
  });

  it('uses --output-dir and exits zero for a passing flow', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
      '--output-dir',
      outputDir,
    ], { AGENT_BROWSER_LOG: commandLog });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('执行成功');
    expect(result.stdout).not.toContain('Status: PASS');
    expect(result.stdout).not.toContain(outputDir);
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands).not.toContain('--session-name');
    expect(commands).toContain('--profile Default');
    expect(commands).not.toContain('close --all');
    expect(commands).toContain('state save');
    expect(commands).not.toContain('--auto-connect');
    expect(commands).not.toContain('--state ');
    expect(commands).toContain('open https://example.com');
    expect(commands).toContain('--profile Default');
    expect(commands).toContain('--headed open https://example.com');
    expect(commands).toContain('browser-opt-default.json');
    expect(commands).not.toContain('auth-import');
    expect(commands).not.toContain('dashboard start');
    expect(fs.readdirSync(outputDir).some((entry) => fs.existsSync(path.join(outputDir, entry, 'report.json')))).toBe(true);
  });

  it('allows overriding the default profile explicitly', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
      '--profile',
      'Work',
      '--output-dir',
      outputDir,
    ], { AGENT_BROWSER_LOG: commandLog });

    expect(result.status).toBe(0);
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands).toContain('--profile Work');
    expect(commands).not.toContain('--profile Default');
    expect(commands).toContain('state save');
    expect(commands).toContain('browser-opt-work.json');
  });

  it('loads an existing state file instead of using a profile', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const stateDir = makeTempDir();
    const statePath = path.join(stateDir, 'browser-opt-default.json');
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
      '--output-dir',
      outputDir,
    ], { AGENT_BROWSER_LOG: commandLog, BROWSER_OPT_AUTH_STATE_DIR: stateDir });

    expect(result.status).toBe(0);
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands).not.toContain(`state load ${statePath}`);
    expect(commands.match(new RegExp(`--state ${statePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) ?? []).toHaveLength(1);
    expect(commands).toContain(`--state ${statePath} --session`);
    expect(commands).not.toContain('--profile Default');
    expect(commands).not.toContain('--auto-connect');
    expect(commands).toContain('state save');
  });

  it('falls back to the default profile when the default state opens on a login page', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const stateOpenMarker = path.join(makeTempDir(), 'state-opened');
    const stateDir = makeTempDir();
    const statePath = path.join(stateDir, 'browser-opt-default.json');
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
      '--output-dir',
      outputDir,
    ], {
      AGENT_BROWSER_LOG: commandLog,
      AGENT_BROWSER_LOGIN_SNAPSHOT: '1',
      AGENT_BROWSER_LOGIN_SNAPSHOT_STATE_ONLY: '1',
      AGENT_BROWSER_STATE_OPEN_MARKER: stateOpenMarker,
      BROWSER_OPT_AUTH_STATE_DIR: stateDir,
    });

    expect(result.status).toBe(0);
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands.match(new RegExp(`--state ${statePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) ?? []).toHaveLength(1);
    expect(commands).toContain('--profile Default --headed open https://example.com');
    expect(commands).toContain('close');
    expect(commands).toContain(`state save ${statePath}`);
  });

  it('uses an explicit state path when it exists', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const statePath = path.join(makeTempDir(), 'custom-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
      '--state',
      statePath,
      '--output-dir',
      outputDir,
    ], { AGENT_BROWSER_LOG: commandLog });

    expect(result.status).toBe(0);
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands).not.toContain(`state load ${statePath}`);
    expect(commands.match(new RegExp(`--state ${statePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')) ?? []).toHaveLength(1);
    expect(commands).toContain(`--state ${statePath} --session`);
    expect(commands).not.toContain('--profile Default');
    expect(commands).toContain(`state save ${statePath}`);
  });

  it('prints report details when a flow fails', () => {
    const outputDir = makeTempDir();
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Missing"。',
      '--output-dir',
      outputDir,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Status: FAIL');
    expect(result.stdout).toContain('Report JSON:');
    expect(result.stdout).toContain(outputDir);
    expect(result.stdout).toContain('FAIL 1.');
    expect(result.stdout).not.toContain('执行成功');
  });

  it('keeps ordinary deterministic action failures on exit code 1', () => {
    const outputDir = makeTempDir();
    const result = runCli([
      'browser-opt',
      '执行创建安选公开直播流程：https://example.com/live/create\n1. 直播间名称输入“安选公开直播自动化”',
      '--output-dir',
      outputDir,
    ], {
      AGENT_BROWSER_SNAPSHOT_TEXT: '创建直播页',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Status: FAIL');
    expect(result.stdout).not.toContain('Handoff: 已触发');
  });

  it('waits for handoff completion and resumes the target flow after login', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const resumeMarker = path.join(makeTempDir(), 'resume-marker');
    const result = runCli([
      'browser-opt',
      '执行创建安选公开直播流程：\n1. 访问 https://example.com/live/create\n2. 直播间名称输入“安选公开直播自动化”',
      '--output-dir',
      outputDir,
    ], {
      AGENT_BROWSER_LOG: commandLog,
      AGENT_BROWSER_LOGIN_SNAPSHOT: '1',
      AGENT_BROWSER_LOGIN_SNAPSHOT_TEXT: '登录远方的梦想直播平台',
      AGENT_BROWSER_AFTER_RESUME_SNAPSHOT_TEXT: '创建直播页',
      AGENT_BROWSER_LIVE_CREATE_SNAPSHOT: '1',
      AGENT_BROWSER_RESUME_MARKER: resumeMarker,
    }, 'done\n');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('=== Browser Opt Handoff ===');
    expect(result.stdout).toContain('人工操作完成，恢复 browser-opt 自动化执行。');
    expect(result.stdout.trim()).toContain('执行成功');
    expect(result.stdout).not.toContain('Status: HANDOFF');
    expect(result.stdout).not.toContain('Status: FAIL');
    expect(result.stdout).toContain('初始化打开目标页面后检测到登录页跳转');
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands).toContain('handoff');
    expect(commands).toContain('resume');
    expect(commands).toContain('fill @e2 安选公开直播自动化');
    expect(commands).toContain('state save');
  });

  it('prints handoff steps as HANDOFF instead of FAIL', () => {
    const outputDir = makeTempDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result: BrowserOptRunResult = {
      passed: false,
      report: {
        status: 'HANDOFF',
        handoffTriggered: true,
        url: 'https://example.com/live/create',
        flow: '测试 https://example.com/live/create',
        startedAt: '2026-07-08T00:00:00.000Z',
        endedAt: '2026-07-08T00:00:01.000Z',
        durationMs: 1000,
        outputDir,
        reportJsonPath: path.join(outputDir, 'report.json'),
        reportMarkdownPath: path.join(outputDir, 'report.md'),
        logPath: path.join(outputDir, 'run.log'),
        screenshots: [],
        logs: [],
        steps: [{
          index: 1,
          instruction: '验证页面包含 "Dashboard"。',
          passed: false,
          handoffTriggered: true,
          attempts: 1,
          beforeSnapshotPath: path.join(outputDir, '01-before.snapshot.json'),
          afterSnapshotPath: path.join(outputDir, '01-after.snapshot.json'),
          beforeScreenshotPath: path.join(outputDir, '01-before.png'),
          afterScreenshotPath: path.join(outputDir, '01-after.png'),
          verification: '步骤 1 验证时检测到登录页跳转，疑似登录态已失效。',
          logs: [],
        }],
      },
    };

    printBrowserOptResult(result);
    const output = log.mock.calls.map((call) => String(call[0])).join('\n');

    expect(output).toContain('Status: HANDOFF');
    expect(output).toContain('HANDOFF 1. 验证页面包含 "Dashboard"。');
    expect(output).not.toContain('FAIL 1. 验证页面包含 "Dashboard"。');
  });
});
