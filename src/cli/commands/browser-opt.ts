/**
 * 承载 browser-opt 即时执行、Workflow 管理子命令的参数解析与执行编排。
 * 文件只协调 CLI 交互，存储、匹配和浏览器执行分别交由对应领域模块处理。
 */
import {
  BrowserOptRunner,
  browserOptTemplate,
  extractBrowserOptUrl,
} from '../../browser-opt/runner/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  findBrowserOptWorkflowById,
  loadBrowserOptWorkflows,
  matchBrowserOptWorkflows,
  renderBrowserOptWorkflowFlow,
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

interface BrowserOptDetachedRun {
  runId: string;
  pid: number;
  workflowId: string;
  signalPath: string;
  outputPath: string;
  startedAt: string;
}

type BrowserOptDetachedRunStatus = 'RUNNING' | 'HANDOFF' | 'PASS' | 'FAIL';

const BROWSER_OPT_EXIT_CODE_FAILURE = 1;
const BROWSER_OPT_EXIT_CODE_HANDOFF = 2;
const BROWSER_OPT_EXIT_CODE_AMBIGUOUS = 3;
const BROWSER_OPT_EXIT_CODE_NOT_FOUND = 4;
const DEFAULT_BROWSER_PROFILE = 'Default';
const DEFAULT_AUTH_STATE_DIR = '.browser-opt/states';
const DEFAULT_HANDOFF_RUN_DIR = '.browser-opt/handoffs';
const HANDOFF_SIGNAL_POLL_INTERVAL_MS = 250;

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
  if (subcommand === 'start' && !isImmediateFlow) {
    startWorkflowCommand(parsed.positionals.slice(1).join(' '), parsed.flags);
    return;
  }
  if (subcommand === 'status' && !isImmediateFlow) {
    statusWorkflowCommand(parsed.flags);
    return;
  }
  if (subcommand === 'resume' && !isImmediateFlow) {
    resumeWorkflowCommand(parsed.flags);
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
  identity?: string,
): Promise<void> {
  const liveViewport = resolveLiveViewport(flags);
  const requestedProfile = resolveProfile(flags) ?? DEFAULT_BROWSER_PROFILE;
  const authState = resolveBrowserOptAuthState(flags, requestedProfile);
  const outputDir = getStringFlag(flags, 'output-dir');
  const useAgentChat = getBooleanFlag(flags, 'agent-chat');
  const handoffSignalPath = getStringFlag(flags, 'handoff-signal');

  const runner = new BrowserOptRunner();
  const runnerOptions: BrowserOptRunnerOptions = {
    sessionId: resolveBrowserOptSessionId(flags, identity ?? text),
    profile: authState.profile,
    statePath: authState.statePath,
    authStateSavePath: authState.authStateSavePath,
    authStateFallbackProfile: authState.fallbackProfile,
    liveViewport,
    outputDir,
    useAgentChat,
    handoff: createBrowserOptHandoffOptions(liveViewport, handoffSignalPath),
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
    console.error('使用方式：npx browser-opt save "<名称>" --flow "<完整自然语言流程>" [--workflow-dir <目录>] [--force]');
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
    console.error('使用方式：npx browser-opt match "<查询语句>" [--workflow-dir <目录>] [--json]');
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
    await executeBrowserOptFlow(renderBrowserOptWorkflowFlow(workflow), flags, workflow.id);
    return;
  }
  if (!query.trim()) {
    console.error('使用方式：npx browser-opt run "<查询语句>" [--workflow-dir <目录>]');
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
  await executeBrowserOptFlow(renderBrowserOptWorkflowFlow(result.matched.workflow), flags, result.matched.workflow.id);
}

/** 后台启动可跨 Codex turn 恢复的 Workflow，handoff 期间不依赖临时 PTY 会话。 */
function startWorkflowCommand(query: string, flags: Record<string, string | boolean>): void {
  const loaded = loadBrowserOptWorkflows(getStringFlag(flags, 'workflow-dir'));
  printWorkflowWarnings(loaded.warnings);
  const workflow = resolveWorkflowForExecution(query, flags, loaded.workflows);
  const runId = randomUUID();
  const runDir = path.resolve(process.cwd(), DEFAULT_HANDOFF_RUN_DIR, runId);
  const signalPath = path.join(runDir, 'resume.signal');
  const outputPath = path.join(runDir, 'output.log');
  const metadataPath = path.join(runDir, 'run.json');
  fs.mkdirSync(runDir, { recursive: true });

  const outputFd = fs.openSync(outputPath, 'a');
  const child = spawn(process.execPath, buildDetachedWorkflowArgs(workflow.id, signalPath, flags), {
    detached: true,
    stdio: ['ignore', outputFd, outputFd],
    env: {
      ...process.env,
      BROWSER_OPT_HANDOFF_RUN_ID: runId,
    },
  });
  fs.closeSync(outputFd);
  if (!child.pid) {
    throw new Error('无法启动后台 browser-opt Workflow。');
  }
  child.unref();

  const metadata: BrowserOptDetachedRun = {
    runId,
    pid: child.pid,
    workflowId: workflow.id,
    signalPath,
    outputPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  printDetachedRun(metadata, 'RUNNING', getBooleanFlag(flags, 'json'));
}

/** 查询后台 Workflow 的稳定状态，并返回最近输出供 Skill 识别 handoff 与最终报告。 */
function statusWorkflowCommand(flags: Record<string, string | boolean>): void {
  const metadata = loadDetachedRun(flags);
  const output = readDetachedRunOutput(metadata.outputPath);
  const status = resolveDetachedRunStatus(metadata.pid, output);
  printDetachedRun(metadata, status, getBooleanFlag(flags, 'json'), output);
}

/** 向后台 Workflow 写入一次性恢复信号，原 runner 会在同一浏览器实例中继续。 */
function resumeWorkflowCommand(flags: Record<string, string | boolean>): void {
  const metadata = loadDetachedRun(flags);
  fs.mkdirSync(path.dirname(metadata.signalPath), { recursive: true });
  fs.writeFileSync(metadata.signalPath, 'done\n');
  if (getBooleanFlag(flags, 'json')) {
    console.log(JSON.stringify({ status: 'RESUME_REQUESTED', ...metadata }, null, 2));
    return;
  }
  console.log(`已发送恢复信号：${metadata.runId}`);
}

/** start 与 run 共用 Workflow 唯一匹配规则，避免后台入口选择不同的流程。 */
function resolveWorkflowForExecution(
  query: string,
  flags: Record<string, string | boolean>,
  workflows: BrowserOptWorkflow[],
): BrowserOptWorkflow {
  const workflowId = getStringFlag(flags, 'workflow-id');
  if (workflowId) {
    const workflow = findBrowserOptWorkflowById(workflowId, workflows);
    if (workflow) {
      return workflow;
    }
    throw new Error(`未找到 Workflow ID：${workflowId}`);
  }
  if (!query.trim()) {
    throw new Error('使用方式：npx browser-opt start "<查询语句>" [--workflow-dir <目录>]');
  }

  const result = matchBrowserOptWorkflows(query, workflows);
  if (result.status !== 'matched' || !result.matched) {
    throw new Error(result.status === 'ambiguous' ? 'Workflow 匹配结果不唯一，请使用 --workflow-id。' : '未找到匹配的 Workflow。');
  }
  return result.matched.workflow;
}

/** 复用当前 Node/tsx 入口启动子进程，并只透传会影响 Workflow 执行的参数。 */
function buildDetachedWorkflowArgs(
  workflowId: string,
  signalPath: string,
  flags: Record<string, string | boolean>,
): string[] {
  const executableName = path.basename(process.argv[1] ?? '');
  const commandPrefix = executableName.startsWith('browser-opt') ? [] : ['browser-opt'];
  const childArgs = [
    ...process.execArgv,
    process.argv[1] ?? '',
    ...commandPrefix,
    'run',
    '--workflow-id',
    workflowId,
    '--handoff-signal',
    signalPath,
  ];
  const excludedFlags = new Set(['workflow-id', 'json', 'run-id', 'handoff-signal']);
  for (const [key, value] of Object.entries(flags)) {
    if (excludedFlags.has(key)) {
      continue;
    }
    childArgs.push(`--${key}`);
    if (typeof value === 'string') {
      childArgs.push(value);
    }
  }
  return childArgs;
}

/** 从固定控制目录读取后台任务元数据，runId 是跨 turn 的唯一恢复凭据。 */
function loadDetachedRun(flags: Record<string, string | boolean>): BrowserOptDetachedRun {
  const runId = getStringFlag(flags, 'run-id')?.trim();
  if (!runId) {
    throw new Error('缺少 --run-id。');
  }
  const metadataPath = path.resolve(process.cwd(), DEFAULT_HANDOFF_RUN_DIR, runId, 'run.json');
  const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')) as BrowserOptDetachedRun;
  if (parsed.runId !== runId) {
    throw new Error(`后台 Workflow 元数据与 runId 不一致：${runId}`);
  }
  return parsed;
}

/** 后台输出只返回尾部，既保留最新 handoff/报告信息，也避免历史日志无限增长。 */
function readDetachedRunOutput(outputPath: string): string {
  if (!fs.existsSync(outputPath)) {
    return '';
  }
  return fs.readFileSync(outputPath, 'utf-8').slice(-12_000);
}

/** 结合进程存活状态与 CLI 输出判断当前阶段。 */
function resolveDetachedRunStatus(pid: number, output: string): BrowserOptDetachedRunStatus {
  if (isProcessRunning(pid)) {
    const handoffIndex = output.lastIndexOf('=== Browser Opt Handoff ===');
    const resumedIndex = output.lastIndexOf('人工操作完成，恢复 browser-opt 自动化执行。');
    return handoffIndex > resumedIndex ? 'HANDOFF' : 'RUNNING';
  }
  return output.includes('执行成功') ? 'PASS' : 'FAIL';
}

/** 只探测后台进程是否仍存在，不发送信号或改变运行状态。 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 人类输出与 JSON 输出共享同一组后台任务字段。 */
function printDetachedRun(
  metadata: BrowserOptDetachedRun,
  status: BrowserOptDetachedRunStatus,
  json: boolean,
  output = '',
): void {
  if (json) {
    console.log(JSON.stringify({ status, ...metadata, output }, null, 2));
    return;
  }
  console.log(`Status: ${status}`);
  console.log(`Run ID: ${metadata.runId}`);
  console.log(`Output: ${metadata.outputPath}`);
  if (output.trim()) {
    console.log(output.trim());
  }
}

/** JSON 输出收敛为候选元数据，避免匹配阶段把完整自动化正文回显给调用方。 */
function toWorkflowMatchOutput(result: BrowserOptWorkflowMatchResult, warnings: string[]) {
  const compact = (workflow: BrowserOptWorkflow, score?: number) => ({
    id: workflow.id,
    name: workflow.name,
    ...(workflow.filePath ? { filePath: workflow.filePath } : {}),
    ...(workflow.filePath ? { displayPath: formatWorkflowDisplayPath(workflow.filePath) } : {}),
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
    const label = result.candidates.length > 1 ? '找到多个相似 Workflow' : '找到相似 Workflow';
    console.log(`${label}，请选择候选序号，或使用 --workflow-id 执行：`);
    result.candidates.forEach((candidate, index) => {
      console.log(`  ${index + 1}. ${formatWorkflowLink(candidate.workflow)} [${candidate.workflow.id}]`);
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
    console.log(`  - ${formatWorkflowLink(workflow)} [${workflow.id}]`);
  }
}

function printWorkflowWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(`跳过无效 Workflow：${warning}`);
  }
}

/** 在支持 Markdown 的界面里把候选流程渲染为可点击文件链接，终端里仍保留可读名称。 */
function formatWorkflowLink(workflow: BrowserOptWorkflow): string {
  if (!workflow.filePath) {
    return workflow.name;
  }
  return `[${escapeMarkdownLinkText(workflow.name)}](<${workflow.filePath}>)`;
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\\\[\]])/g, '\\$1');
}

