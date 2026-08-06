/**
 * 提供 browser-opt 自检 npm 最新版本的轻量能力。
 * 检查直接访问 registry HTTP 接口，不依赖 npm 命令或本地 npm cache。
 */
import * as fs from 'node:fs';
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
} = {}): Promise<BrowserOptUpdateCheckResult> {
  const currentVersion = readCurrentPackageVersion();
  const updateCommand = 'browser-opt update';
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_UPDATE_CHECK_MAX_AGE_MS;
  if (!options.noCache) {
    const cached = readCachedUpdateCheck(currentVersion, updateCommand, maxAgeMs);
    if (cached) {
      return cached;
    }
  }

  try {
    const latestVersion = await fetchLatestVersion(
      options.registry ?? DEFAULT_NPM_REGISTRY,
      options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
    );
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
    return {
      status: 'unknown',
      currentVersion,
      updateCommand,
      error: error instanceof Error ? error.message : String(error),
    };
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
    if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > maxAgeMs) {
      return undefined;
    }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const endpoint = new URL(`${PACKAGE_NAME}/latest`, normalizeRegistryUrl(registry));
    const response = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`registry returned HTTP ${response.status}`);
    }
    const metadata = await response.json() as NpmLatestPackageMetadata;
    return typeof metadata.version === 'string' ? metadata.version : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeRegistryUrl(registry: string): string {
  return registry.endsWith('/') ? registry : `${registry}/`;
}

function readCurrentPackageVersion(): string {
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
