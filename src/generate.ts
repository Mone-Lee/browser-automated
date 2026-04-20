import { createBrowserAgent, type BrowserAgentFactory } from './agent.js';
import type { TestCase, TestStep } from './types.js';

/**
 * Generates structured {@link TestCase} objects from a free-form natural
 * language description of what should be tested.
 *
 * Generation works by:
 * 1. Navigating to the target URL.
 * 2. Taking an accessibility snapshot of the page.
 * 3. Using `agent-browser chat` to turn the description into concrete test steps.
 *
 * @example
 * ```ts
 * import { TestCaseGenerator } from 'browser-automated';
 *
 * const generator = new TestCaseGenerator();
 *
 * const testCase = await generator.generate(
 *   'https://www.google.com',
 *   'Search for "TypeScript" and verify that the first result is shown',
 * );
 *
 * console.log(JSON.stringify(testCase, null, 2));
 * ```
 */
export class TestCaseGenerator {
  private readonly agentFactory: BrowserAgentFactory;

  constructor(agentFactory: BrowserAgentFactory = createBrowserAgent) {
    this.agentFactory = agentFactory;
  }
  /**
   * Generate a {@link TestCase} from a natural language description.
   *
   * @param url - The URL to test.
   * @param description - A natural language description of the test scenario.
   * @param name - Optional test case name (derived from `description` if omitted).
   */
  async generate(url: string, description: string, name?: string): Promise<TestCase> {
    const agent = this.agentFactory({ timeout: 30_000 });

    try {
      agent.open(url);
      const pageSnapshot = agent.snapshot();

      const prompt = buildGenerationPrompt(description, pageSnapshot);
      const output = agent.chat(prompt);

      const steps = parseStepsFromOutput(output, description);

      return {
        name: name ?? description.slice(0, 80),
        url,
        steps,
      };
    } finally {
      agent.close();
    }
  }
}

/**
 * Build the prompt that asks agent-browser to turn a natural language description
 * into a numbered list of test steps.
 */
function buildGenerationPrompt(description: string, snapshot: string): string {
  return (
    `Based on this page (accessibility snapshot below) and the test scenario described, ` +
    `generate a numbered list of test steps in English. ` +
    `Each step should be a clear, actionable instruction. ` +
    `Optionally append " | assert: <expected outcome>" after any step that should be verified.\n\n` +
    `Test scenario: ${description}\n\n` +
    `Page snapshot:\n${snapshot.slice(0, 2000)}\n\n` +
    `Output only the numbered list, nothing else.`
  );
}

/**
 * Parse the numbered-list output from the chat model into {@link TestStep} objects.
 *
 * Supported formats:
 *   1. Click the search box
 *   2. Type "TypeScript" | assert: the search box contains "TypeScript"
 */
function parseStepsFromOutput(output: string, fallbackDescription: string): TestStep[] {
  const lines = output
    .split('\n')
    .map((l) => l.replace(/^\d+\.\s*/, '').trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    // Fallback: treat the entire description as a single step.
    return [{ instruction: fallbackDescription }];
  }

  return lines.map((line) => {
    const [instruction, assertionPart] = line.split(/\s*\|\s*assert:\s*/i);
    const step: TestStep = { instruction: instruction.trim() };
    if (assertionPart) {
      step.assertion = assertionPart.trim();
    }
    return step;
  });
}
