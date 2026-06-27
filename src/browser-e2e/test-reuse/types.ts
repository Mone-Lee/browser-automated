/**
 * 定义 browser-e2e 测试复用链路、生成测试索引和代码生成结果所需的数据结构。
 */
import type { TestCase, TestResult } from '../../core/types.js';

export interface GeneratedTestMeta {
  id: string;
  name: string;
  filePath: string;
  url: string;
  tags: string[];
  nlHints: string[];
  fingerprint: string;
  createdAt: string;
  lastPassedAt?: string;
}

export interface GeneratedTestIndex {
  version: 1;
  tests: GeneratedTestMeta[];
}

export interface MatchCandidate {
  test: GeneratedTestMeta;
  score: number;
}

export interface MatchResult {
  best: MatchCandidate | null;
  candidates: MatchCandidate[];
}

export interface CodeExecutionResult {
  passed: boolean;
  output: string;
}

export interface BrowserE2ETriggerInput {
  url: string;
  instruction: string;
  profile?: string;
  assertion?: string;
  autoGenerate?: boolean;
  generatedName?: string;
  tags?: string[];
  liveViewport?: boolean;
  handoff?: {
    maxConsecutiveFailuresBeforeHandoff?: number;
    maxHandoffsPerScenario?: number;
    onActionFailure?: (context: {
      instruction: string;
      action: { type: string; value?: string; field?: string };
      consecutiveFailures: number;
      error: string;
    }) => Promise<'handoff' | 'continue' | void> | 'handoff' | 'continue' | void;
    onHandoffRequired?: (context: {
      instruction: string;
      action: { type: string; value?: string; field?: string };
      consecutiveFailures: number;
      error: string;
      handoffMessage: string;
      handoffOutput: string;
      sessionId?: string;
    }) => Promise<void> | void;
    waitForUserResume?: (context: {
      instruction: string;
      action: { type: string; value?: string; field?: string };
      consecutiveFailures: number;
      error: string;
      handoffMessage: string;
      handoffOutput: string;
      sessionId?: string;
    }) => Promise<void> | void;
    onHandoffCompleted?: (context: {
      instruction: string;
      action: { type: string; value?: string; field?: string };
      consecutiveFailures: number;
      error: string;
      handoffMessage: string;
      handoffOutput: string;
      sessionId?: string;
    }) => Promise<void> | void;
  };
}

export interface GeneratedCodeArtifact {
  testCase: TestCase;
  filePath: string;
  meta: GeneratedTestMeta;
}

export interface BrowserE2ETriggerResult {
  mode: 'code' | 'one-shot';
  matched?: MatchCandidate | null;
  execution: CodeExecutionResult | TestResult;
  generated?: GeneratedCodeArtifact;
  guidance?: string;
  handoff?: {
    triggered: boolean;
    count: number;
  };
}
