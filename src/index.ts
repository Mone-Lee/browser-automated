/**
 * 包级公共 API 入口，向外汇总 core、browser-opt 与 browser-e2e 的稳定能力。
 * 内部目录可以继续演进，但这里尽量维持兼容导出。
 */
export { BrowserAgent, createBrowserAgent } from './core/index.js';
export type { BrowserAgentFactory } from './core/index.js';
export {
  BrowserE2ETestReuseService,
  NaturalLanguageTestRunner,
  TestCaseGenerator,
} from './browser-e2e/index.js';
export {
  BrowserOptRunner,
  browserOptTemplate,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from './browser-opt/index.js';
export type {
  TestStep,
  TestCase,
  StepResult,
  TestResult,
  TestRunSummary,
  AgentOptions,
  RunnerOptions,
} from './core/index.js';
export type {
  BrowserOptReport,
  BrowserOptRunResult,
  BrowserOptRunnerOptions,
  BrowserOptStepResult,
} from './browser-opt/index.js';
export type {
  GeneratedTestMeta,
  GeneratedTestIndex,
  BrowserE2ETriggerInput,
  BrowserE2ETriggerResult,
  MatchCandidate,
  MatchResult,
} from './browser-e2e/index.js';
