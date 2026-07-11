/**
 * browser-opt 上传动作执行器，负责定位上传控件、准备本地文件并下发 upload。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrowserAgent } from '../../../../core/agent.js';
import type { DeterministicAction, SnapshotEvidence, DeterministicExecutionOptions } from '../../../type.js';
import { findUploadRef } from '../../../utils.js';

/** 执行上传动作，默认依赖快照中的上传控件 ref。 */
export async function executeUploadAction(
  agent: BrowserAgent,
  action: Extract<DeterministicAction, { type: 'upload' }>,
  snapshot: SnapshotEvidence,
  outputDir: string,
  _options: DeterministicExecutionOptions,
): Promise<string> {
  const ref = findUploadRef(snapshot, action.field);
  if (!ref) {
    throw new Error(`无法找到上传控件：${action.field}`);
  }

  const filePath = await prepareUploadFile(action.source, outputDir);
  const output = agent.upload(ref, [filePath]);
  return `upload @${ref} ${filePath}\n${output}`.trim();
}

/** 将远程上传素材下载到本次证据目录，让 agent-browser upload 使用稳定的本地路径。 */
async function prepareUploadFile(source: string, outputDir: string): Promise<string> {
  if (!/^https?:\/\//i.test(source)) {
    return path.resolve(source);
  }

  const uploadsDir = path.join(outputDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const url = new URL(source);
  const basename = path.basename(url.pathname) || 'upload-file';
  const filePath = path.join(uploadsDir, basename);
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`下载上传文件失败：${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
