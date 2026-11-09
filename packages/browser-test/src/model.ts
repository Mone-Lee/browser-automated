/**
 * 调用方 AI 的本地协作入口：草案、步骤解释、复杂动作与服务不可用时的页面判定通过请求文件交给当前 Agent。
 * 不在 CLI 内连接生成模型服务；普通元素选择与断言优先使用独立的 TypeSafe 客户端。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Observation } from './types.js';

/** 调用方注入现有 AI 能力；执行器只依赖结构化问答，不负责选择模型或读取生成模型密钥。 */
export interface ModelClient {
  /** 发送系统提示与结构化输入，返回解析后的 JSON；不能解析时抛出错误。 */
  json(system: string, input: unknown, timeoutMs: number): Promise<unknown>;
}

/** 请求通知只公开文件位置；提示与页面数据保存在本次运行独占的临时目录。 */
export interface AgentRequestNotice {
  type: 'agent-request';
  id: string;
  requestFile: string;
  responseFile: string;
  /** 回复必须在此时间之前送达，超时后该请求作废。 */
  expiresAt: string;
}

/** 文件通道由调用者在运行结束后关闭，清除提示、页面数据与回复。 */
export interface AgentModelClient extends ModelClient {
  close(): Promise<void>;
}

/** 发布请求后等待当前 Agent 的同编号回复；每次使用独立文件，拒绝错配回复与并发请求。 */
export async function createAgentModel(onRequest: (notice: AgentRequestNotice) => void): Promise<AgentModelClient> {
  const directory = await mkdtemp(join(tmpdir(), 'browser-test-agent-'));
  let closed = false;
  let pending = false;
  return {
    async json(system, input, timeoutMs) {
      if (closed) throw new Error('当前 Agent 通道已关闭');
      if (pending) throw new Error('当前 Agent 通道已有待处理请求');
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('当前 Agent 请求的时间预算已耗尽');
      pending = true;
      const id = randomUUID();
      const deadline = Date.now() + timeoutMs;
      const notice: AgentRequestNotice = {
        type: 'agent-request', id, requestFile: join(directory, `${id}.request.json`),
        responseFile: join(directory, `${id}.response.json`), expiresAt: new Date(deadline).toISOString(),
      };
      try {
        await writeFile(notice.requestFile, JSON.stringify({ ...notice, system, input }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        onRequest(notice);
        while (!closed && Date.now() < deadline) {
          let content: string;
          try { content = await readFile(notice.responseFile, 'utf8'); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await delay(Math.min(100, Math.max(1, deadline - Date.now())));
            continue;
          }
          if (Date.now() >= deadline) break;
          let reply: unknown;
          try { reply = JSON.parse(content); } catch { throw new Error('当前 Agent 回复不是有效 JSON，请完整写入临时文件后重命名到 responseFile'); }
          if (!reply || typeof reply !== 'object' || !('id' in reply) || reply.id !== id) throw new Error('当前 Agent 回复的请求编号不匹配');
          if ('error' in reply) throw new Error(`当前 Agent 无法完成请求：${String(reply.error)}`);
          if (!('result' in reply)) throw new Error('当前 Agent 回复缺少 result 字段');
          return reply.result;
        }
        throw new Error(closed ? '当前 Agent 通道已关闭' : '等待当前 Agent 回复超时');
      } finally {
        pending = false;
        await Promise.all([rm(notice.requestFile, { force: true }), rm(notice.responseFile, { force: true })]);
      }
    },
    async close() {
      closed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** 把观测压缩成模型输入：页面内容属于不可信数据，只作为描述，不会被当作指令。 */
export function describeObservation(observation: Observation): unknown {
  const evidence = (source: string) => observation.evidence.find(item => item.source === source)?.actual;
  const text = String(evidence('body-text') ?? '');
  const rows = (evidence('table-rows') as unknown[] | undefined) ?? [];
  const tabs = (evidence('tab-states') as unknown[] | undefined) ?? [];
  return {
    observationId: observation.id,
    url: observation.url,
    capture: { ...observation.capture, textTruncated: observation.capture.textTruncated || text.length > 6000, rowsTruncated: observation.capture.rowsTruncated || rows.length > 40 },
    // 静态单元格和空节点已由正文、表格提供，不重复灌入模型；宿主仍保留全部目标用于门禁。
    targets: observation.targets.filter(item => item.name.trim() && !['generic', 'row', 'cell', 'columnheader', 'LabelText', 'Iframe', 'image'].includes(item.role ?? '')).map(({ id, role, name }) => ({ id, role, name })),
    pageText: text.length > 6000 ? `${text.slice(0, 6000)}…（已截断）` : text,
    tableRows: rows.slice(0, 40),
    tableStructure: evidence('table-structure'),
    tabStates: tabs,
    evidenceIds: observation.evidence.map(item => item.id),
  };
}
