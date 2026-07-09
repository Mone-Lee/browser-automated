/**
 * browser-opt 人工接管工具，负责登录态失效识别、handoff 上下文和恢复后的状态保存。
 * 执行层只消费这里的统一结果，不直接拼接接管日志和提示文案。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from '../../core/agent.js';
import type { BrowserOptHandoffContext, BrowserOptHandoffOptions, SnapshotEvidence } from '../type.js';
import { normalizeUrlForCompare } from './evidence.js';

/** 把 handoff 文案与底层输出组装成统一上下文，供恢复逻辑和 CLI 提示复用。 */
export function buildHandoffContext(agent: BrowserAgent, message: string, output: string): BrowserOptHandoffContext {
  return {
    message,
    output,
    sessionId: agent.getSessionId(),
  };
}

/** 用于识别确定性动作返回值里是否已经进入 handoff。 */
export function isHandoffActionOutput(actionOutput: string): boolean {
  return actionOutput.startsWith('handoff ');
}

/** 尽量从 handoff 动作日志里还原给用户看的提示文案。 */
export function extractHandoffMessage(actionOutput: string): string | null {
  const firstLine = actionOutput.split('\n')[0] ?? '';
  const rawMessage = firstLine.replace(/^handoff\s+/, '').trim();
  if (!rawMessage) {
    return null;
  }

  try {
    return JSON.parse(rawMessage) as string;
  } catch {
    return rawMessage;
  }
}

/**
 * 只有目标并非登录流程、但页面明显停在登录页时，才自动转入 handoff，避免误伤本来就要测登录的场景。
 */
export function shouldTriggerLoginHandoff(flowOrInstruction: string, targetUrl: string | undefined, snapshot: SnapshotEvidence): boolean {
  return isLoginLikeSnapshot(snapshot) && !isExpectedLoginFlow(flowOrInstruction, targetUrl);
}

/** 统一生成登录态失效时的 handoff 文案，并把提示写入日志。 */
export function triggerLoginHandoff(agent: BrowserAgent, logs: string[], reason: string): BrowserOptHandoffContext {
  const message = `${reason}，疑似登录态已失效。请在浏览器中完成登录，然后继续当前 browser-opt 流程。`;
  const output = buildLoginHandoffActionOutput(agent, message);
  logs.push(`handoff: ${message}`);
  logs.push(`handoff-output: ${output}`);
  return buildHandoffContext(agent, message, output);
}

/** 登录页拦截统一走 handoff，而不是把它当成普通动作异常直接抛出。 */
export function buildLoginHandoffActionOutput(agent: BrowserAgent, message: string): string {
  const output = agent.handoff(message);
  return `handoff ${JSON.stringify(message)}\n${output}`.trim();
}

/** 粗略识别“本次流程本来就是要去登录页”的场景，避免错误触发 handoff。 */
function isExpectedLoginFlow(flowOrInstruction: string, targetUrl?: string): boolean {
  if (targetUrl && /login|signin|sign-in|auth|oauth|sso/i.test(normalizeUrlForCompare(targetUrl))) {
    return true;
  }

  return /登录页|登录|登陆|sign\s*in|log\s*in|输入密码|验证码|短信码|二次验证/i.test(flowOrInstruction);
}

/** 当调用方提供等待逻辑时，进入 handoff 后暂停等待用户恢复，再继续当前会话。 */
export async function resumeFromHandoff(
  agent: BrowserAgent,
  logs: string[],
  handoff: BrowserOptHandoffContext,
  options?: BrowserOptHandoffOptions,
  authStateSavePath?: string,
): Promise<boolean> {
  if (!options?.waitForUserResume) {
    return false;
  }

  await options.onHandoffRequired?.(handoff);
  await options.waitForUserResume(handoff);
  const resumeOutput = agent.resume();
  logs.push(`resume: ${resumeOutput}`);
  if (authStateSavePath) {
    saveAuthState(agent, authStateSavePath, logs);
  }
  await options.onHandoffCompleted?.(handoff);
  return true;
}

/** 保存 cookies 与 storage，失败只记录日志，避免覆盖原本流程的 PASS/FAIL 结论。 */
export function saveAuthState(agent: BrowserAgent, authStateSavePath: string, logs: string[]): void {
  try {
    fs.mkdirSync(path.dirname(authStateSavePath), { recursive: true });
    const saveOutput = agent.stateSave(authStateSavePath);
    logs.push(`auth-state-save: ${authStateSavePath}`);
    if (saveOutput.trim()) {
      logs.push(`auth-state-save-output: ${saveOutput.trim()}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs.push(`auth-state-save-failed: ${message}`);
  }
}

export function isLoginLikeSnapshot(snapshot: SnapshotEvidence): boolean {
  return /登录|登\s*录|login|请输入手机号|请输入密码/i.test(snapshot.text);
}
