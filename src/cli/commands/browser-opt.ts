/**
 * 承载 browser-opt 即时执行、Workflow 管理子命令的参数解析与执行编排。
 * 文件只协调 CLI 交互，存储、匹配和浏览器执行分别交由对应领域模块处理。
 */
import {
  BrowserOptRunner,
  browserOptTemplate,
  extractBrowserOptUrl,
} from '../../browser-opt/runner/index.js';
import {
  findBrowserOptWorkflowById,
  loadBrowserOptWorkflows,
  matchBrowserOptWorkflows,
  resolveBrowserOptWorkflowDir,
  saveBrowserOptWorkflow,
} from '../../browser-opt/workflow/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { BrowserOptHandoffContext, BrowserOptRunnerOptions } from '../../browser-opt/type.js';
import type {
  BrowserOptWorkflow,
  BrowserOptWorkflowMatchResult,
} from '../../browser-opt/workflow/type.js';
import {
  getBooleanFlag,
  getStringFlag,
  parseCliArgs,
  resolveLiveViewport,
  resolveProfile,
  resolveStatePath,
} from '../utils/args.js';
import { BROWSER_OPT_USAGE, HANDOFF_DONE_ANSWERS, LIVE_VIEWPORT_DASHBOARD_URL } from '../utils/constants.js';
import { printBrowserOptResult } from '../utils/output.js';

const BROWSER_OPT_EXIT_CODE_FAILURE = 1;
const BROWSER_OPT_EXIT_CODE_HANDOFF = 2;
const BROWSER_OPT_EXIT_CODE_AMBIGUOUS = 3;
const BROWSER_OPT_EXIT_CODE_NOT_FOUND = 4;
const DEFAULT_BROWSER_PROFILE = 'Default';
const DEFAULT_AUTH_STATE_DIR = '.browser-automated/states';

export async function cmdBrowserOpt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [subcommand] = parsed.positionals;
  const positionalText = parsed.positionals.join(' ').trim();
  const isImmediateFlow = Boolean(extractBrowserOptUrl(positionalText));
  if (subcommand === 'save' && (!isImmediateFlow || getStringFlag(parsed.flags, 'flow'))) {
    saveWorkflowCommand(parsed.positionals.slice(1).join(' '), parsed.flags);
    return;
  }
  if (subcommand === 'list' && !isImmediateFlow) {
    listWorkflowCommand(parsed.flags);
    return;
  }
  if (subcommand === 'match' && !isImmediateFlow) {
    matchWorkflowCommand(parsed.positionals.slice(1).join(' '), parsed.flags);
    return;
  }
  if (subcommand === 'run' && (!isImmediateFlow || getStringFlag(parsed.flags, 'workflow-id'))) {
    await runWorkflowCommand(parsed.positionals.slice(1).join(' '), parsed.flags);
    return;
  }

  const text = positionalText;
  if (!text) {
    console.log(`${BROWSER_OPT_USAGE}\n\n${browserOptTemplate()}`);
    process.exit(BROWSER_OPT_EXIT_CODE_FAILURE);
  }

  await executeBrowserOptFlow(text, parsed.flags);
}

/** 统一执行即时或已保存流程，确保两条入口共享登录态、浏览器和报告参数。 */
async function executeBrowserOptFlow(
  text: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const liveViewport = resolveLiveViewport(flags);
  const requestedProfile = resolveProfile(flags) ?? DEFAULT_BROWSER_PROFILE;
  const authState = resolveBrowserOptAuthState(flags, requestedProfile);
  const outputDir = getStringFlag(flags, 'output-dir');
  const useAgentChat = getBooleanFlag(flags, 'agent-chat');

  const runner = new BrowserOptRunner();
  const runnerOptions: BrowserOptRunnerOptions = {
    profile: authState.profile,
    statePath: authState.statePath,
    authStateSavePath: authState.authStateSavePath,
    authStateFallbackProfile: authState.fallbackProfile,
    liveViewport,
    outputDir,
    useAgentChat,
    handoff: createBrowserOptHandoffOptions(liveViewport),
  };
  const result = await runner.run(text, runnerOptions);

  printBrowserOptResult(result);
  if (result.passed) {
    process.exit(0);
  }

  process.exit(result.report.handoffTriggered ? BROWSER_OPT_EXIT_CODE_HANDOFF : BROWSER_OPT_EXIT_CODE_FAILURE);
}

