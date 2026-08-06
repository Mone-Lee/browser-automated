/**
 * 封装 agent-browser CLI，提供两个对外产物共享的浏览器 session、截图和 handoff 能力。
 */
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveSystemChromeExecutable } from './browser-executable.js';
import { createAgentBrowserEnvironment } from './proxy-env.js';
import { AgentOptions } from './types.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_DASHBOARD_PORT = 4848;
const DEFAULT_STREAM_PORT = 9223;
const DEFAULT_CLEAN_BROWSER_ARGS = [
  '--disable-session-crashed-bubble',
  '--no-first-run',
  '--no-default-browser-check',
];
const AGENT_BROWSER_INSTALL_HINT = '请先安装 agent-browser，例如：npm install -g agent-browser。';

export interface AgentBrowserJsonResult {
  raw: string;
  data: unknown | null;
  parseError?: string;
}

export interface BrowserTabInfo {
  /** 当前标签页是否处于激活状态。 */
  active: boolean;
  /** agent-browser 返回的稳定标签页标识，可用于后续切换。 */
  tabId: string;
  /** 浏览器标签页标题。 */
  title: string;
  /** 浏览器标签页类型，例如 `page`。 */
  type: string;
  /** 当前标签页地址。 */
  url: string;
}

interface CdpResponse<TResult> {
  id: number;
  result?: TResult;
  error?: { code: number; message: string };
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
}

interface CdpTargetListResult {
  targetInfos: CdpTargetInfo[];
}

interface CdpOpenDevToolsResult {
  targetId: string;
}

