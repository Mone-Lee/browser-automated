import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserAgent } from '../../packages/browser-core/dist/agent.js';

// 监听 spawnSync，确保测试过程不会真的启动浏览器。
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync, spawnSync } from 'node:child_process';

const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawnSync = vi.mocked(spawnSync);

function makeOkResult(stdout = '') {
  return { status: 0, stdout, stderr: '', error: undefined } as ReturnType<typeof spawnSync>;
}

function makeErrorResult(stderr = 'command failed', status = 1) {
  return { status, stdout: '', stderr, error: undefined } as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue('');
  mockSpawnSync.mockReset();
});

describe('BrowserAgent', () => {
  describe('inspect()', () => {
    it('opens native DevTools for the active page through CDP', async () => {
      const sentMessages: Array<{ id: number; method: string; params?: Record<string, string> }> = [];
      class MockWebSocket {
        private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

        constructor(public readonly url: string) {
          queueMicrotask(() => this.emit('open', {}));
        }

        addEventListener(type: string, listener: (event: { data?: string }) => void): void {
          const listeners = this.listeners.get(type) ?? new Set();
          listeners.add(listener);
          this.listeners.set(type, listeners);
        }

        removeEventListener(type: string, listener: (event: { data?: string }) => void): void {
          this.listeners.get(type)?.delete(listener);
        }

        send(payload: string): void {
          const message = JSON.parse(payload) as { id: number; method: string; params?: Record<string, string> };
          sentMessages.push(message);
          const result = message.method === 'Target.getTargets'
            ? { targetInfos: [{ targetId: 'page-target', type: 'page', url: 'https://example.com/' }] }
            : { targetId: 'devtools-target' };
          queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, result }) }));
        }

        close(): void {}

        private emit(type: string, event: { data?: string }): void {
          for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
          }
        }
      }

      vi.stubGlobal('WebSocket', MockWebSocket);
      mockSpawnSync
        .mockReturnValueOnce(makeOkResult('https://example.com/\n'))
        .mockReturnValueOnce(makeOkResult('ws://127.0.0.1:9222/devtools/browser/test'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      await expect(agent.inspect()).resolves.toBe('Chrome 原生 DevTools 已打开：devtools-target');
      expect(sentMessages).toEqual([
        { id: 1, method: 'Target.getTargets' },
        { id: 2, method: 'Target.openDevTools', params: { targetId: 'page-target' } },
      ]);
    });
  });

  describe('open()', () => {
    it('calls agent-browser open with the url and session flag', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        [
          '--session',
          'test-session',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('uses the latest proxy environment when running a command', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      vi.stubEnv('NO_PROXY', 'localhost,.created-after-agent');
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            NO_PROXY: 'localhost,.created-after-agent',
            no_proxy: 'localhost,.created-after-agent',
          }),
        }),
      );
    });

    it('pins agent-browser to the configured standard Chrome and isolated namespace', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));
      const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-chrome-'));
      const chromePath = path.join(temporaryDirectory, 'Google Chrome');
      fs.writeFileSync(chromePath, 'stub');
      fs.chmodSync(chromePath, 0o755);
      vi.stubEnv('AGENT_BROWSER_EXECUTABLE_PATH', chromePath);

      try {
        const agent = new BrowserAgent({ sessionId: 'test-session', namespace: 'browser-opt' });
        agent.open('https://example.com');

        expect(mockSpawnSync).toHaveBeenCalledWith(
          'agent-browser',
          expect.any(Array),
          expect.objectContaining({
            env: expect.objectContaining({
              AGENT_BROWSER_EXECUTABLE_PATH: chromePath,
              AGENT_BROWSER_NAMESPACE: 'browser-opt',
            }),
          }),
        );
      } finally {
        fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    });

    it('throws when agent-browser exits with a non-zero code', () => {
      mockSpawnSync.mockReturnValue(makeErrorResult('navigation error'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      expect(() => agent.open('https://bad-url')).toThrow('navigation error');
    });

    it('adds --headed when live viewport is enabled', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', liveViewport: true });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        [
          '--session',
          'test-session',
          '--headed',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('passes --profile when configured', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', profile: 'Default' });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--profile', 'Default', '--session', 'test-session', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('passes --session-name when configured', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', sessionName: 'browser-opt-example-com' });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        [
          '--session-name',
          'browser-opt-example-com',
          '--session',
          'test-session',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('combines --profile with headed launch mode', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', profile: 'Default', liveViewport: true });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--profile', 'Default', '--session', 'test-session', '--headed', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('keeps profile and headless mode stable after an explicitly headless profile launch', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ profile: 'Default', headless: true });
      agent.open('https://example.com');
      agent.snapshotJson();

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        ['--profile', 'Default', '--session', expect.stringMatching(/^browser-agent-/), '--headed', 'false', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        ['--profile', 'Default', '--session', expect.stringMatching(/^browser-agent-/), '--headed', 'false', 'snapshot', '-i', '--json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('keeps profile on follow-up commands after a profile launch', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('https://example.com/'));

      const agent = new BrowserAgent({ sessionId: 'test-session', profile: 'Default' });
      agent.open('https://example.com');
      agent.getUrl();

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        ['--profile', 'Default', '--session', 'test-session', 'get', 'url'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('uses the same profile for open and snapshot commands', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', profile: 'Default' });
      agent.open('https://example.com');
      agent.snapshotJson();

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        ['--profile', 'Default', '--session', 'test-session', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        ['--profile', 'Default', '--session', 'test-session', 'snapshot', '-i', '--json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('does not close or restart when profile launch returns a warning', () => {
      mockSpawnSync.mockReturnValue({
        status: 0,
        stdout: 'opened',
        stderr: '--profile ignored: daemon already running',
        error: undefined,
      } as ReturnType<typeof spawnSync>);

      const agent = new BrowserAgent({ sessionId: 'test-session', profile: 'Default', liveViewport: true });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--profile', 'Default', '--session', 'test-session', '--headed', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        'agent-browser',
        ['close', '--all'],
        expect.anything(),
      );
    });


    it('passes --auto-connect when reusing the running browser', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', reuseRunningBrowser: true });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--auto-connect', '--session', 'test-session', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('uses a state file directly without auto-connect or profile import', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({
        sessionId: 'test-session',
        statePath: '/tmp/auth-state.json',
        reuseRunningBrowser: true,
      });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        [
          '--state',
          '/tmp/auth-state.json',
          '--session',
          'test-session',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('omits the state flag on follow-up commands after a state launch', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('https://example.com/'));

      const agent = new BrowserAgent({
        sessionId: 'test-session',
        statePath: '/tmp/auth-state.json',
      });
      agent.getUrl();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'get', 'url'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('uses the state file only on the first open of the same session', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('opened'));

      const agent = new BrowserAgent({
        sessionId: 'test-session',
        statePath: '/tmp/auth-state.json',
      });
      agent.open('https://example.com/login');
      agent.open('https://example.com/dashboard');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        [
          '--state',
          '/tmp/auth-state.json',
          '--session',
          'test-session',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com/login',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        [
          '--session',
          'test-session',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com/dashboard',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('keeps state save and load commands free of the configured state flag', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('state ok'));

      const agent = new BrowserAgent({
        sessionId: 'test-session',
        statePath: '/tmp/auth-state.json',
      });
      agent.stateLoad('/tmp/auth-state.json');
      agent.stateSave('/tmp/auth-state.json');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        ['--session', 'test-session', 'state', 'load', '/tmp/auth-state.json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        ['--session', 'test-session', 'state', 'save', '/tmp/auth-state.json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('auto-opens dashboard once when live viewport initializes', () => {
      (BrowserAgent as unknown as { autoOpenedDashboardUrls: Set<string> }).autoOpenedDashboardUrls.clear();

      mockSpawnSync
        .mockReturnValueOnce(makeOkResult(''))
        .mockReturnValueOnce(makeOkResult('dashboard started'))
        .mockReturnValueOnce(makeOkResult('Streaming disabled'))
        .mockReturnValueOnce(makeOkResult('Streaming enabled on ws://127.0.0.1:9223'))
        .mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session', liveViewport: true });
      agent.open('https://example.com');
      agent.open('https://example.com/next');

      const openDashboardCommand = process.platform === 'darwin'
        ? ['open', 'http://localhost:4848']
        : process.platform === 'win32'
          ? ['cmd', '/c', 'start', '', 'http://localhost:4848']
          : ['xdg-open', 'http://localhost:4848'];

      expect(mockSpawnSync).toHaveBeenCalledWith(
        openDashboardCommand[0],
        openDashboardCommand.slice(1),
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('keeps headed browser visible without opening dashboard when disabled', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({
        sessionId: 'test-session',
        liveViewport: true,
        openLiveDashboard: false,
      });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        [
          '--session',
          'test-session',
          '--headed',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'open',
          'https://example.com',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).not.toHaveBeenCalledWith(
        'agent-browser',
        ['dashboard', 'start', '--port', '4848'],
        expect.anything(),
      );
    });
  });

  describe('chat()', () => {
    it('passes the instruction to agent-browser chat', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('Done.'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.chat('Click the login button');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'chat', 'Click the login button'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output).toBe('Done.');
    });
  });

  describe('chatJson()', () => {
    it('passes --json to agent-browser chat and parses JSON output', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('{"success":true,"text":"Done"}'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.chatJson('Click the login button');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'chat', 'Click the login button', '--json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output.data).toEqual({ success: true, text: 'Done' });
    });

    it('keeps raw output when chat JSON parsing fails', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('Done.'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.chatJson('Click the login button');

      expect(output.data).toBeNull();
      expect(output.raw).toBe('Done.');
      expect(output.parseError).toBeTruthy();
    });
  });

  describe('snapshot()', () => {
    it('calls agent-browser snapshot with -i flag', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('button[Submit]'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const result = agent.snapshot();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'snapshot', '-i'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result).toBe('button[Submit]');
    });
  });

  describe('snapshotJson()', () => {
    it('calls agent-browser snapshot with -i and --json flags', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('{"success":true,"data":{"snapshot":"button","refs":{"e1":{"role":"button"}}}}'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const result = agent.snapshotJson();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'snapshot', '-i', '--json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(result.data).toEqual({
        success: true,
        data: {
          snapshot: 'button',
          refs: {
            e1: {
              role: 'button',
            },
          },
        },
      });
    });

    it('keeps headed mode on follow-up snapshots so the daemon does not replace the visible browser', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('{"success":true,"data":{"snapshot":"button","refs":{}}}'));

      const agent = new BrowserAgent({ sessionId: 'test-session', liveViewport: true });
      agent.snapshotJson();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', '--headed', 'snapshot', '-i', '--json'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('keeps browser launch arguments on commands after open so the daemon preserves the page', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('{"success":true,"data":{"snapshot":"button","refs":{}}}'));

      const agent = new BrowserAgent({
        sessionId: 'test-session',
        liveViewport: true,
        openLiveDashboard: false,
      });
      agent.open('https://example.com');
      agent.snapshotJson();

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        [
          '--session',
          'test-session',
          '--headed',
          '--args',
          '--disable-session-crashed-bubble,--no-first-run,--no-default-browser-check',
          'snapshot',
          '-i',
          '--json',
        ],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });
  });

  describe('screenshot()', () => {
    it('calls agent-browser screenshot without a path when not provided', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('/tmp/screenshot.png'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      agent.screenshot();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'screenshot'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });

    it('passes the path to agent-browser screenshot when provided', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('/custom/path.png'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      agent.screenshot('/custom/path.png');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'screenshot', '/custom/path.png'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
    });
  });

  describe('upload()', () => {
    it('calls agent-browser upload with a ref and local files', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('uploaded'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.upload('e3', ['/tmp/image.png']);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'upload', '@e3', '/tmp/image.png'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output).toBe('uploaded');
    });

    it('keeps CSS selectors unchanged when uploading files', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('uploaded'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.upload('[data-browser-opt-upload-id="browser-opt-upload-0"]', ['/tmp/image.png']);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'upload', '[data-browser-opt-upload-id="browser-opt-upload-0"]', '/tmp/image.png'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output).toBe('uploaded');
    });
  });

  describe('batch()', () => {
    it('pipes commands as JSON to agent-browser batch --json', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('[]'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const commands = [['open', 'https://example.com'], ['snapshot', '-i']];
      agent.batch(commands);

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'batch', '--json'],
        expect.objectContaining({
          input: JSON.stringify(commands),
          encoding: 'utf-8',
        }),
      );
    });
  });

  describe('handoff()/resume()', () => {
    it('creates project-level handoff context without invoking agent-browser', () => {
      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.handoff('Stuck on CAPTCHA');

      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(output).toContain('HANDOFF');
      expect(output).toContain('Session: test-session');
      expect(output).toContain('Stuck on CAPTCHA');
    });

    it('resumes at project level without invoking agent-browser', () => {
      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.resume();

      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(output).toContain('RESUME');
      expect(output).toContain('test-session');
    });

    it('keeps handoff and resume on the original browser without another command', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('ok'));

      const agent = new BrowserAgent({ profile: 'Default', headed: true, openLiveDashboard: false });
      agent.open('https://example.com/login');
      agent.handoff('Need manual login');
      agent.resume();

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        ['--profile', 'Default', '--session', expect.stringMatching(/^browser-agent-/), '--headed', 'open', 'https://example.com/login'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(mockSpawnSync.mock.calls.filter((call) => (call[1] as string[]).includes('open'))).toHaveLength(1);
    });
  });

  describe('getSessionId()', () => {
    it('returns the configured session id', () => {
      const agent = new BrowserAgent({ sessionId: 'test-session' });
      expect(agent.getSessionId()).toBe('test-session');
    });
  });

  describe('close()', () => {
    it('swallows errors so cleanup always succeeds', () => {
      mockSpawnSync.mockReturnValue(makeErrorResult('session not found'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      expect(() => agent.close()).not.toThrow();
    });
  });

  describe('getTitle()', () => {
    it('returns the page title trimmed', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('  Example Domain  \n'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      expect(agent.getTitle()).toBe('Example Domain');
    });
  });

  describe('getUrl()', () => {
    it('returns the current URL trimmed', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('https://example.com/page\n'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      expect(agent.getUrl()).toBe('https://example.com/page');
    });
  });

  describe('tabs', () => {
    it('lists tabs and switches by stable tab id', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeOkResult(
          JSON.stringify({
            success: true,
            data: {
              tabs: [
                { active: true, tabId: 't2', title: 'Example', type: 'page', url: 'https://example.com' },
              ],
            },
          }),
        ))
        .mockReturnValueOnce(makeOkResult('switched'));
      const agent = new BrowserAgent({ sessionId: 'test-session' });

      expect(agent.getTabs()).toEqual([
        { active: true, tabId: 't2', title: 'Example', type: 'page', url: 'https://example.com' },
      ]);
      expect(agent.switchTab('t2')).toBe('switched');
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        ['--session', 'test-session', 'tab', 'list', '--json'],
        expect.any(Object),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        ['--session', 'test-session', 'tab', 't2'],
        expect.any(Object),
      );
    });
  });
});
