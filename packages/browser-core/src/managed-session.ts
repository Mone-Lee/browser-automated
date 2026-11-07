/**
 * 按工具命名空间记录托管浏览器会话，在下一轮启动前清理遗留进程；只复用登录态，不复用页面上下文。
 * 不接管外部浏览器，登录态选择和配置回退仍由调用方负责。
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** 每个工具独立保存会话清单；保留模式只推迟清理，不脱离托管。 */
export interface ManagedBrowserSessionOptions {
  namespace: 'browser-opt' | 'browser-test';
  stateDirectory: string;
  keepPrevious?: boolean;
  /** 仅用于兼容曾经按项目路径生成稳定会话标识的工具。 */
  cleanLegacySession?: boolean;
}

/** 所有主会话、站点切换和配置回退都应在启动前登记，供异常退出后的下一轮清理。 */
export interface ManagedBrowserSessions {
  createSessionId(configuredSession?: string): string;
}

/** 为每轮启动生成独立标识，避免复用旧进程及其通信连接。 */
export function createBrowserSessionId(namespace: string): string {
  return `${namespace}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** 直接终止对应命名空间的托管进程，避免 close 命令在浏览器已退出时重新启动窗口。 */
function terminateManagedSession(namespace: string, sessionId: string): void {
  if (basename(sessionId) !== sessionId) return;
  try {
    const pidPath = join(homedir(), '.agent-browser', 'namespaces', namespace, 'run', `${sessionId}.pid`);
    const pid = Number.parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
    const executableName = basename(command.split(/\s+/, 1)[0] ?? '');
    if (!executableName.startsWith('agent-browser')) return;
    process.kill(pid, 'SIGTERM');
  } catch {
    // 已退出或记录失效时跳过，不通过浏览器命令重新拉起窗口。
  }
}

/** 清理上一轮记录，随后在每个新会话启动前持久化其标识；损坏记录按无记录处理。 */
export function createManagedBrowserSessions(options: ManagedBrowserSessionOptions): ManagedBrowserSessions {
  const statePath = join(options.stateDirectory, `${options.namespace}-sessions.json`);
  let previousSessionIds: string[] = [];
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { sessionIds?: unknown };
    if (Array.isArray(state.sessionIds)) {
      previousSessionIds = state.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
    }
  } catch {
    // 首次运行或记录损坏时，仍允许创建本轮会话。
  }
  if (!options.keepPrevious) {
    if (!previousSessionIds.length && options.cleanLegacySession) {
      const hash = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
      previousSessionIds.push(`${options.namespace}-${hash}`);
    }
    previousSessionIds.forEach(id => terminateManagedSession(options.namespace, id));
  }
  const sessionIds = options.keepPrevious ? previousSessionIds : [];
  return {
    createSessionId(configuredSession) {
      const sessionId = configuredSession ?? createBrowserSessionId(options.namespace);
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
      mkdirSync(options.stateDirectory, { recursive: true });
      writeFileSync(statePath, JSON.stringify({ sessionIds }, null, 2));
      return sessionId;
    },
  };
}