/** 保存完整自然语言流程；默认拒绝覆盖已有同名 Workflow。 */
function saveWorkflowCommand(name: string, flags: Record<string, string | boolean>): void {
  const flow = getStringFlag(flags, 'flow');
  if (!name.trim() || !flow?.trim()) {
    console.error('使用方式：browser-opt save "<名称>" --flow "<完整自然语言流程>" [--workflow-dir <目录>] [--force]');
    process.exit(BROWSER_OPT_EXIT_CODE_FAILURE);
  }

  const result = saveBrowserOptWorkflow({
    name,
    flow,
    workflowDir: getStringFlag(flags, 'workflow-dir'),
    force: getBooleanFlag(flags, 'force'),
  });
  console.log(`${result.created ? '已保存' : '已更新'} Workflow：${result.workflow.name}`);
  console.log(`文件：${result.filePath}`);
}

/** 列出项目目录第一层的有效 Workflow，JSON 模式供 Skill 和脚本稳定解析。 */
function listWorkflowCommand(flags: Record<string, string | boolean>): void {
  const workflowDir = getStringFlag(flags, 'workflow-dir');
  const loaded = loadBrowserOptWorkflows(workflowDir);
  printWorkflowWarnings(loaded.warnings);
  if (getBooleanFlag(flags, 'json')) {
    console.log(JSON.stringify({
      workflowDir: resolveBrowserOptWorkflowDir(workflowDir),
      workflows: loaded.workflows,
      warnings: loaded.warnings,
    }, null, 2));
    return;
  }

  if (loaded.workflows.length === 0) {
    console.log(`未找到已保存的 Workflow：${resolveBrowserOptWorkflowDir(workflowDir)}`);
    return;
  }
  console.log(`已保存的 Workflow（${resolveBrowserOptWorkflowDir(workflowDir)}）：`);
  for (const workflow of loaded.workflows) {
    console.log(`  - ${workflow.name} [${workflow.id}]`);
  }
}

/** 输出查询解析结果；该命令本身不启动浏览器，供 Skill 决定是否需要用户选择。 */
function matchWorkflowCommand(query: string, flags: Record<string, string | boolean>): void {
  if (!query.trim()) {
    console.error('使用方式：browser-opt match "<查询语句>" [--workflow-dir <目录>] [--json]');
    process.exit(BROWSER_OPT_EXIT_CODE_FAILURE);
  }

  const loaded = loadBrowserOptWorkflows(getStringFlag(flags, 'workflow-dir'));
  const result = matchBrowserOptWorkflows(query, loaded.workflows);
  printWorkflowWarnings(loaded.warnings);
  if (getBooleanFlag(flags, 'json')) {
    console.log(JSON.stringify(toWorkflowMatchOutput(result, loaded.warnings), null, 2));
    return;
  }
  printWorkflowMatch(result);
}

/** 先解析查询或指定 ID，只有结果唯一时才进入现有 BrowserOptRunner。 */
async function runWorkflowCommand(query: string, flags: Record<string, string | boolean>): Promise<void> {
  const loaded = loadBrowserOptWorkflows(getStringFlag(flags, 'workflow-dir'));
  printWorkflowWarnings(loaded.warnings);
  const workflowId = getStringFlag(flags, 'workflow-id');
  if (workflowId) {
    const workflow = findBrowserOptWorkflowById(workflowId, loaded.workflows);
    if (!workflow) {
      console.error(`未找到 Workflow ID：${workflowId}`);
      printAvailableWorkflows(loaded.workflows);
      process.exit(BROWSER_OPT_EXIT_CODE_NOT_FOUND);
    }
    await executeBrowserOptFlow(workflow.flow, flags);
    return;
  }
  if (!query.trim()) {
    console.error('使用方式：browser-opt run "<查询语句>" [--workflow-dir <目录>]');
    process.exit(BROWSER_OPT_EXIT_CODE_FAILURE);
  }

  const result = matchBrowserOptWorkflows(query, loaded.workflows);
  if (result.status === 'ambiguous') {
    printWorkflowMatch(result);
    process.exit(BROWSER_OPT_EXIT_CODE_AMBIGUOUS);
  }
  if (result.status === 'not-found' || !result.matched) {
    printWorkflowMatch(result);
    process.exit(BROWSER_OPT_EXIT_CODE_NOT_FOUND);
  }
  await executeBrowserOptFlow(result.matched.workflow.flow, flags);
}

/** JSON 输出收敛为候选元数据，避免匹配阶段把完整自动化正文回显给调用方。 */
function toWorkflowMatchOutput(result: BrowserOptWorkflowMatchResult, warnings: string[]) {
  const compact = (workflow: BrowserOptWorkflow, score?: number) => ({
    id: workflow.id,
    name: workflow.name,
    ...(score === undefined ? {} : { score }),
  });
  return {
    status: result.status,
    matched: result.matched ? compact(result.matched.workflow, result.matched.score) : null,
    candidates: result.candidates.map((candidate) => compact(candidate.workflow, candidate.score)),
    available: result.available.map((workflow) => compact(workflow)),
    warnings,
  };
}

