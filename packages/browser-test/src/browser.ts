/**
 * browser-test 与浏览器之间的唯一适配层：采集观测（快照、URL、页面文本、表格行、截图）并把合法的原子动作映射为 agent-browser 命令。
 * 执行器只依赖 BrowserPort 接口，因此校验、预算等逻辑可以脱离真实浏览器验证；这里不做任何门禁判断。
 */
import { createInterface } from 'node:readline/promises';
import { createBrowserAgent, type BrowserAgent } from '#browser-core/agent';
import type { AtomicAction, Observation, ObservationTarget } from './types.js';

export interface BrowserPort {
  /** 采集一次观测；shotPath 给出时同时截图。 */
  observe(id: string, shotPath?: string): Observation;
  /** 执行一个已通过门禁的动作，返回命令输出摘要。 */
  act(action: AtomicAction, observation: Observation): string;
  /** 暂停自动执行等待人工操作；返回 false 表示无法接管（非交互或已取消）。 */
  handoff(message: string): Promise<boolean>;
  close(): void;
}

export interface BrowserPortOptions {
  /** 无头模式下无法人工接管。 */
  headless: boolean;
  /** 单条命令的超时（毫秒）。 */
  timeoutMs: number;
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

/** 基于 BrowserAgent 创建浏览器端口；可见窗口默认开启以便登录等人工接管。 */
export function createBrowserPort(options: BrowserPortOptions, agent: BrowserAgent = createBrowserAgent({
  headed: !options.headless, headless: options.headless, openLiveDashboard: false, timeout: options.timeoutMs,
})): BrowserPort {
  return {
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
      return {
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
    },

    act(action, observation) {
      const target = (targetId: string): ObservationTarget => {
        const found = observation.targets.find(item => item.id === targetId);
        if (!found) throw new Error(`目标 ${targetId} 不在观测 ${observation.id} 中`);
        return found;
      };
      switch (action.type) {
        case 'open': return agent.open(action.url).trim();
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
      if (options.headless || !process.stdin.isTTY) return false;
      agent.handoff(message);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(`需要人工操作：${message}\n完成后按 Enter 继续，输入 q 取消：`);
        if (answer.trim().toLowerCase() === 'q') return false;
        agent.resume();
        return true;
      } finally { rl.close(); }
    },

    close() { agent.close(); },
  };
}
