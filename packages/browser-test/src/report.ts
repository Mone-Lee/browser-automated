/**
 * 运行产物：把一次 run 的结果落盘为 result.json（机器可读，含动作链与证据）和 report.md（人读，失败步骤置顶）。
 * trace.log 与 shots/ 由执行过程直接写入，这里只负责结果文件，保证每个证据编号都能在报告中找到实际观测。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatureResult, StepResult } from './types.js';

/** 目录名使用本地时间 YYYYMMDD-HHmm；同一分钟重复运行追加序号，避免覆盖上一次产物。 */
export async function createRunDirectory(base: string, now = new Date()): Promise<string> {
  const pad = (value: number) => String(value).padStart(2, '0');
  const name = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  await mkdir(base, { recursive: true });
  for (let index = 0; ; index += 1) {
    const directory = join(base, index ? `${name}-${index + 1}` : name);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await mkdir(join(directory, 'shots'));
    return directory;
  }
}

/** 单行步骤摘要：状态、原文行号与原文。 */
function stepLine(step: StepResult): string {
  if (step.execution === 'not-run') return `- ⏭ 未执行 · 第 ${step.source.line} 行 \`${step.source.original}\`：${step.reason}`;
  return `- ${step.status === 'PASS' ? '✅' : step.status === 'FAIL' ? '❌' : '⛔'} ${step.status} · 第 ${step.source.line} 行 \`${step.source.original}\`${step.reason ? `：${step.reason}` : ''}`;
}

/** 渲染 report.md：失败与阻塞步骤置顶并附实际值，其后按场景列出每一步（含未执行步骤）。 */
function renderReport(result: FeatureResult): string {
  const lines = [`# ${result.feature}`, '', `结果：**${result.status}**　平台：${result.platform}　数据模式：${result.dataMode}（真实环境验证）`, ''];
  if (result.authState?.length) lines.push('## 登录态', '', ...result.authState.map(line => `- ${line}`), '');
  const problems = result.scenarios.flatMap(scenario => scenario.steps.filter((step): step is Extract<StepResult, { execution: 'executed' }> => step.execution === 'executed' && step.status !== 'PASS').map(step => ({ scenario: scenario.title, step })));
  if (problems.length) {
    lines.push('## 需要关注', '');
    for (const { scenario, step } of problems) {
      lines.push(`### ${step.status}：${scenario} · 第 ${step.source.line} 行`, '', `原文：\`${step.source.original}\``);
      if (step.reason) lines.push(`原因：${step.reason}`);
      for (const check of step.checks.filter(item => item.status !== 'PASS')) {
        const evidence = result.evidence.filter(item => check.evidenceIds.includes(item.id));
        lines.push(`- 条件 ${check.conditionId}（${check.by}，${check.status}）实际：${JSON.stringify(check.actual)}${evidence.length ? `；证据 ${evidence.map(item => item.id).join('、')}` : ''}${evidence.find(item => item.shot) ? `；截图 ${evidence.find(item => item.shot)!.shot}` : ''}`);
      }
      lines.push('');
    }
  }
  for (const scenario of result.scenarios) lines.push(`## ${scenario.title}（${scenario.status}）`, '', ...scenario.steps.map(stepLine), '');
  lines.push(`环境：入口 ${result.environment.declaredUrl ?? '未声明'}，实际 ${result.environment.actualUrl ?? '未知'}`, `复现：\`${result.rerun}\``, '');
  return lines.join('\n');
}

/** 写入 result.json 与 report.md。 */
export async function writeReport(directory: string, result: FeatureResult): Promise<void> {
  await writeFile(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(directory, 'report.md'), renderReport(result));
}
