/**
 * 将自然语言 E2E 步骤解析为确定性浏览器动作，并负责失败重试与 handoff 恢复。
 */
import type { BrowserAgent } from '../core/agent.js';
import type { StepResult, TestStep } from '../core/types.js';

interface SnapshotNode {
  kind: 'textbox' | 'button' | 'link' | 'generic';
  label: string;
  ref: string;
}

export interface DeterministicAction {
  type: 'open' | 'fill' | 'click' | 'assert-url' | 'assert-text';
  value?: string;
  field?: string;
}

export interface DeterministicExecutionResult {
  passed: boolean;
  step: StepResult;
}

export interface HandoffRequestContext {
  instruction: string;
  action: DeterministicAction;
  consecutiveFailures: number;
  error: string;
}

export interface HandoffLifecycleContext extends HandoffRequestContext {
  handoffMessage: string;
  handoffOutput: string;
  sessionId?: string;
}

export interface DeterministicScenarioOptions {
  maxConsecutiveFailuresBeforeHandoff?: number;
  maxHandoffsPerScenario?: number;
  onActionFailure?: (context: HandoffRequestContext) => Promise<'handoff' | 'continue' | void> | 'handoff' | 'continue' | void;
  onHandoffRequired?: (context: HandoffLifecycleContext) => Promise<void> | void;
  waitForUserResume?: (context: HandoffLifecycleContext) => Promise<void> | void;
  onHandoffCompleted?: (context: HandoffLifecycleContext) => Promise<void> | void;
}

export interface DeterministicScenarioExecutionMeta {
  handoffTriggered: boolean;
  handoffCount: number;
}

export interface DeterministicScenarioExecutionResult {
  step: StepResult;
  meta: DeterministicScenarioExecutionMeta;
}

const QUOTED_VALUE_RE = /["“]([^"”]+)["”]/g;

function parseSnapshot(snapshot: string): SnapshotNode[] {
  const lines = snapshot.split('\n').map((line) => line.trim());
  const nodes: SnapshotNode[] = [];

  for (const line of lines) {
    let match = line.match(/textbox\s+"([^"]*)"\s+\[ref=([^\]]+)\]/i);
    if (match) {
      nodes.push({ kind: 'textbox', label: match[1], ref: match[2] });
      continue;
    }

    match = line.match(/button\s+"([^"]*)"\s+\[ref=([^\]]+)\]/i);
    if (match) {
      nodes.push({ kind: 'button', label: match[1], ref: match[2] });
      continue;
    }

    match = line.match(/link\s+"([^"]*)"\s+\[ref=([^\]]+)\]/i);
    if (match) {
      nodes.push({ kind: 'link', label: match[1], ref: match[2] });
      continue;
    }

    match = line.match(/generic\s+"([^"]*)"\s+\[ref=([^\]]+)\].*clickable/i);
    if (match) {
      nodes.push({ kind: 'generic', label: match[1], ref: match[2] });
    }
  }

  return nodes;
}

function splitWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s\-_\/]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getFieldKeywords(field: string): string[] {
  const normalized = field.toLowerCase();

  if (/(用户名|账号|user|username|email|邮箱|手机号|手机)/i.test(normalized)) {
    return ['用户名', '账号', 'user', 'username', 'email', '邮箱', '手机号', '手机'];
  }
  if (/(密码|password|pwd)/i.test(normalized)) {
    return ['密码', 'password', 'pwd'];
  }
  if (/(验证码|captcha|code)/i.test(normalized)) {
    return ['验证码', 'captcha', 'code'];
  }

  return splitWords(field);
}

function findTextboxRef(snapshot: string, field: string): string | null {
  const nodes = parseSnapshot(snapshot).filter((node) => node.kind === 'textbox');
  const keywords = getFieldKeywords(field);

  const exact = nodes.find((node) => keywords.some((kw) => node.label.toLowerCase().includes(kw.toLowerCase())));
  if (exact) {
    return exact.ref;
  }

  return nodes[0]?.ref ?? null;
}

function findClickableRef(snapshot: string, target: string): string | null {
  const nodes = parseSnapshot(snapshot).filter((node) => node.kind !== 'textbox');
  const keywords = splitWords(target);

  const exact = nodes.find((node) => {
    const label = node.label.toLowerCase();
    if (!label) return false;
    return keywords.every((kw) => label.includes(kw));
  });
  if (exact) {
    return exact.ref;
  }

  const partial = nodes.find((node) => {
    const label = node.label.toLowerCase();
    return keywords.some((kw) => label.includes(kw));
  });

  if (partial) {
    return partial.ref;
  }

  const loginFallback = nodes.find((node) => /登录|登\s*录|login|sign in/i.test(node.label));
  return loginFallback?.ref ?? null;
}

