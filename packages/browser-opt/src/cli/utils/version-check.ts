/**
 * 提供 browser-opt 自检 npm 最新版本的轻量能力。
 * 检查直接访问 registry HTTP 接口，不依赖 npm 命令或本地 npm cache。
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrowserOptUpdateCheckResult {
  status: 'up-to-date' | 'outdated' | 'unknown';
  currentVersion: string;
  latestVersion?: string;
  updateCommand: string;
  error?: string;
}

interface NpmLatestPackageMetadata {
  version?: unknown;
}

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 1200;
const DEFAULT_UPDATE_CHECK_MAX_AGE_MS = 10 * 60 * 1000;
const PACKAGE_NAME = 'browser-opt';

/** 读取当前包版本并与 npm registry 的 latest 元数据比较，失败时返回 unknown。 */
export async function checkBrowserOptUpdate(options: {
  registry?: string;
  timeoutMs?: number;
  maxAgeMs?: number;
  noCache?: boolean;
  backgroundOnCacheMiss?: boolean;
} = {}): Promise<BrowserOptUpdateCheckResult> {
  const currentVersion = readCurrentPackageVersion();
  const updateCommand = 'browser-opt update';
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_UPDATE_CHECK_MAX_AGE_MS;
  // 默认优先走本地缓存：命中后完全不发网络请求，确保 Skill 前置检查延迟可控。
  if (!options.noCache) {
    const cached = readCachedUpdateCheck(currentVersion, updateCommand, maxAgeMs);
    if (cached) {
      return cached;
    }
    // 给 Skill 默认提供“首轮不阻塞”模式：缓存未命中时立即返回，再后台刷新缓存。
    if (options.backgroundOnCacheMiss) {
      triggerBackgroundUpdateCheck(options.registry, options.timeoutMs);
      return {
        status: 'unknown',
        currentVersion,
        updateCommand,
        error: 'update check scheduled in background (cache miss)',
      };
    }
  }

  try {
    const registry = options.registry ?? DEFAULT_NPM_REGISTRY;
    const timeoutMs = options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS;
    let latestVersion: string | undefined;
    try {
      latestVersion = await fetchLatestVersion(registry, timeoutMs);
    } catch {
      latestVersion = undefined;
    }
    latestVersion = latestVersion ?? fetchLatestVersionViaNpm(registry, timeoutMs);
    if (!latestVersion) {
      return {
        status: 'unknown',
        currentVersion,
        updateCommand,
        error: 'registry response does not include a valid version',
      };
    }

    const result: BrowserOptUpdateCheckResult = {
      status: compareVersions(currentVersion, latestVersion) < 0 ? 'outdated' : 'up-to-date',
      currentVersion,
      latestVersion,
      updateCommand,
    };
    writeCachedUpdateCheck(result);
    return result;
  } catch (error) {
    // 任何网络异常都降级为 unknown，调用方继续主流程，不把版本检查变成阻塞点。
    const result: BrowserOptUpdateCheckResult = {
      status: 'unknown',
      currentVersion,
      updateCommand,
      error: error instanceof Error ? error.message : String(error),
    };
    // 网络异常同样写缓存，避免 Skill 每次启动都重复触发慢请求。
    writeCachedUpdateCheck(result);
    return result;
  }
}

function readCachedUpdateCheck(
  currentVersion: string,
  updateCommand: string,
  maxAgeMs: number,
): BrowserOptUpdateCheckResult | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveCachePath(), 'utf-8')) as BrowserOptUpdateCheckResult & {
      checkedAt?: unknown;
    };
    const checkedAt = typeof parsed.checkedAt === 'string' ? Date.parse(parsed.checkedAt) : NaN;
    // 超过最大缓存年龄就强制回源，避免长期使用过期版本信息。
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > maxAgeMs) {
      return undefined;
    }
    // 当前 CLI 版本变化后不复用旧缓存，防止跨版本误判。
    if (parsed.currentVersion !== currentVersion) {
      return undefined;
    }
    return {
      status: parsed.status,
      currentVersion,
      latestVersion: parsed.latestVersion,
      updateCommand,
      error: parsed.error,
    };
  } catch {
    return undefined;
  }
}

function writeCachedUpdateCheck(result: BrowserOptUpdateCheckResult): void {
  try {
    const cachePath = resolveCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ ...result, checkedAt: new Date().toISOString() }, null, 2));
  } catch {
    // 缓存失败不影响版本检查结果。
  }
}

function resolveWarmupLockPath(): string {
  return path.join(path.dirname(resolveCachePath()), 'update-check.warmup.lock');
}

