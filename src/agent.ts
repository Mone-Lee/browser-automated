import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { AgentOptions } from './types.js';

const DEFAULT_TIMEOUT = 30_000;

/**
 * Wrapper around the `agent-browser` CLI.
 *
 * Each instance manages an isolated browser session identified by `sessionId`.
 * Commands are executed synchronously via `spawnSync` so the caller can await
 * the result without setting up async plumbing around the child process.
 */
export class BrowserAgent {
  private readonly sessionId: string;
  private readonly timeout: number;

  constructor(options: AgentOptions = {}) {
    this.sessionId = options.sessionId ?? `session-${Date.now()}`;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Low-level helper — runs a single agent-browser command and returns stdout. */
  private run(args: string[]): string {
    const result: SpawnSyncReturns<string> = spawnSync(
      'agent-browser',
      ['--session', this.sessionId, ...args],
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

    return result.stdout ?? '';
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
    const result = spawnSync('agent-browser', ['batch', '--json'], {
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
