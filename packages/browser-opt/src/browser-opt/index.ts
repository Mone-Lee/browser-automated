/**
 * browser-opt 模块对外导出即时自然语言执行和项目级 Workflow 复用能力。
 * 该目录处理流程存储、匹配、证据采集和执行报告，不承载 E2E 测试代码生成。
 */
export {
  BrowserOptRunner,
  browserOptTemplate,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from './runner/index.js';
export {
  DEFAULT_BROWSER_OPT_WORKFLOW_DIR,
  findBrowserOptWorkflowById,
  loadBrowserOptWorkflows,
  matchBrowserOptWorkflows,
  normalizeBrowserOptWorkflowQuery,
  resolveBrowserOptWorkflowDir,
  safeWorkflowId,
  saveBrowserOptWorkflow,
  scoreBrowserOptWorkflow,
} from './workflow/index.js';

export type {
  BrowserOptStatus,
  BrowserOptReport,
  BrowserOptRunResult,
  BrowserOptRunnerOptions,
  BrowserOptSkippedStep,
  BrowserOptStepResult,
} from './type.js';
export type {
  BrowserOptWorkflow,
  BrowserOptWorkflowCandidate,
  BrowserOptWorkflowLoadResult,
  BrowserOptWorkflowMatchResult,
  BrowserOptWorkflowMatchStatus,
  SaveBrowserOptWorkflowInput,
  SaveBrowserOptWorkflowResult,
} from './workflow/index.js';
