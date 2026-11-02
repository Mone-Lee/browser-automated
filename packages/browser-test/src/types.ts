/**
 * 定义 XMind 导入用例与 run 的运行时协议类型；来源文件仅记录在 XMindImport.file，节点不重复携带来源、画布或节点 ID。
 * 运行时类型是内存协议，不替换 browser-core 的同名类型，动作链与检查最终写入 result.json。
 */

/** 保留原文与层级的主题节点，既用于用例分组，也用于保存尚未识别的内容。 */
export interface XMindNode {
  title: string;
  /** 从画布根主题到当前主题的标题序列，包含当前标题，不含画布名称。 */
  path: string[];
  /** 按原始子主题类别分组，例如附属主题 attached、自由主题 detached。 */
  children: Record<string, XMindNode[]>;
  /** 原始主题中除 id、title、children 外的属性，如备注、标签、优先级标记。 */
  raw: Record<string, unknown>;
}

/** 按字段或嵌套布局识别出的用例；不定义业务用例编号，原文编号仅保留在主题内容中。 */
export interface XMindCase {
  title: string;
  /** 字段标记识别为 sections；依据前置条件及操作子树识别为 nested。 */
  structure: 'sections' | 'nested';
  /** 从根主题到用例父主题的标题序列，不含用例自身标题。 */
  modulePath: string[];
  /** 用例主题及完整子树，保留未归入前置、操作或预期分组的内容。 */
  node: XMindNode;
  /** 前置字段节点及其子树，同行内容保留在标题中；无字段时为空数组。 */
  preconditions: XMindNode[];
  /** 操作字段或嵌套布局中的操作节点，保留原有顺序与完整子树。 */
  steps: XMindNode[];
  /** 预期字段或操作的直属附属节点；嵌套布局中父操作与直属子预期通过路径及操作子树保持对应。 */
  expectedResults: XMindNode[];
}

/** 单个文件的导入结果，仅表达原文结构与识别情况，不包含执行结论。 */
export interface XMindImport {
  /** 导入文件的绝对路径。 */
  file: string;
  /** 按原文件顺序保存所有画布及完整主题树，包括未识别为用例的节点。 */
  sheets: { title: string; root: XMindNode }[];
  cases: XMindCase[];
  /** 需人工确认的非致命问题及其来源；格式错误则由导入接口抛出异常。 */
  warnings: { /** 触发提示的主题路径，便于不依赖 ID 定位。 */ path: string[]; message: string }[];
}

/** 三种测试结论；未执行步骤用 StepResult 的 execution 区分，不是第四种结论。 */
export type Verdict = 'PASS' | 'FAIL' | 'BLOCKED';

/** 规则判定：只允许这些确定性检查，其余条件交给 AI 并标记 by: ai。 */
export type ConditionRule =
  | { type: 'text-present'; text: string }
  | { type: 'text-absent'; text: string }
  | { type: 'url-contains'; value: string }
  | { type: 'target-present'; role?: string; name: string }
  | { type: 'target-absent'; role?: string; name: string }
  | { type: 'rows-all-contain'; text: string };

/** 条件只是原文的拆分，不是页面反推的预期。 */
export interface StepCondition {
  id: string;
  expected: string;
  /** data 与 visual 目前没有可用证据来源，判定一律 BLOCKED，不能附带 rule。 */
  evidenceKind: 'page' | 'data' | 'visual';
  rule?: ConditionRule;
}

/** 每个解释结果始终关联原步骤。 */
export interface StepIntent {
  source: { file: string; scenario: string; line: number; original: string };
  semantic: 'Given' | 'When' | 'Then';
  kind: 'entry' | 'login' | 'precondition' | 'interaction' | 'assertion';
  scope: { description: string; entityKey?: string };
  conditions: StepCondition[];
}

/** 观测中的可操作目标；编号只在该次观测内有效。 */
export interface ObservationTarget {
  id: string;
  ref: string;
  role?: string;
  name: string;
  visible: boolean;
}

/** 采集是否完整：失败或截断时，“不存在”类结论不可信。 */
export interface ObservationCapture {
  probeFailed: boolean;
  textTruncated: boolean;
  targetsTruncated: boolean;
  rowsTruncated: boolean;
}

/** 一次实际观测；证据编号形如 o3-text，可在 result.json 中回查。 */
export interface Observation {
  id: string;
  capturedAt: string;
  url: string;
  shot?: string;
  targets: ObservationTarget[];
  capture: ObservationCapture;
  evidence: Array<{ id: string; kind: 'page' | 'data'; source: string; actual: unknown }>;
}

/** 宿主支持的原子动作；模型不能提交脚本、Shell 或未观测的定位器。 */
export type AtomicAction =
  | { type: 'open'; url: string }
  | { type: 'click'; targetId: string }
  | { type: 'fill'; targetId: string; value: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction: 'up' | 'down' }
  | { type: 'wait'; milliseconds: number };

/** 模型只能选择受支持的决定；动作还必须经过宿主门禁。 */
export type ActionDecision = { observationId: string; reason: string } & (
  | { kind: 'act'; action: AtomicAction; /** 业务写入必须引用当前操作步骤的原文，并说明可观测的完成结果；不是额外授权。 */ write?: { sourceText: string; expected: string } }
  | { kind: 'check'; conditionIds: string[] }
  | { kind: 'handoff'; message: string }
  | { kind: 'blocked'; reasonCode: string }
);

export interface CheckResult {
  conditionId: string;
  status: Verdict;
  by: 'rule' | 'ai';
  actual: unknown;
  evidenceIds: string[];
}

/** 动作链记录；target 保存动作所引用目标当时的名称与 ref，便于从 observationId + targetId 还原。 */
export interface ActionRecord {
  decision: ActionDecision;
  afterObservationId: string;
  outcome: string;
  target?: { id: string; role?: string; name: string; ref: string };
}

/** 未执行步骤单独记录执行状态及停止原因。 */
export type StepResult = { source: StepIntent['source'] } & (
  | { execution: 'not-run'; reason: string }
  | {
      execution: 'executed';
      status: Verdict;
      durationMs: number;
      reason?: string;
      actions: ActionRecord[];
      checks: CheckResult[];
    }
);

export interface ScenarioResult {
  title: string;
  status: Verdict;
  steps: StepResult[];
}

export interface EvidenceRecord {
  id: string;
  observationId: string;
  source: string;
  actual: unknown;
  shot?: string;
}

/** run 的完整结果，写入 result.json；首期只有 Web 真实环境。 */
export interface FeatureResult {
  feature: string;
  featureDigest: string;
  environment: { declaredUrl?: string; actualUrl?: string; source: 'feature' };
  platform: 'web';
  runtime: 'browser';
  dataMode: 'real';
  status: Verdict;
  scenarios: ScenarioResult[];
  evidence: EvidenceRecord[];
  rerun: string;
}
