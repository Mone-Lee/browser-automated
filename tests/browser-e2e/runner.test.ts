import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NaturalLanguageTestRunner } from '../../src/browser-e2e/runner.js';
import type { TestCase, AgentOptions } from '../../src/core/types.js';
import type { BrowserAgent } from '../../src/core/agent.js';

// Build a mock agent object. The runner uses factory injection so no class
// mocking is required.
function buildMockAgent(overrides: {
  open?: (url: string) => string;
  snapshot?: () => string;
  fill?: (ref: string, value: string) => string;
  click?: (ref: string) => string;
  screenshot?: (path?: string) => string;
  getUrl?: () => string;
  close?: () => void;
} = {}): BrowserAgent {
  return {
    open: vi.fn(overrides.open ?? (() => '')),
    snapshot: vi.fn(overrides.snapshot ?? (() => '- textbox "请输入用户名" [ref=e10]\n- button "登 录" [ref=e5]')),
    fill: vi.fn(overrides.fill ?? (() => '')),
    click: vi.fn(overrides.click ?? (() => '')),
    screenshot: vi.fn(overrides.screenshot ?? (() => '/tmp/shot.png')),
    getUrl: vi.fn(overrides.getUrl ?? (() => 'https://example.com/Home')),
    close: vi.fn(overrides.close ?? (() => {})),
    waitForUrl: vi.fn(() => ''),
    waitForText: vi.fn(() => ''),
    waitMs: vi.fn(() => ''),
    chat: vi.fn(() => ''),
    getTitle: vi.fn(() => 'Test Page'),
    batch: vi.fn(() => '[]'),
  } as unknown as BrowserAgent;
}

function makeFactory(agent: BrowserAgent) {
  return (_options?: AgentOptions) => agent;
}

