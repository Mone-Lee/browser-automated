/**
 * 存放 browser-opt CLI 复用的提示文案与常量，避免命令编排文件混入长文本。
 * 当前只保留 browser-opt 自身会消费的内容，防止把 browser-e2e 边界带进来。
 */

export const LIVE_VIEWPORT_DASHBOARD_URL = 'http://localhost:4848';

export const HANDOFF_DONE_ANSWERS = ['done', 'ok', '继续', '完成'] as const;

export const BROWSER_OPT_USAGE = `使用方式：
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install [--download-browser] [--with-deps] [--skip-skill] [--agent agents|codex] [--skills-dir <目录>]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest <自然语言流程> [--profile <name>] [--state <path>] [--session <id>] [--no-live-viewport] [--output-dir <dir>] [--agent-chat]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest save "<名称>" --flow "<完整流程>" [--workflow-dir <目录>] [--force]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest run "<查询语句>" [--workflow-dir <目录>]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest run --workflow-id "<ID>" [--workflow-dir <目录>]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest start --workflow-id "<ID>" [--workflow-dir <目录>] [--json]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest status --run-id "<ID>" [--json]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest resume --run-id "<ID>" [--json]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest list [--workflow-dir <目录>] [--json]
  npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest match "<查询语句>" [--workflow-dir <目录>] [--json]`;
