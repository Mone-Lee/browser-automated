/**
 * 承载 browser-opt 命令的参数解析与执行编排，让一次性自然语言流程入口保持单一职责。
 * 文件只关心 browser-opt 相关流程，公共参数解析与输出能力则交由共享模块处理。
 */
import { BrowserOptRunner, browserOptTemplate } from '../../browser-opt/runner/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { BrowserOptHandoffContext } from '../../browser-opt/type.js';
import {
  getBooleanFlag,
  getStringFlag,
  parseCliArgs,
  resolveLiveViewport,
  resolveProfile,
  resolveStatePath,
} from '../utils/args.js';
import { BROWSER_OPT_USAGE, HANDOFF_DONE_ANSWERS, LIVE_VIEWPORT_DASHBOARD_URL } from '../utils/constants.js';
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
    authStateFallbackProfile: authState.fallbackProfile,
    liveViewport,
    outputDir,
    useAgentChat,
    handoff: createBrowserOptHandoffOptions(liveViewport),
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
  fallbackProfile?: string;
}

/**
 * 登录态复用策略：
 * 1. 默认 state 存在时优先加载，避免每次从完整 Chrome profile 启动。
 * 2. 默认 state 不存在时用 profile 首次导入，并把 cookies/storage 保存成 state。
 * 3. 只有自动选择的默认 state 才允许后续 profile fallback；显式 --state 保持隔离语义。
 */
function resolveBrowserOptAuthState(flags: Record<string, string | boolean>, profile: string): BrowserOptAuthState {
  const configuredStatePath = resolveStatePath(flags);
  const authStateSavePath = configuredStatePath ?? defaultBrowserOptStatePath(profile);
  if (fs.existsSync(authStateSavePath)) {
    return {
      statePath: authStateSavePath,
      authStateSavePath,
      fallbackProfile: configuredStatePath ? undefined : profile,
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

/** 读取终端输入，供 handoff 暂停点等待用户确认继续。 */
function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 判断用户是否已确认人工登录或处理动作完成。 */
function isDoneAnswer(input: string): boolean {
  const value = input.trim().toLowerCase();
  return HANDOFF_DONE_ANSWERS.includes(value as (typeof HANDOFF_DONE_ANSWERS)[number]);
}

/** browser-opt 默认进入 handoff 后等待用户完成操作，再恢复同一个浏览器会话继续执行。 */
function createBrowserOptHandoffOptions(liveViewport: boolean) {
  return {
    onHandoffRequired: async (context: BrowserOptHandoffContext) => {
      console.log('\n=== Browser Opt Handoff ===');
      console.log(`Reason: ${context.message}`);
      if (context.sessionId) {
        console.log(`Session: ${context.sessionId}`);
      }
      if (liveViewport) {
        console.log(`Live viewport: ${LIVE_VIEWPORT_DASHBOARD_URL}`);
      }
      console.log('已打开可视浏览器，请手动完成登录。');
      console.log('完成后请在这里输入 done（或 ok / 继续 / 完成）以恢复自动化。');
      if (context.output.trim()) {
        console.log(context.output.trim());
      }
    },
    waitForUserResume: waitForBrowserOptHandoffDone,
    onHandoffCompleted: async () => {
      console.log('人工操作完成，恢复 browser-opt 自动化执行。\n');
    },
  };
}

/** 循环等待明确完成信号，避免误触回车后过早恢复自动化。 */
async function waitForBrowserOptHandoffDone(): Promise<void> {
  while (true) {
    const answer = await promptUser('请输入 done 继续：\n> ');
    if (isDoneAnswer(answer)) {
      return;
    }
    console.log('未识别输入，请输入 done / ok / 继续 / 完成。');
  }
}
