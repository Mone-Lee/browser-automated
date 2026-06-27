#!/usr/bin/env node
/**
 * browser-e2e 的独立 CLI 入口，只暴露 E2E 执行、匹配与测试生成能力。
 * 底层继续复用 browser-e2e service 与 handoff 编排，保持对外入口收敛。
 */
import { runBrowserE2ECli } from './index.js';

runBrowserE2ECli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
