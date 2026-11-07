/**
 * browser-test 的浏览器适配层：管理登录态与浏览器配置回退，采集页面观测并执行已校验的原子动作。
 * 执行器通过 BrowserPort 重新观测切换后的页面；业务门禁与用例判定仍由执行器负责。
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { authStateDirectory, isLoginLikeSnapshot, loadAuthState, resolveBrowserAuthState, saveAuthenticatedHandoffState, saveAuthState } from '#browser-core/auth-state';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { createBrowserAgent, type BrowserAgent, type BrowserAgentFactory } from '#browser-core/agent';
import type { AtomicAction, Observation, ObservationTarget } from './types.js';

export interface BrowserPort {
  /** 采集一次观测；shotPath 给出时同时截图。 */
  observe(id: string, shotPath?: string): Observation;
  /** 执行一个已通过门禁的动作，返回命令输出摘要。 */
  act(action: AtomicAction, observation: Observation): string;
  /** 暂停自动执行等待人工操作；返回 false 表示无法接管（无头模式或已取消）。 */
  handoff(message: string): Promise<boolean>;
  /** 在打开已确认入口前选择并加载登录态；按站点隔离运行会话。 */
  prepareEntry?(url: string, trace: (line: string) => void): void;
  /** 自动登录态失效时最多切换一次浏览器配置并重开入口；切换后必须重新观测。 */
  retryAuthStateFallback?(url: string): boolean;
  close(): void;
}

export interface BrowserPortOptions {
  /** 无头模式下无法人工接管。 */
  headless: boolean;
  /** 单条命令的超时（毫秒）。 */
  timeoutMs: number;
  /** 显式指定的已有登录态；与禁用登录态选项互斥。 */
  statePath?: string;
  /** 导入及回退使用的浏览器配置名称或路径，默认使用 Default。 */
  profile?: string;
  /** 禁用本次登录态的加载、保存与浏览器配置导入。 */
  noState?: boolean;
}

interface ProbeResult {
  text: string;
  rows: Array<{ header: boolean; cells: string[] }>;
  textTruncated: boolean;
  rowsTruncated: boolean;
}

const TEXT_LIMIT = 20_000;
const TARGET_LIMIT = 200;
const ROW_LIMIT = 200;

// 固定的只读采集脚本：页面文本与表格行，快照不保证覆盖静态文本和布局；不接受模型传入的脚本。
const PROBE_SCRIPT = `(() => {
  const clean = (value) => (value || '').trim().replace(/\\s+/g, ' ');
  const fullText = document.body ? document.body.innerText : '';
  const text = fullText.slice(0, ${TEXT_LIMIT});
  const allRows = Array.from(document.querySelectorAll('tr, [role="row"]'));
  const rows = allRows.slice(0, ${ROW_LIMIT}).map((row) => {
    const cells = Array.from(row.querySelectorAll('th, td, [role="cell"], [role="gridcell"], [role="columnheader"]'));
    const header = cells.length > 0 && cells.every((cell) => cell.tagName === 'TH' || cell.getAttribute('role') === 'columnheader');
    return { header, cells: cells.map((cell) => clean(cell.innerText)) };
  });
  return JSON.stringify({ text, rows, textTruncated: fullText.length > text.length, rowsTruncated: allRows.length > rows.length });
})()`;

const ALLOWED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp']);

/** 解析 agent-browser eval 的输出：脚本返回 JSON 字符串，命令输出会再包一层 JSON。 */
function parseProbeOutput(output: string): ProbeResult {
  let value: unknown = JSON.parse(output.trim());
  if (typeof value === 'string') value = JSON.parse(value);
  const probe = value as Partial<ProbeResult>;
  return { text: probe.text ?? '', rows: probe.rows ?? [], textTruncated: probe.textTruncated === true, rowsTruncated: probe.rowsTruncated === true };
}

/** 从快照结果的 refs 提取目标；agent-browser 仅列出当前可达节点，因此一律视为可见。 */
function parseTargets(snapshot: { data: unknown }): { targets: ObservationTarget[]; truncated: boolean } {
  const refs = (snapshot.data as { data?: { refs?: Record<string, { name?: string; role?: string }> } } | null)?.data?.refs ?? {};
  const entries = Object.entries(refs);
  const targets = entries.slice(0, TARGET_LIMIT).map(([ref, info], index) => ({
    id: `t${index + 1}`, ref, role: info.role, name: info.name ?? '', visible: true,
  }));
  return { targets, truncated: entries.length > TARGET_LIMIT };
}

