/**
 * 承载 browser-opt 即时执行、Workflow 管理子命令的参数解析与执行编排。
 * 文件只协调 CLI 交互，存储、匹配和浏览器执行分别交由对应领域模块处理。
 */
import {
  browserOptTemplate,
  extractBrowserOptUrl,
  splitBrowserOptSteps,
} from '../../browser-opt/utils.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  findBrowserOptWorkflowById,
  loadBrowserOptWorkflows,
  matchBrowserOptWorkflows,
  renderBrowserOptWorkflowFlow,
  resolveBrowserOptWorkflowDir,
  saveBrowserOptWorkflow,
} from '../../browser-opt/workflow/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
  resolveReuseRunningBrowser,
  resolveStatePath,
} from '../utils/args.js';
import { BROWSER_OPT_USAGE, HANDOFF_DONE_ANSWERS, LIVE_VIEWPORT_DASHBOARD_URL } from '../utils/constants.js';
import { printBrowserOptResult } from '../utils/output.js';
import { checkBrowserOptUpdate, printBrowserOptUpdateCheck, readCurrentPackageVersion } from '../utils/version-check.js';
import { setupBrowserOpt, uninstallBrowserOpt } from './setup.js';

interface BrowserOptDetachedRun {
  runId: string;
  pid: number;
  workflowId?: string;
  signalPath: string;
  outputPath: string;
  startedAt: string;
}

interface BrowserOptManagedSessionState {
  sessionIds: string[];
}

interface BrowserOptSessionPlan {
  sessionId: string;
  authStateFallbackSessionId?: string;
}

type BrowserOptDetachedRunStatus = 'RUNNING' | 'HANDOFF' | 'PASS' | 'FAIL';

const BROWSER_OPT_EXIT_CODE_FAILURE = 1;
const BROWSER_OPT_EXIT_CODE_HANDOFF = 2;
const BROWSER_OPT_EXIT_CODE_AMBIGUOUS = 3;
const BROWSER_OPT_EXIT_CODE_NOT_FOUND = 4;
const DEFAULT_BROWSER_PROFILE = 'Default';
const DEFAULT_AUTH_STATE_DIR = '.browser-opt/states';
const MANAGED_SESSION_STATE_FILE = 'browser-opt-sessions.json';
const DEFAULT_HANDOFF_RUN_DIR = '.browser-opt/handoffs';
const HANDOFF_SIGNAL_POLL_INTERVAL_MS = 250;
const NEW_BROWSER_WINDOW_PATTERN = '(?:(?:新开|全新|新的|独立)(?:一个|的)?\\s*(?:Chrome|谷歌浏览器)(?:\\s*(?:窗口|实例))?|(?:Chrome|谷歌浏览器)(?:\\s*(?:窗口|实例))?\\s*(?:新开|全新|新的|独立))';
const NEW_BROWSER_WINDOW_RE = new RegExp(NEW_BROWSER_WINDOW_PATTERN, 'i');
const NEW_BROWSER_WINDOW_STEP_RE = new RegExp(`^(?:请)?${NEW_BROWSER_WINDOW_PATTERN}[。.!！]*$`, 'i');

