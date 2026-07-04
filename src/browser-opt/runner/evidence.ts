/**
 * browser-opt 证据采集工具，负责 snapshot 落盘、临时快照和初始页面稳定等待。
 * 这些函数不判断业务语义，只为执行层提供一致的页面证据。
 */
import * as fs from 'node:fs';
import type { BrowserAgent } from '../../core/agent.js';
import type { SnapshotEvidence } from '../type.js';
import { countSnapshotNodes, snapshotText } from '../utils.js';

/** 采集一份机器可读快照并同时落盘，供动作匹配与报告复用。 */
export function captureSnapshot(agent: BrowserAgent, filePath: string): SnapshotEvidence {
  const output = agent.snapshotJson();
  fs.writeFileSync(filePath, JSON.stringify(output.data ?? { raw: output.raw, parseError: output.parseError }, null, 2));
  return {
    output,
    text: snapshotText(output),
    nodeCount: countSnapshotNodes(output.data),
  };
}

/** 仅供动作内部临时判断使用的快照，不落盘，避免打乱步骤证据文件命名。 */
export function captureTransientSnapshot(agent: BrowserAgent): SnapshotEvidence {
  const output = agent.snapshotJson();
  return {
    output,
    text: snapshotText(output),
    nodeCount: countSnapshotNodes(output.data),
  };
}

/** 打开页面后等待空白初始页退场，避免把 about:blank 误判成目标页面状态。 */
export function captureSettledSnapshot(agent: BrowserAgent, filePath: string, logs: string[]): SnapshotEvidence {
  let snapshot = captureSnapshot(agent, filePath);
  for (let attempt = 1; attempt <= 5 && isBlankInitialSnapshot(snapshot); attempt += 1) {
    logs.push(`open-wait ${attempt}: snapshot 仍为空白页，等待页面接管后重试。`);
    agent.waitMs(500);
    snapshot = captureSnapshot(agent, filePath);
  }
  return snapshot;
}

function isBlankInitialSnapshot(snapshot: SnapshotEvidence): boolean {
  const origin = findStringProperty(snapshot.output.data, 'origin');
  return snapshot.nodeCount === 0 && snapshot.text.trim() === '(no interactive elements)' && (!origin || origin === 'about:blank');
}

function findStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string') {
    return record[key] as string;
  }

  for (const entry of Object.values(record)) {
    const found = findStringProperty(entry, key);
    if (found) {
      return found;
    }
  }

  return null;
}

export function normalizeUrlForCompare(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim().replace(/\/$/, '');
  }
}
