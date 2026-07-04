/**
 * 承载 browser-opt 命令的参数解析与执行编排，让一次性自然语言流程入口保持单一职责。
 * 文件只关心 browser-opt 相关流程，公共参数解析与输出能力则交由共享模块处理。
 */
import { BrowserOptRunner, browserOptTemplate } from '../../browser-opt/runner.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getBooleanFlag,
  getStringFlag,
  parseCliArgs,
  resolveLiveViewport,
  resolveProfile,
  resolveStatePath,
} from '../utils/args.js';
import { BROWSER_OPT_USAGE } from '../utils/constants.js';
import { printBrowserOptResult } from '../utils/output.js';

const BROWSER_OPT_EXIT_CODE_FAILURE = 1;
const BROWSER_OPT_EXIT_CODE_HANDOFF = 2;
const DEFAULT_BROWSER_PROFILE = 'Default';
const DEFAULT_AUTH_STATE_DIR = '.browser-automated/states';

export async function cmdBrowserOpt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const text = parsed.positionals.join(' ').trim();
  if (!text) {
    console.log(`${BROWSER_OPT_USAGE}\n\n${browserOptTemplate()}`);
    process.exit(BROWSER_OPT_EXIT_CODE_FAILURE);
  }

  const liveViewport = resolveLiveViewport(parsed.flags);
  const requestedProfile = resolveProfile(parsed.flags) ?? DEFAULT_BROWSER_PROFILE;
  const authState = resolveBrowserOptAuthState(parsed.flags, requestedProfile);
  const outputDir = getStringFlag(parsed.flags, 'output-dir');
  const useAgentChat = getBooleanFlag(parsed.flags, 'agent-chat');

  const runner = new BrowserOptRunner();
  const result = await runner.run(text, {
    profile: authState.profile,
    statePath: authState.statePath,
    authStateSavePath: authState.authStateSavePath,
    liveViewport,
    outputDir,
    useAgentChat,
  });

  printBrowserOptResult(result);
  if (result.passed) {
    process.exit(0);
  }

  process.exit(result.report.handoffTriggered ? BROWSER_OPT_EXIT_CODE_HANDOFF : BROWSER_OPT_EXIT_CODE_FAILURE);
}

interface BrowserOptAuthState {
  profile?: string;
  statePath?: string;
  authStateSavePath: string;
}

/** 根据已有登录态文件选择启动方式：有 state 时走干净窗口加载，没有时借 profile 首次导入并保存。 */
function resolveBrowserOptAuthState(flags: Record<string, string | boolean>, profile: string): BrowserOptAuthState {
  const configuredStatePath = resolveStatePath(flags);
  const authStateSavePath = configuredStatePath ?? defaultBrowserOptStatePath(profile);
  if (fs.existsSync(authStateSavePath)) {
    return {
      statePath: authStateSavePath,
      authStateSavePath,
    };
  }

  return {
    profile,
    authStateSavePath,
  };
}

/** 默认 state 文件按 profile 分开保存，避免 Work/Default 等登录态互相覆盖。 */
function defaultBrowserOptStatePath(profile: string): string {
  const stateDir = process.env.BROWSER_OPT_AUTH_STATE_DIR || path.resolve(process.cwd(), DEFAULT_AUTH_STATE_DIR);
  const stateName = profile.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return path.join(stateDir, `browser-opt-${stateName}.json`);
}
