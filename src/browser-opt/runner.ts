/**
 * browser-opt 负责通过 agent-browser 执行自然语言浏览器流程，并在 M1 阶段
 * 保持严格的证据采集闭环。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserAgent, createBrowserAgent, type AgentBrowserJsonResult, type BrowserAgentFactory } from '../core/agent.js';
import type { AgentOptions } from '../core/types.js';

export type BrowserOptStatus = 'PASS' | 'FAIL';

export interface BrowserOptStepResult {
  index: number;
  instruction: string;
  passed: boolean;
  attempts: number;
  beforeSnapshotPath: string;
  afterSnapshotPath: string;
  beforeScreenshotPath: string;
  afterScreenshotPath: string;
  actionOutput?: string;
  verification?: string;
  error?: string;
  logs: string[];
}

export interface BrowserOptReport {
  status: BrowserOptStatus;
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
}

export interface BrowserOptRunResult {
  passed: boolean;
  report: BrowserOptReport;
}

export interface BrowserOptRunnerOptions {
  profile?: string;
  liveViewport?: boolean;
  outputDir?: string;
  timeout?: number;
}

interface SnapshotEvidence {
  output: AgentBrowserJsonResult;
  text: string;
  nodeCount: number;
}

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'artifacts', 'browser-opt');
const URL_RE = /https?:\/\/[^\s。，、，)）]+/i;

export function extractBrowserOptUrl(text: string): string | null {
  const match = text.match(URL_RE);
  return match ? match[0] : null;
}

export function splitBrowserOptSteps(text: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const numbered = lines
    .map((line) => line.match(/^(?:目标[:：]\s*)?(\d+)[\.)、]\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match?.[2]))
    .map((match) => match[2].trim())
    .filter(Boolean);

  if (numbered.length > 0) {
    return numbered;
  }

  const compact = lines
    .filter((line) => !/^目标[:：]?$/.test(line))
    .join('\n')
    .trim();
  return compact ? [compact] : [];
}

// 统一管理执行循环与报告产物，调用方只需要提供自然语言流程和可选运行参数。
export class BrowserOptRunner {
  private readonly agentFactory: (options?: AgentOptions) => BrowserAgent;

  constructor(agentFactory: BrowserAgentFactory = createBrowserAgent) {
    this.agentFactory = agentFactory;
  }

  async run(flow: string, options: BrowserOptRunnerOptions = {}): Promise<BrowserOptRunResult> {
    const url = extractBrowserOptUrl(flow);
    if (!url) {
      throw new Error(`无法从自然语言流程中提取 URL。\n\n${browserOptTemplate()}`);
    }

    const steps = splitBrowserOptSteps(flow);
    if (steps.length === 0) {
      throw new Error(`自然语言流程为空，请使用通用测试模板。\n\n${browserOptTemplate()}`);
    }

    const startedAt = new Date();
    const outputDir = resolveOutputDir(flow, options.outputDir, startedAt);
    fs.mkdirSync(outputDir, { recursive: true });

    const logs: string[] = [];
    const screenshots: string[] = [];
    const stepResults: BrowserOptStepResult[] = [];
    let fatalError: string | undefined;
    const agent = this.agentFactory({
      profile: options.profile ?? 'Default',
      liveViewport: options.liveViewport ?? true,
      timeout: options.timeout,
    });

    try {
      logs.push(`open: ${url}`);
      agent.open(url);

      const openSnapshotPath = path.join(outputDir, '00-open.snapshot.json');
      const openScreenshotPath = path.join(outputDir, '00-open.png');
      const openSnapshot = captureSnapshot(agent, openSnapshotPath);
      agent.screenshot(openScreenshotPath);
      screenshots.push(openScreenshotPath);
      logs.push(`snapshot: ${openSnapshotPath}`);
      logs.push(`screenshot: ${openScreenshotPath}`);
      logs.push(`page-state: ${summarizeSnapshot(openSnapshot)}`);

      for (let index = 0; index < steps.length; index++) {
        const result = await executeStep(agent, outputDir, index + 1, steps[index]);
        stepResults.push(result);
        screenshots.push(result.beforeScreenshotPath, result.afterScreenshotPath);
        logs.push(...result.logs);

        if (!result.passed) {
          break;
        }
      }
    } catch (err) {
      fatalError = err instanceof Error ? err.message : String(err);
      logs.push(`fatal: ${fatalError}`);
    } finally {
      agent.close();
    }

    const endedAt = new Date();
    const passed = !fatalError && stepResults.length === steps.length && stepResults.every((step) => step.passed);
    const reportJsonPath = path.join(outputDir, 'report.json');
    const reportMarkdownPath = path.join(outputDir, 'report.md');
    const logPath = path.join(outputDir, 'run.log');
    const report: BrowserOptReport = {
      status: passed ? 'PASS' : 'FAIL',
      url,
      flow,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      outputDir,
      reportJsonPath,
      reportMarkdownPath,
      logPath,
      screenshots,
      logs,
      steps: stepResults,
    };

    fs.writeFileSync(logPath, logs.join('\n'));
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(reportMarkdownPath, renderMarkdownReport(report));

    return {
      passed,
      report,
    };
  }
}

async function executeStep(
  agent: BrowserAgent,
  outputDir: string,
  index: number,
  instruction: string,
): Promise<BrowserOptStepResult> {
  const prefix = String(index).padStart(2, '0');
  const beforeSnapshotPath = path.join(outputDir, `${prefix}-before.snapshot.json`);
  const afterSnapshotPath = path.join(outputDir, `${prefix}-after.snapshot.json`);
  const retrySnapshotPath = path.join(outputDir, `${prefix}-retry.snapshot.json`);
  const beforeScreenshotPath = path.join(outputDir, `${prefix}-before.png`);
  const afterScreenshotPath = path.join(outputDir, `${prefix}-after.png`);
  const logs: string[] = [];

  const beforeSnapshot = captureSnapshot(agent, beforeSnapshotPath);
  agent.screenshot(beforeScreenshotPath);
  logs.push(`step ${index}: ${instruction}`);
  logs.push(`before-state: ${summarizeSnapshot(beforeSnapshot)}`);
  logs.push(`before-screenshot: ${beforeScreenshotPath}`);
  logs.push(`thinking: 当前页面状态已记录，下一步执行自然语言动作或验证。`);

  let attempts = 0;
  let actionOutput = '';
  let actionError: string | undefined;

  while (attempts < 2) {
    attempts += 1;
    try {
      if (!isVerificationStep(instruction)) {
        const chat = agent.chatJson(instruction);
        actionOutput = summarizeJsonResult(chat);
        logs.push(`attempt ${attempts}: agent-browser chat --json`);
        if (chat.parseError) {
          logs.push(`attempt ${attempts}: chat JSON parse fallback: ${chat.parseError}`);
        }
      } else {
        logs.push(`attempt ${attempts}: verification-only step, no chat action`);
      }
      actionError = undefined;
      break;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
      logs.push(`attempt ${attempts}: action failed: ${actionError}`);
      if (attempts < 2) {
        const retrySnapshot = captureSnapshot(agent, retrySnapshotPath);
        logs.push(`retry-snapshot: ${retrySnapshotPath}`);
        logs.push(`retry-state: ${summarizeSnapshot(retrySnapshot)}`);
      }
    }
  }

  const afterSnapshot = captureSnapshot(agent, afterSnapshotPath);
  agent.screenshot(afterScreenshotPath);
  logs.push(`after-state: ${summarizeSnapshot(afterSnapshot)}`);
  logs.push(`after-screenshot: ${afterScreenshotPath}`);

  if (actionError) {
    return {
      index,
      instruction,
      passed: false,
      attempts,
      beforeSnapshotPath,
      afterSnapshotPath,
      beforeScreenshotPath,
      afterScreenshotPath,
      actionOutput,
      error: actionError,
      logs,
    };
  }

  const verification = verifyStep(instruction, afterSnapshot);
  if (!verification.passed) {
    logs.push(`verification failed: ${verification.message}`);
  } else {
    logs.push(`verification passed: ${verification.message}`);
  }

  return {
    index,
    instruction,
    passed: verification.passed,
    attempts,
    beforeSnapshotPath,
    afterSnapshotPath,
    beforeScreenshotPath,
    afterScreenshotPath,
    actionOutput,
    verification: verification.message,
    error: verification.passed ? undefined : verification.message,
    logs,
  };
}

function captureSnapshot(agent: BrowserAgent, filePath: string): SnapshotEvidence {
  const output = agent.snapshotJson();
  fs.writeFileSync(filePath, JSON.stringify(output.data ?? { raw: output.raw, parseError: output.parseError }, null, 2));
  return {
    output,
    text: snapshotText(output),
    nodeCount: countSnapshotNodes(output.data),
  };
}

function isVerificationStep(instruction: string): boolean {
  return /验证|断言|检查|确认|verify|assert|expect|should|包含|存在|至少\s*\d+/i.test(instruction);
}

function verifyStep(instruction: string, snapshot: SnapshotEvidence): { passed: boolean; message: string } {
  if (!isVerificationStep(instruction)) {
    return { passed: true, message: '非验证步骤，已完成动作并重新 snapshot。' };
  }

  const atLeastCount = parseAtLeastCount(instruction);
  if (atLeastCount !== null) {
    const passed = snapshot.nodeCount >= atLeastCount;
    return {
      passed,
      message: passed
        ? `元素数量 ${snapshot.nodeCount} >= ${atLeastCount}`
        : `元素数量 ${snapshot.nodeCount} < ${atLeastCount}`,
    };
  }

  const expectedText = parseExpectedText(instruction);
  if (expectedText) {
    const passed = normalizedIncludes(snapshot.text, expectedText);
    return {
      passed,
      message: passed
        ? `页面包含文本：${expectedText}`
        : `页面未包含文本：${expectedText}`,
    };
  }

  if (/存在|visible|exists?|出现/i.test(instruction)) {
    return snapshot.nodeCount > 0
      ? { passed: true, message: `存在可交互元素，数量：${snapshot.nodeCount}` }
      : { passed: false, message: '未发现可交互元素。' };
  }

  return snapshot.text.trim()
    ? { passed: true, message: '验证步骤已执行，页面 snapshot 非空。' }
    : { passed: false, message: '验证步骤执行后页面 snapshot 为空。' };
}

function parseAtLeastCount(instruction: string): number | null {
  const match = instruction.match(/(?:至少|不少于|>=|at\s+least)\s*(\d+)/i);
  return match?.[1] ? Number(match[1]) : null;
}

function parseExpectedText(instruction: string): string | null {
  const quoted = instruction.match(/["“]([^"”]+)["”]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  const contains = instruction.match(/(?:包含|看到|显示|contains?|include[s]?)\s*([^。；\n]+)/i);
  if (contains?.[1]) {
    return contains[1].replace(/至少\s*\d+.*$/, '').trim();
  }

  return null;
}

function normalizedIncludes(source: string, expected: string): boolean {
  return source.toLowerCase().includes(expected.toLowerCase());
}

function snapshotText(output: AgentBrowserJsonResult): string {
  if (typeof output.data === 'object' && output.data !== null) {
    const snapshot = findStringProperty(output.data, 'snapshot');
    if (snapshot) {
      return snapshot;
    }
  }

  return output.raw;
}

function findStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string') {
    return record[key] as string;
  }

  for (const entry of Object.values(record)) {
    const found = findStringProperty(entry, key);
    if (found) {
      return found;
    }
  }

  return null;
}

function countSnapshotNodes(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  const record = value as Record<string, unknown>;
  const refs = findObjectProperty(record, 'refs');
  if (refs) {
    return Object.keys(refs).length;
  }

  const snapshot = findStringProperty(record, 'snapshot');
  if (snapshot) {
    return snapshot.split('\n').filter((line) => /\[ref=|@[a-z]\d+/i.test(line)).length;
  }

  return 0;
}

function findObjectProperty(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) {
    return record[key] as Record<string, unknown>;
  }

  for (const entry of Object.values(record)) {
    const found = findObjectProperty(entry, key);
    if (found) {
      return found;
    }
  }

  return null;
}

function summarizeJsonResult(result: AgentBrowserJsonResult): string {
  if (result.data !== null) {
    return JSON.stringify(result.data);
  }

  return result.raw.trim();
}

function summarizeSnapshot(snapshot: SnapshotEvidence): string {
  const text = snapshot.text.replace(/\s+/g, ' ').trim();
  const preview = text.length > 160 ? `${text.slice(0, 160)}...` : text;
  return `nodes=${snapshot.nodeCount}; text="${preview}"`;
}

function resolveOutputDir(flow: string, outputRoot: string | undefined, startedAt: Date): string {
  const root = outputRoot ? path.resolve(outputRoot) : DEFAULT_OUTPUT_ROOT;
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return path.join(root, `${timestamp}-${slugify(flow)}`);
}

function slugify(value: string): string {
  const ascii = value
    .replace(URL_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ascii || 'browser-opt-flow';
}

function renderMarkdownReport(report: BrowserOptReport): string {
  const lines = [
    `# Browser Opt Report: ${report.status}`,
    '',
    `- URL: ${report.url}`,
    `- Started: ${report.startedAt}`,
    `- Duration: ${report.durationMs}ms`,
    `- Evidence directory: ${report.outputDir}`,
    `- Log file: ${report.logPath}`,
    '',
    '## Evidence Screenshots',
    ...report.screenshots.map((screenshot) => `- ${screenshot}`),
    '',
    '## Steps',
  ];

  for (const step of report.steps) {
    lines.push(
      '',
      `### ${step.passed ? 'PASS' : 'FAIL'} ${step.index}. ${step.instruction}`,
      `- Attempts: ${step.attempts}`,
      `- Before screenshot: ${step.beforeScreenshotPath}`,
      `- After screenshot: ${step.afterScreenshotPath}`,
      `- Verification: ${step.verification ?? 'n/a'}`,
      `- Error: ${step.error ?? 'n/a'}`,
      '',
      '```text',
      ...step.logs,
      '```',
    );
  }

  lines.push('', '## Detailed Logs', '```text', ...report.logs, '```', '');
  return lines.join('\n');
}

export function browserOptTemplate(): string {
  return `通用测试模板：
你是一个专业的自动化测试 Agent 执行以下测试用例：

网站：{URL}
测试用例：{描述，如 "用户注册流程"}

预期结果：
1. {步骤1}
2. {步骤2}
...

自然语言流程示例：
测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 在搜索框输入 "agent-browser"。
3. 点击搜索按钮。
4. 验证搜索结果页面是否包含至少 3 个结果项。
5. 点击第一个结果，验证跳转正确。`;
}
