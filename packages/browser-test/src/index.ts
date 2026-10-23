/** 导出版本、XMind 导入、引导生成与 Gherkin 解析接口；执行能力按技术设计逐步实现。 */
export const VERSION = '0.1.0';
export { importXMind } from './xmind.js';
export type { XMindNode, XMindCase, XMindImport } from './types.js';

export { DRAFT_RULES, describeTodo, listTodos, renderDraftPreview, resolveTodo, draftFromAgentSteps, generateFeatureDraft, loadAgentSteps, loadCasesImport, validateFeatureDraft, reviewFeatureDraft, saveDirectFeatureDraft, saveFeatureDraft } from './feature-gen.js';
export type { AgentSteps, FeatureDraft, DraftScenario, DraftStep, FeatureReview } from './feature-gen.js';

export { findPendingConfirmations, parseFeature, parseFeatureFile } from './feature.js';
export type { PendingConfirmation, FeatureStep, FeatureScenario, ParsedFeature } from './feature.js';

export { prepareAddresses, confirmAddress, validAddress } from './feature-address.js';
export type { PageVisit, AddressRequest } from './feature-address.js';
