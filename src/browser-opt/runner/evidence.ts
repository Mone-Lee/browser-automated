/**
 * browser-opt 证据采集工具，负责 snapshot 落盘、临时快照和初始页面稳定等待。
 * 这些函数不判断业务语义，只为执行层提供一致的页面证据。
 */
import * as fs from 'node:fs';
import type { BrowserAgent } from '../../core/agent.js';
import type { SnapshotEvidence } from '../type.js';
import { countSnapshotNodes, snapshotText } from '../utils.js';

interface CaptureSettledSnapshotOptions {
  reloadAfterBlank?: boolean;
  targetUrl?: string;
}

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

/** 打开页面后短暂等待空白初始页退场，必要时刷新一次，避免卡在 SPA 半初始化状态。 */
export function captureSettledSnapshot(
  agent: BrowserAgent,
  filePath: string,
  logs: string[],
  options: CaptureSettledSnapshotOptions = {},
): SnapshotEvidence {
  let snapshot = captureSnapshot(agent, filePath);
  let blankWaits = 0;
  for (let attempt = 1; attempt <= 5 && isBlankInitialSnapshot(snapshot); attempt += 1) {
    blankWaits = attempt;
    logs.push(`open-wait ${attempt}: snapshot 仍为空白页，等待页面接管后重试。`);
    agent.waitMs(500);
    snapshot = captureSnapshot(agent, filePath);
  }
  snapshot = recoverNonBlankTab(agent, snapshot, filePath, logs, options.targetUrl);
  if (blankWaits > 0 && options.reloadAfterBlank) {
    logs.push(`open-reload: 初始打开经历空白页，刷新一次避免停留在半初始化页面。`);
    agent.reload();
    agent.waitMs(500);
    snapshot = captureSnapshot(agent, filePath);
    for (let attempt = 1; attempt <= 5 && isBlankInitialSnapshot(snapshot); attempt += 1) {
      logs.push(`open-reload-wait ${attempt}: 刷新后 snapshot 仍为空白页，继续短暂等待。`);
      agent.waitMs(500);
      snapshot = captureSnapshot(agent, filePath);
    }
    snapshot = recoverNonBlankTab(agent, snapshot, filePath, logs, options.targetUrl);
  }
  return snapshot;
}

export function isBlankInitialSnapshot(snapshot: SnapshotEvidence): boolean {
  return snapshot.nodeCount === 0 && snapshot.text.trim() === '(no interactive elements)';
}

/** 空白活动页持续不退场时，尝试切换到同一会话中已经打开的业务页或登录页。 */
function recoverNonBlankTab(
  agent: BrowserAgent,
  snapshot: SnapshotEvidence,
  filePath: string,
  logs: string[],
  targetUrl?: string,
): SnapshotEvidence {
  if (!isBlankInitialSnapshot(snapshot) || !isAboutBlankUrl(readCurrentUrl(agent))) {
    return snapshot;
  }

  try {
    const tabs = agent.getTabs().filter((tab) => tab.type === 'page' && !isAboutBlankUrl(tab.url));
    const targetOrigin = targetUrl ? readOrigin(targetUrl) : '';
    const targetTab = tabs.find((tab) => targetOrigin && readOrigin(tab.url) === targetOrigin) ?? tabs.at(-1);
    if (!targetTab) {
      logs.push('open-tab-recovery: 当前会话没有可切换的非空页面。');
      return snapshot;
    }

    logs.push(`open-tab-recovery: 当前活动页为 about:blank，切换到标签页 ${targetTab.tabId} (${targetTab.url})。`);
    agent.switchTab(targetTab.tabId);
    agent.waitMs(250);
    return captureSnapshot(agent, filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs.push(`open-tab-recovery: 标签页恢复失败：${message}`);
    return snapshot;
  }
}

/** 判断证据与浏览器当前地址是否都表明页面仍停留在初始空白页。 */
export function isAboutBlankOpen(agent: BrowserAgent, snapshot: SnapshotEvidence): boolean {
  if (!isBlankInitialSnapshot(snapshot)) {
    return false;
  }

  const data = snapshot.output.data as { data?: { origin?: unknown } } | null;
  const snapshotOrigin = data?.data?.origin;
  return snapshotOrigin === 'about:blank' || isAboutBlankUrl(readCurrentUrl(agent));
}

function readCurrentUrl(agent: BrowserAgent): string {
  try {
    return agent.getUrl();
  } catch {
    return '';
  }
}

function isAboutBlankUrl(value: string): boolean {
  return value.trim().toLowerCase() === 'about:blank';
}

function readOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
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
