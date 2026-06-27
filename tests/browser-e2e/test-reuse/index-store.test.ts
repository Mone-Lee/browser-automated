import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  loadGeneratedTestIndex,
  saveGeneratedTestIndex,
  upsertGeneratedTestMeta,
} from '../../../src/browser-e2e/test-reuse/index-store.js';

describe('generated test index store', () => {
  it('loads empty index when file does not exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    const indexPath = path.join(tempDir, 'index.json');

    const index = loadGeneratedTestIndex(indexPath);
    expect(index.tests).toHaveLength(0);
  });

  it('upserts metadata and persists to disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    const indexPath = path.join(tempDir, 'index.json');

    saveGeneratedTestIndex({ version: 1, tests: [] }, indexPath);

    const next = upsertGeneratedTestMeta(
      {
        id: 'abc',
        name: 'pricing flow',
        filePath: 'tests/generated/pricing-flow.spec.ts',
        url: 'https://example.com',
        tags: ['pricing'],
        nlHints: ['open pricing page'],
        fingerprint: 'fp-abc',
        createdAt: new Date().toISOString(),
      },
      indexPath,
    );

    expect(next.tests).toHaveLength(1);
    expect(next.tests[0].id).toBe('abc');
  });
});
