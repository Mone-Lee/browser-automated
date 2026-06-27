import { describe, it, expect } from 'vitest';
import { findMatches, scoreMatch } from '../../../src/browser-e2e/test-reuse/matcher.js';
import type { GeneratedTestMeta } from '../../../src/browser-e2e/test-reuse/types.js';

const tests: GeneratedTestMeta[] = [
  {
    id: 'a',
    name: 'pricing contact flow',
    filePath: 'tests/generated/pricing-contact-flow.spec.ts',
    url: 'https://example.com',
    tags: ['pricing', 'contact', 'navigation'],
    nlHints: ['open pricing page', 'go to contact form'],
    fingerprint: 'fpa',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'b',
    name: 'login flow',
    filePath: 'tests/generated/login-flow.spec.ts',
    url: 'https://example.com',
    tags: ['login', 'auth'],
    nlHints: ['sign in with user and password'],
    fingerprint: 'fpb',
    createdAt: new Date().toISOString(),
  },
];

describe('skills matcher', () => {
  it('returns higher score for close keyword match', () => {
    const scoreA = scoreMatch('go to pricing and open contact', tests[0]);
    const scoreB = scoreMatch('go to pricing and open contact', tests[1]);
    expect(scoreA).toBeGreaterThan(scoreB);
  });

  it('returns sorted candidates and best match', () => {
    const result = findMatches('open pricing page and contact', tests);
    expect(result.best?.test.id).toBe('a');
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
  });
});
