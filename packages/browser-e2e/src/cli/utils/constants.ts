/**
 * 存放 browser-e2e CLI 共享的命令提示与交互常量，避免命令文件夹杂大段展示文案。
 * 这里只保留 browser-e2e 真正会用到的文案，不再承载历史兼容入口描述。
 */

export const LIVE_VIEWPORT_DASHBOARD_URL = 'http://localhost:4848';

export const HANDOFF_DONE_ANSWERS = ['done', 'ok', '继续', '完成'] as const;

export const BROWSER_E2E_SKILL_USAGE = `使用方式：
      browser-e2e <自然语言测试描述>

示例：
  browser-e2e 测试网站 https://example.com/login 的登录功能。\n\n目标：\n1. 打开登录页面。\n2. 输入用户名 "testuser" 和密码 "password123"。\n3. 点击登录按钮。\n4. 验证是否跳转到仪表盘页面（URL 包含 /dashboard 或看到欢迎文字）。`;
