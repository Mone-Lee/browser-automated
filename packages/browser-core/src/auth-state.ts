/**
 * 统一浏览器登录态的选择、加载与安全保存规则，按工具隔离目录；站点或配置文件的选择由调用方决定。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from './agent.js';

/** 登录判断只依赖页面文本与可选地址，避免共享层绑定具体运行器的证据结构。 */
export interface AuthSnapshot {
  text: string;
  /** 可选的实际地址，用于识别跨域登录中转页。 */
  url?: string;
}

/** 登录态选择结果；显式文件不会附带自动切换账号来源的回退配置。 */
export interface BrowserAuthState {
  profile?: string;
  statePath?: string;
  authStateSavePath?: string;
  fallbackProfile?: string;
}

/** 按工具选择独立的登录态目录与环境变量，相对路径基于调用方工作目录解析。 */
export function authStateDirectory(tool: 'browser-opt' | 'browser-test'): string {
  const configuredDirectory = tool === 'browser-test'
    ? process.env.BROWSER_TEST_AUTH_STATE_DIR
    : process.env.BROWSER_OPT_AUTH_STATE_DIR;
  return path.resolve(configuredDirectory || `.${tool}/states`);
}

/** 优先复用已有文件，缺失时导入指定的浏览器配置；仅自动选择的文件允许失效后回退。 */
export function resolveBrowserAuthState(
  configuredStatePath: string | undefined,
  defaultStatePath: string,
  profile: string,
): BrowserAuthState {
  const authStateSavePath = configuredStatePath ?? defaultStatePath;
  if (fs.existsSync(authStateSavePath)) {
    return { statePath: authStateSavePath, authStateSavePath, fallbackProfile: configuredStatePath ? undefined : profile };
  }
  return { profile, authStateSavePath };
}

/** 在业务请求发出前恢复登录态；失败只记录状态，不把可能含凭证的命令输出写入日志。 */
export function loadAuthState(agent: BrowserAgent, statePath: string, log: (line: string) => void): boolean {
  try {
    agent.open('about:blank');
    log('auth-state-stage-open: about:blank');
    agent.stateLoad(statePath);
    log(`auth-state-load: ${statePath}`);
    return true;
  } catch {
    log('auth-state-load-failed: 登录态加载失败，继续核验页面并按需人工接管。');
    return false;
  }
}

/** 保存完整会话并收紧文件权限；预先创建受限文件，避免首次写入时暴露凭证。 */
export function saveAuthState(agent: BrowserAgent, statePath: string, logs: string[]): boolean {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const descriptor = fs.openSync(statePath, 'a', 0o600);
    fs.closeSync(descriptor);
    fs.chmodSync(statePath, 0o600);
    agent.stateSave(statePath);
    fs.chmodSync(statePath, 0o600);
    logs.push(`auth-state-save: ${statePath}`);
    return true;
  } catch {
    logs.push('auth-state-save-failed: 登录态保存失败。');
    return false;
  }
}

/** 通过登录表单相关文本和可选的中转地址，识别尚未完成的登录页面。 */
export function isLoginLikeSnapshot(snapshot: AuthSnapshot): boolean {
  return /登录|登\s*录|login|请输入手机号|请输入密码/i.test(snapshot.text)
    || /(?:login|signin|sign-in|oauth|sso)(?:[/?#]|$)/i.test(snapshot.url ?? '');
}

/** 接管恢复后最多等待五次跳转，仅在非空白、非登录页面保存，避免固化登录中转态。 */
export function saveAuthenticatedHandoffState(
  agent: BrowserAgent,
  statePath: string | undefined,
  logs: string[],
  snapshot: AuthSnapshot,
  capture: () => AuthSnapshot,
): void {
  if (!statePath) return;
  let current = snapshot;
  const pending = () => !current.text.trim() || isLoginLikeSnapshot(current);
  for (let attempt = 1; attempt <= 5 && pending(); attempt += 1) {
    logs.push(`auth-state-save-wait ${attempt}: 等待人工登录后的页面跳转。`);
    agent.waitMs(500);
    current = capture();
  }
  if (pending()) {
    logs.push('auth-state-save-skipped: 页面尚未离开登录页或空白页。');
    return;
  }
  saveAuthState(agent, statePath, logs);
}
