/**
 * 读写生成测试索引，供 browser-e2e 根据自然语言命中已有 Playwright 测试。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GeneratedTestIndex, GeneratedTestMeta } from './types.js';

export const DEFAULT_INDEX_PATH = path.resolve(process.cwd(), 'tests/generated/index.json');

export function loadGeneratedTestIndex(indexPath: string = DEFAULT_INDEX_PATH): GeneratedTestIndex {
  if (!fs.existsSync(indexPath)) {
    return { version: 1, tests: [] };
  }

  const raw = fs.readFileSync(indexPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<GeneratedTestIndex>;

  if (parsed.version !== 1 || !Array.isArray(parsed.tests)) {
    throw new Error(`Invalid generated test index format: ${indexPath}`);
  }

  return {
    version: 1,
    tests: parsed.tests,
  };
}

export function saveGeneratedTestIndex(
  index: GeneratedTestIndex,
  indexPath: string = DEFAULT_INDEX_PATH,
): void {
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
}

export function upsertGeneratedTestMeta(
  meta: GeneratedTestMeta,
  indexPath: string = DEFAULT_INDEX_PATH,
): GeneratedTestIndex {
  const index = loadGeneratedTestIndex(indexPath);
  const existing = index.tests.findIndex((t) => t.id === meta.id || t.fingerprint === meta.fingerprint);

  if (existing >= 0) {
    index.tests[existing] = meta;
  } else {
    index.tests.push(meta);
  }

  saveGeneratedTestIndex(index, indexPath);
  return index;
}
