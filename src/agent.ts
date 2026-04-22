import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { AgentOptions } from './types.js';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_DASHBOARD_PORT = 4848;
const DEFAULT_STREAM_PORT = 9223;

/**
 * Wrapper around the `agent-browser` CLI.
 *
 * Each instance manages an isolated browser session identified by `sessionId`.
 * Commands are executed synchronously via `spawnSync` so the caller can await
 * the result without setting up async plumbing around the child process.
 */
export class BrowserAgent {
  private static autoOpenedDashboardUrls: Set<string> = new Set();

  private readonly sessionId: string;
  private readonly timeout: number;
  private readonly headed: boolean;
  private readonly profile: string | null;
  private liveViewportReady: boolean;

  constructor(options: AgentOptions = {}) {
    this.sessionId = options.sessionId ?? `session-${Date.now()}`;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this.headed = options.headed ?? options.liveViewport ?? false;
    this.profile = options.profile ?? null;
    this.liveViewportReady = false;
  }

  /** Return the agent-browser session id used by this agent. */
  getSessionId(): string {
    return this.sessionId;
  }

  getLiveViewportUrl(): string | null {
    return this.headed ? `http://localhost:${DEFAULT_DASHBOARD_PORT}` : null;
  }

  /** Low-level helper — runs a single agent-browser command and returns stdout. */
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

    if (useHeaded && args[0] === 'open') {
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
      // Best effort only.
    }
    try {
      urlText = this.getUrl().toLowerCase();
    } catch {
      // Best effort only.
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

  /** Navigate to a URL. */
  open(url: string): string {
    return this.run(['open', url]);
  }

  /** Click an element by ref (e.g. e5 from snapshot output). */
  click(ref: string): string {
    return this.run(['click', `@${ref.replace(/^@/, '')}`]);
  }

  /** Fill an input by ref (e.g. e10 from snapshot output). */
  fill(ref: string, value: string): string {
    return this.run(['fill', `@${ref.replace(/^@/, '')}`, value]);
  }

  /** Wait for a URL pattern (example: /Home). */
  waitForUrl(pattern: string): string {
    return this.run(['wait', '--url', pattern]);
  }

  /** Wait until text appears on page. */
  waitForText(text: string): string {
    return this.run(['wait', '--text', text]);
  }

  /** Wait for a fixed duration in milliseconds. */
  waitMs(ms: number): string {
    return this.run(['wait', String(ms)]);
  }

  /**
   * Execute a natural language instruction using `agent-browser chat`.
   * The CLI interprets the instruction and performs the corresponding browser actions.
   */
  chat(instruction: string): string {
    return this.run(['chat', instruction]);
  }

  /** Capture the accessibility tree (interactive elements only). Useful for assertions. */
  snapshot(): string {
    return this.run(['snapshot', '-i']);
  }

  /** Take a screenshot. */
  screenshot(path?: string): string {
    return this.run(path ? ['screenshot', path] : ['screenshot']);
  }

  /** Get the current page title. */
  getTitle(): string {
    return this.run(['get', 'title']).trim();
  }

  /** Get the current page URL. */
  getUrl(): string {
    return this.run(['get', 'url']).trim();
  }

  /**
   * Execute multiple commands in one process invocation (lower overhead).
   * Each element of `commands` is an array of arguments, e.g. `['open', 'https://example.com']`.
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

  /** Hand off to a real headed browser for user-driven interaction. */
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

  /** Resume automation after user handoff. */
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

  /** Close the browser session. Errors are swallowed so cleanup always succeeds. */
  close(): void {
    try {
      this.run(['close']);
    } catch {
      // Ignore errors during cleanup — the session may already be gone.
    }
  }
}

/**
 * Factory function for creating a {@link BrowserAgent}.
 * This is the preferred way to create agents — it can be easily swapped in
 * tests without needing to mock the ES module class constructor.
 */
export function createBrowserAgent(options?: AgentOptions): BrowserAgent {
  return new BrowserAgent(options);
}

/** Type alias for the agent factory so callers can type-check injected factories. */
export type BrowserAgentFactory = typeof createBrowserAgent;
