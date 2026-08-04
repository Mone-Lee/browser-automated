/**
 * 验证 browser-opt setup 能一次安装浏览器运行时与随包发布的 Agent Skill。
 * 测试使用桩 agent-browser，避免下载真实浏览器或修改用户目录。
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

/** 创建可记录安装参数的 agent-browser 桩命令。 */
function createAgentBrowserStub(logPath: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-setup-bin-'));
  temporaryDirectories.push(directory);
  const commandPath = path.join(directory, 'agent-browser');
  fs.writeFileSync(commandPath, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(' '));\n`);
  fs.chmodSync(commandPath, 0o755);
  return directory;
}

describe('browser-opt setup', () => {
  it('installs agent-browser and the bundled Skill into the shared Agent directory by default', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-home-'));
    const commandLog = path.join(home, 'agent-browser.log');
    temporaryDirectories.push(home);
    const binDirectory = createAgentBrowserStub(commandLog);
    const result = spawnSync('node', [path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'), 'setup', '--with-deps'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(commandLog, 'utf-8')).toBe('install --with-deps');
    expect(fs.existsSync(path.join(home, '.agents/skills/browser-opt/SKILL.md'))).toBe(true);
    expect(result.stdout).toContain('已安装 Agent Skill');
    expect(result.stdout).toContain('browser-opt 已就绪');
  });

  it('can install the bundled Skill into Codex explicitly', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-codex-home-'));
    const commandLog = path.join(codexHome, 'agent-browser.log');
    temporaryDirectories.push(codexHome);
    const binDirectory = createAgentBrowserStub(commandLog);
    const result = spawnSync('node', [path.join(projectRoot, 'packages/browser-opt/dist/cli/browser-opt.js'), 'setup', '--agent', 'codex'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env, CODEX_HOME: codexHome, PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(commandLog, 'utf-8')).toBe('install');
    expect(fs.existsSync(path.join(codexHome, 'skills/browser-opt/SKILL.md'))).toBe(true);
    expect(result.stdout).toContain('已安装 Codex Skill');
  });
});