describe('NaturalLanguageTestRunner', () => {
  describe('runOne()', () => {
    it('does not inject profile into runner-created agents', async () => {
      const mockAgent = buildMockAgent();
      const capturedOptions: AgentOptions[] = [];
      const factory = (options?: AgentOptions) => {
        capturedOptions.push(options ?? {});
        return mockAgent;
      };

      const runner = new NaturalLanguageTestRunner({}, factory);
      await runner.runOne({
        name: 'No profile injection',
        url: 'https://example.com',
        steps: [{ instruction: '点击登录按钮' }],
      });

      expect(capturedOptions).toHaveLength(1);
      expect(capturedOptions[0].profile).toBeUndefined();
    });

    it('returns a passing result when all steps succeed', async () => {
      const mockAgent = buildMockAgent();
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const testCase: TestCase = {
        name: 'Login flow',
        url: 'https://example.com/login',
        steps: [
          { instruction: '输入用户名 "test@example.com"' },
          { instruction: '点击登录按钮' },
        ],
      };

      const result = await runner.runOne(testCase);

      expect(result.name).toBe('Login flow');
      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(2);
      expect(result.steps[0].passed).toBe(true);
      expect(result.steps[1].passed).toBe(true);
      expect((mockAgent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('marks the test as failed when a step throws', async () => {
      const clickFn = vi.fn()
        .mockImplementationOnce(() => '')
        .mockImplementationOnce(() => { throw new Error('Element not found'); });
      const mockAgent = buildMockAgent({ click: clickFn });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const testCase: TestCase = {
        name: 'Failing test',
        url: 'https://example.com',
        steps: [
          { instruction: '点击登录按钮' },
          { instruction: '点击不存在按钮' },
        ],
      };

      const result = await runner.runOne(testCase);

      expect(result.passed).toBe(false);
      expect(result.steps[0].passed).toBe(true);
      expect(result.steps[1].passed).toBe(false);
      expect(result.steps[1].error).toContain('Element not found');
    });

    it('stops executing further steps after the first failure', async () => {
      const clickFn = vi.fn().mockImplementationOnce(() => { throw new Error('fail'); });
      const mockAgent = buildMockAgent({ click: clickFn });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const testCase: TestCase = {
        name: 'Bail on failure',
        url: 'https://example.com',
        steps: [
          { instruction: '点击登录按钮' },
          { instruction: '点击登录按钮' },
        ],
      };

      const result = await runner.runOne(testCase);

      // Only the first step ran.
      expect(result.steps).toHaveLength(1);
      expect(clickFn).toHaveBeenCalledTimes(1);
    });

    it('takes a screenshot on failure when screenshotOnFailure is enabled', async () => {
      const clickFn = vi.fn().mockImplementationOnce(() => { throw new Error('fail'); });
      const mockAgent = buildMockAgent({ click: clickFn });
      const runner = new NaturalLanguageTestRunner(
        { screenshotOnFailure: true, screenshotDir: '/tmp' },
        makeFactory(mockAgent),
      );

      const testCase: TestCase = {
        name: 'Screenshot on failure',
        url: 'https://example.com',
        steps: [{ instruction: '点击登录按钮' }],
      };

      await runner.runOne(testCase);

      expect((mockAgent.screenshot as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.stringContaining('screenshot_on_failure-failure.png'),
      );
    });

    it('closes the browser even when open() throws', async () => {
      const mockAgent = buildMockAgent({
        open: () => { throw new Error('navigation failed'); },
      });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const result = await runner.runOne({ name: 'Fail on open', url: 'bad-url', steps: [] });

      expect(result.passed).toBe(false);
      expect(result.error).toContain('navigation failed');
      expect((mockAgent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('verifies assertion with deterministic url check', async () => {
      const mockAgent = buildMockAgent({ getUrl: () => 'https://example.com/Home/Dashboard' });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const result = await runner.runOne({
        name: 'Assertion pass',
        url: 'https://example.com',
        steps: [{ instruction: '点击登录按钮', assertion: 'URL 包含 /Home' }],
      });

      expect(result.passed).toBe(true);
    });

    it('fails the step when deterministic assertion does not match', async () => {
      const mockAgent = buildMockAgent({ getUrl: () => 'https://example.com/Login' });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const result = await runner.runOne({
        name: 'Assertion fail',
        url: 'https://example.com',
        steps: [{ instruction: '点击登录按钮', assertion: 'URL 包含 /Home' }],
      });

      expect(result.passed).toBe(false);
      expect(result.steps[0].error).toContain('Expected URL include /Home');
    });
  });

  describe('run()', () => {
    it('returns a summary with correct counts', async () => {
      const passingAgent = buildMockAgent();
      const failingAgent = buildMockAgent({
        click: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });

      let call = 0;
      const factory = (_options?: AgentOptions) => {
        const agents = [passingAgent, failingAgent, passingAgent];
        return agents[call++ % agents.length];
      };

      const runner = new NaturalLanguageTestRunner({}, factory);
      const testCases: TestCase[] = [
        { name: 'Test 1', url: 'https://example.com', steps: [{ instruction: '点击登录按钮' }] },
        { name: 'Test 2', url: 'https://example.com', steps: [{ instruction: '点击登录按钮' }] },
        { name: 'Test 3', url: 'https://example.com', steps: [{ instruction: '点击登录按钮' }] },
      ];

      const summary = await runner.run(testCases);

      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.results).toHaveLength(3);
    });

    it('stops after first failure when bail is enabled', async () => {
      let instancesCreated = 0;
      const failingAgent = buildMockAgent({ click: vi.fn().mockImplementation(() => { throw new Error('fail'); }) });
      const factory = (_options?: AgentOptions) => {
        instancesCreated++;
        return failingAgent;
      };

      const runner = new NaturalLanguageTestRunner({ bail: true }, factory);
      const testCases: TestCase[] = [
        { name: 'Test 1', url: 'https://example.com', steps: [{ instruction: '点击登录按钮' }] },
        { name: 'Test 2', url: 'https://example.com', steps: [{ instruction: '点击登录按钮' }] },
      ];

      const summary = await runner.run(testCases);

      expect(summary.total).toBe(1); // Only one test ran
      expect(instancesCreated).toBe(1);
    });
  });
});
