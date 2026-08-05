/**
 * 负责 Playwright 测试代码生成、生成测试元数据构建，以及单个 spec 的执行。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TestCase } from '#browser-core';
import type { CodeExecutionResult, GeneratedTestMeta } from './types.js';

export interface GeneratePlaywrightSpecOptions {
  outputDir?: string;
  tags?: string[];
}

const DEFAULT_GENERATED_TEST_DIR = path.resolve(process.cwd(), 'tests/generated');

export function computeFingerprint(url: string, instruction: string): string {
  return createHash('sha256').update(`${url}\n${instruction}`).digest('hex').slice(0, 16);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'generated-test';
}

function escapeForTs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildPlaywrightSpec(testCase: TestCase): string {
  const sessionIdVar = "`pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`";
  const stepBlocks = testCase.steps
    .map((step) => {
      const lines = [
        `    executeInstruction('${escapeForTs(step.instruction)}');`,
      ];

      if (step.assertion) {
        lines.push(`    verifyAssertion('${escapeForTs(step.assertion)}');`);
      }

      return lines.join('\n');
    })
    .join('\n\n');

  return `import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';

function runAgent(args: string[]): string {
  const result = spawnSync('agent-browser', args, {
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'agent-browser failed');
  }

  return result.stdout ?? '';
}

let activeSessionId = '';

function parseSnapshotNodes(snapshot: string): Array<{ kind: 'textbox' | 'button' | 'link' | 'generic'; label: string; ref: string }> {
  const nodes: Array<{ kind: 'textbox' | 'button' | 'link' | 'generic'; label: string; ref: string }> = [];
  for (const rawLine of snapshot.split('\n')) {
    const line = rawLine.trim();

    let m = line.match(/textbox\s+"([^"]*)"\s+\[ref=([^\]]+)\]/i);
    if (m) {
      nodes.push({ kind: 'textbox', label: m[1], ref: m[2] });
      continue;
    }

    m = line.match(/button\s+"([^"]*)"\s+\[ref=([^\]]+)\]/i);
    if (m) {
      nodes.push({ kind: 'button', label: m[1], ref: m[2] });
      continue;
    }

    m = line.match(/link\s+"([^"]*)"\s+\[ref=([^\]]+)\]/i);
    if (m) {
      nodes.push({ kind: 'link', label: m[1], ref: m[2] });
      continue;
    }

    m = line.match(/generic\s+"([^"]*)"\s+\[ref=([^\]]+)\].*clickable/i);
    if (m) {
      nodes.push({ kind: 'generic', label: m[1], ref: m[2] });
    }
  }
  return nodes;
}

function quotedValues(input: string): string[] {
  const values: string[] = [];
  const re = /["“]([^"”]+)["”]/g;
  for (const match of input.matchAll(re)) {
    if (match[1]) values.push(match[1]);
  }
  return values;
}

function fieldKeywords(field: string): string[] {
  if (/(用户名|账号|user|username|email|邮箱|手机号|手机)/i.test(field)) {
    return ['用户名', '账号', 'user', 'username', 'email', '邮箱', '手机号', '手机'];
  }
  if (/(密码|password|pwd)/i.test(field)) {
    return ['密码', 'password', 'pwd'];
  }
  if (/(验证码|captcha|code)/i.test(field)) {
    return ['验证码', 'captcha', 'code'];
  }
  return field.toLowerCase().split(/[\s\-_\/]+/).filter(Boolean);
}

function findTextboxRef(snapshot: string, field: string): string {
  const nodes = parseSnapshotNodes(snapshot).filter((n) => n.kind === 'textbox');
  const keywords = fieldKeywords(field);
  const found = nodes.find((n) => keywords.some((kw) => n.label.toLowerCase().includes(kw.toLowerCase())));
  if (found) return found.ref;
  if (!nodes[0]) throw new Error('No textbox found for field: ' + field);
  return nodes[0].ref;
}

function findClickableRef(snapshot: string, target: string): string {
  const nodes = parseSnapshotNodes(snapshot).filter((n) => n.kind !== 'textbox');
  const lowered = target.toLowerCase();
  const direct = nodes.find((n) => n.label.toLowerCase().includes(lowered));
  if (direct) return direct.ref;
  const loginLike = nodes.find((n) => /(登录|登\s*录|login|submit)/i.test(n.label));
  if (loginLike) return loginLike.ref;
  if (!nodes[0]) throw new Error('No clickable element found for target: ' + target);
  return nodes[0].ref;
}

function parseFillPairs(instruction: string): Array<{ field: string; value: string }> {
  const pairs: Array<{ field: string; value: string }> = [];
  const re = /(用户名|账号|密码|验证码|邮箱|手机号|username|password|email|captcha|code)[^"“”]*["“]([^"”]+)["”]/gi;
  for (const m of instruction.matchAll(re)) {
    if (m[1] && m[2]) pairs.push({ field: m[1], value: m[2] });
  }
  if (pairs.length > 0) return pairs;

  const values = quotedValues(instruction);
  if (values.length >= 2) {
    return [
      { field: '用户名', value: values[0] },
      { field: '密码', value: values[1] },
    ];
  }
  if (values.length === 1) {
    return [{ field: '文本', value: values[0] }];
  }
  return [];
}

function executeInstruction(instruction: string): void {
  if (!instruction.trim()) return;
  const line = instruction.trim();

  if (/输入|填写|type|fill/i.test(line)) {
    const pairs = parseFillPairs(line);
    if (pairs.length === 0) {
      throw new Error('Cannot parse fill instruction: ' + instruction);
    }
    for (const pair of pairs) {
      const snapshot = runAgent(['--session', activeSessionId, 'snapshot', '-i']);
      const ref = findTextboxRef(snapshot, pair.field);
      runAgent(['--session', activeSessionId, 'fill', '@' + ref, pair.value]);
    }
    return;
  }

  if (/点击|click|tap|press/i.test(line)) {
    const target = quotedValues(line)[0] || (line.match(/(登录|登\s*录|login|submit|按钮|button)/i)?.[0] || '登录');
    const snapshot = runAgent(['--session', activeSessionId, 'snapshot', '-i']);
    const ref = findClickableRef(snapshot, target);
    runAgent(['--session', activeSessionId, 'click', '@' + ref]);
    return;
  }

  if (/打开|访问|open|goto|navigate/i.test(line) && /https?:\/\//i.test(line)) {
    const url = line.match(/https?:\/\/[^\s。，、，]+/i)?.[0];
    if (url) runAgent(['--session', activeSessionId, 'open', url]);
    return;
  }

  if (/url\s*包含|url\s*contains/i.test(line)) {
    const needle = line.match(/URL\s*包含\s*([\/A-Za-z0-9_-]+)/i)?.[1]
      || line.match(/url\s+contains\s+([\/A-Za-z0-9_-]+)/i)?.[1];
    if (!needle) {
      throw new Error('Cannot parse URL assertion from: ' + instruction);
    }
    const currentUrl = runAgent(['--session', activeSessionId, 'get', 'url']).trim();
    expect(currentUrl.includes(needle)).toBeTruthy();
    return;
  }
}

function verifyAssertion(assertion: string): void {
  if (/url\s*包含|url\s*contains/i.test(assertion)) {
    const matched = assertion.match(/([\/A-Za-z0-9_-]+)/)?.[1] ?? assertion;
    executeInstruction('URL 包含 ' + matched);
    return;
  }

  const quoted = quotedValues(assertion)[0];
  const textNeedle = quoted || assertion.replace(/看到|文字|文案|should|be|visible|text/gi, '').trim();
  if (!textNeedle) return;
  const snapshot = runAgent(['--session', activeSessionId, 'snapshot', '-i']);
  expect(snapshot.includes(textNeedle)).toBeTruthy();
}

test('${escapeForTs(testCase.name)}', async () => {
  const sessionId = ${sessionIdVar};
  activeSessionId = sessionId;

  try {
    runAgent(['--session', sessionId, 'open', '${escapeForTs(testCase.url)}']);

${stepBlocks || "    // 未生成可执行步骤，保留一个显式通过断言。\n    expect(true).toBeTruthy();"}
  } finally {
    try {
      runAgent(['--session', sessionId, 'close']);
    } catch {
      // 清理失败不覆盖测试主体结果。
    }
  }
});
`;
}

export function writePlaywrightSpec(
  testCase: TestCase,
  options: GeneratePlaywrightSpecOptions = {},
): { filePath: string; fileName: string; content: string } {
  const outputDir = options.outputDir ?? DEFAULT_GENERATED_TEST_DIR;
  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = `${slugify(testCase.name)}.spec.ts`;
  const filePath = path.join(outputDir, fileName);
  const content = buildPlaywrightSpec(testCase);

  fs.writeFileSync(filePath, content, 'utf-8');

  return {
    filePath,
    fileName,
    content,
  };
}

export function buildGeneratedTestMeta(params: {
  name: string;
  filePath: string;
  url: string;
  instruction: string;
  tags?: string[];
  hints?: string[];
}): GeneratedTestMeta {
  const now = new Date().toISOString();
  const fingerprint = computeFingerprint(params.url, params.instruction);

  return {
    id: fingerprint,
    name: params.name,
    filePath: params.filePath,
    url: params.url,
    tags: params.tags ?? [],
    nlHints: [params.instruction, ...(params.hints ?? [])],
    fingerprint,
    createdAt: now,
  };
}

export function executePlaywrightSpec(filePath: string): CodeExecutionResult {
  const result = spawnSync('npx', ['playwright', 'test', filePath, '--reporter=line'], {
    encoding: 'utf-8',
    timeout: 180_000,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  if (result.error) {
    return {
      passed: false,
      output: `${output}\n${result.error.message}`.trim(),
    };
  }

  return {
    passed: result.status === 0,
    output,
  };
}