function parseJsonOutput(raw: string): AgentBrowserJsonResult {
  try {
    return {
      raw,
      data: JSON.parse(raw) as unknown,
    };
  } catch (err) {
    return {
      raw,
      data: null,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `agent-browser` CLI 的封装层。
 *
 * 每个实例都维护一个由 `sessionId` 标识的独立浏览器会话，并通过 `spawnSync`
 * 同步执行命令，让上层无需自行处理额外的子进程异步编排。
 */
export class BrowserAgent {
  private static autoOpenedDashboardUrls: Set<string> = new Set();

  private readonly sessionId: string;
  private readonly namespace: string | null;
  private readonly sessionName: string | null;
  private readonly timeout: number;
  private readonly headed: boolean;
  private readonly forceHeadless: boolean;
  private readonly openLiveDashboard: boolean;
  private readonly profile: string | null;
  private readonly executablePath: string | null;
  private readonly statePath: string | null;
  private readonly reuseRunningBrowser: boolean;
  private readonly browserArgs: string[];
  private liveViewportReady: boolean;
  private browserOpened: boolean;

  constructor(options: AgentOptions = {}) {
    this.sessionId = options.sessionId ?? `browser-agent-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.namespace = options.namespace ?? null;
    this.sessionName = options.sessionName ?? null;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.headed = options.headed ?? options.liveViewport ?? false;
    this.forceHeadless = options.headless ?? false;
    this.openLiveDashboard = options.openLiveDashboard ?? true;
    this.profile = options.profile ?? null;
    this.executablePath = options.executablePath ?? resolveSystemChromeExecutable() ?? null;
    this.statePath = options.statePath ?? null;
    this.reuseRunningBrowser = options.reuseRunningBrowser ?? false;
    this.browserArgs =
      options.browserArgs ??
      (!this.profile && (!this.reuseRunningBrowser || this.statePath) ? DEFAULT_CLEAN_BROWSER_ARGS : []);
    this.liveViewportReady = false;
    this.browserOpened = false;
  }

  /** 返回当前 agent 使用的 agent-browser 会话 id。 */
  getSessionId(): string {
    return this.sessionId;
  }

  getLiveViewportUrl(): string | null {
    return this.headed ? `http://localhost:${DEFAULT_DASHBOARD_PORT}` : null;
  }

  /** 统一拼接 agent-browser 的全局参数，保证不同命令共享同一套会话与启动策略。 */
  private buildGlobalArgs(
    args: string[],
    useHeaded: boolean,
    options: { profile?: string | null; reuseRunningBrowser?: boolean; browserArgs?: string[]; statePath?: string | null } = {},
  ): string[] {
    const profile = Object.hasOwn(options, 'profile') ? options.profile ?? null : this.profile;
    const statePath = Object.hasOwn(options, 'statePath') ? options.statePath ?? null : this.statePath;
    const reuseRunningBrowser = options.reuseRunningBrowser ?? (this.reuseRunningBrowser && !profile && !statePath);
    const browserArgs = options.browserArgs ?? this.browserArgs;
    const isBrowserLaunch = args[0] === 'open' && !this.browserOpened;
    const hasBrowserLaunch = args[0] === 'open' || this.browserOpened;
    return [
      // profile 只负责导入登录态，session 负责隔离本次运行，避免复用仍存活的旧 profile 窗口。
      ...(profile ? ['--profile', profile] : []),
      ...(this.sessionName ? ['--session-name', this.sessionName] : []),
      ...(statePath && isBrowserLaunch ? ['--state', statePath] : []),
      ...(reuseRunningBrowser ? ['--auto-connect'] : []),
      '--session',
      this.sessionId,
      ...(useHeaded ? ['--headed'] : this.forceHeadless ? ['--headed', 'false'] : []),
      ...(hasBrowserLaunch && browserArgs.length > 0
        ? ['--args', browserArgs.join(',')]
        : []),
      ...args,
    ];
  }

  private resultErrorMessage(result: SpawnSyncReturns<string>, fallback: string): string {
    const stderr = result.stderr?.trim() || '';
    const stdout = result.stdout?.trim() || '';
    return stderr || stdout || fallback;
  }

  /** 固定 agent-browser 使用系统标准 Chrome，防止已下载的测试浏览器被优先选中。 */
  private createCommandEnvironment(): NodeJS.ProcessEnv {
    return {
      ...createAgentBrowserEnvironment(),
      ...(this.namespace ? { AGENT_BROWSER_NAMESPACE: this.namespace } : {}),
      ...(this.executablePath ? { AGENT_BROWSER_EXECUTABLE_PATH: this.executablePath } : {}),
    };
  }

  /** 底层命令执行入口，负责调用单条 agent-browser 命令并返回 stdout。 */
  private run(args: string[], options: { headed?: boolean; statePath?: string | null } = {}): string {
    const useHeaded = options.headed ?? this.headed;
    const result: SpawnSyncReturns<string> = spawnSync(
      'agent-browser',
      this.buildGlobalArgs(args, useHeaded, Object.hasOwn(options, 'statePath') ? { statePath: options.statePath } : {}),
      { encoding: 'utf-8', timeout: this.timeout, env: this.createCommandEnvironment() },
    );

    if (result.error) {
      throw new Error(`无法启动 agent-browser：${result.error.message}。${AGENT_BROWSER_INSTALL_HINT}`);
    }
    if (result.status !== 0) {
      throw new Error(this.resultErrorMessage(result, `agent-browser exited with code ${result.status}`));
    }

    if (args[0] === 'open') {
      this.browserOpened = true;
    } else if (args[0] === 'close') {
      this.browserOpened = false;
    }

    if (useHeaded && this.openLiveDashboard && args[0] === 'open') {
      this.ensureLiveViewport();
    }

    return result.stdout ?? '';
  }

  private runBestEffort(args: string[]): SpawnSyncReturns<string> {
    return spawnSync('agent-browser', args, {
      encoding: 'utf-8',
      timeout: this.timeout,
      env: this.createCommandEnvironment(),
    });
  }

  private runSystemBestEffort(command: string, args: string[]): SpawnSyncReturns<string> {
    return spawnSync(command, args, {
      encoding: 'utf-8',
      timeout: this.timeout,
    });
  }

  private autoOpenDashboard(url: string): void {
    if (BrowserAgent.autoOpenedDashboardUrls.has(url)) {
      return;
    }

    BrowserAgent.autoOpenedDashboardUrls.add(url);
    if (process.platform === 'darwin') {
      this.runSystemBestEffort('open', [url]);
      return;
    }

    if (process.platform === 'win32') {
      this.runSystemBestEffort('cmd', ['/c', 'start', '', url]);
      return;
    }

    this.runSystemBestEffort('xdg-open', [url]);
  }

  private ensureLiveViewport(): void {
    if (this.liveViewportReady) {
      return;
    }

    this.runBestEffort(['dashboard', 'start', '--port', String(DEFAULT_DASHBOARD_PORT)]);

    const statusResult = this.runBestEffort(['--session', this.sessionId, 'stream', 'status']);
    const statusText = `${statusResult?.stdout ?? ''}\n${statusResult?.stderr ?? ''}`;

    if (!statusText.includes(`:${DEFAULT_STREAM_PORT}`)) {
      if (/Streaming enabled/i.test(statusText)) {
        this.runBestEffort(['--session', this.sessionId, 'stream', 'disable']);
      }
      this.runBestEffort(['--session', this.sessionId, 'stream', 'enable', '--port', String(DEFAULT_STREAM_PORT)]);
    }

    const dashboardUrl = this.getLiveViewportUrl();
    if (dashboardUrl) {
      this.autoOpenDashboard(dashboardUrl);
    }

    this.liveViewportReady = true;
  }

  detectHandoffChallenge(extraText?: string): {
    detected: boolean;
    categories: string[];
    evidence: string[];
  } {
    const evidence: string[] = [];
    const categories: string[] = [];

    let snapshotText = '';
    let urlText = '';
    try {
      snapshotText = this.snapshot().toLowerCase();
    } catch {
      // 这里只做尽力探测，不影响主流程。
    }
    try {
      urlText = this.getUrl().toLowerCase();
    } catch {
      // 这里只做尽力探测，不影响主流程。
    }

    const combined = `${snapshotText}\n${urlText}\n${extraText ?? ''}`.toLowerCase();
    const patterns: Array<{ category: string; regex: RegExp; hint: string }> = [
      { category: 'CAPTCHA', regex: /(recaptcha|g-recaptcha|hcaptcha|h-captcha|turnstile|cloudflare\s*challenge|verify\s*you\s*are\s*human|机器人验证|验证码)/i, hint: 'captcha/bot verification markers' },
      { category: 'OAuth', regex: /(oauth|authorize\b|consent\b|continue\s+with|sign\s+in\s+with|登录授权|第三方登录)/i, hint: 'oauth or third-party authorization markers' },
      { category: 'MFA', regex: /(two[ -]?factor|2fa|mfa|authenticator|one[ -]?time\s*password|otp|sms\s*code|verification\s*code|动态码|短信验证码)/i, hint: 'multi-factor verification markers' },
    ];

    for (const pattern of patterns) {
      if (pattern.regex.test(combined)) {
        categories.push(pattern.category);
        evidence.push(pattern.hint);
      }
    }

    return {
      detected: categories.length > 0,
      categories,
      evidence,
    };
  }

  /** 打开指定 URL。 */
  open(url: string): string {
    return this.run(['open', url]);
  }

  /** 通过当前浏览器的 CDP 连接，在活动页面所在 Chrome 窗口中打开原生 DevTools。 */
  async inspect(): Promise<string> {
    const currentUrl = this.getUrl();
    const cdpUrl = this.run(['get', 'cdp-url']).trim();
    const socket = new WebSocket(cdpUrl);

    try {
      await this.waitForWebSocketOpen(socket);
      const targetList = await this.sendCdpCommand<CdpTargetListResult>(socket, 1, 'Target.getTargets');
      const target = targetList.targetInfos.find((candidate) => (
        candidate.type === 'page' && candidate.url === currentUrl
      ));
      if (!target) {
        throw new Error(`无法在 CDP target 列表中定位当前页面：${currentUrl}`);
      }

      const opened = await this.sendCdpCommand<CdpOpenDevToolsResult>(socket, 2, 'Target.openDevTools', {
        targetId: target.targetId,
      });
      return `Chrome 原生 DevTools 已打开：${opened.targetId}`;
    } finally {
      socket.close();
    }
  }

  /** 等待 CDP WebSocket 建立连接，并在 agent 超时时间内给出明确失败。 */
  private waitForWebSocketOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Chrome DevTools Protocol 超时')), this.timeout);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('无法连接 Chrome DevTools Protocol'));
      }, { once: true });
    });
  }

  /** 发送单条 CDP 指令并校验协议响应，避免实验性能力失败时仍报告成功。 */
  private sendCdpCommand<TResult>(
    socket: WebSocket,
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 指令超时：${method}`)), this.timeout);
      const handleMessage = (event: MessageEvent) => {
        const response = JSON.parse(String(event.data)) as CdpResponse<TResult>;
        if (response.id !== id) {
          return;
        }

        clearTimeout(timer);
        socket.removeEventListener('message', handleMessage);
        if (response.error) {
          reject(new Error(`CDP ${method} 失败：${response.error.message}`));
          return;
        }
        if (!response.result) {
          reject(new Error(`CDP ${method} 未返回结果`));
          return;
        }
        resolve(response.result);
      };

      socket.addEventListener('message', handleMessage);
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  /** 刷新当前页面，用于处理 SPA 首次进入后卡在半初始化状态的场景。 */
  reload(): string {
    return this.evaluate('window.location.reload()');
  }

  /** 通过 ref 点击元素，例如 snapshot 结果中的 e5。 */
  click(ref: string): string {
    return this.run(['click', `@${ref.replace(/^@/, '')}`]);
  }

  /** 通过 ref 填充输入框，例如 snapshot 结果中的 e10。 */
  fill(ref: string, value: string): string {
    return this.run(['fill', `@${ref.replace(/^@/, '')}`, value]);
  }

  /** 通过 ref 或选择器把本地文件上传到文件选择控件。 */
  upload(refOrSelector: string, filePaths: string[]): string {
    const target = /^@/.test(refOrSelector)
      ? refOrSelector
      : /^[a-z]\d+$/i.test(refOrSelector)
        ? `@${refOrSelector}`
        : refOrSelector;
    return this.run(['upload', target, ...filePaths]);
  }

  /** 等待 URL 命中某个模式，例如 `/Home`。 */
  waitForUrl(pattern: string): string {
    return this.run(['wait', '--url', pattern]);
  }

  /** 等待页面出现指定文本。 */
  waitForText(text: string): string {
    return this.run(['wait', '--text', text]);
  }

  /** 按毫秒固定等待一段时间。 */
  waitMs(ms: number): string {
    return this.run(['wait', String(ms)]);
  }

  /** 滚动页面，让当前可交互快照覆盖更大范围的长表单。 */
  scroll(direction: 'up' | 'down' | 'left' | 'right', amount = 600): string {
    return this.run(['scroll', direction, String(amount)]);
  }

  /**
   * 通过 `agent-browser chat` 执行自然语言指令。
   * CLI 会解释这段指令，并完成对应的浏览器动作。
   */
  chat(instruction: string): string {
    return this.run(['chat', instruction]);
  }

  /** 在 agent-browser 支持时，以 JSON 输出执行自然语言指令。 */
  chatJson(instruction: string): AgentBrowserJsonResult {
    return parseJsonOutput(this.run(['chat', instruction, '--json']));
  }

  /** 获取只包含可交互元素的无障碍树快照，便于做断言。 */
  snapshot(): string {
    return this.run(['snapshot', '-i']);
  }

  /** 获取机器可读的可交互无障碍树快照。 */
  snapshotJson(): AgentBrowserJsonResult {
    return parseJsonOutput(this.run(['snapshot', '-i', '--json']));
  }

  /** 保存当前会话的 cookies 与 storage，用于后续以干净窗口复用登录态。 */
  stateSave(path: string): string {
    return this.run(['state', 'save', path], { statePath: null });
  }

  /** 加载已保存的 cookies 与 storage，用于干净窗口复用登录态。 */
  stateLoad(path: string): string {
    return this.run(['state', 'load', path], { statePath: null });
  }

  /** 截图。 */
  screenshot(path?: string): string {
    return this.run(path ? ['screenshot', path] : ['screenshot']);
  }

  /** 在页面上下文中执行 JavaScript，用于读取快照无法可靠表达的控件状态。 */
  evaluate(script: string): string {
    return this.run(['eval', script]);
  }

  /** 获取当前页面标题。 */
  getTitle(): string {
    return this.run(['get', 'title']).trim();
  }

  /** 获取当前页面 URL。 */
  getUrl(): string {
    return this.run(['get', 'url']).trim();
  }

  /** 获取当前浏览器窗口中的页面标签页，供上层从意外的空白活动页恢复。 */
  getTabs(): BrowserTabInfo[] {
    const output = parseJsonOutput(this.run(['tab', 'list', '--json']));
    if (!output.data || typeof output.data !== 'object') {
      return [];
    }

    const data = output.data as { data?: { tabs?: unknown } };
    if (!Array.isArray(data.data?.tabs)) {
      return [];
    }

    return data.data.tabs.filter((tab): tab is BrowserTabInfo => {
      if (!tab || typeof tab !== 'object') {
        return false;
      }
      const candidate = tab as Partial<BrowserTabInfo>;
      return typeof candidate.tabId === 'string'
        && typeof candidate.url === 'string'
        && typeof candidate.title === 'string'
        && typeof candidate.type === 'string'
        && typeof candidate.active === 'boolean';
    });
  }

  /** 切换到指定稳定标签页 id。 */
  switchTab(tabId: string): string {
    return this.run(['tab', tabId]);
  }

  /**
   * 在一次进程调用中串行执行多条命令，减少多次启动命令的开销。
   * `commands` 中的每一项都是参数数组，例如 `['open', 'https://example.com']`。
   */
  batch(commands: string[][]): string {
    const result = spawnSync(
      'agent-browser',
      this.buildGlobalArgs(['batch', '--json'], this.headed),
      {
        input: JSON.stringify(commands),
        encoding: 'utf-8',
        timeout: this.timeout * commands.length,
        env: this.createCommandEnvironment(),
      },
    );

    if (result.error) {
      throw new Error(`无法启动 agent-browser：${result.error.message}。${AGENT_BROWSER_INSTALL_HINT}`);
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || '';
      throw new Error(stderr || `agent-browser batch exited with code ${result.status}`);
    }

    return result.stdout ?? '';
  }

  /** 记录项目级人工接管状态；暂停与恢复由上层控制，不向 agent-browser 发送伪命令。 */
  handoff(message: string): string {
    return [
      'HANDOFF: reusing the current browser session for manual interaction.',
      `Session: ${this.sessionId}`,
      `Reason: ${message}`,
    ].join('\n');
  }

  /** 标记项目级人工接管结束；后续自动化直接复用当前浏览器 session。 */
  resume(): string {
    return `RESUME: continuing browser session ${this.sessionId}.`;
  }

  /** 关闭浏览器会话；这里吞掉异常，保证清理阶段尽量顺利完成。 */
  close(): void {
    try {
      this.run(['close']);
    } catch {
      // 清理阶段忽略关闭失败，常见原因是会话已经提前结束。
    }
  }
}

/**
 * 创建 {@link BrowserAgent} 的工厂函数。
 * 这里作为首选入口，方便测试时替换实现，而不需要直接 mock ES module 类构造函数。
 */
export function createBrowserAgent(options?: AgentOptions): BrowserAgent {
  return new BrowserAgent(options);
}

/** agent 工厂的类型别名，便于调用方约束注入的工厂签名。 */
export type BrowserAgentFactory = typeof createBrowserAgent;
