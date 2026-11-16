/**
 * run 入口：串联场景隔离、入口前提检查、逐步执行、结果汇总与报告落盘。
 * 单个场景失败或阻塞后，其余步骤记为未执行；每个场景重新进入已确认入口并清空观测引用，不继承上个场景的结论。
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPort } from './browser.js';
import { entryUrlOf, executeStep, originOf, prepareStepIntents, type ExecutionContext, type SemanticStep } from './executor.js';
import type { ParsedFeature } from './feature.js';
import type { ModelClient } from './model.js';
import type { JudgeClient } from './typesafe-judge.js';
import { createRunDirectory, writeReport } from './report.js';
import type { EvidenceRecord, FeatureResult, Observation, ScenarioResult, StepIntent, StepResult, Verdict } from './types.js';

export interface RunOptions {
  port: BrowserPort;
  /** 由调用方注入当前 AI；CLI 使用本地请求文件交回发起任务的 Agent。 */
  model?: ModelClient;
  /** 可选的 TypeSafe 判定客户端；缺失或调用失败时由 model 中的当前 Agent 兜底。 */
  judge?: JudgeClient;
  /** feature 文件内容摘要，写入结果便于核对运行的是哪一版。 */
  digest: string;
  /** 运行目录的父目录，CLI 默认使用调用目录下的 .browser-test/artifacts。 */
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

/** 输出当前阶段并每隔十五秒提示等待状态；完成或异常时清理计时器，避免上一阶段继续报进度。 */
async function trackProgress<T>(label: string, log: (line: string) => void, task: (progress: (message: string) => void) => Promise<T>): Promise<T> {
  const started = Date.now();
  let phase = '开始执行';
  let updated = started;
  const progress = (message: string) => {
    phase = message;
    updated = Date.now();
    log(`${label} ${message}`);
  };
  progress(phase);
  const timer = setInterval(() => {
    if (Date.now() - updated >= 15_000) log(`${label} 仍在${phase}（已耗时 ${Math.floor((Date.now() - started) / 1000)} 秒；尚未返回结果）`);
  }, 15_000);
  timer.unref();
  try { return await task(progress); } finally { clearInterval(timer); }
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
  const log = (line: string) => {
    trace(`progress ${line}`);
    options.log?.(line);
  };
  log(`开始执行流程：共 ${feature.scenarios.length} 个场景`);
  const observations = new Map<string, Observation>();
  const counters = { observation: 0 };
  const intentCache = new Map<string, Pick<StepIntent, 'kind' | 'scope' | 'conditions'>>();
  const limits = { maxActions: options.limits?.maxActions ?? 10, stepMs: options.limits?.stepMs ?? 60_000, maxRounds: options.limits?.maxRounds ?? 20 };
  const scenarios: ScenarioResult[] = [];
  let declaredUrl: string | undefined;
  let intentsPrepared = false;

  for (const [scenarioIndex, scenario] of feature.scenarios.entries()) {
    const label = `[场景 ${scenarioIndex + 1}/${feature.scenarios.length}「${scenario.title}」]`;
    log(`${label} 开始，共 ${scenario.steps.length} 个步骤`);
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
      log(`${label} 执行受阻 BLOCKED：${blockReason}；其余 ${scenario.steps.length - 1} 个步骤未执行`);
      scenarios.push({ title: scenario.title, status: 'BLOCKED', steps: [blocked, ...scenario.steps.slice(1).map(step => notRun(step, blockReason))] });
      continue;
    }

    // 同一 feature 的步骤意图只在首个可执行场景前批量预热一次，避免各场景重复请求模型。
    // 仅预热语义完整且入口同源的场景；多入口或缺入口的用例会在各自执行时按既有门禁返回 BLOCKED，不能混入同一批上下文。
    if (!intentsPrepared && options.model) {
      intentsPrepared = true;
      const items = feature.scenarios.flatMap(item => {
        const semanticSteps = withSemantics(item.steps);
        const origins = new Set(semanticSteps?.flatMap(semanticStep => entryUrlOf(semanticStep) ?? []).map(url => originOf(url) ?? url));
        return semanticSteps && origins.size === 1 ? semanticSteps.map(semanticStep => ({ step: semanticStep, scenario: item.title })) : [];
      });
      await trackProgress(`${label} [准备步骤]`, log, async progress => {
        progress('等待当前 Agent 批量解释步骤');
        await prepareStepIntents(items, options.model!, intentCache, limits.stepMs, trace);
      });
      log(`${label} 步骤准备完成，开始逐步执行`);
    }
    const context: ExecutionContext = {
      port: options.port, model: options.model, judge: options.judge, file: feature.file, scenario: scenario.title,
      shotsDir: join(directory, 'shots'), trace, observations, counters, limits, intentCache,
    };
    const results: StepResult[] = [];
    let stopped: string | undefined;
    for (const [stepIndex, step] of steps!.entries()) {
      const stepLabel = `${label} [步骤 ${stepIndex + 1}/${steps!.length}，第 ${step.line} 行] ${step.keyword} ${step.text}`;
      if (stopped) {
        results.push(notRun(step, stopped));
        log(`${stepLabel} 未执行：${stopped}`);
        continue;
      }
      const result = await trackProgress(stepLabel, log, progress => {
        context.progress = progress;
        context.model = options.model && {
          async json(system, input, timeoutMs) {
            progress('等待当前 Agent 解释或判定');
            const reply = await options.model!.json(system, input, timeoutMs);
            progress('处理当前 Agent 返回的结果');
            return reply;
          },
        };
        return executeStep(step, context);
      });
      results.push(result);
      if (result.execution === 'executed') {
        log(`${stepLabel} ${result.status === 'PASS' ? '执行成功' : result.status === 'FAIL' ? '执行失败' : '执行受阻'} ${result.status}（${(result.durationMs / 1000).toFixed(1)} 秒）${result.reason ? `：${result.reason}` : ''}`);
        if (result.status !== 'PASS') stopped = `同场景第 ${step.line} 行${result.status === 'FAIL' ? '断言失败' : '被阻塞'}`;
      }
    }
    declaredUrl ??= context.entryUrl;
    const status = overall(results.flatMap(item => item.execution === 'executed' ? [item.status] : []));
    scenarios.push({ title: scenario.title, status, steps: results });
    log(`${label} 场景结束 ${status}；通过 ${results.filter(item => item.execution === 'executed' && item.status === 'PASS').length}/${results.length}，未执行 ${results.filter(item => item.execution === 'not-run').length}`);
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
