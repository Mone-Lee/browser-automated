/** 导出版本、XMind 导入、引导生成与 Gherkin 解析接口；执行能力按技术设计逐步实现。 */
export const VERSION = '0.1.0';
export { importXMind } from './xmind.js';


export { DRAFT_RULES, describeTodo, listTodos, renderDraftPreview, resolveTodo, draftFromAgentSteps, generateFeatureDraft, loadAgentSteps, loadCasesImport, validateFeatureDraft, reviewFeatureDraft, saveDirectFeatureDraft, saveFeatureDraft } from './feature-gen.js';
export type { AgentSteps, FeatureDraft, DraftScenario, DraftStep, FeatureReview } from './feature-gen.js';

export { findPendingConfirmations, parseFeature, parseFeatureFile } from './feature.js';
export type { PendingConfirmation, FeatureStep, FeatureScenario, ParsedFeature } from './feature.js';

export { prepareAddresses, confirmAddress, validAddress } from './feature-address.js';
export type { PageVisit, AddressRequest } from './feature-address.js';

export { runFeature } from './run.js';
export type { RunOptions } from './run.js';
export { executeStep, entryUrlOf } from './executor.js';
export type { ExecutionContext, SemanticStep } from './executor.js';
export { createBrowserPort } from './browser.js';
export type { BrowserPort, BrowserPortOptions } from './browser.js';
export { createAgentModel } from './model.js';
export type { AgentModelClient, AgentRequestNotice, ModelClient } from './model.js';
export { createTypeSafeJudge } from './typesafe-judge.js';
export type { JudgeClient, JudgeInput } from './typesafe-judge.js';
export { judgeConditions, aggregate } from './verdict.js';
export type * from './types.js';
