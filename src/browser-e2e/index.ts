/**
 * browser-e2e 模块对外导出 E2E 执行、测试生成和可复用索引能力。
 * 该目录可以复用 core 的浏览器控制，但对外只服务测试执行与测试代码沉淀。
 */
export { NaturalLanguageTestRunner } from './runner.js';
export { TestCaseGenerator } from './generate.js';
export {
  executeDeterministicScenario,
  executeDeterministicScenarioWithHandoff,
  executeDeterministicStep,
} from './deterministic.js';
export { BrowserE2ETestReuseService, suggestTestName } from './test-reuse/service.js';
export type {
  DeterministicAction,
  DeterministicExecutionResult,
  DeterministicScenarioExecutionMeta,
  DeterministicScenarioExecutionResult,
  DeterministicScenarioOptions,
  HandoffLifecycleContext,
  HandoffRequestContext,
} from './deterministic.js';
export type {
  BrowserE2ETriggerInput,
  BrowserE2ETriggerResult,
  GeneratedTestMeta,
  GeneratedTestIndex,
  MatchCandidate,
  MatchResult,
} from './test-reuse/types.js';
