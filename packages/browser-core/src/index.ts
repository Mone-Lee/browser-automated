/**
 * core 模块放置 browser-opt、browser-test 与 browser-e2e 共享的基础类型和浏览器适配层。
 * 这里不编排具体业务流程，只提供稳定的底层能力。
 */
export { BrowserAgent, createBrowserAgent } from './agent.js';
export type { BrowserAgentFactory } from './agent.js';
export { resolveSystemChromeExecutable } from './browser-executable.js';
export { createBrowserSessionId, createManagedBrowserSessions } from './managed-session.js';
export type { ManagedBrowserSessionOptions, ManagedBrowserSessions } from './managed-session.js';
export type {
  AgentOptions,
  RunnerOptions,
  StepResult,
  TestCase,
  TestResult,
  TestRunSummary,
  TestStep,
} from './types.js';