function quotedValues(text: string): string[] {
  const values: string[] = [];
  for (const m of text.matchAll(QUOTED_VALUE_RE)) {
    if (m[1]) {
      values.push(m[1]);
    }
  }
  return values;
}

function parseUrlAssertion(text: string): string | null {
  const m1 = text.match(/URL\s*包含\s*([\/A-Za-z0-9_-]+)/i);
  if (m1?.[1]) {
    return m1[1];
  }

  const m2 = text.match(/url\s+contains\s+([\/A-Za-z0-9_-]+)/i);
  if (m2?.[1]) {
    return m2[1];
  }

  return null;
}

function parseTextAssertion(text: string): string | null {
  const m1 = text.match(/看到([^。；\n]+)(?:文字|文案)?/i);
  if (m1?.[1]) {
    return m1[1].replace(/["“”]/g, '').trim();
  }

  const m2 = text.match(/see\s+text\s+["“]([^"”]+)["”]/i);
  if (m2?.[1]) {
    return m2[1].trim();
  }

  return null;
}

export function parseDeterministicActionsFromInstruction(instruction: string): DeterministicAction[] {
  const actions: DeterministicAction[] = [];
  const lines = instruction
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const orderedLines = lines.length > 0 ? lines : [instruction.trim()];

  for (const line of orderedLines) {
    const normalized = line.replace(/^\d+\.\s*/, '').trim();

    if (/打开|访问|open|goto|navigate/i.test(normalized) && /https?:\/\//i.test(normalized)) {
      const url = normalized.match(/https?:\/\/[^\s。，、，]+/i)?.[0];
      if (url) {
        actions.push({ type: 'open', value: url });
        continue;
      }
    }

    if (/输入|填写|type|fill/i.test(normalized)) {
      const pairs: Array<{ field: string; value: string }> = [];
      for (const m of normalized.matchAll(/(用户名|账号|密码|验证码|邮箱|手机号|username|password|email|captcha|code)[^"“”]*["“]([^"”]+)["”]/gi)) {
        if (m[1] && m[2]) {
          pairs.push({ field: m[1], value: m[2] });
        }
      }

      if (pairs.length === 0) {
        const values = quotedValues(normalized);
        if (values.length === 1) {
          actions.push({ type: 'fill', field: '文本', value: values[0] });
          continue;
        }
        if (values.length >= 2) {
          actions.push({ type: 'fill', field: '用户名', value: values[0] });
          actions.push({ type: 'fill', field: '密码', value: values[1] });
          continue;
        }
      }

      for (const pair of pairs) {
        actions.push({ type: 'fill', field: pair.field, value: pair.value });
      }
      continue;
    }

    if (/点击|click|tap|press/i.test(normalized)) {
      const textValue = quotedValues(normalized)[0];
      const target = textValue ?? (normalized.match(/(登录|登\s*录|login|submit|提交|按钮|button)/i)?.[0] ?? '登录');
      actions.push({ type: 'click', value: target });
      continue;
    }

    if (/验证|断言|verify|assert/i.test(normalized)) {
      const urlNeedle = parseUrlAssertion(normalized);
      if (urlNeedle) {
        actions.push({ type: 'assert-url', value: urlNeedle });
      }

      const textNeedle = parseTextAssertion(normalized);
      if (textNeedle) {
        actions.push({ type: 'assert-text', value: textNeedle });
      }
      continue;
    }

    if (/url\s*包含|url\s*contains/i.test(normalized)) {
      const urlNeedle = parseUrlAssertion(normalized);
      if (urlNeedle) {
        actions.push({ type: 'assert-url', value: urlNeedle });
      }
      continue;
    }
  }

  return actions;
}

export function deriveDeterministicSteps(url: string, description: string): TestStep[] {
  const lines = description
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\./.test(line));

  const steps = lines.map((line) => ({ instruction: line.replace(/^\d+\.\s*/, '').trim() }));

  if (steps.length > 0) {
    return steps;
  }

  return [
    { instruction: `打开页面 ${url}` },
    { instruction: description.trim() },
  ];
}

export function executeDeterministicStep(
  agent: BrowserAgent,
  instruction: string,
  assertion?: string,
): DeterministicExecutionResult {
  const actions = parseDeterministicActionsFromInstruction(instruction);

  if (actions.length === 0) {
    return {
      passed: false,
      step: {
        instruction,
        passed: false,
        error: 'Unsupported deterministic instruction. Please provide explicit open/fill/click/assert steps.',
      },
    };
  }

  try {
    const outputs: string[] = [];

    for (const action of actions) {
      if (action.type === 'open') {
        outputs.push(agent.open(action.value ?? ''));
        continue;
      }

      if (action.type === 'fill') {
        const snapshot = agent.snapshot();
        const ref = findTextboxRef(snapshot, action.field ?? '');
        if (!ref) {
          throw new Error(`Cannot locate textbox for field: ${action.field ?? 'unknown'}`);
        }
        outputs.push(agent.fill(ref, action.value ?? ''));
        continue;
      }

      if (action.type === 'click') {
        const snapshot = agent.snapshot();
        const ref = findClickableRef(snapshot, action.value ?? '');
        if (!ref) {
          throw new Error(`Cannot locate clickable element for target: ${action.value ?? 'unknown'}`);
        }
        outputs.push(agent.click(ref));
        continue;
      }

      if (action.type === 'assert-url') {
        const currentUrl = agent.getUrl();
        if (!currentUrl.includes(action.value ?? '')) {
          throw new Error(`URL assertion failed. Expected URL to include: ${action.value}. Actual: ${currentUrl}`);
        }
        outputs.push(`URL includes: ${action.value}`);
        continue;
      }

      if (action.type === 'assert-text') {
        const snapshot = agent.snapshot();
        if (!snapshot.includes(action.value ?? '')) {
          throw new Error(`Text assertion failed. Expected text: ${action.value}`);
        }
        outputs.push(`Text visible: ${action.value}`);
      }
    }

    if (assertion) {
      const assertionActions = parseDeterministicActionsFromInstruction(`验证 ${assertion}`);
      for (const action of assertionActions) {
        if (action.type === 'assert-url') {
          const currentUrl = agent.getUrl();
          if (!currentUrl.includes(action.value ?? '')) {
            throw new Error(`Assertion failed. Expected URL include ${action.value}. Actual: ${currentUrl}`);
          }
        }
        if (action.type === 'assert-text') {
          const snapshot = agent.snapshot();
          if (!snapshot.includes(action.value ?? '')) {
            throw new Error(`Assertion failed. Expected text: ${action.value}`);
          }
        }
      }
    }

    return {
      passed: true,
      step: {
        instruction,
        passed: true,
        output: outputs.filter(Boolean).join('\n').trim(),
      },
    };
  } catch (err) {
    return {
      passed: false,
      step: {
        instruction,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function actionErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function executeSingleAction(agent: BrowserAgent, action: DeterministicAction, outputs: string[]): void {
  if (action.type === 'open') {
    outputs.push(agent.open(action.value ?? ''));
    return;
  }

  if (action.type === 'fill') {
    const snapshot = agent.snapshot();
    const ref = findTextboxRef(snapshot, action.field ?? '');
    if (!ref) {
      throw new Error(`Cannot locate textbox for field: ${action.field ?? 'unknown'}`);
    }
    outputs.push(agent.fill(ref, action.value ?? ''));
    return;
  }

  if (action.type === 'click') {
    const snapshot = agent.snapshot();
    const ref = findClickableRef(snapshot, action.value ?? '');
    if (!ref) {
      throw new Error(`Cannot locate clickable element for target: ${action.value ?? 'unknown'}`);
    }
    outputs.push(agent.click(ref));
    return;
  }

  if (action.type === 'assert-url') {
    const currentUrl = agent.getUrl();
    if (!currentUrl.includes(action.value ?? '')) {
      throw new Error(`URL assertion failed. Expected URL to include: ${action.value}. Actual: ${currentUrl}`);
    }
    outputs.push(`URL includes: ${action.value}`);
    return;
  }

  if (action.type === 'assert-text') {
    const snapshot = agent.snapshot();
    if (!snapshot.includes(action.value ?? '')) {
      throw new Error(`Text assertion failed. Expected text: ${action.value}`);
    }
    outputs.push(`Text visible: ${action.value}`);
  }
}

export async function executeDeterministicScenarioWithHandoff(
  agent: BrowserAgent,
  url: string,
  instruction: string,
  options: DeterministicScenarioOptions = {},
): Promise<DeterministicScenarioExecutionResult> {
  const lines = instruction
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\./.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, '').trim());

  const scopedInstructions = lines.length > 0 ? lines : [instruction];
  const outputs: string[] = [];
  const threshold = Math.max(1, options.maxConsecutiveFailuresBeforeHandoff ?? 3);
  const maxHandoffs = Math.max(1, options.maxHandoffsPerScenario ?? 1);
  let consecutiveFailures = 0;
  let handoffCount = 0;

  try {
    outputs.push(agent.open(url));

    for (const item of scopedInstructions) {
      const actions = parseDeterministicActionsFromInstruction(item);
      if (actions.length === 0) {
        throw new Error('Unsupported deterministic instruction. Please provide explicit open/fill/click/assert steps.');
      }

      for (const action of actions) {
        let attempts = 0;

        while (true) {
          try {
            executeSingleAction(agent, action, outputs);
            consecutiveFailures = 0;
            break;
          } catch (err) {
            attempts += 1;
            consecutiveFailures += 1;
            const error = actionErrorMessage(err);
            const failureContext: HandoffRequestContext = {
              instruction: item,
              action,
              consecutiveFailures,
              error,
            };

            const failureDecision = await options.onActionFailure?.(failureContext);
            const challenge = agent.detectHandoffChallenge(error);
            const shouldHandoff =
              failureDecision === 'handoff' ||
              challenge.detected ||
              consecutiveFailures >= threshold;

            if (shouldHandoff && handoffCount < maxHandoffs && options.waitForUserResume) {
              const handoffMessage = challenge.detected
                ? `Detected ${challenge.categories.join(', ')} challenge while executing ${action.type}. Evidence: ${challenge.evidence.join('; ')}. Last error: ${error}`
                : `Stuck on ${action.type} after ${consecutiveFailures} failures: ${error}`;
              const handoffOutput = agent.handoff(handoffMessage);
              const lifecycleContext: HandoffLifecycleContext = {
                ...failureContext,
                handoffMessage,
                handoffOutput,
                sessionId: agent.getSessionId(),
              };

              await options.onHandoffRequired?.(lifecycleContext);
              await options.waitForUserResume(lifecycleContext);
              agent.resume();
              agent.snapshot();
              await options.onHandoffCompleted?.(lifecycleContext);

              handoffCount += 1;
              consecutiveFailures = 0;

              try {
                executeSingleAction(agent, action, outputs);
                break;
              } catch (retryErr) {
                const retryMessage = actionErrorMessage(retryErr);
                throw new Error(`Action failed after handoff resume: ${retryMessage}`);
              }
            }

            if (attempts >= threshold) {
              throw new Error(error);
            }
          }
        }
      }
    }

    return {
      step: {
        instruction,
        passed: true,
        output: outputs.filter(Boolean).join('\n').trim(),
      },
      meta: {
        handoffTriggered: handoffCount > 0,
        handoffCount,
      },
    };
  } catch (err) {
    return {
      step: {
        instruction,
        passed: false,
        output: outputs.filter(Boolean).join('\n').trim(),
        error: actionErrorMessage(err),
      },
      meta: {
        handoffTriggered: handoffCount > 0,
        handoffCount,
      },
    };
  }
}

export function executeDeterministicScenario(
  agent: BrowserAgent,
  url: string,
  instruction: string,
): StepResult {
  const lines = instruction
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\./.test(line))
    .map((line) => line.replace(/^\d+\.\s*/, '').trim());

  const scopedInstructions = lines.length > 0 ? lines : [instruction];

  const openResult = executeDeterministicStep(agent, `打开页面 ${url}`);
  if (!openResult.passed) {
    return openResult.step;
  }

  const outputs: string[] = [openResult.step.output ?? ''];
  for (const item of scopedInstructions) {
    const result = executeDeterministicStep(agent, item);
    if (!result.passed) {
      return {
        instruction,
        passed: false,
        output: outputs.filter(Boolean).join('\n'),
        error: result.step.error,
      };
    }
    if (result.step.output) {
      outputs.push(result.step.output);
    }
  }

  return {
    instruction,
    passed: true,
    output: outputs.filter(Boolean).join('\n'),
  };
}
