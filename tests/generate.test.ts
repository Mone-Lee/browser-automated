import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestCaseGenerator } from '../src/generate.js';
import type { AgentOptions } from '../src/types.js';
import type { BrowserAgent } from '../src/agent.js';

function buildMockAgent(snapshot: string, chatOutput: string): BrowserAgent {
  return {
    open: vi.fn(() => ''),
    snapshot: vi.fn(() => snapshot),
    chat: vi.fn(() => chatOutput),
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
      const mockAgent = buildMockAgent(
        'button[Search]',
        '1. Type "TypeScript" in the search box\n2. Click the Search button',
      );

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
      const mockAgent = buildMockAgent('', '1. Click the button');

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate(
        'https://example.com',
        'Click the contact button',
      );

      expect(testCase.name).toBe('Click the contact button');
    });

    it('parses numbered steps from the chat output', async () => {
      const mockAgent = buildMockAgent(
        '',
        '1. Fill in the email field\n2. Fill in the password field\n3. Click Submit',
      );

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate('https://example.com', 'Log in to the app');

      expect(testCase.steps).toHaveLength(3);
      expect(testCase.steps[0].instruction).toBe('Fill in the email field');
      expect(testCase.steps[2].instruction).toBe('Click Submit');
    });

    it('parses inline assertions from steps', async () => {
      const mockAgent = buildMockAgent(
        '',
        '1. Click the submit button | assert: A success message is shown',
      );

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate('https://example.com', 'Submit the form');

      expect(testCase.steps[0].instruction).toBe('Click the submit button');
      expect(testCase.steps[0].assertion).toBe('A success message is shown');
    });

    it('falls back to the description as a single step when chat returns no list', async () => {
      const mockAgent = buildMockAgent('', '  ');

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      const testCase = await generator.generate('https://example.com', 'Do something');

      expect(testCase.steps).toHaveLength(1);
      expect(testCase.steps[0].instruction).toBe('Do something');
    });

    it('closes the browser even when an error occurs', async () => {
      const mockAgent = buildMockAgent('', '');
      (mockAgent.open as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('nav error');
      });

      const generator = new TestCaseGenerator(makeFactory(mockAgent));
      await expect(generator.generate('bad-url', 'Some test')).rejects.toThrow('nav error');

      expect((mockAgent.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });
  });
});
