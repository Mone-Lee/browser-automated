/**
 * 独立检查 browser-opt 运行环境并安装 Agent Skill，普通工作流不再承担任何安装职责。
 * 默认要求本机已有标准 Chrome；只有显式请求时才下载测试浏览器作为兜底。
 */
import { resolveSystemChromeExecutable } from '#browser-core/browser-executable';
import { resolveSkillInstallTarget } from '#browser-core/skill-install';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface BrowserOptSetupOptions {
  installSystemDependencies: boolean;
  downloadBrowser: boolean;
  installSkill: boolean;
  agent?: string;
  skillsDir?: string;
}

/** 检查 CLI 与系统 Chrome，并在需要时把 browser-opt Skill 放到目标 Agent 的用户级目录。 */
export function setupBrowserOpt(options: BrowserOptSetupOptions): void {
  const probe = spawnSync('agent-browser', ['--version'], { encoding: 'utf-8' });
  if (probe.error) {
    throw new Error(`无法启动 agent-browser：${probe.error.message}`);
  }
  if (probe.status !== 0) {
    throw new Error(`agent-browser 环境检查失败（退出码 ${probe.status ?? 'unknown'}）。`);
  }

  let chromePath = resolveSystemChromeExecutable();
  if (!chromePath && !options.downloadBrowser) {
    throw new Error('未找到系统标准 Chrome。请先安装 Google Chrome；如确需测试浏览器，可显式传入 --download-browser。');
  }
  if (options.downloadBrowser) {
    const installArgs = ['install', ...(options.installSystemDependencies ? ['--with-deps'] : [])];
    const result = spawnSync('agent-browser', installArgs, { stdio: 'inherit' });
    if (result.error) {
      throw new Error(`无法启动 agent-browser：${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`agent-browser install 失败（退出码 ${result.status ?? 'unknown'}）。`);
    }
    chromePath = chromePath ?? 'agent-browser 下载的测试浏览器';
  }

  if (options.installSkill) {
    const { label, targetDir } = resolveSkillInstallTarget('browser-opt', {
      agent: options.agent,
      skillsDir: options.skillsDir,
    });
    fs.cpSync(resolveBundledSkillDir(), targetDir, { recursive: true, force: true });
    console.log(`已安装 ${label}：${targetDir}`);
  }
  console.log(`浏览器环境：${chromePath}`);
  console.log('browser-opt 已就绪。');
}

/** 从编译后的 CLI 位置反查 npm 包内随包发布的 browser-opt Skill。 */
function resolveBundledSkillDir(): string {
  return path.join(resolveBundledPackageDir(), 'skills/browser-opt');
}

/** 从编译后的 CLI 位置解析 browser-opt npm 包根目录。 */
function resolveBundledPackageDir(): string {
  const commandDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(commandDir, '../../..');
}
