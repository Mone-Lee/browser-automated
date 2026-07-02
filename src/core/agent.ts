/**
 * 封装 agent-browser CLI，提供两个对外产物共享的浏览器 session、截图和 handoff 能力。
 */
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { AgentOptions } from './types.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_DASHBOARD_PORT = 4848;
const DEFAULT_STREAM_PORT = 9223;

export interface AgentBrowserJsonResult {
  raw: string;
  data: unknown | null;
  parseError?: string;
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
  private readonly timeout: number;
  private readonly headed: boolean;
  private readonly openLiveDashboard: boolean;
  private readonly profile: string | null;
  private liveViewportReady: boolean;

  constructor(options: AgentOptions = {}) {
    this.sessionId = options.sessionId ?? `session-${Date.now()}`;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.headed = options.headed ?? options.liveViewport ?? false;
    this.openLiveDashboard = options.openLiveDashboard ?? true;
    this.profile = options.profile ?? null;
    this.liveViewportReady = false;
  }

  /** 返回当前 agent 使用的 agent-browser 会话 id。 */
  getSessionId(): string {
    return this.sessionId;
  }

  getLiveViewportUrl(): string | null {
    return this.headed ? `http://localhost:${DEFAULT_DASHBOARD_PORT}` : null;
  }

  /** 底层命令执行入口，负责调用单条 agent-browser 命令并返回 stdout。 */
  private run(args: string[], options: { headed?: boolean } = {}): string {
    const useHeaded = options.headed ?? this.headed;
    const result: SpawnSyncReturns<string> = spawnSync(
      'agent-browser',
      [
        ...(this.profile ? ['--profile', this.profile] : []),
        '--session',
        this.sessionId,
        ...(useHeaded ? ['--headed'] : []),
        ...args,
      ],
      { encoding: 'utf-8', timeout: this.timeout },
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || '';
      const stdout = result.stdout?.trim() || '';
      throw new Error(
        stderr || stdout || `agent-browser exited with code ${result.status}`,
      );
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

  private isUnsupportedCommandError(err: unknown, command: string): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return message.includes(`Unknown command: ${command}`);
  }

  private currentUrlOrBlank(): string {
    try {
      return this.getUrl() || 'about:blank';
    } catch {
      return 'about:blank';
    }
  }

  /** 打开指定 URL。 */
  open(url: string): string {
    return this.run(['open', url]);
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

  /** 截图。 */
  screenshot(path?: string): string {
    return this.run(path ? ['screenshot', path] : ['screenshot']);
  }

  /** 获取当前页面标题。 */
  getTitle(): string {
    return this.run(['get', 'title']).trim();
  }

  /** 获取当前页面 URL。 */
  getUrl(): string {
    return this.run(['get', 'url']).trim();
  }

  /**
   * 在一次进程调用中串行执行多条命令，减少多次启动命令的开销。
   * `commands` 中的每一项都是参数数组，例如 `['open', 'https://example.com']`。
   */
  batch(commands: string[][]): string {
    const result = spawnSync('agent-browser', ['--session', this.sessionId, 'batch', '--json'], {
      input: JSON.stringify(commands),
      encoding: 'utf-8',
      timeout: this.timeout * commands.length,
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const stderr = result.stderr?.trim() || '';
      throw new Error(stderr || `agent-browser batch exited with code ${result.status}`);
    }

    return result.stdout ?? '';
  }

  /** 将控制权交给真实的有头浏览器，便于用户手动接管。 */
  handoff(message: string): string {
    try {
      return this.run(['handoff', message]);
    } catch (err) {
      if (!this.isUnsupportedCommandError(err, 'handoff')) {
        throw err;
      }

      const url = this.currentUrlOrBlank();
      const openOutput = this.run(['open', url], { headed: true }).trim();
      return [
        'HANDOFF_FALLBACK: opened a visible browser window for manual interaction.',
        `Session: ${this.sessionId}`,
        `URL: ${url}`,
        `Reason: ${message}`,
        openOutput,
      ]
        .filter(Boolean)
        .join('\n');
    }
  }

  /** 在用户接管完成后恢复自动化。 */
  resume(): string {
    try {
      return this.run(['resume']);
    } catch (err) {
      if (!this.isUnsupportedCommandError(err, 'resume')) {
        throw err;
      }

      return `RESUME_FALLBACK: continuing session ${this.sessionId} without an explicit resume command.`;
    }
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
