import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestCaseGenerator } from '../src/generate.js';
import type { AgentOptions } from '../src/types.js';
import type { BrowserAgent } from '../src/agent.js';

function buildMockAgent(snapshot: string): BrowserAgent {
  return {
    open: vi.fn(() => ''),
    snapshot: vi.fn(() => snapshot),
    chat: vi.fn(() => ''),
    click: vi.fn(() => ''),
    fill: vi.fn(() => ''),
    waitForUrl: vi.fn(() => ''),
    waitForText: vi.fn(() => ''),
    waitMs: vi.fn(() => ''),
    close: vi.fn(() => {}),
    screenshot: vi.fn(),
    getTitle: vi.fn(() => 'Test'),
    getUrl: vi.fn(() => 'https://example.com'),
    batch: vi.fn(() => '[]'),
  } as unknown as BrowserAgent;
}

function makeFactory(agent: BrowserAgent) {
  return (_options?: AgentOptions) => agent;
}

describe('TestCaseGenerator', () => {
  describe('generate()', () => {
    it('returns a TestCase with the provided name and url', async () => {
      const mockAgent = buildMockAgent('button[Search]');

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate(
        'https://example.com',
        'Search for TypeScript',
        'My Search Test',
      );

      expect(testCase.name).toBe('My Search Test');
      expect(testCase.url).toBe('https://example.com');
    });

    it('derives the name from the description when name is not provided', async () => {
      const mockAgent = buildMockAgent('');

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate(
        'https://example.com',
        'Click the contact button',
      );

      expect(testCase.name).toBe('Click the contact button');
    });

    it('parses numbered steps from the description', async () => {
      const mockAgent = buildMockAgent('');

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate(
        'https://example.com',
        '测试登录。\n1. 输入用户名 "u"。\n2. 输入密码 "p"。\n3. 点击登录按钮。',
      );

      expect(testCase.steps).toHaveLength(3);
      expect(testCase.steps[0].instruction).toBe('输入用户名 "u"。');
      expect(testCase.steps[2].instruction).toBe('点击登录按钮。');
    });

    it('falls back to default deterministic steps when no numbered list is provided', async () => {
      const mockAgent = buildMockAgent('');

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate('https://example.com', 'Submit the form');

      expect(testCase.steps).toHaveLength(2);
      expect(testCase.steps[0].instruction).toContain('打开页面');
      expect(testCase.steps[1].instruction).toBe('Submit the form');
    });

    it('closes the browser even when an error occurs', async () => {
      const mockAgent = buildMockAgent('');
      (mockAgent.open as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('nav error');
      });

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      await expect(generator.generate('bad-url', 'Some test')).rejects.toThrow('nav error');

      expect((mockAgent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
  });
});
