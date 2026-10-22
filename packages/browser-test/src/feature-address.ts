/** 管理生成阶段的页面地址确认与复用；只读取指定目录的已确认用例，不访问页面或推测路由。 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatureDraft, DraftScenario } from './feature-gen.js';

/** 页面身份来自原文或用户确认；空应用或页面不能用于跨场景复用，环境为空表示未区分环境。 */
export interface PageVisit {
  application: string;
  page: string;
  environment?: string;
  url?: string;
  source?: string;
}

/** 编号以当前草案中的首个场景序号为准，一次确认作用于同一明确页面的全部缺失地址。 */
export interface AddressRequest {
  id: string;
  visit: PageVisit;
  scenarios: DraftScenario[];
  candidates: { url: string; source: string }[];
}

/** 只接受可直接访问的 HTTP(S) 完整地址，保留用户原始字符串，不拼接或改写路径。 */
export function validAddress(value: unknown): value is string {
  if (typeof value !== 'string' || /[\s\u0000-\u001f]/u.test(value)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname; } catch { return false; }
}

/** 页面身份按明确文本匹配；未知身份不共享，避免同名页面或未知环境串用。 */
function key(visit: PageVisit): string | undefined {
  return visit.page ? JSON.stringify([visit.application ?? '', visit.page, visit.environment ?? '']) : undefined;
}

/** 兼容已有步骤：只提取明确登录应用和进入页面的常见句式；复杂描述留给用户确认。 */
export function inferVisit(scenario: DraftScenario): PageVisit {
  const text = scenario.steps.filter(step => !step.todo).map(step => step.text).join('\n');
  const application = /(?:已登录|登录)\s*([^\n，。,；;]+)/u.exec(text)?.[1]?.trim() ?? '';
  const page = /(?:进入|打开)\s*([^\n，。,；;]+)/u.exec(text)?.[1]?.replace(/^[【「]|[】」]$/gu, '').trim() ?? '';
  const environment = /(?:运行环境|访问环境|环境)(?:为|是|：|:)\s*([^\n，。,；;]+)/u.exec(text)?.[1]?.trim();
  const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>，。；【】「」]+/gu) ?? [])].filter(validAddress);
  return { application, page, ...(environment ? { environment } : {}), ...(urls.length === 1 ? { url: urls[0], source: '用例原文' } : {}) };
}

/** 递归读取输出目录，忽略符号链接、草案和待确认场景；仅信任能与实际地址步骤核对的来源注释。 */
async function history(directory: string): Promise<PageVisit[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const visits: PageVisit[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { visits.push(...await history(path)); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.feature') || /(?:draft|preview)/i.test(entry.name)) continue;
    const content = await readFile(path, 'utf8');
    if (content.includes('草案预览')) continue;
    for (const block of content.split(/^\s*Scenario:\s*/m).slice(1)) {
      if (/TODO|待确认|待补充/u.test(block)) continue;
      const title = block.split('\n')[0].trim();
      const marker = /^\s*# 访问页面: (.+)$/m.exec(block);
      const steps = [...block.matchAll(/^\s*(Given|When|Then|And) (.+)$/gm)].map(match => ({ keyword: match[1] as 'Given', text: match[2] }));
      let visit: PageVisit;
      if (marker) {
        try { visit = JSON.parse(marker[1]); visit.application ??= ''; } catch { continue; }
        if (!visit || (visit.application !== undefined && typeof visit.application !== 'string') || typeof visit.page !== 'string'
          || (visit.environment !== undefined && typeof visit.environment !== 'string') || !validAddress(visit.url)) continue;
        if (!steps.some(step => step.text === `本次访问地址为 ${JSON.stringify(visit.url)}`)) continue;
      } else {
        visit = inferVisit({ title, modulePath: [], steps });
        // 旧文件只有一个导航页面和一个地址时才允许建立明确对应关系。
        if (steps.filter(step => /进入|打开/u.test(step.text)).length !== 1) continue;
      }
      if (key(visit) && visit.url) visits.push({ ...visit, source: `${path} / ${title}` });
    }
  }
  return visits;
}

/** 合并本批地址问题，唯一历史地址直接复用；冲突保留候选，供终端与 Agent 集中确认。 */
export async function prepareAddresses(draft: FeatureDraft, output: string): Promise<AddressRequest[]> {
  for (const scenario of draft.scenarios) {
    if (scenario.platform !== 'miniprogram' && scenario.platform !== 'unsupported') {
      const inferred = inferVisit(scenario);
      scenario.visit ??= inferred;
      if (!scenario.visit.url && inferred.url) Object.assign(scenario.visit, { url: inferred.url, source: inferred.source });
    }
  }
  const historical = await history(output);
  const batch = draft.scenarios.filter(s => s.visit?.url).map(s => ({ ...s.visit!, source: s.visit!.source ?? `本批用例 / ${s.title}` }));
  const groups = new Map<string, AddressRequest>();
  draft.scenarios.forEach((scenario, index) => {
    const visit = scenario.visit;
    if (!visit || visit.url) return;
    const identity = key(visit);
    const groupKey = identity ?? `未知页面:${index}`;
    let request = groups.get(groupKey);
    if (!request) {
      const current = identity ? batch.filter(item => key(item) === identity && item.url) : [];
      const matching = current.length ? current : identity ? historical.filter(item => key(item) === identity && item.url) : [];
      const candidates = matching.map(item => ({ url: item.url!, source: item.source! }));
      request = { id: String(index + 1), visit, scenarios: [], candidates };
      groups.set(groupKey, request);
    }
    request.scenarios.push(scenario);
  });
  const pending: AddressRequest[] = [];
  for (const request of groups.values()) {
    const urls = new Set(request.candidates.map(item => item.url));
    if (urls.size === 1) {
      const candidate = request.candidates[0];
      for (const scenario of request.scenarios) scenario.visit = { ...scenario.visit!, url: candidate.url, source: `复用 ${candidate.source}` };
    } else pending.push(request);
  }
  return pending;
}

/** 用户一次提供地址后更新该组场景；未知页面必须同时补齐身份才能成为后续复用来源。 */
export function confirmAddress(request: AddressRequest, url: string, application = request.visit.application, page = request.visit.page, environment = request.visit.environment): void {
  if (!validAddress(url)) throw new Error('请提供完整的 HTTP(S) URL');
  if (!application.trim() || !page.trim()) throw new Error('请同时提供应用名称和页面名称');
  if ([application, page, environment ?? ''].some(value => /[\r\n\u0000-\u001f]/u.test(value))) throw new Error('页面身份必须为单行文本');
  for (const scenario of request.scenarios) scenario.visit = { application: application.trim(), page: page.trim(), ...(environment ? { environment: environment.trim() } : {}), url, source: '用户在生成阶段确认' };
}
