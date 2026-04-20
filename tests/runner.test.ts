import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NaturalLanguageTestRunner } from '../src/runner.js';
import type { TestCase, AgentOptions } from '../src/types.js';
import type { BrowserAgent } from '../src/agent.js';

// Build a mock agent object. The runner uses factory injection so no class
// mocking is required.
function buildMockAgent(overrides: {
  open?: (url: string) => string;
  chat?: (instruction: string) => string;
  screenshot?: (path?: string) => string;
  close?: () => void;
} = {}): BrowserAgent {
  return {
    open: vi.fn(overrides.open ?? (() => '')),
    chat: vi.fn(overrides.chat ?? (() => 'Done.')),
    screenshot: vi.fn(overrides.screenshot ?? (() => '/tmp/shot.png')),
    close: vi.fn(overrides.close ?? (() => {})),
    snapshot: vi.fn(() => ''),
    getTitle: vi.fn(() => 'Test Page'),
    getUrl: vi.fn(() => 'https://example.com'),
    batch: vi.fn(() => '[]'),
  } as unknown as BrowserAgent;
}

function makeFactory(agent: BrowserAgent) {
  return (_options?: AgentOptions) => agent;
}

describe('NaturalLanguageTestRunner', () => {
  describe('runOne()', () => {
    it('returns a passing result when all steps succeed', async () => {
      const mockAgent = buildMockAgent();
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const testCase: TestCase = {
        name: 'Login flow',
        url: 'https://example.com/login',
        steps: [
          { instruction: 'Fill in the email field with "test@example.com"' },
          { instruction: 'Click the submit button' },
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
      const chatFn = vi.fn()
        .mockReturnValueOnce('Done.')
        .mockImplementationOnce(() => { throw new Error('Element not found'); });
      const mockAgent = buildMockAgent({ chat: chatFn });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const testCase: TestCase = {
        name: 'Failing test',
        url: 'https://example.com',
        steps: [
          { instruction: 'Click the first button' },
          { instruction: 'Click the missing button' },
        ],
      };

      const result = await runner.runOne(testCase);

      expect(result.passed).toBe(false);
      expect(result.steps[0].passed).toBe(true);
      expect(result.steps[1].passed).toBe(false);
      expect(result.steps[1].error).toContain('Element not found');
    });

    it('stops executing further steps after the first failure', async () => {
      const chatFn = vi.fn().mockImplementationOnce(() => { throw new Error('fail'); });
      const mockAgent = buildMockAgent({ chat: chatFn });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const testCase: TestCase = {
        name: 'Bail on failure',
        url: 'https://example.com',
        steps: [
          { instruction: 'Step that fails' },
          { instruction: 'Step that should not run' },
        ],
      };

      const result = await runner.runOne(testCase);

      // Only the first step ran.
      expect(result.steps).toHaveLength(1);
      expect(chatFn).toHaveBeenCalledTimes(1);
    });

    it('takes a screenshot on failure when screenshotOnFailure is enabled', async () => {
      const chatFn = vi.fn().mockImplementationOnce(() => { throw new Error('fail'); });
      const mockAgent = buildMockAgent({ chat: chatFn });
      const runner = new NaturalLanguageTestRunner(
        { screenshotOnFailure: true, screenshotDir: '/tmp' },
        makeFactory(mockAgent),
      );

      const testCase: TestCase = {
        name: 'Screenshot on failure',
        url: 'https://example.com',
        steps: [{ instruction: 'Step that fails' }],
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

    it('verifies the assertion when a step has one and passes on PASS reply', async () => {
      const chatFn = vi.fn()
        .mockReturnValueOnce('Clicked.')  // step instruction
        .mockReturnValueOnce('PASS');     // assertion verification
      const mockAgent = buildMockAgent({ chat: chatFn });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const result = await runner.runOne({
        name: 'Assertion pass',
        url: 'https://example.com',
        steps: [{ instruction: 'Click the button', assertion: 'A success banner is shown' }],
      });

      expect(result.passed).toBe(true);
    });

    it('fails the step when the assertion verification returns FAIL', async () => {
      const chatFn = vi.fn()
        .mockReturnValueOnce('Clicked.')
        .mockReturnValueOnce('FAIL: banner not found');
      const mockAgent = buildMockAgent({ chat: chatFn });
      const runner = new NaturalLanguageTestRunner({}, makeFactory(mockAgent));

      const result = await runner.runOne({
        name: 'Assertion fail',
        url: 'https://example.com',
        steps: [{ instruction: 'Click the button', assertion: 'A success banner is shown' }],
      });

      expect(result.passed).toBe(false);
      expect(result.steps[0].error).toContain('Assertion failed');
    });
  });

  describe('run()', () => {
    it('returns a summary with correct counts', async () => {
      const passingAgent = buildMockAgent({ chat: vi.fn().mockReturnValue('Done.') });
      const failingAgent = buildMockAgent({
        chat: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });

      let call = 0;
      const factory = (_options?: AgentOptions) => {
        const agents = [passingAgent, failingAgent, passingAgent];
        return agents[call++ % agents.length];
      };

      const runner = new NaturalLanguageTestRunner({}, factory);
      const testCases: TestCase[] = [
        { name: 'Test 1', url: 'https://example.com', steps: [{ instruction: 'Step' }] },
        { name: 'Test 2', url: 'https://example.com', steps: [{ instruction: 'Step' }] },
        { name: 'Test 3', url: 'https://example.com', steps: [{ instruction: 'Step' }] },
      ];

      const summary = await runner.run(testCases);

      expect(summary.total).toBe(3);
      expect(summary.passed).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.results).toHaveLength(3);
    });

    it('stops after first failure when bail is enabled', async () => {
      let instancesCreated = 0;
      const failingAgent = buildMockAgent({
        chat: vi.fn().mockImplementation(() => { throw new Error('fail'); }),
      });
      const factory = (_options?: AgentOptions) => {
        instancesCreated++;
        return failingAgent;
      };

      const runner = new NaturalLanguageTestRunner({ bail: true }, factory);
      const testCases: TestCase[] = [
        { name: 'Test 1', url: 'https://example.com', steps: [{ instruction: 'Step' }] },
        { name: 'Test 2', url: 'https://example.com', steps: [{ instruction: 'Step' }] },
      ];

      const summary = await runner.run(testCases);

      expect(summary.total).toBe(1); // Only one test ran
      expect(instancesCreated).toBe(1);
    });
  });
});
