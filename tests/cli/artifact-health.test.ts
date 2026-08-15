/**
 * 验证 browser-opt 临时产物阈值、终态过滤和从旧到新的清理候选计算。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatBrowserOptArtifactCleanupAdvice,
  inspectBrowserOptArtifacts,
} from '../../packages/browser-opt/dist/cli/utils/artifact-health.js';

const tempDirs: string[] = [];

interface TemporaryRunOptions {
  modifiedAtMs: number;
  sizeBytes?: number;
  handoffOutput?: string;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProjectDir(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-artifact-health-'));
  tempDirs.push(projectDir);
  return projectDir;
}

/** 创建具备稳定修改时间和可控逻辑大小的临时产物目录。 */
function createTemporaryRun(
  projectDir: string,
  kind: 'artifacts' | 'handoffs' | 'states' | 'workflows',
  name: string,
  options: TemporaryRunOptions,
): string {
  const runDir = path.join(projectDir, '.browser-opt', kind, name);
  fs.mkdirSync(runDir, { recursive: true });
  const payloadPath = path.join(runDir, 'payload.bin');
  fs.writeFileSync(payloadPath, 'x');
  if (options.sizeBytes !== undefined) {
    fs.truncateSync(payloadPath, options.sizeBytes);
  }
  if (options.handoffOutput !== undefined) {
    fs.writeFileSync(path.join(runDir, 'output.log'), options.handoffOutput);
  }
  const modifiedAt = new Date(options.modifiedAtMs);
  fs.utimesSync(runDir, modifiedAt, modifiedAt);
  return runDir;
}

describe('browser-opt artifact health', () => {
  it('does not advise cleanup at exactly ten artifact runs', () => {
    const projectDir = makeProjectDir();
    for (let index = 0; index < 10; index++) {
      createTemporaryRun(projectDir, 'artifacts', `run-${index}`, { modifiedAtMs: 1_000 + index });
    }

    expect(inspectBrowserOptArtifacts(projectDir)).toBeNull();
  });

  it('selects the oldest artifact first when the run count exceeds ten', () => {
    const projectDir = makeProjectDir();
    const runs = Array.from({ length: 11 }, (_, index) => createTemporaryRun(
      projectDir,
      'artifacts',
      `run-${String(index).padStart(2, '0')}`,
      { modifiedAtMs: 1_000 + index },
    ));

    const advice = inspectBrowserOptArtifacts(projectDir);

    expect(advice).toMatchObject({ artifactCount: 11, exceedsCountLimit: true, exceedsSizeLimit: false });
    expect(advice?.candidates.map((item) => item.path)).toEqual([runs[0]]);
  });

  it('protects the current output and uses the next oldest artifact', () => {
    const projectDir = makeProjectDir();
    const runs = Array.from({ length: 11 }, (_, index) => createTemporaryRun(
      projectDir,
      'artifacts',
      `run-${String(index).padStart(2, '0')}`,
      { modifiedAtMs: 1_000 + index },
    ));

    const advice = inspectBrowserOptArtifacts(projectDir, runs[0]);

    expect(advice?.candidates.map((item) => item.path)).toEqual([runs[1]]);
  });

  it('counts only completed handoffs toward the size threshold and excludes the current run id', () => {
    const projectDir = makeProjectDir();
    const completed = createTemporaryRun(projectDir, 'handoffs', 'completed', {
      modifiedAtMs: 1_000,
      sizeBytes: 300 * 1024 * 1024,
      handoffOutput: 'Status: FAIL\n',
    });
    createTemporaryRun(projectDir, 'handoffs', 'running', {
      modifiedAtMs: 2_000,
      sizeBytes: 300 * 1024 * 1024,
      handoffOutput: '=== Browser Opt Handoff ===\n',
    });
    createTemporaryRun(projectDir, 'handoffs', 'current', {
      modifiedAtMs: 3_000,
      sizeBytes: 300 * 1024 * 1024,
      handoffOutput: '执行成功\n',
    });
    const artifact = createTemporaryRun(projectDir, 'artifacts', 'artifact', {
      modifiedAtMs: 4_000,
      sizeBytes: 250 * 1024 * 1024,
    });

    const advice = inspectBrowserOptArtifacts(projectDir, artifact, 'current');

    expect(advice).toMatchObject({ artifactCount: 1, exceedsCountLimit: false, exceedsSizeLimit: true });
    expect(advice?.candidates.map((item) => item.path)).toEqual([completed]);
  });

  it('orders capacity candidates by modification time', () => {
    const projectDir = makeProjectDir();
    const candidates = Array.from({ length: 6 }, (_, index) => createTemporaryRun(
      projectDir,
      'handoffs',
      `handoff-${index}`,
      {
        modifiedAtMs: 1_000 + index,
        sizeBytes: 100 * 1024 * 1024,
        handoffOutput: '执行成功\n',
      },
    ));

    const advice = inspectBrowserOptArtifacts(projectDir);
    const output = advice ? formatBrowserOptArtifactCleanupAdvice(advice).join('\n') : '';

    expect(advice?.candidates.map((item) => item.path)).toEqual(candidates.slice(0, 2));
    expect(output).toContain('超过 500 MB');
    expect(output).toContain('尚未删除任何文件');
  });

  it('renders at most five oldest candidate paths', () => {
    const projectDir = makeProjectDir();
    const runs = Array.from({ length: 16 }, (_, index) => createTemporaryRun(
      projectDir,
      'artifacts',
      `run-${String(index).padStart(2, '0')}`,
      { modifiedAtMs: 1_000 + index },
    ));

    const advice = inspectBrowserOptArtifacts(projectDir);
    const output = advice ? formatBrowserOptArtifactCleanupAdvice(advice).join('\n') : '';

    expect(advice?.candidates).toHaveLength(6);
    expect(output).toContain(runs[0]);
    expect(output).toContain(runs[4]);
    expect(output).not.toContain(runs[5]);
    expect(output).toContain('另有 1 个较新候选未展开');
  });

  it('does not traverse symlink targets or inspect states and workflows', () => {
    const projectDir = makeProjectDir();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-opt-artifact-outside-'));
    tempDirs.push(outsideDir);
    const outsidePayloadPath = path.join(outsideDir, 'large.bin');
    fs.writeFileSync(outsidePayloadPath, 'x');
    fs.truncateSync(outsidePayloadPath, 600 * 1024 * 1024);
    const artifactDir = createTemporaryRun(projectDir, 'artifacts', 'artifact', { modifiedAtMs: 1_000 });
    fs.symlinkSync(outsideDir, path.join(artifactDir, 'outside-link'));
    createTemporaryRun(projectDir, 'states', 'state', { modifiedAtMs: 2_000, sizeBytes: 600 * 1024 * 1024 });
    createTemporaryRun(projectDir, 'workflows', 'workflow', { modifiedAtMs: 3_000, sizeBytes: 600 * 1024 * 1024 });

    expect(inspectBrowserOptArtifacts(projectDir)).toBeNull();
  });
});