/**
 * 后台刷新采用轻量锁避免重复拉起：60 秒内最多启动一次刷新子进程。
 */
function triggerBackgroundUpdateCheck(registry?: string, timeoutMs?: number): void {
  try {
    if (process.env.BROWSER_OPT_DISABLE_BACKGROUND_UPDATE_CHECK === '1') {
      return;
    }
    const lockPath = resolveWarmupLockPath();
    const now = Date.now();
    const lockRaw = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf-8') : '';
    const startedAt = Number.parseInt(lockRaw, 10);
    if (Number.isFinite(startedAt) && now - startedAt < 60_000) {
      return;
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(now));

    const cliPath = process.argv[1];
    if (!cliPath || !fs.existsSync(cliPath)) {
      return;
    }

    const args = [cliPath, 'check-update', '--no-cache', '--json'];
    if (registry) {
      args.push('--registry', registry);
    }
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      args.push('--timeout-ms', String(timeoutMs));
    }
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        BROWSER_OPT_BACKGROUND_UPDATE_CHECK: '1',
      },
    });
    child.unref();
  } catch {
    // 后台刷新失败不影响前台流程，调用方保持 unknown 并继续执行。
  }
}

/**
 * 使用用户缓存目录而非项目目录，保证跨仓库/跨会话共用一次检查结果。
 */
function resolveCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'browser-opt', 'update-check.json');
}

/** 将版本检查结果输出成给 Skill 稳定解析的 JSON 或人类可读提示。 */
export function printBrowserOptUpdateCheck(
  result: BrowserOptUpdateCheckResult,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === 'outdated') {
    console.log(`browser-opt 有新版本：${result.currentVersion} -> ${result.latestVersion}`);
    console.log(`更新命令：${result.updateCommand}`);
    return;
  }
  if (result.status === 'up-to-date') {
    console.log(`browser-opt 已是最新版本：${result.currentVersion}`);
    return;
  }
  console.log(`无法检查 browser-opt 最新版本：${result.error ?? 'unknown error'}`);
}

async function fetchLatestVersion(registry: string, timeoutMs: number): Promise<string | undefined> {
  const endpoint = new URL(`${PACKAGE_NAME}/latest`, normalizeRegistryUrl(registry));
  const metadata = await requestJsonWithTimeout(endpoint, timeoutMs) as NpmLatestPackageMetadata;
  return typeof metadata.version === 'string' ? metadata.version : undefined;
}

/**
 * 当直连 registry 失败时，再走 npm view 作为兜底。
 * 该路径可复用用户已有的 npmrc、企业镜像与代理配置，降低长期 unknown 的概率。
 */
function fetchLatestVersionViaNpm(registry: string, timeoutMs: number): string | undefined {
  const args = ['view', PACKAGE_NAME, 'version', '--json', `--registry=${registry}`];
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs })
    : spawnSync('npm', args, { encoding: 'utf-8', stdio: 'pipe', timeout: timeoutMs });
  if (result.status !== 0 || !result.stdout.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (typeof parsed === 'string') {
      return parsed;
    }
  } catch {
    // 某些 npm 版本返回纯文本版本号，不是 JSON 字符串。
  }

  const plain = result.stdout.trim().replace(/^"|"$/gu, '');
  return plain.length > 0 ? plain : undefined;
}

function normalizeRegistryUrl(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`;
}

/**
 * 用原生 HTTP(S) 请求实现硬超时，超时时主动 destroy request，避免网络异常场景拖慢 Skill 前置检查。
 */
function requestJsonWithTimeout(url: URL, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'http:' ? http : https;
    const request = client.request(url, { method: 'GET', headers: { accept: 'application/json' } }, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`registry returned HTTP ${statusCode}`));
        return;
      }

      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    const timeout = setTimeout(() => {
      request.destroy(new Error(`update check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.on('close', () => {
      clearTimeout(timeout);
    });
    request.end();
  });
}

/** 读取当前 browser-opt CLI 所在包的版本号，供版本展示和更新检查共用。 */
export function readCurrentPackageVersion(): string {
  const packagePath = path.join(resolvePackageDir(), 'package.json');
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf-8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`无法读取 ${PACKAGE_NAME} 当前版本。`);
  }
  return parsed.version;
}

function resolvePackageDir(): string {
  const commandDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(commandDir, '../../..');
}

function compareVersions(current: string, latest: string): number {
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);
  for (let index = 0; index < Math.max(currentParts.length, latestParts.length); index += 1) {
    const diff = (currentParts[index] ?? 0) - (latestParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function parseVersion(version: string): number[] {
  return version
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}
