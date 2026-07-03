/**
 * 统一封装 CLI 参数解析与常用 flag 读取逻辑，避免各命令重复处理细节。
 * 这里仅负责轻量解析，不引入命令语义，让命令文件保持聚焦在业务流程上。
 */

export interface CliParseResult {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(args: string[]): CliParseResult {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positionals, flags };
}

export function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

export function getBooleanFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true;
}

export function resolveProfile(flags: Record<string, string | boolean>): string | undefined {
  return getStringFlag(flags, 'profile');
}

export function resolveStatePath(flags: Record<string, string | boolean>): string | undefined {
  return getStringFlag(flags, 'state') ?? process.env.AGENT_BROWSER_STATE;
}

export function resolveReuseRunningBrowser(
  flags: Record<string, string | boolean>,
  statePath?: string,
  defaultValue = false,
): boolean {
  if (statePath) {
    return false;
  }
  if (getBooleanFlag(flags, 'clean-browser')) {
    return false;
  }
  if (getBooleanFlag(flags, 'reuse-focused-browser')) {
    return true;
  }
  return defaultValue;
}

export function resolveLiveViewport(flags: Record<string, string | boolean>): boolean {
  if (getBooleanFlag(flags, 'no-live-viewport')) {
    return false;
  }
  if (getBooleanFlag(flags, 'live-viewport')) {
    return true;
  }
  return true;
}

export function parseCsv(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
