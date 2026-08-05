/**
 * 验证 browser-opt install 将环境初始化与普通工作流调用分离。
 * 测试使用桩 agent-browser 和 Chrome，避免下载真实浏览器或修改用户目录。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** 创建可按行记录浏览器检查参数的 agent-browser 桩命令。 */
function createAgentBrowserStub(agentBrowserLogPath: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-setup-bin-'));
  temporaryDirectories.push(directory);
  const agentBrowserCommandPath = path.join(directory, 'agent-browser');
  fs.writeFileSync(agentBrowserCommandPath, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(agentBrowserLogPath)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  fs.chmodSync(agentBrowserCommandPath, 0o755);
  return directory;
}

describe('browser-opt install', () => {
  it('checks the existing standard Chrome without downloading a test browser', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    temporaryDirectories.push(home);
    const chromePath = path.join(home, 'Google Chrome');
    fs.writeFileSync(chromePath, 'stub');
    fs.chmodSync(chromePath, 0o755);
    const binDirectory = createAgentBrowserStub(commandLog);
    const result = spawnSync('node', [path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'), 'install'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(commandLog, 'utf-8')).toBe('--version\n');
    expect(fs.existsSync(path.join(home, '.agents/skills/browser-opt/SKILL.md'))).toBe(true);
    expect(result.stdout).toContain('已安装 Agent Skill');
    expect(result.stdout).toContain('browser-opt 已就绪');
  });

  it('keeps setup as an alias and downloads a browser only when explicitly requested', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-codex-home-'));
    const commandLog = path.join(codexHome, 'agent-browser.log');
    temporaryDirectories.push(codexHome);
    const chromePath = path.join(codexHome, 'Google Chrome');
    fs.writeFileSync(chromePath, 'stub');
    fs.chmodSync(chromePath, 0o755);
    const binDirectory = createAgentBrowserStub(commandLog);
    const result = spawnSync('node', [
      path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'),
      'setup',
      '--agent',
      'codex',
      '--download-browser',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(commandLog, 'utf-8')).toBe('--version\ninstall\n');
    expect(fs.existsSync(path.join(codexHome, 'skills/browser-opt/SKILL.md'))).toBe(true);
    expect(result.stdout).toContain('已安装 Codex Skill');
  });
});
