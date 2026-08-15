/**
 * 检查当前项目 browser-opt 临时产物的数量与容量，并生成只读清理建议。
 * 该模块只处理可重建的运行证据与已结束 handoff，不接触登录态和 Workflow。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface BrowserOptArtifactItem {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
}

export interface BrowserOptArtifactCleanupAdvice {
  artifactCount: number;
  totalSizeBytes: number;
  exceedsCountLimit: boolean;
  exceedsSizeLimit: boolean;
  candidates: BrowserOptArtifactItem[];
  remainingSizeBytes: number;
}

const ARTIFACT_COUNT_LIMIT = 10;
const TEMPORARY_SIZE_LIMIT_BYTES = 500 * 1024 * 1024;
const DEFAULT_DATA_DIR = '.browser-opt';

/**
 * 检查项目内临时产物；任何读取异常都按不可安全建议删除处理，不影响原任务结果。
 */
export function inspectBrowserOptArtifacts(
  projectDir: string,
  currentOutputDir?: string,
  currentHandoffRunId?: string,
): BrowserOptArtifactCleanupAdvice | null {
  try {
    const dataDir = path.resolve(projectDir, DEFAULT_DATA_DIR);
    const artifacts = collectArtifactItems(path.join(dataDir, 'artifacts'));
    const handoffs = collectCompletedHandoffItems(path.join(dataDir, 'handoffs'), currentHandoffRunId);
    const totalSizeBytes = [...artifacts, ...handoffs].reduce((total, item) => total + item.sizeBytes, 0);
    const exceedsCountLimit = artifacts.length > ARTIFACT_COUNT_LIMIT;
    const exceedsSizeLimit = totalSizeBytes > TEMPORARY_SIZE_LIMIT_BYTES;
    if (!exceedsCountLimit && !exceedsSizeLimit) {
      return null;
    }

    const protectedOutputDir = currentOutputDir ? path.resolve(currentOutputDir) : undefined;
    const removableArtifacts = artifacts.filter((item) => item.path !== protectedOutputDir);
    const candidates: BrowserOptArtifactItem[] = [];
    const selectedPaths = new Set<string>();
    let remainingSizeBytes = totalSizeBytes;

    const requiredArtifactDeletions = Math.max(0, artifacts.length - ARTIFACT_COUNT_LIMIT);
    for (const item of removableArtifacts.slice(0, requiredArtifactDeletions)) {
      candidates.push(item);
      selectedPaths.add(item.path);
      remainingSizeBytes -= item.sizeBytes;
    }

    if (remainingSizeBytes > TEMPORARY_SIZE_LIMIT_BYTES) {
      const remainingItems = [...removableArtifacts, ...handoffs]
        .filter((item) => !selectedPaths.has(item.path))
        .sort(compareArtifactItems);
      for (const item of remainingItems) {
        candidates.push(item);
        remainingSizeBytes -= item.sizeBytes;
        if (remainingSizeBytes <= TEMPORARY_SIZE_LIMIT_BYTES) {
          break;
        }
      }
    }

    return {
      artifactCount: artifacts.length,
      totalSizeBytes,
      exceedsCountLimit,
      exceedsSizeLimit,
      candidates: candidates.sort(compareArtifactItems),
      remainingSizeBytes: Math.max(0, remainingSizeBytes),
    };
  } catch {
    return null;
  }
}

/** 按一级目录收集每次运行的证据，目录时间相同时使用绝对路径稳定排序。 */
function collectArtifactItems(artifactsDir: string): BrowserOptArtifactItem[] {
  return collectChildDirectories(artifactsDir)
    .map(createArtifactItem)
    .filter((item): item is BrowserOptArtifactItem => Boolean(item))
    .sort(compareArtifactItems);
}

/** 只收集输出中已经出现 PASS 或 FAIL 终态的 handoff 目录。 */
function collectCompletedHandoffItems(handoffsDir: string, currentRunId?: string): BrowserOptArtifactItem[] {
  return collectChildDirectories(handoffsDir)
    .filter((entryPath) => path.basename(entryPath) !== currentRunId)
    .filter((entryPath) => hasTerminalHandoffOutput(path.join(entryPath, 'output.log')))
    .map(createArtifactItem)
    .filter((item): item is BrowserOptArtifactItem => Boolean(item))
    .sort(compareArtifactItems);
}

function collectChildDirectories(parentDir: string): string[] {
  try {
    return fs.readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.resolve(parentDir, entry.name));
  } catch {
    return [];
  }
}

function createArtifactItem(entryPath: string): BrowserOptArtifactItem | null {
  try {
    const stat = fs.lstatSync(entryPath);
    return {
      path: entryPath,
      sizeBytes: directorySize(entryPath),
      modifiedAtMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

/** 递归统计普通文件大小；符号链接只计算链接本身且绝不继续遍历目标。 */
function directorySize(entryPath: string): number {
  try {
    const stat = fs.lstatSync(entryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return stat.size;
    }
    return fs.readdirSync(entryPath).reduce(
      (total, name) => total + directorySize(path.join(entryPath, name)),
      0,
    );
  } catch {
    return 0;
  }
}

function hasTerminalHandoffOutput(outputPath: string): boolean {
  try {
    const output = fs.readFileSync(outputPath, 'utf-8');
    return /(?:^|\n)执行成功(?:\n|$)/.test(output) || /(?:^|\n)Status: (?:PASS|FAIL)(?:\n|$)/.test(output);
  } catch {
    return false;
  }
}

function compareArtifactItems(left: BrowserOptArtifactItem, right: BrowserOptArtifactItem): number {
  return left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path);
}

/** 把产物检查结果渲染为简短、可直接操作但不自动执行的删除建议。 */
export function formatBrowserOptArtifactCleanupAdvice(advice: BrowserOptArtifactCleanupAdvice): string[] {
  const reasons = [
    ...(advice.exceedsCountLimit ? [`运行产物 ${advice.artifactCount} 份，超过 10 份`] : []),
    ...(advice.exceedsSizeLimit ? [`临时产物总量 ${formatBytes(advice.totalSizeBytes)}，超过 500 MB`] : []),
  ];
  const shownCandidates = advice.candidates.slice(0, 5);
  const reclaimableBytes = advice.candidates.reduce((total, item) => total + item.sizeBytes, 0);
  const lines = [
    `产物清理建议：${reasons.join('；')}。以下仅为建议，尚未删除任何文件。`,
    ...(shownCandidates.length > 0
      ? [
        `建议从最旧产物开始删除，预计可释放 ${formatBytes(reclaimableBytes)}：`,
        ...shownCandidates.map((item) => `  - ${item.path}（${formatBytes(item.sizeBytes)}）`),
      ]
      : ['没有可安全建议删除的旧产物。']),
  ];
  if (advice.candidates.length > shownCandidates.length) {
    lines.push(`  - 另有 ${advice.candidates.length - shownCandidates.length} 个较新候选未展开`);
  }
  if (advice.remainingSizeBytes > TEMPORARY_SIZE_LIMIT_BYTES) {
    lines.push('删除上述旧产物后仍可能超过 500 MB，请审阅本次运行证据后再决定是否手动删除。');
  }
  return lines;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(2)} KB`;
  }
  return `${sizeBytes} B`;
}