export async function cmdBrowserOpt(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  const [subcommand] = parsed.positionals;
  if (getBooleanFlag(parsed.flags, 'version') || subcommand === 'version') {
    console.log(readCurrentPackageVersion());
    return;
  }
  const positionalText = parsed.positionals.join(' ').trim();
  const isImmediateFlow = Boolean(extractBrowserOptUrl(positionalText));
  if ((subcommand === 'install' || subcommand === 'setup' || subcommand === 'update') && !isImmediateFlow) {
    const installSystemDependencies = getBooleanFlag(parsed.flags, 'with-deps');
    setupBrowserOpt({
      installRuntime: !getBooleanFlag(parsed.flags, 'skip-runtime'),
      installSystemDependencies,
      downloadBrowser: getBooleanFlag(parsed.flags, 'download-browser') || installSystemDependencies,
      installSkill: !getBooleanFlag(parsed.flags, 'skip-skill'),
      mode: subcommand as 'install' | 'setup' | 'update',
      preferCurrentInstallPrefix: subcommand === 'update',
      registry: getStringFlag(parsed.flags, 'registry'),
      agent: getStringFlag(parsed.flags, 'agent'),
      skillsDir: getStringFlag(parsed.flags, 'skills-dir'),
    });
    return;
  }
  if (subcommand === 'uninstall' && !isImmediateFlow) {
    uninstallBrowserOpt({
      uninstallRuntime: !getBooleanFlag(parsed.flags, 'skip-runtime'),
      uninstallSkill: !getBooleanFlag(parsed.flags, 'skip-skill'),
      removeAllData: getBooleanFlag(parsed.flags, 'all-data'),
      agent: getStringFlag(parsed.flags, 'agent'),
      skillsDir: getStringFlag(parsed.flags, 'skills-dir'),
    });
    return;
  }
  if (subcommand === 'check-update' && !isImmediateFlow) {
    const noCache = getBooleanFlag(parsed.flags, 'no-cache');
    const result = await checkBrowserOptUpdate({
      registry: getStringFlag(parsed.flags, 'registry'),
      timeoutMs: Number(getStringFlag(parsed.flags, 'timeout-ms')) || undefined,
      maxAgeMs: Number(getStringFlag(parsed.flags, 'max-age-ms')) || undefined,
      noCache,
      backgroundOnCacheMiss: !noCache,
    });
    printBrowserOptUpdateCheck(result, getBooleanFlag(parsed.flags, 'json'));
    return;
  }
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
    startDetachedFlowCommand(parsed.positionals.slice(1).join(' '), parsed.flags);
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
  if (subcommand === 'stop' && !isImmediateFlow) {
    stopWorkflowCommand(parsed.flags);
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
  const executionFlags = applyNaturalLanguageBrowserMode(text, flags);
  const executionText = stripNaturalLanguageBrowserModeSteps(text);
  const liveViewport = resolveLiveViewport(executionFlags);
  // 读取调用方显式指定的 Chrome Profile。
  const configuredProfile = resolveProfile(executionFlags);
  // 读取调用方显式指定的 state 文件或环境变量中的 state 路径。
  const configuredStatePath = resolveStatePath(executionFlags);
  /**
   * 显式指定 Profile 时必须启动对应的独立浏览器上下文，不能连接其他运行中的浏览器， Profile 与 focused-browser 复用互斥，因此强制关闭运行中浏览器复用 (false)。
   * 没有 Profile 时，再根据 state、clean-browser 和 reuse-focused-browser 等参数决定连接模式。
   */
  const reuseRunningBrowser = configuredProfile
    ? false
    : resolveReuseRunningBrowser(executionFlags, configuredStatePath, false);
  // 未指定 Profile 时使用 Default，供 state 文件命名和 profile 回退逻辑使用。
  const requestedProfile = configuredProfile ?? DEFAULT_BROWSER_PROFILE;
  // 根据浏览器连接模式选择 state、profile 或外部浏览器当前登录态。
  const authState = resolveBrowserOptAuthState(executionFlags, requestedProfile, reuseRunningBrowser);
  const outputDir = getStringFlag(executionFlags, 'output-dir');
  const useAgentChat = getBooleanFlag(executionFlags, 'agent-chat');
  const handoffSignalPath = getStringFlag(executionFlags, 'handoff-signal');
  const sessionPlan = await prepareBrowserOptSession(executionFlags, reuseRunningBrowser);

  const { BrowserOptRunner } = await import('../../browser-opt/runner/index.js');
  const runner = new BrowserOptRunner();
  const runnerOptions: BrowserOptRunnerOptions = {
    sessionId: sessionPlan.sessionId,
    authStateFallbackSessionId: sessionPlan.authStateFallbackSessionId,
    profile: authState.profile,
    statePath: authState.statePath,
    authStateSavePath: authState.authStateSavePath,
    authStateFallbackProfile: authState.fallbackProfile,
    reuseRunningBrowser,
    liveViewport,
    outputDir,
    useAgentChat,
    handoff: createBrowserOptHandoffOptions(liveViewport, handoffSignalPath),
  };
  const result = await runner.run(executionText, runnerOptions);

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
  const executionFlags = applyNaturalLanguageBrowserMode(query, flags);
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
    await executeBrowserOptFlow(renderBrowserOptWorkflowFlow(workflow), executionFlags);
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
  await executeBrowserOptFlow(renderBrowserOptWorkflowFlow(result.matched.workflow), executionFlags);
}

/** 后台启动可跨 Codex turn 恢复的即时流程或 Workflow，handoff 期间不依赖临时 PTY 会话。 */
function startDetachedFlowCommand(query: string, flags: Record<string, string | boolean>): void {
  const executionFlags = applyNaturalLanguageBrowserMode(query, flags);
  const immediateFlow = getStringFlag(flags, 'flow')?.trim();
  const workflow = immediateFlow ? undefined : resolveDetachedWorkflow(query, flags);
  const runId = randomUUID();
  const runDir = path.resolve(process.cwd(), DEFAULT_HANDOFF_RUN_DIR, runId);
  const signalPath = path.join(runDir, 'resume.signal');
  const outputPath = path.join(runDir, 'output.log');
  const metadataPath = path.join(runDir, 'run.json');
  fs.mkdirSync(runDir, { recursive: true });

  const outputFd = fs.openSync(outputPath, 'a');
  const child = spawn(process.execPath, buildDetachedFlowArgs(workflow?.id, immediateFlow, signalPath, executionFlags), {
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
    workflowId: workflow?.id,
    signalPath,
    outputPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  printDetachedRun(metadata, 'RUNNING', getBooleanFlag(flags, 'json'));
}

/** 即时流程直接使用 --flow；未提供时再按现有规则解析已保存 Workflow。 */
function resolveDetachedWorkflow(
  query: string,
  flags: Record<string, string | boolean>,
): BrowserOptWorkflow {
  const loaded = loadBrowserOptWorkflows(getStringFlag(flags, 'workflow-dir'));
  printWorkflowWarnings(loaded.warnings);
  return resolveWorkflowForExecution(query, flags, loaded.workflows);
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

/** 停止仍在运行的后台 Workflow，避免 handoff 或异常重试在脱离当前终端后继续执行。 */
function stopWorkflowCommand(flags: Record<string, string | boolean>): void {
  const metadata = loadDetachedRun(flags);
  const running = isProcessRunning(metadata.pid);
  if (running) {
    process.kill(metadata.pid, 'SIGTERM');
  }
  if (getBooleanFlag(flags, 'json')) {
    console.log(JSON.stringify({ status: running ? 'STOP_REQUESTED' : 'ALREADY_STOPPED', ...metadata }, null, 2));
    return;
  }
  console.log(running ? `已请求停止后台任务：${metadata.runId}` : `后台任务已经结束：${metadata.runId}`);
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
    throw new Error('使用方式：browser-opt start "<查询语句>" [--workflow-dir <目录>]');
  }

  const result = matchBrowserOptWorkflows(query, workflows);
  if (result.status !== 'matched' || !result.matched) {
    throw new Error(result.status === 'ambiguous' ? 'Workflow 匹配结果不唯一，请使用 --workflow-id。' : '未找到匹配的 Workflow。');
  }
  return result.matched.workflow;
}

/** 复用当前 Node/tsx 入口启动子进程，并只透传会影响流程执行的参数。 */
function buildDetachedFlowArgs(
  workflowId: string | undefined,
  immediateFlow: string | undefined,
  signalPath: string,
  flags: Record<string, string | boolean>,
): string[] {
  const executableName = path.basename(process.argv[1] ?? '');
  const commandPrefix = executableName.startsWith('browser-opt') ? [] : ['browser-opt'];
  const childArgs = [
    ...process.execArgv,
    process.argv[1] ?? '',
    ...commandPrefix,
    ...(immediateFlow ? [immediateFlow] : ['run', '--workflow-id', workflowId ?? '']),
    '--handoff-signal',
    signalPath,
  ];
  const excludedFlags = new Set(['flow', 'workflow-id', 'json', 'run-id', 'handoff-signal']);
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
  authStateSavePath?: string;
  fallbackProfile?: string;
}

/**
 * browser-opt 托管 Chrome 时只复用登录态，不复用上一次运行遗留的页面：
 * 1. 优先加载已有 state；没有 state 时用 profile 打开并保存 cookies/storage。
 * 2. 默认 state 失效时切换一次 profile；显式 --state 不自动回退。
 * 3. focused-browser 直接使用外部浏览器的登录态，不再加载 state 或 profile。
 */
function resolveBrowserOptAuthState(
  flags: Record<string, string | boolean>,
  profile: string,
  reuseRunningBrowser: boolean,
): BrowserOptAuthState {
  const configuredStatePath = resolveStatePath(flags);
  const authStateSavePath = configuredStatePath ?? defaultBrowserOptStatePath(profile);
  if (reuseRunningBrowser) {
    return {};
  }
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

/** 识别流程开头或说明文本里的新开浏览器要求，不把普通页面“新窗口”操作误判成运行模式。 */
function requestsNewBrowserWindow(flow: string): boolean {
  const description = flow
    .split(/(?:\r?\n)?\s*(?:目标|步骤|预期结果)[:：]/, 1)[0]
    ?.replace(/https?:\/\/\S+/gi, ' ')
    ?? '';
  return NEW_BROWSER_WINDOW_RE.test(description)
    || splitBrowserOptSteps(flow).some(isNewBrowserWindowStep);
}

/** 判断单个 Workflow 步骤是否只表达新开 Chrome 窗口的运行模式。 */
function isNewBrowserWindowStep(step: string): boolean {
  return NEW_BROWSER_WINDOW_STEP_RE.test(step.trim());
}

/** 从编号步骤中移除浏览器运行模式，避免它被步骤执行器误判为页面操作。 */
function stripNaturalLanguageBrowserModeSteps(flow: string): string {
  return flow
    .split('\n')
    .filter((line) => {
      const match = line.match(/^\s*(?:目标[:：]\s*)?\d+[\.)、]\s*(.+)$/);
      return !match || !isNewBrowserWindowStep(match[1]);
    })
    .join('\n');
}

/** 把 Workflow 查询中的浏览器模式要求转换为参数，确保匹配后不会随查询文本丢失。 */
function applyNaturalLanguageBrowserMode(
  text: string,
  flags: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const hasExplicitMode = getBooleanFlag(flags, 'clean-browser')
    || getBooleanFlag(flags, 'reuse-focused-browser')
    || getBooleanFlag(flags, 'keep-previous-browser')
    || Boolean(resolveProfile(flags))
    || Boolean(resolveStatePath(flags));
  if (hasExplicitMode) {
    return flags;
  }
  if (requestsNewBrowserWindow(text)) {
    return { ...flags, 'keep-previous-browser': true };
  }
  return flags;
}

/** 默认 state 文件按 profile 分开保存，避免 Work/Default 等登录态互相覆盖。 */
function defaultBrowserOptStatePath(profile: string): string {
  const stateDir = process.env.BROWSER_OPT_AUTH_STATE_DIR || path.resolve(process.cwd(), DEFAULT_AUTH_STATE_DIR);
  const stateName = profile.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return path.join(stateDir, `browser-opt-${stateName}.json`);
}

/**
 * 托管 Chrome 每次使用全新 session，并记录本轮主实例与 profile fallback 的 ID。
 * 默认启动前关闭记录中的上一轮 session；要求保留时继续记录旧 session，留待后续默认运行清理。
 * focused-browser 不参与托管实例清理。
 */
async function prepareBrowserOptSession(
  flags: Record<string, string | boolean>,
  reuseRunningBrowser: boolean,
): Promise<BrowserOptSessionPlan> {
  const configuredSession = getStringFlag(flags, 'session')?.trim();
  if (reuseRunningBrowser) {
    return { sessionId: configuredSession ?? createBrowserOptSessionId() };
  }

  const keepPreviousBrowser = getBooleanFlag(flags, 'keep-previous-browser');
  const statePath = managedSessionStatePath();
  const previousSessionIds = loadManagedSessionIds(statePath);
  if (previousSessionIds.length === 0 && !keepPreviousBrowser) {
    previousSessionIds.push(legacyManagedSessionId());
  }

  if (!keepPreviousBrowser) {
    for (const sessionId of previousSessionIds) {
      terminateManagedSession(sessionId);
    }
  }

  const sessionId = configuredSession ?? createBrowserOptSessionId();
  const authStateFallbackSessionId = createBrowserOptSessionId();
  saveManagedSessionIds(
    statePath,
    keepPreviousBrowser
      ? [...new Set([...previousSessionIds, sessionId, authStateFallbackSessionId])]
      : [sessionId, authStateFallbackSessionId],
  );
  return { sessionId, authStateFallbackSessionId };
}

/**
 * 直接终止 browser-opt 托管的 agent-browser daemon。
 * `agent-browser close` 在 Chrome 已退出但 daemon 尚存时会短暂重启 Chrome，因此清理旧会话时绕过该命令。
 */
function terminateManagedSession(sessionId: string): void {
  if (path.basename(sessionId) !== sessionId) {
    return;
  }

  try {
    const pidPath = path.join(
      os.homedir(),
      '.agent-browser',
      'namespaces',
      'browser-opt',
      'run',
      `${sessionId}.pid`,
    );
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return;
    }

    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
    const executableName = path.basename(command.split(/\s+/, 1)[0] ?? '');
    if (!executableName.startsWith('agent-browser')) {
      return;
    }
    process.kill(pid, 'SIGTERM');
  } catch {
    // 进程已退出或运行目录已清理时无需继续关闭，避免 close 命令重新拉起 Chrome。
  }
}

/** 生成不会复用 daemon/socket 生命周期的 browser-opt session ID。 */
function createBrowserOptSessionId(): string {
  return `browser-opt-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** 首次升级时兼容清理旧版按项目路径生成的稳定 session。 */
function legacyManagedSessionId(): string {
  const projectHash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
  return `browser-opt-${projectHash}`;
}

/** session 记录与登录 state 放在同一项目数据目录，测试和自定义目录也能保持隔离。 */
function managedSessionStatePath(): string {
  const stateDir = process.env.BROWSER_OPT_AUTH_STATE_DIR || path.resolve(process.cwd(), DEFAULT_AUTH_STATE_DIR);
  return path.join(stateDir, MANAGED_SESSION_STATE_FILE);
}

/** 读取上一轮可能存活的 session；损坏记录按无记录处理，由旧版稳定 ID 兜底。 */
function loadManagedSessionIds(statePath: string): string[] {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as BrowserOptManagedSessionState;
    return Array.isArray(state.sessionIds)
      ? state.sessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)
      : [];
  } catch {
    return [];
  }
}

/** 在浏览器启动前记录本轮 session，确保异常退出后下一次调用仍能完成清理。 */
function saveManagedSessionIds(statePath: string, sessionIds: string[]): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ sessionIds }, null, 2));
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
