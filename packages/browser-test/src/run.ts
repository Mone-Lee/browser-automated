/**
 * run 入口：串联场景隔离、入口前提检查、逐步执行、结果汇总与报告落盘。
 * 单个场景失败或阻塞后，其余步骤记为未执行；每个场景重新进入已确认入口并清空观测引用，不继承上个场景的结论。
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPort } from './browser.js';
import { entryUrlOf, executeStep, originOf, type ExecutionContext, type SemanticStep } from './executor.js';
import type { ParsedFeature } from './feature.js';
import type { ModelClient } from './model.js';
import type { JudgeClient } from './typesafe-judge.js';
import { createRunDirectory, writeReport } from './report.js';
import type { EvidenceRecord, FeatureResult, Observation, ScenarioResult, StepResult, Verdict } from './types.js';

export interface RunOptions {
  port: BrowserPort;
  /** 由调用方注入当前 AI；CLI 使用本地请求文件交回发起任务的 Agent。 */
  model?: ModelClient;
  /** 可选的 TypeSafe 判定客户端；缺失或调用失败时由 model 中的当前 Agent 兜底。 */
  judge?: JudgeClient;
  /** feature 文件内容摘要，写入结果便于核对运行的是哪一版。 */
  digest: string;
  /** 运行目录的父目录，默认调用目录下的 .browser-test/runs。 */
  runsDirectory: string;
  /** 复现命令中展示的 feature 路径。 */
  featureArgument: string;
  /** 每步限制；默认 10 次动作、60 秒、20 轮决策。 */
  limits?: { maxActions?: number; stepMs?: number; maxRounds?: number };
  log?: (line: string) => void;
}

const EVIDENCE_TEXT_LIMIT = 2000;
const EVIDENCE_ROWS_LIMIT = 50;

/** And 继承最近一个 Given/When/Then 的语义；开头的 And 无法确定所属阶段，返回 undefined。 */
function withSemantics(steps: ParsedFeature['scenarios'][number]['steps']): SemanticStep[] | undefined {
  const result: SemanticStep[] = [];
  let current: SemanticStep['semantic'] | undefined;
  for (const step of steps) {
    if (step.keyword !== 'And') current = step.keyword;
    if (!current) return undefined;
    result.push({ ...step, semantic: current });
  }
  return result;
}

/** 证据只保留判定所需的内容，避免整页文本撑大 result.json。 */
function compactEvidence(observation: Observation, evidenceId: string): EvidenceRecord | undefined {
  const item = observation.evidence.find(entry => entry.id === evidenceId);
  if (!item) return undefined;
  let actual = item.actual;
  if (typeof actual === 'string' && actual.length > EVIDENCE_TEXT_LIMIT) actual = `${actual.slice(0, EVIDENCE_TEXT_LIMIT)}…（已截断）`;
  if (Array.isArray(actual) && actual.length > EVIDENCE_ROWS_LIMIT) actual = actual.slice(0, EVIDENCE_ROWS_LIMIT);
  return { id: item.id, observationId: observation.id, source: item.source, actual, shot: observation.shot };
}

/** 按 FAIL > BLOCKED > PASS 汇总。 */
function overall(statuses: Verdict[]): Verdict {
  return statuses.includes('FAIL') ? 'FAIL' : statuses.includes('BLOCKED') ? 'BLOCKED' : 'PASS';
}

