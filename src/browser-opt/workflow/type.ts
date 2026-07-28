/**
 * 定义 browser-opt 可复用 Workflow 的持久化结构、匹配结果与存储诊断。
 * 这些类型同时服务于公共 API、CLI JSON 输出和 Skill 调用协议。
 */

export interface BrowserOptWorkflowTarget {
  url: string;
}

export interface BrowserOptWorkflow {
  version: 2;
  id: string;
  name: string;
  target: BrowserOptWorkflowTarget;
  steps: string[];
  createdAt: string;
  updatedAt: string;
}

export interface BrowserOptWorkflowLoadResult {
  workflows: BrowserOptWorkflow[];
  warnings: string[];
}

export interface BrowserOptWorkflowCandidate {
  workflow: BrowserOptWorkflow;
  score: number;
}

export type BrowserOptWorkflowMatchStatus = 'matched' | 'ambiguous' | 'not-found';

export interface BrowserOptWorkflowMatchResult {
  status: BrowserOptWorkflowMatchStatus;
  matched: BrowserOptWorkflowCandidate | null;
  candidates: BrowserOptWorkflowCandidate[];
  available: BrowserOptWorkflow[];
}

export interface SaveBrowserOptWorkflowInput {
  name: string;
  flow: string;
  workflowDir?: string;
  force?: boolean;
}

export interface SaveBrowserOptWorkflowResult {
  workflow: BrowserOptWorkflow;
  filePath: string;
  created: boolean;
}
