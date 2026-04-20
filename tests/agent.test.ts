import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowserAgent } from '../src/agent.js';

// Spy on spawnSync so the tests never touch a real browser.
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
        ['batch', '--json'],
        expect.objectContaining({
          input: JSON.stringify(commands),
          encoding: 'utf-8',
        }),
      );
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
