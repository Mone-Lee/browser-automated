/**
 * 根据 URL 与自然语言目标生成结构化 TestCase，供 E2E 执行和代码生成复用。
 */
import { createBrowserAgent, type BrowserAgentFactory } from '#browser-core/agent';
import { deriveDeterministicSteps } from './deterministic.js';
import type { TestCase } from '#browser-core';

/**
 * TestCaseGenerator 将自由文本测试目标转换为仓库内部统一的 TestCase 结构。
 */
export class TestCaseGenerator {
  private readonly agentFactory: BrowserAgentFactory;

  constructor(agentFactory: BrowserAgentFactory = createBrowserAgent) {
    this.agentFactory = agentFactory;
  }
  /**
   * 从自然语言描述生成 TestCase，未传名称时使用描述前缀作为默认名称。
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
