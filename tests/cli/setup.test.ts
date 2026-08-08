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

/** 创建可按行记录 npm 与 agent-browser 调用的桩命令。 */
function createSetupCommandStubs(agentBrowserLogPath: string, npmLogPath: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-setup-bin-'));
  temporaryDirectories.push(directory);
  const agentBrowserCommandPath = path.join(directory, 'agent-browser');
  fs.writeFileSync(agentBrowserCommandPath, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(agentBrowserLogPath)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  fs.chmodSync(agentBrowserCommandPath, 0o755);
  const npmCommandPath = path.join(directory, 'npm');
  fs.writeFileSync(npmCommandPath, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(npmLogPath)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  fs.chmodSync(npmCommandPath, 0o755);
  return directory;
}

function createNpmExecStub(directory: string, npmLogPath: string): string {
  const npmExecPath = path.join(directory, 'npm-cli.js');
  fs.writeFileSync(
    npmExecPath,
    `const { spawnSync } = require('node:child_process');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(npmLogPath)}, 'exec:' + args.join(' ') + '\\n');\nconst npmPath = path.join(${JSON.stringify(directory)}, 'npm');\nconst result = spawnSync(npmPath, args, { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`,
  );
  return npmExecPath;
}

function readLoggedCommands(logPath: string): string[] {
  return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter((line) => line.length > 0);
}

describe('browser-opt install', () => {
  it('checks the existing standard Chrome without downloading a test browser', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    const npmLog = path.join(home, 'npm.log');
    temporaryDirectories.push(home);
    const chromePath = path.join(home, 'Google Chrome');
    fs.writeFileSync(chromePath, 'stub');
    fs.chmodSync(chromePath, 0o755);
    const binDirectory = createSetupCommandStubs(commandLog, npmLog);
    const result = spawnSync('node', [path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'), 'install'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        npm_execpath: '',
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      },
    });

    expect(result.status).toBe(0);
    const npmCommands = readLoggedCommands(npmLog);
    expect(npmCommands.slice(0, 2)).toEqual([
      'install -g browser-opt@latest --registry=https://registry.npmjs.org/',
      'install -g agent-browser@latest --registry=https://registry.npmjs.org/',
    ]);
    expect(npmCommands).toContain('prefix -g --registry=https://registry.npmjs.org/');
    expect(fs.readFileSync(commandLog, 'utf-8')).toBe('--version\n');
    const installedSkillPath = path.join(home, '.agents/skills/browser-opt/SKILL.md');
    expect(fs.existsSync(installedSkillPath)).toBe(true);
    expect(fs.readFileSync(installedSkillPath, 'utf-8')).toContain('browser-opt check-update --json');
    expect(result.stdout).toContain('已安装 Agent Skill');
    expect(result.stdout).toContain('browser-opt 已就绪');
  });

  it('keeps setup as an alias, supports Claude Code and downloads a browser only when explicitly requested', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-claude-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    const npmLog = path.join(home, 'npm.log');
    temporaryDirectories.push(home);
    const chromePath = path.join(home, 'Google Chrome');
    fs.writeFileSync(chromePath, 'stub');
    fs.chmodSync(chromePath, 0o755);
    const binDirectory = createSetupCommandStubs(commandLog, npmLog);
    const result = spawnSync('node', [
      path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'),
      'setup',
      '--agent',
      'claude',
      '--download-browser',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        npm_execpath: '',
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      },
    });

    expect(result.status).toBe(0);
    const npmCommands = readLoggedCommands(npmLog);
    expect(npmCommands.slice(0, 2)).toEqual([
      'install -g browser-opt@latest --registry=https://registry.npmjs.org/',
      'install -g agent-browser@latest --registry=https://registry.npmjs.org/',
    ]);
    expect(npmCommands).toContain('prefix -g --registry=https://registry.npmjs.org/');
    expect(fs.readFileSync(commandLog, 'utf-8')).toBe('--version\ninstall\n');
    expect(fs.existsSync(path.join(home, '.claude/skills/browser-opt/SKILL.md'))).toBe(true);
    expect(result.stdout).toContain('已安装 Claude Code Skill');
  });

  it('updates the CLI, runtime and shared Skill with one command', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-update-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    const npmLog = path.join(home, 'npm.log');
    temporaryDirectories.push(home);
    const chromePath = path.join(home, 'Google Chrome');
    fs.writeFileSync(chromePath, 'stub');
    fs.chmodSync(chromePath, 0o755);
    const binDirectory = createSetupCommandStubs(commandLog, npmLog);

    const result = spawnSync('node', [
      path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'),
      'update',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        npm_execpath: '',
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      },
    });

    expect(result.status).toBe(0);
    const npmCommands = readLoggedCommands(npmLog);
    expect(npmCommands.slice(0, 2)).toEqual([
      'install -g browser-opt@latest --registry=https://registry.npmjs.org/',
      'install -g agent-browser@latest --registry=https://registry.npmjs.org/',
    ]);
    expect(npmCommands).toContain('prefix -g --registry=https://registry.npmjs.org/');
    expect(fs.existsSync(path.join(home, '.agents/skills/browser-opt/SKILL.md'))).toBe(true);
  });

  it('keeps update compatible when npm_execpath is provided', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-update-prefix-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    const npmLog = path.join(home, 'npm.log');
    temporaryDirectories.push(home);
    const chromePath = path.join(home, 'Google Chrome');
    fs.writeFileSync(chromePath, 'stub');
    fs.chmodSync(chromePath, 0o755);
    const binDirectory = createSetupCommandStubs(commandLog, npmLog);
    const npmExecPath = createNpmExecStub(binDirectory, npmLog);

    const result = spawnSync('node', [
      path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'),
      'update',
    ], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        npm_execpath: npmExecPath,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
      },
    });

    expect(result.status).toBe(0);
    const npmCommands = readLoggedCommands(npmLog);
    expect(npmCommands).toContain('exec:install -g browser-opt@latest --registry=https://registry.npmjs.org/');
    expect(npmCommands).toContain('exec:install -g agent-browser@latest --registry=https://registry.npmjs.org/');
    expect(npmCommands).toContain('exec:prefix -g --registry=https://registry.npmjs.org/');
    expect(fs.existsSync(path.join(home, '.agents/skills/browser-opt/SKILL.md'))).toBe(true);
  });

  it('uninstalls the global runtime, installed Skill and optional project data', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-project-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-uninstall-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    const npmLog = path.join(home, 'npm.log');
    const skillDir = path.join(home, '.agents/skills/browser-opt');
    const dataDir = path.join(projectDir, '.browser-opt/states');
    temporaryDirectories.push(projectDir, home);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'stub');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
    const binDirectory = createSetupCommandStubs(commandLog, npmLog);

    const result = spawnSync('node', [
      path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'),
      'uninstall',
      '--all-data',
    ], {
      cwd: projectDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        npm_execpath: '',
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(npmLog, 'utf-8')).toBe(
      'uninstall -g browser-opt agent-browser --registry=https://registry.npmjs.org/\n',
    );
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.browser-opt'))).toBe(false);
    expect(result.stdout).toContain('browser-opt 运行依赖已清理');
  });
});
