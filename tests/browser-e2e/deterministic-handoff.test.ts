import { describe, it, expect, vi } from 'vitest';
import { executeDeterministicScenarioWithHandoff } from '../../src/browser-e2e/deterministic.js';
import type { BrowserAgent } from '../../src/core/agent.js';

function buildAgent(clickImpl: () => string): BrowserAgent {
  return {
    open: vi.fn(() => ''),
    snapshot: vi.fn(() => '- button "登录" [ref=e1]'),
    click: vi.fn(clickImpl),
    fill: vi.fn(() => ''),
    waitForUrl: vi.fn(() => ''),
    waitForText: vi.fn(() => ''),
    waitMs: vi.fn(() => ''),
    chat: vi.fn(() => ''),
    screenshot: vi.fn(() => ''),
    getTitle: vi.fn(() => 'Test'),
    getUrl: vi.fn(() => 'https://example.com'),
    batch: vi.fn(() => '[]'),
    handoff: vi.fn(() => 'HANDOFF: waiting'),
    resume: vi.fn(() => 'RESUME: ok'),
    detectHandoffChallenge: vi.fn(() => ({ detected: false, categories: [], evidence: [] })),
    getSessionId: vi.fn(() => 'session-1'),
    close: vi.fn(() => {}),
  } as unknown as BrowserAgent;
}

describe('executeDeterministicScenarioWithHandoff', () => {
  it('auto-handoffs after 3 consecutive failures and resumes once', async () => {
    const click = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('click failed 1');
      })
      .mockImplementationOnce(() => {
        throw new Error('click failed 2');
      })
      .mockImplementationOnce(() => {
        throw new Error('click failed 3');
      })
      .mockImplementationOnce(() => 'clicked after resume');

    const agent = buildAgent(click);
    const waitForUserResume = vi.fn(async () => {});

    const result = await executeDeterministicScenarioWithHandoff(
      agent,
      'https://example.com/login',
      '点击登录按钮',
      {
        maxConsecutiveFailuresBeforeHandoff: 3,
        waitForUserResume,
      },
    );

    expect(result.step.passed).toBe(true);
    expect(result.meta.handoffTriggered).toBe(true);
    expect(result.meta.handoffCount).toBe(1);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(waitForUserResume).toHaveBeenCalledTimes(1);
    expect((agent.resume as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('fails when action still fails after handoff retry', async () => {
    const click = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('click failed 1');
      })
      .mockImplementationOnce(() => {
        throw new Error('click failed 2');
      })
      .mockImplementationOnce(() => {
        throw new Error('click failed 3');
      })
      .mockImplementationOnce(() => {
        throw new Error('still failing after resume');
      });

    const agent = buildAgent(click);

    const result = await executeDeterministicScenarioWithHandoff(
      agent,
      'https://example.com/login',
      '点击登录按钮',
      {
        maxConsecutiveFailuresBeforeHandoff: 3,
        waitForUserResume: async () => {},
      },
    );

    expect(result.step.passed).toBe(false);
    expect(result.step.error).toContain('Action failed after handoff resume');
    expect(result.meta.handoffTriggered).toBe(true);
  });

  it('triggers immediate handoff when challenge is detected before threshold', async () => {
    const click = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('blocked by captcha widget');
      })
      .mockImplementationOnce(() => 'clicked after resume');

    const agent = buildAgent(click);
    (agent.detectHandoffChallenge as ReturnType<typeof vi.fn>).mockReturnValue({
      detected: true,
      categories: ['CAPTCHA'],
      evidence: ['captcha/bot verification markers'],
    });

    const waitForUserResume = vi.fn(async () => {});

    const result = await executeDeterministicScenarioWithHandoff(
      agent,
      'https://example.com/login',
      '点击登录按钮',
      {
        maxConsecutiveFailuresBeforeHandoff: 3,
        waitForUserResume,
      },
    );

    expect(result.step.passed).toBe(true);
    expect((agent.handoff as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((agent.handoff as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Detected CAPTCHA challenge');
    expect(waitForUserResume).toHaveBeenCalledTimes(1);
  });
});
