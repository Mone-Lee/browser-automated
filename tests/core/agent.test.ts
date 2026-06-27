import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserAgent } from '../../src/core/agent.js';

// 监听 spawnSync，确保测试过程不会真的启动浏览器。
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';

const mockSpawnSync = vi.mocked(spawnSync);

function makeOkResult(stdout = '') {
  return { status: 0, stdout, stderr: '', error: undefined } as ReturnType<typeof spawnSync>;
}

function makeErrorResult(stderr = 'command failed', status = 1) {
  return { status, stdout: '', stderr, error: undefined } as ReturnType<typeof spawnSync>;
}

beforeEach(() => {
  mockSpawnSync.mockReset();
});

describe('BrowserAgent', () => {
  describe('open()', () => {
    it('calls agent-browser open with the url and session flag', () => {
      mockSpawnSync.mockReturnValue(makeOkResult(''));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      agent.open('https://example.com');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'open', 'https://example.com'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
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
        ['--session', 'test-session', '--headed', 'open', 'https://example.com'],
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
    it('calls handoff with the same session', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('HANDOFF: waiting'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.handoff('Stuck on CAPTCHA');

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'handoff', 'Stuck on CAPTCHA'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output).toContain('HANDOFF');
    });

    it('calls resume with the same session', () => {
      mockSpawnSync.mockReturnValue(makeOkResult('RESUME: ok'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.resume();

      expect(mockSpawnSync).toHaveBeenCalledWith(
        'agent-browser',
        ['--session', 'test-session', 'resume'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output).toContain('RESUME');
    });

    it('falls back to a headed browser when handoff is unsupported', () => {
      mockSpawnSync
        .mockReturnValueOnce(makeErrorResult('Unknown command: handoff'))
        .mockReturnValueOnce(makeOkResult('https://example.com/login\n'))
        .mockReturnValueOnce(makeOkResult('opened headed browser'))
        .mockReturnValueOnce(makeOkResult('Dashboard started at http://localhost:4848'))
        .mockReturnValueOnce(makeOkResult('Streaming enabled on ws://127.0.0.1:61898'))
        .mockReturnValueOnce(makeOkResult('Streaming disabled'))
        .mockReturnValueOnce(makeOkResult('Streaming enabled on ws://127.0.0.1:9223'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.handoff('Need manual captcha');

      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        1,
        'agent-browser',
        ['--session', 'test-session', 'handoff', 'Need manual captcha'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        2,
        'agent-browser',
        ['--session', 'test-session', 'get', 'url'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        3,
        'agent-browser',
        ['--session', 'test-session', '--headed', 'open', 'https://example.com/login'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        4,
        'agent-browser',
        ['dashboard', 'start', '--port', '4848'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        5,
        'agent-browser',
        ['--session', 'test-session', 'stream', 'status'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        6,
        'agent-browser',
        ['--session', 'test-session', 'stream', 'disable'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(mockSpawnSync).toHaveBeenNthCalledWith(
        7,
        'agent-browser',
        ['--session', 'test-session', 'stream', 'enable', '--port', '9223'],
        expect.objectContaining({ encoding: 'utf-8' }),
      );
      expect(output).toContain('HANDOFF_FALLBACK');
    });

    it('falls back to a no-op resume when resume is unsupported', () => {
      mockSpawnSync.mockReturnValue(makeErrorResult('Unknown command: resume'));

      const agent = new BrowserAgent({ sessionId: 'test-session' });
      const output = agent.resume();

      expect(output).toContain('RESUME_FALLBACK');
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
});
