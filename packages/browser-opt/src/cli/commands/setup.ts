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
  installRuntime: boolean;
  installSystemDependencies: boolean;
  downloadBrowser: boolean;
  installSkill: boolean;
  agent?: string;
  skillsDir?: string;
}

interface BrowserOptUninstallOptions {
  uninstallRuntime: boolean;
  uninstallSkill: boolean;
  removeAllData: boolean;
  agent?: string;
  skillsDir?: string;
}

const AGENT_BROWSER_PACKAGE = 'agent-browser@latest';
const AGENT_BROWSER_INSTALL_HINT = '请先安装 agent-browser，例如：npm install -g agent-browser。';

/** 安装或更新 browser-opt 的外部运行时，并把随包发布的 Skill 放到目标 Agent 目录。 */
export function setupBrowserOpt(options: BrowserOptSetupOptions): void {
  if (!options.installRuntime && options.downloadBrowser) {
    throw new Error('--download-browser 需要同时安装运行时，请移除 --skip-runtime。');
  }
  if (options.installRuntime) {
    installAgentBrowserRuntime();
    verifyAgentBrowserRuntime();
  }

  let chromePath = options.installRuntime ? resolveSystemChromeExecutable() : null;
  if (options.installRuntime && !chromePath && !options.downloadBrowser) {
    throw new Error('未找到系统标准 Chrome。请先安装 Google Chrome；如确需测试浏览器，可显式传入 --download-browser。');
  }
  if (options.downloadBrowser) {
    const installArgs = ['install', ...(options.installSystemDependencies ? ['--with-deps'] : [])];
    const result = spawnSync('agent-browser', installArgs, { stdio: 'inherit' });
    if (result.error) {
      throw new Error(`无法启动 agent-browser：${result.error.message}。${AGENT_BROWSER_INSTALL_HINT}`);
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
  console.log(options.installRuntime ? `浏览器环境：${chromePath}` : '浏览器运行时：已跳过');
  console.log('browser-opt 已就绪。');
}

/** 卸载 install 写入的全局运行时、Skill，以及按需删除当前项目的运行数据。 */
export function uninstallBrowserOpt(options: BrowserOptUninstallOptions): void {
  if (options.uninstallRuntime) {
    uninstallAgentBrowserRuntime();
  }

  if (options.uninstallSkill) {
    const { label, targetDir } = resolveSkillInstallTarget('browser-opt', {
      agent: options.agent,
      skillsDir: options.skillsDir,
    });
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(`已卸载 ${label}：${targetDir}`);
  }

  if (options.removeAllData) {
    const dataDir = path.resolve(process.cwd(), '.browser-opt');
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(`已删除项目数据：${dataDir}`);
  }

  console.log('browser-opt 运行依赖已清理。');
}

/** 通过 npm 全局安装或更新运行时，使 npx browser-opt@latest 可以保持轻量。 */
function installAgentBrowserRuntime(): void {
  const result = spawnNpm(['install', '-g', AGENT_BROWSER_PACKAGE]);
  if (result.error) {
    throw new Error(`无法安装 agent-browser：${result.error.message}。`);
  }
  if (result.status !== 0) {
    throw new Error(`agent-browser 安装失败（退出码 ${result.status ?? 'unknown'}）。`);
  }
}

/** 卸载 install 安装的全局运行时，失败时直接暴露 npm 诊断。 */
function uninstallAgentBrowserRuntime(): void {
  const result = spawnNpm(['uninstall', '-g', 'agent-browser']);
  if (result.error) {
    throw new Error(`无法卸载 agent-browser：${result.error.message}。`);
  }
  if (result.status !== 0) {
    throw new Error(`agent-browser 卸载失败（退出码 ${result.status ?? 'unknown'}）。`);
  }
}

/** 安装后再探测一次 CLI，保证后续 run/start 能给出确定的运行时状态。 */
function verifyAgentBrowserRuntime(): void {
  const probe = spawnSync('agent-browser', ['--version'], { encoding: 'utf-8' });
  if (probe.error) {
    throw new Error(`无法启动 agent-browser：${probe.error.message}。${AGENT_BROWSER_INSTALL_HINT}`);
  }
  if (probe.status !== 0) {
    throw new Error(`agent-browser 环境检查失败（退出码 ${probe.status ?? 'unknown'}）。`);
  }
}

function spawnNpm(args: string[]): ReturnType<typeof spawnSync> {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' });
  }
  return spawnSync('npm', args, { stdio: 'inherit' });
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
