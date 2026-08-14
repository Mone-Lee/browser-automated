/**
 * browser-opt 类型定义文件，集中承载对外报告结构以及 runner 内部共用的
 * 快照、动作和执行选项类型，避免执行逻辑与类型声明交错在同一个文件里。
 */
import type { AgentBrowserJsonResult } from '#browser-core/agent';
import type { BrowserAgent } from '#browser-core/agent';

export type BrowserOptStatus = 'PASS' | 'FAIL' | 'HANDOFF';
export type BrowserOptFailureKind = 'execution' | 'business-validation';

export interface BrowserOptStepResult {
  index: number;
  instruction: string;
  passed: boolean;
  handoffTriggered?: boolean;
  attempts: number;
  beforeSnapshotPath: string;
  afterSnapshotPath: string;
  beforeScreenshotPath: string;
  afterScreenshotPath: string;
  actionOutput?: string;
  verification?: string;
  error?: string;
  failureKind?: BrowserOptFailureKind;
  logs: string[];
}

/** 记录因前置步骤失败而未执行的依赖步骤，供 JSON、Markdown 与 CLI 统一展示。 */
export interface BrowserOptSkippedStep {
  index: number;
  instruction: string;
  reason: string;
}

export interface BrowserOptReport {
  status: BrowserOptStatus;
  handoffTriggered?: boolean;
  url: string;
  flow: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outputDir: string;
  reportJsonPath: string;
  reportMarkdownPath: string;
  logPath: string;
  screenshots: string[];
  logs: string[];
  steps: BrowserOptStepResult[];
  /** 保持可选以兼容旧版持久化报告与外部构造的报告对象。 */
  skippedSteps?: BrowserOptSkippedStep[];
}

export interface BrowserOptRunResult {
  passed: boolean;
  report: BrowserOptReport;
}

export interface BrowserOptRunnerOptions {
  sessionId?: string;
  profile?: string;
  sessionName?: string;
  statePath?: string;
  reuseRunningBrowser?: boolean;
  liveViewport?: boolean;
  closeOnComplete?: boolean;
  outputDir?: string;
  timeout?: number;
  useAgentChat?: boolean;
  authStateSavePath?: string;
  authStateFallbackProfile?: string;
  handoff?: BrowserOptHandoffOptions;
}

export interface BrowserOptStepExecutionOptions {
  useAgentChat: boolean;
  alreadyOpenedUrl?: string;
  authStateSavePath?: string;
  retryAuthStateFallback?: () => BrowserAgent | null;
  handoff?: BrowserOptHandoffOptions;
}

export interface BrowserOptHandoffContext {
  message: string;
  output: string;
  sessionId?: string;
}

export interface BrowserOptHandoffOptions {
  onHandoffRequired?: (context: BrowserOptHandoffContext) => Promise<void> | void;
  waitForUserResume?: (context: BrowserOptHandoffContext) => Promise<void> | void;
  onHandoffCompleted?: (context: BrowserOptHandoffContext) => Promise<void> | void;
}

export interface SnapshotEvidence {
  output: AgentBrowserJsonResult;
  text: string;
  nodeCount: number;
}

export interface SnapshotNode {
  ref: string;
  role: string;
  label: string;
  clickable?: boolean;
  checked?: boolean;
  disabled?: boolean;
}

export type DeterministicAction =
  | { type: 'open'; url: string }
  | { type: 'inspect' }
  | { type: 'fill'; field: string; value: string; rowNumber?: number; pressKey?: string }
  | { type: 'press-key'; key: string }
  | { type: 'click'; target: string; field?: string | null; rowNumber?: number }
  | { type: 'check-table-rows'; count: number; target?: never }
  | { type: 'check-table-rows'; target: 'select-all'; count?: never }
  | {
      type: 'select-option';
      field: string | null;
      option: string;
      rowNumber?: number;
      endOption?: string;
      mode?: 'select' | 'deselect' | 'exclusive';
    }
  | { type: 'upload'; field: string; source: string; sources?: never; rowNumber?: number }
  | { type: 'upload'; field: string; sources: string[]; source?: never; rowNumber?: number }
  | { type: 'handoff'; message: string }
  | { type: 'assert-text'; text: string };

export type DeterministicExecutionOptions = {
  alreadyOpenedUrl?: string;
  allowViewportSearch?: boolean;
};
