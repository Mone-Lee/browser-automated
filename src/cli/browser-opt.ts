#!/usr/bin/env node
/**
 * browser-opt 的独立 CLI 入口，只暴露一次性自然语言浏览器操作能力。
 * 实际执行逻辑复用 cli.ts 中的分发函数，避免入口文件复制业务编排。
 */
import { runBrowserOptCli } from './index.js';

runBrowserOptCli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
