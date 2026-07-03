/**
 * 承载 browser-opt 命令的参数解析与执行编排，让一次性自然语言流程入口保持单一职责。
 * 文件只关心 browser-opt 相关流程，公共参数解析与输出能力则交由共享模块处理。
 */
import { BrowserOptRunner, browserOptTemplate } from '../../browser-opt/runner.js';
import {
  getBooleanFlag,
  getStringFlag,
  parseCliArgs,
  resolveLiveViewport,
  resolveProfile,
} from '../utils/args.js';
import { BROWSER_OPT_USAGE } from '../utils/constants.js';
import { printBrowserOptResult } from '../utils/output.js';

const BROWSER_OPT_EXIT_CODE_FAILURE = 1;
const BROWSER_OPT_EXIT_CODE_HANDOFF = 2;
const DEFAULT_BROWSER_PROFILE = 'Default';

export async function cmdBrowserOpt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const text = parsed.positionals.join(' ').trim();
  if (!text) {
    console.log(`${BROWSER_OPT_USAGE}\n\n${browserOptTemplate()}`);
    process.exit(BROWSER_OPT_EXIT_CODE_FAILURE);
  }

  const liveViewport = resolveLiveViewport(parsed.flags);
  const profile = resolveProfile(parsed.flags) ?? DEFAULT_BROWSER_PROFILE;
  const outputDir = getStringFlag(parsed.flags, 'output-dir');
  const useAgentChat = getBooleanFlag(parsed.flags, 'agent-chat');

  const runner = new BrowserOptRunner();
  const result = await runner.run(text, {
    profile,
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
