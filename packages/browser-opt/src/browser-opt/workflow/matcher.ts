/**
 * 为已保存 Workflow 提供中文友好的名称匹配和稳定候选排序。
 * 匹配只使用 Workflow 名称，避免流程正文中的通用网页词汇制造误命中。
 */
import type {
  BrowserOptWorkflow,
  BrowserOptWorkflowCandidate,
  BrowserOptWorkflowMatchResult,
} from './type.js';

const MIN_MATCH_SCORE = 0.45;
const DIRECT_MATCH_SCORE = 0.88;
const MAX_AMBIGUOUS_CANDIDATES = 3;
const LEADING_INTENT_RE = /^(?:请|麻烦|帮我|我要|我想要|现在)*(?:执行|运行|调用|启动|开始|打开)+/u;

/** 将 Skill 调用语句归一化为适合中英文共同匹配的连续文本。 */
export function normalizeBrowserOptWorkflowQuery(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^\/?browser-opt\b/iu, '')
    .trim()
    .replace(LEADING_INTENT_RE, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** 精确或足够强的唯一候选可直接执行；弱相似候选只返回给调用方确认。 */
export function matchBrowserOptWorkflows(
  query: string,
  workflows: BrowserOptWorkflow[],
): BrowserOptWorkflowMatchResult {
  const normalizedQuery = normalizeBrowserOptWorkflowQuery(query);
  const available = [...workflows].sort(compareWorkflows);
  if (!normalizedQuery) {
    return { status: 'not-found', matched: null, candidates: [], available };
  }

  const queryBigrams = toBigrams(normalizedQuery);
  const queryTokens = toTokens(query);
  const scored = workflows
    .map((workflow) => ({
      workflow,
      score: scoreNormalizedWorkflow(
        normalizedQuery,
        queryBigrams,
        queryTokens,
        workflow,
      ),
    }))
    .filter((candidate) => candidate.score >= MIN_MATCH_SCORE)
    .sort(compareCandidates);
  const exact = scored.find((candidate) =>
    normalizeBrowserOptWorkflowQuery(candidate.workflow.name) === normalizedQuery);

  if (exact) {
    return { status: 'matched', matched: exact, candidates: [exact], available };
  }
  if (scored.length === 1) {
    if (scored[0].score >= DIRECT_MATCH_SCORE) {
      return { status: 'matched', matched: scored[0], candidates: scored, available };
    }
    return { status: 'ambiguous', matched: null, candidates: scored, available };
  }
  if (scored.length > 1) {
    return {
      status: 'ambiguous',
      matched: null,
      candidates: scored.slice(0, MAX_AMBIGUOUS_CANDIDATES),
      available,
    };
  }
  return { status: 'not-found', matched: null, candidates: [], available };
}

/** 名称包含是强信号，字符 bigram 与英文 token 重叠负责短句和轻微差异兜底。 */
export function scoreBrowserOptWorkflow(query: string, workflow: BrowserOptWorkflow): number {
  const normalizedQuery = normalizeBrowserOptWorkflowQuery(query);
  return scoreNormalizedWorkflow(normalizedQuery, toBigrams(normalizedQuery), toTokens(query), workflow);
}

/** 复用查询侧归一化结果，避免候选较多时为每个 Workflow 重复拆词。 */
function scoreNormalizedWorkflow(
  normalizedQuery: string,
  queryBigrams: Set<string>,
  queryTokens: Set<string>,
  workflow: BrowserOptWorkflow,
): number {
  const normalizedName = normalizeBrowserOptWorkflowQuery(workflow.name);
  if (!normalizedQuery || !normalizedName) {
    return 0;
  }
  if (normalizedQuery === normalizedName) {
    return 1;
  }

  const containment = normalizedQuery.includes(normalizedName) || normalizedName.includes(normalizedQuery) ? 0.9 : 0;
  const bigramScore = diceCoefficient(queryBigrams, toBigrams(normalizedName));
  const tokenScore = jaccard(queryTokens, toTokens(workflow.name));
  return Math.min(1, Math.max(containment, bigramScore * 0.75 + tokenScore * 0.25));
}

function toBigrams(value: string): Set<string> {
  if (value.length < 2) {
    return new Set(value ? [value] : []);
  }
  const values = Array.from(value);
  return new Set(values.slice(0, -1).map((character, index) => `${character}${values[index + 1]}`));
}

function toTokens(value: string): Set<string> {
  return new Set(
    value.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9]{2,}/g) ?? [],
  );
}

function diceCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (left.size + right.size);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const union = new Set([...left, ...right]);
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) {
      overlap += 1;
    }
  }
  return overlap / union.size;
}

function compareCandidates(left: BrowserOptWorkflowCandidate, right: BrowserOptWorkflowCandidate): number {
  return right.score - left.score || compareWorkflows(left.workflow, right.workflow);
}

function compareWorkflows(left: BrowserOptWorkflow, right: BrowserOptWorkflow): number {
  return left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id, 'zh-CN');
}
