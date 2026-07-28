/**
 * 管理 browser-opt Workflow 的项目级目录解析、JSON 校验和安全落盘。
 * 存储层不负责匹配或执行，让保存格式可以独立演进和测试。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractBrowserOptUrl, splitBrowserOptSteps } from '../utils.js';
import type {
  BrowserOptWorkflow,
  BrowserOptWorkflowLoadResult,
  SaveBrowserOptWorkflowInput,
  SaveBrowserOptWorkflowResult,
} from './type.js';

export const DEFAULT_BROWSER_OPT_WORKFLOW_DIR = path.join('.browser-opt', 'workflows');

/** 相对目录始终以调用者当前项目为基准，避免依赖 browser-opt 包的安装位置。 */
export function resolveBrowserOptWorkflowDir(workflowDir?: string, cwd = process.cwd()): string {
  return path.resolve(cwd, workflowDir?.trim() || DEFAULT_BROWSER_OPT_WORKFLOW_DIR);
}

/** 只加载目标目录第一层的 JSON，并把单文件错误降级为可展示的诊断。 */
export function loadBrowserOptWorkflows(workflowDir?: string): BrowserOptWorkflowLoadResult {
  const resolvedDir = resolveBrowserOptWorkflowDir(workflowDir);
  if (!fs.existsSync(resolvedDir)) {
    return { workflows: [], warnings: [] };
  }

  const workflows: BrowserOptWorkflow[] = [];
  const warnings: string[] = [];
  const entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

  for (const entry of entries) {
    const filePath = path.join(resolvedDir, entry.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      workflows.push(parseBrowserOptWorkflow(parsed, filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${filePath}: ${message}`);
    }
  }

  workflows.sort(compareWorkflows);
  return { workflows, warnings };
}

/** 保存前校验流程可执行性；同名 Workflow 只有显式 force 才允许更新。 */
export function saveBrowserOptWorkflow(input: SaveBrowserOptWorkflowInput): SaveBrowserOptWorkflowResult {
  const name = input.name.trim();
  const flow = input.flow.trim();
  const workflowContent = parseWorkflowContent(flow);
  validateWorkflowInput(name, workflowContent.target.url, workflowContent.steps);

  const workflowDir = resolveBrowserOptWorkflowDir(input.workflowDir);
  const loaded = loadBrowserOptWorkflows(input.workflowDir);
  const normalizedName = normalizeWorkflowName(name);
  const existing = loaded.workflows.find((workflow) => normalizeWorkflowName(workflow.name) === normalizedName);
  if (existing && !input.force) {
    throw new Error(`Workflow“${existing.name}”已存在；如需覆盖请传入 --force。`);
  }

  const id = existing?.id ?? safeWorkflowId(name);
  const filePath = existing
    ? path.join(workflowDir, `${existing.id}.json`)
    : path.join(workflowDir, `${id}.json`);
  const conflicting = loaded.workflows.find((workflow) => workflow.id === id && workflow.name !== name);
  if (conflicting) {
    throw new Error(`Workflow 名称生成的文件标识与“${conflicting.name}”冲突，请更换名称。`);
  }
  const targetExists = fs.existsSync(filePath);
  if (!existing && targetExists && !input.force) {
    throw new Error(`Workflow 文件“${filePath}”已存在但无法作为有效 Workflow 加载；如需替换请传入 --force。`);
  }

  const now = new Date().toISOString();
  const workflow: BrowserOptWorkflow = {
    version: 2,
    id,
    name,
    target: workflowContent.target,
    steps: workflowContent.steps,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf-8');
  return { workflow, filePath, created: !targetExists };
}

/** 按稳定 ID 查找 Workflow，供候选选择后绕过再次模糊匹配。 */
export function findBrowserOptWorkflowById(
  id: string,
  workflows: BrowserOptWorkflow[],
): BrowserOptWorkflow | undefined {
  return workflows.find((workflow) => workflow.id === id);
}

/** 将名称转换为可读且不可穿越目录的 Unicode 文件标识。 */
export function safeWorkflowId(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+|[.-]+$/g, '');
  const shortened = Array.from(normalized).slice(0, 80).join('');
  if (!shortened || shortened === '.' || shortened === '..') {
    throw new Error('Workflow 名称无法生成安全的文件名，请使用中文、英文或数字命名。');
  }
  return shortened;
}

function parseBrowserOptWorkflow(value: unknown, filePath: string): BrowserOptWorkflow {
  if (!value || typeof value !== 'object') {
    throw new Error('Workflow 内容必须是 JSON 对象');
  }

  const candidate = value as Partial<BrowserOptWorkflow>;
  const fields: Array<keyof BrowserOptWorkflow> = ['id', 'name', 'createdAt', 'updatedAt'];
  if (candidate.version !== 2 || fields.some((field) => typeof candidate[field] !== 'string' || !candidate[field]?.trim())) {
    throw new Error('Workflow 格式无效，必须包含 version=2、id、name、createdAt、updatedAt');
  }
  if (!candidate.target || typeof candidate.target !== 'object' || typeof candidate.target.url !== 'string') {
    throw new Error('Workflow 格式无效，target.url 不能为空');
  }
  if (!Array.isArray(candidate.steps)) {
    throw new Error('Workflow 格式无效，steps 必须是字符串数组');
  }
  if (path.basename(filePath, '.json') !== candidate.id) {
    throw new Error('Workflow id 必须与文件名一致');
  }
  validateWorkflowInput(candidate.name as string, candidate.target.url, candidate.steps);
  return candidate as BrowserOptWorkflow;
}

/** 把自然语言 flow 解析为结构化 Workflow 内容，便于人读和手动维护。 */
function parseWorkflowContent(flow: string): { target: { url: string }; steps: string[] } {
  const url = extractBrowserOptUrl(flow);
  if (!url) {
    throw new Error('Workflow 流程必须包含可访问的 http:// 或 https:// URL。');
  }
  const steps = splitBrowserOptSteps(flow);
  return { target: { url }, steps };
}

function validateWorkflowInput(name: string, url: string, steps: string[]): void {
  if (!name) {
    throw new Error('Workflow 名称不能为空。');
  }
  safeWorkflowId(name);
  if (!url.trim()) {
    throw new Error('Workflow URL 不能为空。');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Workflow 流程必须包含可访问的 http:// 或 https:// URL。');
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Workflow 流程必须包含至少一个可执行步骤。');
  }
  for (const step of steps) {
    if (typeof step !== 'string' || !step.trim()) {
      throw new Error('Workflow steps 必须是非空字符串数组。');
    }
  }
}

function normalizeWorkflowName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function compareWorkflows(left: BrowserOptWorkflow, right: BrowserOptWorkflow): number {
  return left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id, 'zh-CN');
}

/** 运行前将结构化 Workflow 还原为现有 runner 可消费的自然语言 flow。 */
export function renderBrowserOptWorkflowFlow(workflow: BrowserOptWorkflow): string {
  const numberedSteps = workflow.steps.map((step, index) => `${index + 1}. ${step}`);
  return `测试 ${workflow.target.url}。\n${numberedSteps.join('\n')}`;
}
