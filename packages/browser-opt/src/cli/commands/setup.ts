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
  mode?: 'install' | 'setup' | 'update';
  preferCurrentInstallPrefix?: boolean;
  registry?: string;
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
const BROWSER_OPT_PACKAGE = 'browser-opt@latest';
const AGENT_BROWSER_INSTALL_HINT = '请先安装 agent-browser，例如：npm install -g agent-browser。';
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** 安装或更新 browser-opt 的外部运行时，并把随包发布的 Skill 放到目标 Agent 目录。 */
export function setupBrowserOpt(options: BrowserOptSetupOptions): void {
  const installPrefix = options.preferCurrentInstallPrefix ? resolveCurrentInstallPrefix() : undefined;
  let installedVersion: string | undefined;
  if (!options.installRuntime && options.downloadBrowser) {
    throw new Error('--download-browser 需要同时安装运行时，请移除 --skip-runtime。');
  }
  if (options.installRuntime) {
    installBrowserOptRuntime(options.registry, installPrefix);
    installAgentBrowserRuntime(options.registry, installPrefix);
    verifyAgentBrowserRuntime();
    installedVersion = printInstalledBrowserOptVersion(options.registry, installPrefix);
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
  if (options.mode === 'update' && installedVersion) {
    console.log(`update 后版本：${installedVersion}`);
  }
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

/** 通过 npm 全局安装或更新 browser-opt，让 Skill 日常调用无需再执行 npx。 */
function installBrowserOptRuntime(registry?: string, installPrefix?: string): void {
  const result = spawnNpm(['install', '-g', BROWSER_OPT_PACKAGE], registry, installPrefix);
  if (result.error) {
    throw new Error(`无法安装 browser-opt：${result.error.message}。`);
  }
  if (result.status !== 0) {
    throw new Error(`browser-opt 安装失败（退出码 ${result.status ?? 'unknown'}）。`);
  }
}

/** 通过 npm 全局安装或更新外部浏览器运行时，避免普通 Workflow 调用重复拉取。 */
function installAgentBrowserRuntime(registry?: string, installPrefix?: string): void {
  const result = spawnNpm(['install', '-g', AGENT_BROWSER_PACKAGE], registry, installPrefix);
  if (result.error) {
    throw new Error(`无法安装 agent-browser：${result.error.message}。`);
  }
  if (result.status !== 0) {
    throw new Error(`agent-browser 安装失败（退出码 ${result.status ?? 'unknown'}）。`);
  }
}

/** 卸载 install 安装的全局运行时，失败时直接暴露 npm 诊断。 */
function uninstallAgentBrowserRuntime(): void {
  const result = spawnNpm(['uninstall', '-g', 'browser-opt', 'agent-browser']);
  if (result.error) {
    throw new Error(`无法卸载 browser-opt/agent-browser：${result.error.message}。`);
  }
  if (result.status !== 0) {
    throw new Error(`browser-opt/agent-browser 卸载失败（退出码 ${result.status ?? 'unknown'}）。`);
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

/** 读取本次 npm 全局安装落盘的精确 browser-opt 路径，并提示 PATH 是否仍指向别处。 */
function printInstalledBrowserOptVersion(registry?: string, installPrefix?: string): string | undefined {
  try {
    const installedBinaryPath = resolveInstalledBrowserOptBinary(registry, installPrefix);
    const resolvedShellPath = resolveShellBrowserOptPath();
    const versionBinaryPath = installedBinaryPath ?? resolvedShellPath;
    if (!versionBinaryPath) {
      return undefined;
    }
    const result = spawnSync(versionBinaryPath, ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
    if (result.status === 0 && result.stdout.trim()) {
      const installedVersion = result.stdout.trim();
      console.log(`browser-opt 已更新至版本：${installedVersion}`);
      console.log(`browser-opt 安装路径：${versionBinaryPath}`);
      if (resolvedShellPath && resolvedShellPath !== installedBinaryPath) {
        console.warn(`当前 shell 的 browser-opt 指向：${resolvedShellPath}`);
        console.warn('当前 shell 没有优先使用刚安装的 browser-opt；请调整 PATH、重开终端，或先直接运行上面的安装路径。');
      }
      return installedVersion;
    }
  } catch {
    // 版本探测失败不影响安装结果。
  }
  return undefined;
}

/**
 * install/update 完成后，通过 npm prefix 反查本次落盘的全局 bin 目录。
 * 这样可以避免 shell 仍指向旧路径时误读版本，先确认“新二进制实际在哪里”。
 */
function resolveInstalledBrowserOptBinary(registry?: string, installPrefix?: string): string | undefined {
  const prefix = captureNpmOutput(['prefix', '-g'], registry, installPrefix) ?? installPrefix;
  if (!prefix) {
    return undefined;
  }
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const executableName = process.platform === 'win32' ? 'browser-opt.cmd' : 'browser-opt';
  const executablePath = path.join(binDir, executableName);
  return fs.existsSync(executablePath) ? executablePath : undefined;
}

/**
 * 读取当前 shell 可执行解析结果，用于和“新安装路径”比对。
 * 仅用于提示 PATH 漂移，不参与安装成功判定。
 */
function resolveShellBrowserOptPath(): string | undefined {
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
  const lookupResult = spawnSync(lookupCommand, ['browser-opt'], { encoding: 'utf-8', stdio: 'pipe' });
  if (lookupResult.status !== 0) {
    return undefined;
  }
  return lookupResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * update 模式优先使用“当前正在执行的安装前缀”。
 * 目的是在多前缀环境（如 nvm/Homebrew/系统 npm 并存）里就地覆盖当前来源，减少更新后命令仍旧版本的概率。
 */
function resolveCurrentInstallPrefix(): string | undefined {
  const packageDir = resolveBundledPackageDir();
  const nodeModulesDir = path.dirname(packageDir);
  if (path.basename(nodeModulesDir) !== 'node_modules') {
    return undefined;
  }

  const parentDir = path.dirname(nodeModulesDir);
  if (process.platform === 'win32') {
    return parentDir;
  }
  if (path.basename(parentDir) === 'lib') {
    return path.dirname(parentDir);
  }
  return parentDir;
}

/**
 * 统一 npm 调用入口：优先复用 npm_execpath，兼容 npm/yarn/pnpm 代理启动场景。
 * 这样 update/install 在被其它包管理器包装时仍能走同一执行链路。
 */
function spawnNpm(
  args: string[],
  registry = DEFAULT_NPM_REGISTRY,
  installPrefix?: string,
): ReturnType<typeof spawnSync> {
  const commandArgs = withNpmTargetArgs(args, registry, installPrefix);
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...commandArgs], { stdio: 'inherit' });
  }
  return spawnSync('npm', commandArgs, { stdio: 'inherit' });
}

/**
 * 只在需要读取 stdout 的场景（如 npm prefix -g）使用 pipe，避免把普通安装输出吞掉。
 */
function captureNpmOutput(args: string[], registry = DEFAULT_NPM_REGISTRY, installPrefix?: string): string | undefined {
  const commandArgs = withNpmTargetArgs(args, registry, installPrefix);
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...commandArgs], { encoding: 'utf-8', stdio: 'pipe' })
    : spawnSync('npm', commandArgs, { encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) {
    return undefined;
  }
  const output = result.stdout.trim();
  return output || undefined;
}

/**
 * 所有 npm 调用都统一附带 registry；仅在提供 installPrefix 时追加 --prefix。
 * 这样可以保持参数顺序稳定，便于测试桩按行记录并断言。
 */
function withNpmTargetArgs(args: string[], registry: string, installPrefix?: string): string[] {
  const prefixArgs = installPrefix ? ['--prefix', installPrefix] : [];
  return [...args, ...prefixArgs, `--registry=${registry}`];
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
