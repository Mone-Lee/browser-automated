/**
 * browser-opt 模块对外导出一次性自然语言浏览器操作能力。
 * 该目录只处理即时执行、证据采集和 PASS/FAIL 报告，不承载 E2E 测试生成。
 */
export {
  BrowserOptRunner,
  browserOptTemplate,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from './runner.js';

export type {
  BrowserOptStatus,
  BrowserOptReport,
  BrowserOptRunResult,
  BrowserOptRunnerOptions,
  BrowserOptStepResult,
} from './type.js';
