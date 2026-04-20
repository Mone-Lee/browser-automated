import type { TestCase, TestResult } from '../types.js';

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

export interface SkillTriggerInput {
  url: string;
  instruction: string;
  assertion?: string;
  autoGenerate?: boolean;
  generatedName?: string;
  tags?: string[];
}

export interface GeneratedCodeArtifact {
  testCase: TestCase;
  filePath: string;
  meta: GeneratedTestMeta;
}

export interface SkillTriggerResult {
  mode: 'code' | 'one-shot';
  matched?: MatchCandidate | null;
  execution: CodeExecutionResult | TestResult;
  generated?: GeneratedCodeArtifact;
  guidance?: string;
}