/** 人类可读输出明确区分唯一命中、需要选择和完全未命中。 */
function printWorkflowMatch(result: BrowserOptWorkflowMatchResult): void {
  if (result.status === 'matched' && result.matched) {
    console.log(`匹配到 Workflow：${result.matched.workflow.name} [${result.matched.workflow.id}]`);
    return;
  }
  if (result.status === 'ambiguous') {
    console.log('找到多个相似 Workflow，请选择后使用 --workflow-id 执行：');
    result.candidates.forEach((candidate, index) => {
      console.log(`  ${index + 1}. ${candidate.workflow.name} [${candidate.workflow.id}]`);
    });
    return;
  }
  console.log('未找到匹配的 Workflow，请补充描述或从可用流程中选择。');
  printAvailableWorkflows(result.available);
}

function printAvailableWorkflows(workflows: BrowserOptWorkflow[]): void {
  if (workflows.length === 0) {
    console.log('当前项目尚未保存 Workflow。');
    return;
  }
  console.log('可用 Workflow：');
  for (const workflow of workflows) {
    console.log(`  - ${workflow.name} [${workflow.id}]`);
  }
}

function printWorkflowWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(`跳过无效 Workflow：${warning}`);
  }
}

interface BrowserOptAuthState {
  profile?: string;
  statePath?: string;
  authStateSavePath: string;
  fallbackProfile?: string;
}

/**
 * 登录态复用策略：
 * 1. 默认 state 存在时优先加载，避免每次从完整 Chrome profile 启动。
 * 2. 默认 state 不存在时用 profile 首次导入，并把 cookies/storage 保存成 state。
 * 3. 只有自动选择的默认 state 才允许后续 profile fallback；显式 --state 保持隔离语义。
 */
function resolveBrowserOptAuthState(flags: Record<string, string | boolean>, profile: string): BrowserOptAuthState {
  const configuredStatePath = resolveStatePath(flags);
  const authStateSavePath = configuredStatePath ?? defaultBrowserOptStatePath(profile);
  if (fs.existsSync(authStateSavePath)) {
    return {
      statePath: authStateSavePath,
      authStateSavePath,
      fallbackProfile: configuredStatePath ? undefined : profile,
    };
  }

  return {
    profile,
    authStateSavePath,
  };
}

/** 默认 state 文件按 profile 分开保存，避免 Work/Default 等登录态互相覆盖。 */
function defaultBrowserOptStatePath(profile: string): string {
  const stateDir = process.env.BROWSER_OPT_AUTH_STATE_DIR || path.resolve(process.cwd(), DEFAULT_AUTH_STATE_DIR);
  const stateName = profile.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return path.join(stateDir, `browser-opt-${stateName}.json`);
}

/** 读取终端输入，供 handoff 暂停点等待用户确认继续。 */
function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 判断用户是否已确认人工登录或处理动作完成。 */
function isDoneAnswer(input: string): boolean {
  const value = input.trim().toLowerCase();
  return HANDOFF_DONE_ANSWERS.includes(value as (typeof HANDOFF_DONE_ANSWERS)[number]);
}

/** browser-opt 默认进入 handoff 后等待用户完成操作，再恢复同一个浏览器会话继续执行。 */
function createBrowserOptHandoffOptions(liveViewport: boolean) {
  return {
    onHandoffRequired: async (context: BrowserOptHandoffContext) => {
      console.log('\n=== Browser Opt Handoff ===');
      console.log(`Reason: ${context.message}`);
      if (context.sessionId) {
        console.log(`Session: ${context.sessionId}`);
      }
      if (liveViewport) {
        console.log(`Live viewport: ${LIVE_VIEWPORT_DASHBOARD_URL}`);
      }
      console.log('已打开可视浏览器，请手动完成登录。');
      console.log('完成后请在这里输入 done（或 ok / 继续 / 完成）以恢复自动化。');
      if (context.output.trim()) {
        console.log(context.output.trim());
      }
    },
    waitForUserResume: waitForBrowserOptHandoffDone,
    onHandoffCompleted: async () => {
      console.log('人工操作完成，恢复 browser-opt 自动化执行。\n');
    },
  };
}

/** 循环等待明确完成信号，避免误触回车后过早恢复自动化。 */
async function waitForBrowserOptHandoffDone(): Promise<void> {
  while (true) {
    const answer = await promptUser('请输入 done 继续：\n> ');
    if (isDoneAnswer(answer)) {
      return;
    }
    console.log('未识别输入，请输入 done / ok / 继续 / 完成。');
  }
}
