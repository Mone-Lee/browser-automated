/**
 * 覆盖 browser-opt CLI 的用户侧参数处理，并通过桩命令避免真的启动浏览器会话。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { printBrowserOptResult } from '../../packages/browser-opt/dist/cli/utils/output.js';
import { checkBrowserOptUpdate } from '../../packages/browser-opt/dist/cli/utils/version-check.js';
import type { BrowserOptRunResult } from '../../packages/browser-opt/dist/browser-opt/type.js';

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

interface RunCliOptions {
  cwd?: string;
  useDefaultAuthStateDir?: boolean;
}

function runCli(args: string[], env: Record<string, string> = {}, input?: string, options: RunCliOptions = {}) {
  const authStateDir = makeTempDir();
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  return spawnSync('node', [path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'), ...args.slice(1)], {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf-8',
    input,
    env: {
      ...process.env,
      AGENT_BROWSER_STATE: '',
      ...(options.useDefaultAuthStateDir ? {} : { BROWSER_OPT_AUTH_STATE_DIR: authStateDir }),
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
  if (arg === '--headed' && args[i + 1] === 'false') {
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
  if (loginSnapshot && process.env.AGENT_BROWSER_RESUME_MARKER) {
    if (process.env.AGENT_BROWSER_COMPLETE_LOGIN_AFTER_PROFILE_SNAPSHOT) {
      if (!stateOpened) fs.writeFileSync(process.env.AGENT_BROWSER_RESUME_MARKER, 'manual-login-completed');
    } else {
      fs.writeFileSync(process.env.AGENT_BROWSER_RESUME_MARKER, 'manual-login-completed');
    }
  }
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

function extractLoggedSessions(commands: string): string[] {
  return commands
    .split('\n')
    .map((command) => command.match(/(?:^|\s)--session\s+(\S+)/)?.[1])
    .filter((session): session is string => Boolean(session));
}

function findLatestReportJson(rootDir: string): string {
  const reports = findReportJsonFiles(rootDir).sort();
  const reportPath = reports.at(-1);
  if (!reportPath) {
    throw new Error(`No report.json found under ${rootDir}`);
  }
  return reportPath;
}

/** 轮询后台 Workflow 状态，模拟 Codex 在不同 turn 中通过 runId 重新连接。 */
async function waitForDetachedRunStatus(
  cwd: string,
  runId: string,
  expectedStatus: string,
): Promise<Record<string, unknown>> {
  let lastStatus: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = runCli([
      'browser-opt',
      'status',
      '--run-id',
      runId,
      '--json',
    ], {}, undefined, { cwd });
    lastStatus = JSON.parse(result.stdout) as Record<string, unknown>;
    if (lastStatus.status === expectedStatus) {
      return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`后台 Workflow 未进入状态：${expectedStatus}\n${JSON.stringify(lastStatus, null, 2)}`);
}

function findReportJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const reports: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      reports.push(...findReportJsonFiles(filePath));
    } else if (entry.isFile() && entry.name === 'report.json') {
      reports.push(filePath);
    }
  }
  return reports;
}

