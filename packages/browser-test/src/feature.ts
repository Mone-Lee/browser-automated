/** 解析 browser-test 支持的受限 Gherkin（Feature/Scenario/@p<number>/步骤），并在执行前统一阻断待确认内容。 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Gherkin 文件中的待确认注释及其行号，供执行入口在运行前阻断。 */
export interface PendingConfirmation {
  line: number;
  text: string;
}

export interface FeatureStep {
  keyword: 'Given' | 'When' | 'Then' | 'And';
  text: string;
  line: number;
}

export interface FeatureScenario {
  title: string;
  line: number;
  priority?: string;
  steps: FeatureStep[];
}

/** source 来自生成文件头注释，仅用于来源追溯。 */
export interface ParsedFeature {
  title: string;
  file: string;
  source?: string;
  scenarios: FeatureScenario[];
}

const pendingPattern = /^\s*#\s*(?:TODO\s*\(确认(?:\s*#[^)]+)?\)|待确认)\s*[:：]?/u;

/** 识别生成器及手写文件支持的两种待确认注释，不把普通步骤中的相同文字误判为标记。 */
export function findPendingConfirmations(content: string): PendingConfirmation[] {
  return content.split(/\r?\n/u).flatMap((text, index) => (
    pendingPattern.test(text) ? [{ line: index + 1, text: text.trim() }] : []
  ));
}

/** 解析受限 Gherkin；含待确认项直接拒绝，无 URL 的场景合法（入口完整性留到执行阶段）。所有错误带文件与行号。 */
export function parseFeature(content: string, file = '<feature>'): ParsedFeature {
  const pending = findPendingConfirmations(content);
  if (pending.length) {
    const locations = pending.map(item => `  ${file}:${item.line} ${item.text}`).join('\n');
    throw new Error(`feature 仍有 ${pending.length} 项待确认，已停止解析。请先直接修改文件并清除待确认注释：\n${locations}`);
  }

  const fail = (line: number, message: string): never => { throw new Error(`${file}:${line} ${message}`); };
  const feature: ParsedFeature = { title: '', file, scenarios: [] };
  let hasFeature = false;
  let priority: string | undefined;
  let scenario: FeatureScenario | undefined;

  content.replace(/^\uFEFF/u, '').split(/\r?\n/u).forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trim();
    if (!text) return;

    if (text.startsWith('#')) {
      feature.source ??= /^#\s*source\s*[:：]\s*(.+)$/iu.exec(text)?.[1].trim();
      return;
    }
    const tag = /^@(p\d+)$/iu.exec(text);
    if (tag) { priority = tag[1].toLowerCase(); return; }

    const featureTitle = /^Feature\s*:\s*(.+)$/u.exec(text);
    if (featureTitle) {
      if (hasFeature) fail(line, '一个文件只能包含一个 Feature');
      hasFeature = true;
      feature.title = featureTitle[1].trim();
      return;
    }
    const scenarioTitle = /^Scenario\s*:\s*(.+)$/u.exec(text);
    if (scenarioTitle) {
      if (!hasFeature) fail(line, 'Scenario 必须位于 Feature 之后');
      scenario = { title: scenarioTitle[1].trim(), line, priority, steps: [] };
      priority = undefined;
      feature.scenarios.push(scenario);
      return;
    }
    const step = /^(Given|When|Then|And)\s+(.+)$/u.exec(text);
    if (step) {
      if (!scenario) fail(line, '步骤必须位于 Scenario 之内');
      scenario!.steps.push({ keyword: step[1] as FeatureStep['keyword'], text: step[2].trim(), line });
      return;
    }
    fail(line, `无法识别或尚不支持的 Gherkin 内容：${text}`);
  });

  if (!hasFeature) fail(1, '缺少 Feature');
  const empty = feature.scenarios.find(item => !item.steps.length);
  if (empty) fail(empty.line, `Scenario 缺少步骤：${empty.title}`);
  if (!feature.scenarios.length) fail(1, 'Feature 至少需要一个 Scenario');
  return feature;
}

/** 从磁盘读取并解析 Feature，文件路径统一为绝对路径。 */
export async function parseFeatureFile(filename: string): Promise<ParsedFeature> {
  const file = resolve(filename);
  return parseFeature(await readFile(file, 'utf8'), file);
}
