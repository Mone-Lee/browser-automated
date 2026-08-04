/**
 * 根据关键词、标签和自然语言 hints 为已有生成测试计算匹配候选。
 */
import type { GeneratedTestMeta, MatchCandidate, MatchResult } from './types.js';

const TOKEN_SEPARATOR = /[^a-z0-9]+/i;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SEPARATOR)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function uniqueTokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

function scoreKeyword(query: string, test: GeneratedTestMeta): number {
  const normalized = query.toLowerCase();
  const bag = [test.name, ...test.tags, ...test.nlHints].map((v) => v.toLowerCase());

  let hits = 0;
  for (const item of bag) {
    if (item.includes(normalized) || normalized.includes(item)) {
      hits += 1;
    }
  }

  if (hits === 0) {
    return 0;
  }

  return Math.min(1, hits / Math.max(1, bag.length / 2));
}

function scoreSemantic(query: string, test: GeneratedTestMeta): number {
  const queryTokens = uniqueTokens(query);
  if (queryTokens.size === 0) {
    return 0;
  }

  const targetTokens = uniqueTokens([test.name, ...test.tags, ...test.nlHints].join(' '));
  if (targetTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) {
      overlap += 1;
    }
  }

  const union = new Set([...queryTokens, ...targetTokens]).size;
  return union === 0 ? 0 : overlap / union;
}

export function scoreMatch(query: string, test: GeneratedTestMeta): number {
  const keywordScore = scoreKeyword(query, test);
  const semanticScore = scoreSemantic(query, test);

  // 关键词是强信号，语义 token 重叠只作为兜底信号。
  return Math.min(1, keywordScore * 0.7 + semanticScore * 0.3);
}

export function findMatches(query: string, tests: GeneratedTestMeta[]): MatchResult {
  const candidates: MatchCandidate[] = tests
    .map((test) => ({ test, score: scoreMatch(query, test) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return {
    best: candidates.length > 0 ? candidates[0] : null,
    candidates,
  };
}
