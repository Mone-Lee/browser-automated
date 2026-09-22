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
  const flagState = getStringFlag(flags, 'state')?.trim();
  if (flagState) {
    return flagState;
  }

  const envState = process.env.AGENT_BROWSER_STATE?.trim();
  return envState || undefined;
}

export function resolveReuseRunningBrowser(
  // 读取 clean-browser 和 reuse-focused-browser 等布尔型浏览器模式参数。
  flags: Record<string, string | boolean>,
  // 传入 state 时必须启动独立浏览器，不能与运行中浏览器连接同时使用。
  statePath?: string,
  // 当调用方没有显式模式参数时使用的默认值。
  defaultValue = false,
): boolean {
  // state 文件需要在受控浏览器上下文中加载，因此优先禁止运行中浏览器复用。
  if (statePath) {
    return false;
  }
  // clean-browser 明确要求启动新的独立浏览器。
  if (getBooleanFlag(flags, 'clean-browser')) {
    return false;
  }
  // reuse-focused-browser 明确要求连接当前可发现的运行中浏览器。
  if (getBooleanFlag(flags, 'reuse-focused-browser')) {
    return true;
  }
  // 没有显式覆盖时，返回调用方传入的默认模式。
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