describe('browser-opt CLI', () => {
  it('prints the current package version with --version and version', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const expectedVersion = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'packages/browser-opt/package.json'), 'utf-8'),
    ) as { version: string };

    const flagResult = runCli(['browser-opt', '--version']);
    const subcommandResult = runCli(['browser-opt', 'version']);

    expect(flagResult.status).toBe(0);
    expect(flagResult.stdout.trim()).toBe(expectedVersion.version);
    expect(subcommandResult.status).toBe(0);
    expect(subcommandResult.stdout.trim()).toBe(expectedVersion.version);
  });

  it('checks npm latest version with a short-lived local cache', async () => {
    const cacheHome = makeTempDir();
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;
    let requestCount = 0;
    const server = createServer((_, response) => {
      requestCount += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: '999.0.0' }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const registry = `http://127.0.0.1:${port}`;

    try {
      const first = await checkBrowserOptUpdate({ registry, maxAgeMs: 60_000 });
      const second = await checkBrowserOptUpdate({ registry, maxAgeMs: 60_000 });

      expect(first).toEqual(expect.objectContaining({
        status: 'outdated',
        latestVersion: '999.0.0',
        updateCommand: 'browser-opt update',
      }));
      expect(second).toEqual(expect.objectContaining({
        status: 'outdated',
        latestVersion: '999.0.0',
      }));
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      process.env.XDG_CACHE_HOME = originalCacheHome;
    }
  });

  it('returns unknown quickly when registry check stalls', async () => {
    const cacheHome = makeTempDir();
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheHome;
    const server = createServer(() => {
      // 故意不返回响应体，用于模拟 registry 长时间无响应。
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const registry = `http://127.0.0.1:${port}`;

    try {
      const startedAt = Date.now();
      const result = await checkBrowserOptUpdate({ registry, timeoutMs: 500, noCache: true });
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe('unknown');
      expect(typeof result.error).toBe('string');
      expect(elapsedMs).toBeLessThan(2000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      process.env.XDG_CACHE_HOME = originalCacheHome;
    }
  });

  it('falls back to npm view when direct registry check cannot complete', async () => {
    const cacheHome = makeTempDir();
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    const originalNpmExecPath = process.env.npm_execpath;
    process.env.XDG_CACHE_HOME = cacheHome;

    const hangingServer = createServer(() => {
      // 模拟直连 registry 不返回，触发 HTTP 路径超时。
    });
    await new Promise<void>((resolve) => {
      hangingServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = hangingServer.address() as AddressInfo;
    const registry = `http://127.0.0.1:${port}`;

    const npmDir = makeTempDir();
    const npmExecPath = path.join(npmDir, 'npm-cli.js');
    const npmLogPath = path.join(npmDir, 'npm.log');
    fs.writeFileSync(
      npmExecPath,
      `const fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(npmLogPath)}, args.join(' ') + '\\n');\nif (args[0] === 'view') { process.stdout.write('"999.0.0"'); process.exit(0); }\nprocess.exit(1);\n`,
    );
    process.env.npm_execpath = npmExecPath;

    try {
      const result = await checkBrowserOptUpdate({ registry, timeoutMs: 50, noCache: true });
      expect(result.status).toBe('outdated');
      expect(result.latestVersion).toBe('999.0.0');
      const npmLog = fs.readFileSync(npmLogPath, 'utf-8');
      expect(npmLog).toContain('view browser-opt version --json');
    } finally {
      await new Promise<void>((resolve, reject) => {
        hangingServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (originalNpmExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = originalNpmExecPath;
      }
      process.env.XDG_CACHE_HOME = originalCacheHome;
    }
  });

  it('returns immediately on cache miss when background refresh is enabled', async () => {
    const cacheHome = makeTempDir();
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    const originalDisableBackground = process.env.BROWSER_OPT_DISABLE_BACKGROUND_UPDATE_CHECK;
    process.env.XDG_CACHE_HOME = cacheHome;
    process.env.BROWSER_OPT_DISABLE_BACKGROUND_UPDATE_CHECK = '1';

    try {
      const startedAt = Date.now();
      const result = await checkBrowserOptUpdate({ backgroundOnCacheMiss: true });
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe('unknown');
      expect(result.error).toContain('scheduled in background');
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      if (originalDisableBackground === undefined) {
        delete process.env.BROWSER_OPT_DISABLE_BACKGROUND_UPDATE_CHECK;
      } else {
        process.env.BROWSER_OPT_DISABLE_BACKGROUND_UPDATE_CHECK = originalDisableBackground;
      }
      process.env.XDG_CACHE_HOME = originalCacheHome;
    }
  });

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

  it('resumes a detached Workflow handoff by run id across CLI processes', async () => {
    const projectDir = makeTempDir();
    const workflowDir = path.join(projectDir, '.browser-opt', 'workflows');
    const saved = runCli([
      'browser-opt',
      'save',
      '跨会话接管流程',
      '--flow',
      '测试 https://example.com。\\n1. handoff 给操作人员：请手动选择“商品白底图”的本地真实图片，并在确认完成后恢复自动化。',
      '--workflow-dir',
      workflowDir,
    ], {}, undefined, { cwd: projectDir });
    expect(saved.status).toBe(0);

    const started = runCli([
      'browser-opt',
      'start',
      '--workflow-id',
      '跨会话接管流程',
      '--workflow-dir',
      workflowDir,
      '--json',
    ], {}, undefined, { cwd: projectDir });
    expect(started.status).toBe(0);
    const startedRun = JSON.parse(started.stdout) as { runId: string; status: string };
    expect(startedRun.status).toBe('RUNNING');

    const handoff = await waitForDetachedRunStatus(projectDir, startedRun.runId, 'HANDOFF');
    expect(String(handoff.output)).toContain('请手动选择“商品白底图”');

    const resumed = runCli([
      'browser-opt',
      'resume',
      '--run-id',
      startedRun.runId,
      '--json',
    ], {}, undefined, { cwd: projectDir });
    expect(resumed.status).toBe(0);
    expect(JSON.parse(resumed.stdout).status).toBe('RESUME_REQUESTED');

    const completed = await waitForDetachedRunStatus(projectDir, startedRun.runId, 'PASS');
    expect(String(completed.output)).toContain('人工操作完成，恢复 browser-opt 自动化执行。');
    expect(String(completed.output)).toContain('执行成功');
  }, 20_000);

  it('resumes a detached immediate flow by run id without opening a second browser session', async () => {
    const projectDir = makeTempDir();
    const commandLog = path.join(projectDir, 'agent-browser.log');
    const flow = '测试 https://example.com。\n1. handoff 给操作人员：请手动选择“商品白底图”的本地真实图片，并在确认完成后恢复自动化。';
    const started = runCli([
      'browser-opt',
      'start',
      '--flow',
      flow,
      '--json',
    ], { AGENT_BROWSER_LOG: commandLog }, undefined, { cwd: projectDir });
    expect(started.status).toBe(0);
    const startedRun = JSON.parse(started.stdout) as { runId: string; status: string };
    expect(startedRun.status).toBe('RUNNING');

    await waitForDetachedRunStatus(projectDir, startedRun.runId, 'HANDOFF');
    const resumed = runCli([
      'browser-opt',
      'resume',
      '--run-id',
      startedRun.runId,
      '--json',
    ], {}, undefined, { cwd: projectDir });
    expect(resumed.status).toBe(0);

    await waitForDetachedRunStatus(projectDir, startedRun.runId, 'PASS');
    const commands = fs.readFileSync(commandLog, 'utf-8');
    const sessions = extractLoggedSessions(commands);
    expect(new Set(sessions).size).toBe(1);
    expect(commands.split('\n').filter((command) => /\bopen https:\/\/example\.com\b/.test(command))).toHaveLength(1);
  }, 20_000);

  it('reuses a stable browser session when rerunning the same saved Workflow', () => {
    const workflowDir = makeTempDir();
    const firstOutputDir = makeTempDir();
    const secondOutputDir = makeTempDir();
    const firstCommandLog = path.join(makeTempDir(), 'first-agent-browser.log');
    const secondCommandLog = path.join(makeTempDir(), 'second-agent-browser.log');
    const stateDir = makeTempDir();
    fs.writeFileSync(path.join(stateDir, 'browser-opt-default.json'), JSON.stringify({ cookies: [], origins: [] }));
    const saveResult = runCli([
      'browser-opt',
      'save',
      '稳定会话流程',
      '--flow',
      '测试 https://example.com。\\n1. 验证页面包含 "Example"。',
      '--workflow-dir',
      workflowDir,
    ]);
    expect(saveResult.status).toBe(0);

    const first = runCli([
      'browser-opt',
      'run',
      '--workflow-id',
      '稳定会话流程',
      '--workflow-dir',
      workflowDir,
      '--output-dir',
      firstOutputDir,
    ], { AGENT_BROWSER_LOG: firstCommandLog, BROWSER_OPT_AUTH_STATE_DIR: stateDir });
    const second = runCli([
      'browser-opt',
      'run',
      '--workflow-id',
      '稳定会话流程',
      '--workflow-dir',
      workflowDir,
      '--output-dir',
      secondOutputDir,
    ], { AGENT_BROWSER_LOG: secondCommandLog, BROWSER_OPT_AUTH_STATE_DIR: stateDir });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstSessions = extractLoggedSessions(fs.readFileSync(firstCommandLog, 'utf-8'));
    const secondSessions = extractLoggedSessions(fs.readFileSync(secondCommandLog, 'utf-8'));
    expect(new Set(firstSessions).size).toBe(1);
    expect(new Set(secondSessions).size).toBe(1);
    expect(firstSessions[0]).toBe(secondSessions[0]);
    expect(firstSessions[0]).toMatch(/^browser-opt-[a-f0-9]{16}$/);
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
    expect(result.stdout).toContain(`[创建安选公开直播流程](<${path.join(workflowDir, '创建安选公开直播流程.json')}>)`);
    expect((result.stdout.match(/^  \d\./gm) ?? [])).toHaveLength(3);
    expect(fs.existsSync(commandLog)).toBe(false);
  });

  it('includes workflow file paths in machine-readable match output', () => {
    const workflowDir = makeTempDir();
    const saved = runCli([
      'browser-opt',
      'save',
      '创建安选公开直播流程',
      '--flow',
      '测试 https://example.com。\\n1. 验证页面包含 "Example"。',
      '--workflow-dir',
      workflowDir,
    ]);
    expect(saved.status).toBe(0);

    const result = runCli([
      'browser-opt',
      'match',
      '创建安选公开直播流程',
      '--workflow-dir',
      workflowDir,
      '--json',
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'matched',
      matched: {
        id: '创建安选公开直播流程',
        name: '创建安选公开直播流程',
        filePath: path.join(workflowDir, '创建安选公开直播流程.json'),
        displayPath: path.join(workflowDir, '创建安选公开直播流程.json'),
      },
    });
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
    expect(commands.trim().split('\n').every((command) => command.startsWith('--profile Default '))).toBe(true);
    expect(commands).toMatch(/--profile Default --session browser-opt-[a-f0-9]{16} --headed open https:\/\/example\.com/);
    expect(commands.split('\n').filter((command) => /\bopen https:\/\/example\.com\b/.test(command))).toHaveLength(1);
    expect(commands).not.toContain('close');
    expect(commands).toContain('browser-opt-default.json');
    expect(commands).not.toContain('auth-import');
    expect(commands).not.toContain('dashboard start');
    expect(fs.readdirSync(outputDir).some((entry) => fs.existsSync(path.join(outputDir, entry, 'report.json')))).toBe(true);
  });

  it('uses a fresh browser session for each immediate flow execution', () => {
    const stateDir = makeTempDir();
    fs.writeFileSync(path.join(stateDir, 'browser-opt-default.json'), JSON.stringify({ cookies: [], origins: [] }));
    const firstCommandLog = path.join(makeTempDir(), 'first-agent-browser.log');
    const secondCommandLog = path.join(makeTempDir(), 'second-agent-browser.log');
    const args = [
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
      '--output-dir',
      makeTempDir(),
    ];

    expect(runCli(args, { AGENT_BROWSER_LOG: firstCommandLog, BROWSER_OPT_AUTH_STATE_DIR: stateDir }).status).toBe(0);
    args[3] = makeTempDir();
    expect(runCli(args, { AGENT_BROWSER_LOG: secondCommandLog, BROWSER_OPT_AUTH_STATE_DIR: stateDir }).status).toBe(0);

    const firstSessions = extractLoggedSessions(fs.readFileSync(firstCommandLog, 'utf-8'));
    const secondSessions = extractLoggedSessions(fs.readFileSync(secondCommandLog, 'utf-8'));
    expect(new Set(firstSessions).size).toBe(1);
    expect(new Set(secondSessions).size).toBe(1);
    expect(firstSessions[0]).not.toBe(secondSessions[0]);
  });

  it('writes default browser-opt state and artifacts under .browser-opt', () => {
    const projectDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Example"。',
    ], { AGENT_BROWSER_LOG: commandLog }, undefined, { cwd: projectDir, useDefaultAuthStateDir: true });

    const canonicalProjectDir = fs.realpathSync(projectDir);
    const statePath = path.join(canonicalProjectDir, '.browser-opt', 'states', 'browser-opt-default.json');
    const artifactsDir = path.join(canonicalProjectDir, '.browser-opt', 'artifacts');
    expect(result.status).toBe(0);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.readdirSync(artifactsDir).some((entry) => fs.existsSync(path.join(artifactsDir, entry, 'report.json')))).toBe(true);
    expect(fs.readFileSync(commandLog, 'utf-8')).toContain(`state save ${statePath}`);
  });

  it('writes default auth state after an authenticated open even if later steps fail', () => {
    const projectDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Missing"。',
    ], { AGENT_BROWSER_LOG: commandLog }, undefined, { cwd: projectDir, useDefaultAuthStateDir: true });

    const canonicalProjectDir = fs.realpathSync(projectDir);
    const statePath = path.join(canonicalProjectDir, '.browser-opt', 'states', 'browser-opt-default.json');
    expect(result.status).toBe(1);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.readFileSync(commandLog, 'utf-8')).toContain(`state save ${statePath}`);
    const reportPath = findLatestReportJson(projectDir);
    expect(fs.readFileSync(reportPath, 'utf-8')).toContain(`auth-state-mode: profile-import Default, save=${statePath}`);
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
    expect(commands).toContain('open about:blank');
    expect(commands).toContain(`state load ${statePath}`);
    expect(commands).not.toContain(`--state ${statePath}`);
    expect(commands).not.toContain('--profile Default');
    expect(commands).not.toContain('--auto-connect');
    expect(commands).toContain('state save');
    expect(fs.readFileSync(findLatestReportJson(outputDir), 'utf-8')).toContain(`auth-state-mode: state ${statePath}, fallback-profile=Default`);
  });

  it('replaces an invalid default state window with the selected profile', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const resumeMarker = path.join(makeTempDir(), 'resume-marker');
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
      AGENT_BROWSER_COMPLETE_LOGIN_AFTER_PROFILE_SNAPSHOT: '1',
      AGENT_BROWSER_RESUME_MARKER: resumeMarker,
      AGENT_BROWSER_STATE_OPEN_MARKER: stateOpenMarker,
      BROWSER_OPT_AUTH_STATE_DIR: stateDir,
    }, 'done\n');

    expect(result.status).toBe(0);
    const commands = fs.readFileSync(commandLog, 'utf-8');
    expect(commands).toContain('open about:blank');
    expect(commands).toContain(`state load ${statePath}`);
    expect(commands).not.toContain(`--state ${statePath}`);
    expect(commands).toContain('--profile Default');
    const stateSession = commands.split('\n').find((command) => command.includes(`state load ${statePath}`))?.match(/--session\s+(\S+)/)?.[1];
    const profileSession = commands.split('\n').find((command) => command.includes('--profile Default'))?.match(/--session\s+(\S+)/)?.[1];
    expect(stateSession).toBeTruthy();
    expect(profileSession).toBeTruthy();
    expect(profileSession).not.toBe(stateSession);
    expect(commands).toContain('close');
    expect(commands).not.toContain('handoff');
    expect(commands).not.toContain('resume');
    expect(commands.split('\n').filter((command) => /\bopen https:\/\/example\.com\b/.test(command))).toHaveLength(2);
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
    expect(commands).toContain('open about:blank');
    expect(commands).toContain(`state load ${statePath}`);
    expect(commands).not.toContain(`--state ${statePath}`);
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
    expect(result.stdout).toContain('Failed steps:');
    expect(result.stdout).toContain('Reason: 页面未包含文本：Missing');
    expect(result.stdout).not.toContain('执行成功');
  });

  it('prints all failures after continuing through later steps', () => {
    const outputDir = makeTempDir();
    const result = runCli([
      'browser-opt',
      '测试 https://example.com。\n\n目标：\n1. 验证页面包含 "Missing"。\n2. 验证页面包含 "Example"。',
      '--output-dir',
      outputDir,
    ]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Status: FAIL');
    expect(result.stdout).toContain('Failed steps:');
    expect(result.stdout).toContain('  - 1. 验证页面包含 "Missing"。');
    expect(result.stdout).toContain('    Reason: 页面未包含文本：Missing');
    expect(result.stdout).toContain('FAIL 1. 验证页面包含 "Missing"。');
    expect(result.stdout).toContain('PASS 2. 验证页面包含 "Example"。');
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
    expect(commands).not.toContain('handoff');
    expect(commands).not.toContain('resume');
    expect(commands.split('\n').filter((command) => /\bopen https:\/\/example\.com\/live\/create\b/.test(command))).toHaveLength(1);
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
