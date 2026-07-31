/**
 * 集中处理 agent-browser 子进程代理环境，避免不同调用入口覆盖调用方已有的代理绕过规则。
 */
import { execFileSync } from 'node:child_process';

/** 解析逗号分隔的代理绕过项，保留调用方配置顺序并忽略空值。 */
function parseNoProxyEntries(value: string | undefined): string[] {
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
}

/** 从 macOS 代理配置输出中提取系统例外列表。 */
export function parseMacOSProxyExceptions(output: string): string[] {
  const exceptionsBlock = output.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)^\s*\}/m)?.[1];
  if (!exceptionsBlock) {
    return [];
  }

  return Array.from(exceptionsBlock.matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm), (match) => match[1])
    .map((entry) => entry.replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean);
}

/** 从 Windows 当前用户代理配置中提取分号分隔的系统例外列表。 */
export function parseWindowsProxyExceptions(output: string): string[] {
  const proxyOverride = output.match(/^\s*ProxyOverride\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/mi)?.[1];
  return proxyOverride?.split(';').map((entry) => entry.trim()).filter(Boolean) ?? [];
}

/** 合并大小写环境变量与系统例外，避免覆盖调用方已有的 NO_PROXY 域名。 */
export function mergeNoProxyEntries(...groups: Array<string[] | undefined>): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const entry of groups.flatMap((group) => group ?? [])) {
    const normalized = entry.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(entry);
    }
  }

  return merged.join(',');
}

/** 读取 macOS 或 Windows 当前用户的系统代理例外；失败时不阻断浏览器执行。 */
function readSystemProxyExceptions(): string[] {
  try {
    if (process.platform === 'darwin') {
      const output = execFileSync('/usr/sbin/scutil', ['--proxy'], {
        encoding: 'utf-8',
        timeout: 1_000,
      });
      return parseMacOSProxyExceptions(output);
    }

    if (process.platform === 'win32') {
      const output = execFileSync('reg.exe', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyOverride',
      ], {
        encoding: 'utf-8',
        timeout: 1_000,
      });
      return parseWindowsProxyExceptions(output);
    }
  } catch {
    return [];
  }

  return [];
}

/** 构造 agent-browser 子进程环境，使环境变量代理规则与当前系统例外保持一致。 */
export function createAgentBrowserEnvironment(): NodeJS.ProcessEnv {
  const noProxy = mergeNoProxyEntries(
    parseNoProxyEntries(process.env.NO_PROXY),
    parseNoProxyEntries(process.env.no_proxy),
    readSystemProxyExceptions(),
  );

  if (!noProxy) {
    return process.env;
  }

  return {
    ...process.env,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
