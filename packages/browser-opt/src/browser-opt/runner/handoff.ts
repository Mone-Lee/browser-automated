/**
 * browser-opt 人工接管工具，负责登录态失效识别、handoff 上下文、恢复控制和登录态保存。
 * 执行层只消费这里的统一结果，不直接拼接接管日志和提示文案。
 */
import { saveAuthenticatedHandoffState as saveHandoffState } from '#browser-core/auth-state';
export { saveAuthState, isLoginLikeSnapshot } from '#browser-core/auth-state';
import { isLoginLikeSnapshot } from '#browser-core/auth-state';
import type { BrowserAgent } from '#browser-core/agent';
import type { BrowserOptHandoffContext, BrowserOptHandoffOptions, SnapshotEvidence } from '../type.js';
import { captureTransientSnapshot, normalizeUrlForCompare } from './evidence.js';

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

/** 识别上传后进入图片裁剪、确认上传等交互式后处理页，需要人工确认后才能继续流程。 */
export function shouldTriggerUploadPostProcessHandoff(snapshot: SnapshotEvidence): boolean {
  const text = snapshot.text.replace(/\s+/g, '');
  const hasImageAsset = /\.(?:png|jpe?g|webp|gif|bmp|svg)(?:\b|[^\w])/i.test(text)
    || /图片|照片|封面|白底图|主图|配图/.test(text);
  const hasCropAction = /图片裁(?:切|剪)|裁(?:切|剪)图片|裁(?:切|剪)图|裁(?:切|剪)|剪裁|裁剪框|编辑图片|调整图片|调整裁剪/.test(text);
  const hasUploadConfirm = /保存并上传|确认上传|上传并保存|保存上传|确定上传|确认提交|保存图片|确定使用|确认使用|使用图片|完成/.test(text);
  const hasPendingState = /待处理|待裁(?:切|剪)|未处理|处理中|等待处理|待确认|待上传|未上传/.test(text);
  const hasCropControl = /缩放|放大|缩小|旋转|比例|目标尺寸|目标大小|推荐尺寸|预览|slider/.test(text);
  const hasBypassAction = /跳过|取消|重新选择|重新上传|更换图片/.test(text);

  return (hasCropAction && (hasUploadConfirm || hasCropControl || hasPendingState))
    || (hasImageAsset && hasUploadConfirm && (hasPendingState || hasCropAction || hasCropControl))
    || (hasPendingState && hasCropAction && hasBypassAction);
}

/** 上传后出现必须人工处理的裁剪/确认界面时，统一生成 handoff 上下文并记录日志。 */
export function triggerUploadPostProcessHandoff(
  agent: BrowserAgent,
  logs: string[],
  field: string,
): BrowserOptHandoffContext {
  const message = `上传“${field}”后页面进入图片裁剪或确认上传流程。请在浏览器中完成裁剪、确认上传，然后继续当前 browser-opt 流程。`;
  const output = agent.handoff(message);
  const actionOutput = `handoff ${JSON.stringify(message)}\n${output}`.trim();
  logs.push(`handoff: ${message}`);
  logs.push(`handoff-output: ${actionOutput}`);
  return buildHandoffContext(agent, message, actionOutput);
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
): Promise<boolean> {
  if (!options?.waitForUserResume) {
    return false;
  }

  await options.onHandoffRequired?.(handoff);
  await options.waitForUserResume(handoff);
  const resumeOutput = agent.resume();
  logs.push(`resume: ${resumeOutput}`);
  await options.onHandoffCompleted?.(handoff);
  return true;
}

/** 人工接管后等待页面离开登录态再保存，避免用户刚恢复就把中转态误判成最终登录结果。 */
export function saveAuthenticatedHandoffState(
  agent: BrowserAgent,
  authStateSavePath: string | undefined,
  logs: string[],
  snapshot: SnapshotEvidence,
): void {
  saveHandoffState(agent, authStateSavePath, logs, snapshot, () => captureTransientSnapshot(agent));
}
