import { BrowserAgent } from '../agent.js';
import { executeDeterministicScenarioWithHandoff } from '../deterministic.js';
import { TestCaseGenerator } from '../generate.js';
import type { TestResult } from '../types.js';
import { loadGeneratedTestIndex, upsertGeneratedTestMeta } from './index-store.js';
import { findMatches } from './matcher.js';
import {
  buildGeneratedTestMeta,
  executePlaywrightSpec,
  writePlaywrightSpec,
} from './playwright.js';
import type { GeneratedCodeArtifact, MatchResult, SkillTriggerInput, SkillTriggerResult } from './types.js';

const STRONG_MATCH_THRESHOLD = 0.5;

async function runOneShot(input: SkillTriggerInput): Promise<{ execution: TestResult; handoff: { triggered: boolean; count: number } }> {
  const agent = new BrowserAgent({
    liveViewport: input.liveViewport ?? true,
    profile: input.profile,
  });
  const start = Date.now();

  try {
    const result = await executeDeterministicScenarioWithHandoff(agent, input.url, input.instruction, {
      maxConsecutiveFailuresBeforeHandoff: input.handoff?.maxConsecutiveFailuresBeforeHandoff,
      maxHandoffsPerScenario: input.handoff?.maxHandoffsPerScenario,
      onActionFailure: input.handoff?.onActionFailure,
      onHandoffRequired: input.handoff?.onHandoffRequired,
      waitForUserResume: input.handoff?.waitForUserResume,
      onHandoffCompleted: input.handoff?.onHandoffCompleted,
    });
    const step = result.step;
    const handoff = { triggered: result.meta.handoffTriggered, count: result.meta.handoffCount };

    if (!step.passed) {
      return {
        execution: {
          name: `One-shot: ${input.instruction.slice(0, 50)}`,
          passed: false,
          duration: Date.now() - start,
          steps: [step],
          error: step.error,
        },
        handoff,
      };
    }

    return {
      execution: {
        name: `One-shot: ${input.instruction.slice(0, 50)}`,
        passed: true,
        duration: Date.now() - start,
        steps: [
          {
            instruction: input.instruction,
            passed: true,
            output: step.output,
          },
        ],
      },
      handoff,
    };
  } catch (err) {
    return {
      execution: {
        name: `One-shot: ${input.instruction.slice(0, 50)}`,
        passed: false,
        duration: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
        steps: [
          {
            instruction: input.instruction,
            passed: false,
            error: err instanceof Error ? err.message : String(err),
          },
        ],
      },
      handoff: {
        triggered: false,
        count: 0,
      },
    };
  } finally {
    agent.close();
  }
}

export class BrowserE2ESkillService {
  private readonly generator: TestCaseGenerator;

  constructor(generator: TestCaseGenerator = new TestCaseGenerator()) {
    this.generator = generator;
  }

  /** 只查询已有测试用例，不执行。供 CLI 交互层先展示候选再由用户决策。 */
  checkForExistingTests(instruction: string): MatchResult {
    const index = loadGeneratedTestIndex();
    return findMatches(instruction, index.tests);
  }

  /** 跳过匹配，直接执行一次性自然语言 e2e，通过后按 autoGenerate 决定是否生成代码。 */
  async runOneShotInstruction(input: SkillTriggerInput): Promise<SkillTriggerResult> {
    const match = this.checkForExistingTests(input.instruction);
    const { execution, handoff } = await runOneShot(input);

    if (!execution.passed) {
      return {
        mode: 'one-shot',
        matched: match.best,
        execution,
        handoff,
        guidance:
          `测试未通过。${handoff.triggered ? `本次已触发用户接管 ${handoff.count} 次。` : '本次未触发用户接管。'}` +
          '\n请按以下模板补充更清晰的步骤后重试：\n测试网站 <url> 的<功能>。\n\n目标：\n1. 打开页面。\n2. 执行关键输入。\n3. 执行关键点击。\n4. 验证 URL 或页面关键文案。',
      };
    }

    if (!input.autoGenerate) {
      const suggestedName = suggestTestName(input.instruction);
      const suggestedTags = (input.tags ?? []).join(',');
      const maybeTagArg = suggestedTags ? ` --tags "${suggestedTags}"` : '';

      return {
        mode: 'one-shot',
        matched: match.best,
        execution,
        handoff,
        guidance:
          `✓ 测试通过！如需生成可复用的 Playwright 测试代码，请运行：\n` +
          `browser-automated e2e-gen "${input.url}" "${input.instruction}" --name "${suggestedName}"${maybeTagArg}`,
      };
    }

    const generated = await this.generateCodeFromInstruction({
      url: input.url,
      instruction: input.instruction,
      name: input.generatedName,
      tags: input.tags,
    });

    return {
      mode: 'one-shot',
      matched: match.best,
      execution,
      handoff,
      generated,
      guidance:
        `✓ 测试通过，已生成 Playwright 测试代码：${generated.filePath}` +
        (handoff.triggered ? `\n已触发用户接管 ${handoff.count} 次并成功恢复自动化。` : ''),
    };
  }

  /** 完整流程：先匹配已有代码用例，命中则执行；未命中则走一次性 NL 流程。 */
  async trigger(input: SkillTriggerInput): Promise<SkillTriggerResult> {
    const match = this.checkForExistingTests(input.instruction);

    if (match.best && match.best.score >= STRONG_MATCH_THRESHOLD) {
      const execution = executePlaywrightSpec(match.best.test.filePath);
      return { mode: 'code', matched: match.best, execution };
    }

    return this.runOneShotInstruction(input);
  }

  async generateCodeFromInstruction(params: {
    url: string;
    instruction: string;
    name?: string;
    tags?: string[];
  }): Promise<GeneratedCodeArtifact> {
    const testCase = await this.generator.generate(params.url, params.instruction, params.name);
    const { filePath } = writePlaywrightSpec(testCase, { tags: params.tags });

    const meta = buildGeneratedTestMeta({
      name: testCase.name,
      filePath,
      url: testCase.url,
      instruction: params.instruction,
      tags: params.tags,
      hints: testCase.steps.map((step) => step.instruction),
    });

    upsertGeneratedTestMeta(meta);

    return {
      testCase,
      filePath,
      meta,
    };
  }
}

export function suggestTestName(instruction: string): string {
  const compact = instruction.trim().replace(/\s+/g, ' ');
  return compact.length <= 80 ? compact : compact.slice(0, 80);
}