/** 用同一套登录页识别规则核验入口、回退与接管后的观测，避免各处判定不一致。 */
export function isLoginObservation(observation: Observation): boolean {
  return isLoginLikeSnapshot({ url: observation.url, text: observation.targets.map(target => target.name).join('\n') });
}

/** 创建浏览器端口；保留初始实例注入，并用工厂为站点切换及配置回退创建独立会话。 */
export function createBrowserPort(
  options: BrowserPortOptions,
  initialAgent?: BrowserAgent,
  agentFactory: BrowserAgentFactory = createBrowserAgent,
): BrowserPort {
  if (options.statePath && options.noState) throw new Error('--state 与 --no-state 不能同时使用');
  if (options.profile !== undefined && !options.profile.trim()) throw new Error('--profile 不能为空');
  if (options.profile && options.noState) throw new Error('--profile 与 --no-state 不能同时使用');
  if (options.statePath && (!existsSync(options.statePath) || !statSync(options.statePath).isFile())) throw new Error('--state 必须指定已存在的登录态文件');
  const createAgent = (profile?: string) => agentFactory({
    headed: !options.headless, headless: options.headless, openLiveDashboard: false, timeout: options.timeoutMs, profile,
  });
  let agent = initialAgent ?? createAgent();
  let origin: string | undefined;
  let savePath: string | undefined;
  let fallbackProfile: string | undefined;
  let profileOpening = false;
  let pendingProfileSave = false;
  let trace: (line: string) => void = () => undefined;

  // 配置导入只尝试一次；之后的自动化与人工接管固定使用替换后的实例。
  const useProfile = (profile: string, closeCurrent: boolean) => {
    fallbackProfile = undefined;
    if (closeCurrent) agent.close();
    agent = createAgent(profile);
    profileOpening = true;
    pendingProfileSave = true;
    trace(`auth-state-source: profile ${profile}`);
  };

  // 配置不可用时改开干净窗口供人工登录，不重复尝试失败的配置导入。
  const open = (url: string): string => {
    try {
      const output = agent.open(url);
      profileOpening = false;
      return output.trim();
    } catch (error) {
      if (!profileOpening) throw error;
      trace('auth-state-profile-failed: 配置导入失败，改用干净窗口并按需人工接管。');
      agent.close();
      agent = createAgent();
      profileOpening = false;
      pendingProfileSave = false;
      return agent.open(url).trim();
    }
  };

  // 接管恢复后复核当前实例，保存失败只记录，不改变本次用例结果。
  const resume = () => {
    agent.resume();
    if (!savePath) return;
    const logs: string[] = [];
    try {
      const capture = () => {
        const url = agent.getUrl();
        return { url, text: !url || url === 'about:blank' ? '' : agent.snapshot() };
      };
      saveAuthenticatedHandoffState(agent, savePath, logs, capture(), capture);
    } catch { logs.push('auth-state-save-failed: 无法核验接管后的页面。'); }
    if (logs.some(line => line.startsWith('auth-state-save:'))) {
      pendingProfileSave = false;
      trace('auth-state-source: HANDOFF');
    }
    logs.forEach(line => trace(line));
  };
  return {
    prepareEntry(url, log) {
      trace = log;
      const nextOrigin = new URL(url).origin;
      if (origin === nextOrigin) return;
      // 站点变化后更换会话，避免把前一站点的自动化上下文带入新场景。
      if (origin) {
        agent.close();
        agent = createAgent();
      }
      origin = nextOrigin;
      fallbackProfile = undefined;
      pendingProfileSave = false;
      profileOpening = false;
      if (options.noState) {
        savePath = undefined;
        trace('auth-state-source: none (--no-state)');
        return;
      }
      const entry = new URL(nextOrigin);
      const host = entry.hostname.replace(/[^a-z0-9.-]/gi, '-');
      const profile = options.profile?.trim() ?? 'Default';
      // 默认配置兼容已有站点文件；其他配置将身份纳入摘要，避免命中默认账号的缓存。
      const identity = profile === 'Default' ? nextOrigin : JSON.stringify([nextOrigin, profile]);
      const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16);
      const defaultPath = join(authStateDirectory('browser-test'), `browser-test-${host}-${entry.port || (entry.protocol === 'https:' ? '443' : '80')}-${hash}.json`);
      const state = resolveBrowserAuthState(options.statePath ? resolve(options.statePath) : undefined, defaultPath, profile);
      savePath = state.authStateSavePath;
      fallbackProfile = state.fallbackProfile;
      trace(`auth-state-source: ${options.statePath ? 'explicit' : state.statePath ? 'automatic' : 'none'}${state.statePath ? ` ${state.statePath}` : ''}`);
      if (state.profile) useProfile(state.profile, false);
      else if (state.statePath && !loadAuthState(agent, state.statePath, trace) && fallbackProfile) {
        trace('auth-state-fallback: 自动登录态加载失败，尝试浏览器配置。');
        useProfile(fallbackProfile, true);
      }
    },
    retryAuthStateFallback(url) {
      if (!fallbackProfile || new URL(url).origin !== origin) return false;
      trace('auth-state-fallback: 自动登录态失效，尝试浏览器配置并重新核验入口。');
      useProfile(fallbackProfile, true);
      open(url);
      return true;
    },
    observe(id, shotPath) {
      const snapshot = agent.snapshotJson();
      const url = agent.getUrl();
      if (shotPath) agent.screenshot(shotPath);
      const { targets, truncated: targetsTruncated } = parseTargets(snapshot);
      let probe: ProbeResult = { text: '', rows: [], textTruncated: false, rowsTruncated: false };
      let probeError: string | undefined;
      try { probe = parseProbeOutput(agent.evaluate(PROBE_SCRIPT)); } catch (error) {
        probeError = error instanceof Error ? error.message : String(error);
      }
      const observation: Observation = {
        id,
        capturedAt: new Date().toISOString(),
        url,
        shot: shotPath,
        targets,
        capture: { probeFailed: probeError !== undefined, textTruncated: probe.textTruncated, targetsTruncated, rowsTruncated: probe.rowsTruncated },
        evidence: [
          { id: `${id}-targets`, kind: 'page', source: 'snapshot-targets', actual: targets.map(({ role, name, ref }) => ({ role, name, ref })) },
          { id: `${id}-url`, kind: 'page', source: 'url', actual: url },
          { id: `${id}-text`, kind: 'page', source: 'body-text', actual: probe.text },
          { id: `${id}-rows`, kind: 'page', source: 'table-rows', actual: probe.rows },
          ...(probeError ? [{ id: `${id}-probe-error`, kind: 'page' as const, source: 'probe-error', actual: probeError }] : []),
        ],
      };
      if (pendingProfileSave && savePath && !probeError && (targets.length || probe.text.trim())
        && !isLoginObservation(observation) && new URL(url).origin === origin) {
        pendingProfileSave = false;
        const logs: string[] = [];
        saveAuthState(agent, savePath, logs);
        logs.forEach(line => trace(line));
      }
      return observation;
    },

    act(action, observation) {
      const target = (targetId: string): ObservationTarget => {
        const found = observation.targets.find(item => item.id === targetId);
        if (!found) throw new Error(`目标 ${targetId} 不在观测 ${observation.id} 中`);
        return found;
      };
      switch (action.type) {
        case 'open': return open(action.url);
        case 'click': return agent.click(target(action.targetId).ref).trim();
        case 'fill': return agent.fill(target(action.targetId).ref, action.value).trim();
        case 'press':
          if (!ALLOWED_KEYS.has(action.key)) throw new Error(`不支持的按键：${action.key}`);
          return agent.press(action.key).trim();
        case 'scroll': return agent.scroll(action.direction).trim();
        case 'wait': return agent.waitMs(action.milliseconds).trim();
      }
    },

    async handoff(message) {
      if (options.headless) return false;
      agent.handoff(message);
      // 后台调用沿用文件信号恢复机制，每次接管使用独立目录，避免旧信号恢复新任务。
      if (!process.stdin.isTTY) {
        const directory = await mkdtemp(join(tmpdir(), 'browser-test-handoff-'));
        const signalFile = join(directory, 'resume');
        try {
          console.log(JSON.stringify({ type: 'handoff-required', message, signalFile, resume: 'done', cancel: 'q' }));
          while (true) {
            let answer = '';
            try { answer = (await readFile(signalFile, 'utf8')).trim().toLowerCase(); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (answer === 'q') return false;
            if (['done', 'ok', '继续', '完成'].includes(answer)) {
              resume();
              return true;
            }
            await delay(250);
          }
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`需要人工操作：${message}\n完成后按 Enter 继续，输入 q 取消：`);
        if (answer.trim().toLowerCase() === 'q') return false;
        resume();
        return true;
      } finally { rl.close(); }
    },

    close() { agent.close(); },
  };
}
