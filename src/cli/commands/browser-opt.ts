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
  resolveReuseRunningBrowser,
  resolveStatePath,
} from '../utils/args.js';
import { BROWSER_OPT_USAGE } from '../utils/constants.js';
import { printBrowserOptResult } from '../utils/output.js';

export async function cmdBrowserOpt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const text = parsed.positionals.join(' ').trim();
  const liveViewport = resolveLiveViewport(parsed.flags);
  const statePath = resolveStatePath(parsed.flags);
  const reuseRunningBrowser = resolveReuseRunningBrowser(parsed.flags, statePath);
  const profile = resolveProfile(parsed.flags);
  const outputDir = getStringFlag(parsed.flags, 'output-dir');
  const useAgentChat = getBooleanFlag(parsed.flags, 'agent-chat');

  if (!text) {
    console.log(`${BROWSER_OPT_USAGE}\n\n${browserOptTemplate()}`);
    process.exit(1);
  }

  const runner = new BrowserOptRunner();
  const result = await runner.run(text, {
    profile,
    statePath,
    reuseRunningBrowser,
    liveViewport,
    outputDir,
    useAgentChat,
  });

  printBrowserOptResult(result);
  process.exit(result.passed ? 0 : 1);
}
