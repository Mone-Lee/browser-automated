#!/usr/bin/env node
/**
 * browser-opt 的独立 CLI 入口，承载即时执行、Workflow 管理和运行环境初始化。
 * 入口直接指向 browser-opt 命令域，避免 npm 产物依赖 browser-e2e 的分发逻辑。
 */
import { cmdBrowserOpt } from './commands/browser-opt.js';

cmdBrowserOpt(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