/** 运行一个已解析的 feature，写出 result.json、report.md、trace.log 与 shots/，返回结果与运行目录。 */
export async function runFeature(feature: ParsedFeature, options: RunOptions): Promise<{ result: FeatureResult; directory: string }> {
  const directory = await createRunDirectory(options.runsDirectory);
  const tracePath = join(directory, 'trace.log');
  const authState: string[] = [];
  const trace = (line: string) => {
    if (line.startsWith('auth-state-')) authState.push(line);
    appendFileSync(tracePath, `${new Date().toISOString()} ${line}\n`);
  };
  const log = options.log ?? (() => undefined);
  const observations = new Map<string, Observation>();
  const counters = { observation: 0 };
  const limits = { maxActions: options.limits?.maxActions ?? 10, stepMs: options.limits?.stepMs ?? 60_000, maxRounds: options.limits?.maxRounds ?? 20 };
  const scenarios: ScenarioResult[] = [];
  let declaredUrl: string | undefined;

  for (const scenario of feature.scenarios) {
    log(`Scenario: ${scenario.title}`);
    trace(`scenario ${scenario.title} (line ${scenario.line})`);
    const steps = withSemantics(scenario.steps);
    const notRun = (step: { keyword: string; text: string; line: number }, reason: string): StepResult => ({
      source: { file: feature.file, scenario: scenario.title, line: step.line, original: `${step.keyword} ${step.text}` }, execution: 'not-run', reason,
    });
    // 入口是执行的硬前提：缺少地址不猜测，整个场景 BLOCKED。
    const entryOrigins = [...new Set(steps?.flatMap(step => entryUrlOf(step) ?? []).map(url => originOf(url) ?? url))];
    const blockReason = !steps ? '步骤以 And 开头，无法确定所属阶段'
      : !entryOrigins.length ? '场景缺少已确认的入口地址，请先在用例中补充'
      : entryOrigins.length > 1 ? `同一场景出现多个应用入口（${entryOrigins.join('、')}），首期每个场景只执行一个应用`
      : undefined;
    if (blockReason) {
      const first = scenario.steps[0];
      const blocked: StepResult = { source: { file: feature.file, scenario: scenario.title, line: first.line, original: `${first.keyword} ${first.text}` }, execution: 'executed', status: 'BLOCKED', durationMs: 0, reason: blockReason, actions: [], checks: [] };
      log(`  BLOCKED  ${blockReason}`);
      scenarios.push({ title: scenario.title, status: 'BLOCKED', steps: [blocked, ...scenario.steps.slice(1).map(step => notRun(step, blockReason))] });
      continue;
    }

    const context: ExecutionContext = {
      port: options.port, model: options.model, judge: options.judge, file: feature.file, scenario: scenario.title,
      shotsDir: join(directory, 'shots'), trace, observations, counters, limits,
    };
    const results: StepResult[] = [];
    let stopped: string | undefined;
    for (const step of steps!) {
      if (stopped) { results.push(notRun(step, stopped)); continue; }
      const result = await executeStep(step, context);
      results.push(result);
      if (result.execution === 'executed') {
        log(`  ${step.keyword.padEnd(5)} ${step.text}  ${result.status}${result.reason ? `（${result.reason}）` : ''}`);
        if (result.status !== 'PASS') stopped = `同场景第 ${step.line} 行${result.status === 'FAIL' ? '断言失败' : '被阻塞'}`;
      }
    }
    declaredUrl ??= context.entryUrl;
    results.forEach((item, index) => { if (item.execution === 'not-run') log(`  ${steps![index].keyword.padEnd(5)} ${steps![index].text}  未执行`); });
    scenarios.push({ title: scenario.title, status: overall(results.flatMap(item => item.execution === 'executed' ? [item.status] : [])), steps: results });
  }

  // 除检查引用的证据外，动作执行后的观测也要保留 URL，便于还原多动作步骤的中间状态。
  const referenced = new Set(scenarios.flatMap(item => item.steps.flatMap(step => step.execution === 'executed'
    ? [...step.checks.flatMap(check => check.evidenceIds), ...step.actions.map(action => `${action.afterObservationId}-url`)]
    : [])));
  const evidence = [...observations.values()].flatMap(observation => [...referenced].filter(id => id.startsWith(`${observation.id}-`)).flatMap(id => compactEvidence(observation, id) ?? []));
  const firstObservation = observations.values().next().value as Observation | undefined;
  const result: FeatureResult = {
    feature: feature.file,
    featureDigest: options.digest,
    environment: { declaredUrl, actualUrl: firstObservation?.url, source: 'feature' },
    authState,
    platform: 'web',
    runtime: 'browser',
    dataMode: 'real',
    status: overall(scenarios.map(item => item.status)),
    scenarios,
    evidence,
    rerun: `browser-test run ${options.featureArgument}`,
  };
  await writeReport(directory, result);
  return { result, directory };
}