/** 优先给调用方返回工作区相对路径，便于 VS Code/Copilot 识别为本地文件引用。 */
function formatWorkflowDisplayPath(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
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
 * 2. 默认 state 不存在时由唯一主 agent 使用 profile 打开，并把 cookies/storage 保存成 state。
 * 3. 默认 state 失效时切换到 profile 窗口，让交互式 handoff 可使用 Chrome 密码管理器。
 * 4. 显式 --state 保持隔离语义，不自动回退到 profile。
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

/** 为同一项目里的同一流程生成稳定 session，便于不同入口一致标识浏览器会话。 */
function resolveBrowserOptSessionId(flags: Record<string, string | boolean>, identity: string): string {
  const configuredSession = getStringFlag(flags, 'session')?.trim();
  if (configuredSession) {
    return configuredSession;
  }

  const seed = `${process.cwd()}\n${identity}`;
  return `browser-opt-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
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

/** browser-opt 默认等待终端输入；后台 Workflow 改用信号文件跨 turn 恢复同一个会话。 */
function createBrowserOptHandoffOptions(liveViewport: boolean, handoffSignalPath?: string) {
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
      console.log('已打开可视浏览器，请手动完成页面要求的操作。');
      if (handoffSignalPath) {
        const runId = process.env.BROWSER_OPT_HANDOFF_RUN_ID;
        console.log(`完成后请恢复后台任务${runId ? ` ${runId}` : ''}，自动化会继续复用当前浏览器。`);
      } else {
        console.log('完成后请在这里输入 done（或 ok / 继续 / 完成）以恢复自动化。');
      }
      if (context.output.trim()) {
        console.log(context.output.trim());
      }
    },
    waitForUserResume: handoffSignalPath
      ? () => waitForBrowserOptHandoffSignal(handoffSignalPath)
      : waitForBrowserOptHandoffDone,
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

/** 后台任务轮询一次性信号文件，消费后删除以支持同一 Workflow 多次 handoff。 */
async function waitForBrowserOptHandoffSignal(signalPath: string): Promise<void> {
  const resolvedSignalPath = path.resolve(signalPath);
  fs.mkdirSync(path.dirname(resolvedSignalPath), { recursive: true });
  fs.rmSync(resolvedSignalPath, { force: true });
  while (true) {
    if (fs.existsSync(resolvedSignalPath)) {
      const answer = fs.readFileSync(resolvedSignalPath, 'utf-8');
      if (isDoneAnswer(answer)) {
        fs.rmSync(resolvedSignalPath, { force: true });
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_SIGNAL_POLL_INTERVAL_MS));
  }
}
