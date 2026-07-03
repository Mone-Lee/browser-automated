/**
 * 覆盖 browser-opt CLI 的用户侧参数处理，并通过桩命令避免真的启动浏览器会话。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    encoding: 'utf-8',
    env: {
      ...process.env,
      AGENT_BROWSER_STATE: '',
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
const optionsWithValues = new Set(['--profile', '--state', '--session', '--args', '--output-dir']);
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
  process.stdout.write('opened');
} else if (command === 'snapshot') {
  process.stdout.write(JSON.stringify({ success: true, data: { snapshot: 'Example page', refs: { e1: { role: 'heading', name: 'Example' } } } }));
} else if (command === 'screenshot') {
  const target = args[args.length - 1];
  if (target && target.endsWith('.png')) fs.writeFileSync(target, 'png');
  process.stdout.write(target || '/tmp/screenshot.png');
} else if (command === 'fill') {
  process.stdout.write('filled');
} else if (command === 'click') {
  process.stdout.write('clicked');
} else if (command === 'chat') {
  process.stdout.write(JSON.stringify({ success: true, text: 'Done' }));
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
    expect(commands).not.toContain('--profile Default');
    expect(commands).toContain('open https://example.com');
    expect(commands).toContain('--headed --args --disable-session-crashed-bubble,--no-first-run,--no-default-browser-check open https://example.com');
    expect(commands).not.toContain('--auto-connect');
    expect(commands).not.toContain('auth-import');
    expect(commands).not.toContain('dashboard start');
    expect(commands).not.toContain('close');
    expect(fs.readdirSync(outputDir).some((entry) => fs.existsSync(path.join(outputDir, entry, 'report.json')))).toBe(true);
  });

  it('uses --state directly without auto-connect or profile import', () => {
    const outputDir = makeTempDir();
    const commandLog = path.join(makeTempDir(), 'agent-browser.log');
    const statePath = path.join(makeTempDir(), 'auth-state.json');
    fs.writeFileSync(statePath, '{}');

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
    expect(commands).toContain(`--state ${statePath}`);
    expect(commands).toContain('--headed --args --disable-session-crashed-bubble,--no-first-run,--no-default-browser-check open https://example.com');
    expect(commands).not.toContain('--profile Default');
    expect(commands).not.toContain('--auto-connect');
    expect(commands).not.toContain('auth-import');
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
});
