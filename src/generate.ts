import { createBrowserAgent, type BrowserAgentFactory } from './agent.js';
import { deriveDeterministicSteps } from './deterministic.js';
import type { TestCase } from './types.js';

/**
 * Generates structured {@link TestCase} objects from a free-form natural
 * language description of what should be tested.
 *
 * Generation works by:
 * 1. Navigating to the target URL.
 * 2. Taking an accessibility snapshot of the page.
 * 3. Deriving deterministic test steps from the structured description.
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
      const steps = deriveDeterministicSteps(url, description);

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
