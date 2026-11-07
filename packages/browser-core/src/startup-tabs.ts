/**
 * 清理托管 Chrome 首次启动时自行创建的新标签页。
 * 这些目标不在 agent-browser 的标签页清单中，因此通过浏览器连接直接枚举和关闭。
 */
import { spawnSync } from 'node:child_process';

// 浏览器端口使用同步接口，独立进程负责异步协议交互，避免改变现有运行器的调用方式。
const CLEANUP_SCRIPT = `
import { readFileSync } from 'node:fs';
const { endpoint } = JSON.parse(readFileSync(0, 'utf8'));
const socket = new WebSocket(endpoint);
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('浏览器连接失败')), { once: true });
  });
  const { targetInfos } = await send('Target.getTargets');
  const startupUrls = new Set([
    'chrome://newtab', 'chrome://newtab/', 'chrome://new-tab-page/',
    'chrome-search://local-ntp/local-ntp.html',
  ]);
  const startupTabs = targetInfos.filter(target => target.type === 'page'
    && startupUrls.has(target.url));
  for (const target of startupTabs) {
    const result = await send('Target.closeTarget', { targetId: target.targetId });
    if (!result.success) throw new Error('无法关闭启动标签页');
  }
} catch {
  process.exitCode = 1;
} finally {
  socket.close();
}
`;

/** 仅在托管会话启动完成、业务导航之前调用；保留运行器的空白准备页及所有业务页面。 */
export function removeStartupTabs(endpoint: string, timeoutMs: number): void {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CLEANUP_SCRIPT], {
    input: JSON.stringify({ endpoint }), encoding: 'utf8', timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) {
    throw new Error('无法清理浏览器启动标签页，请检查浏览器连接后重试。');
  }
}
