/**
 * 解析本机标准 Chrome 的可执行文件，供运行时和环境安装检查共用。
 * 这里刻意不回退到 Playwright 下载的 Chrome for Testing，避免浏览器身份和用户登录态发生漂移。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 优先采用显式配置，否则按操作系统约定查找标准 Chrome。 */
export function resolveSystemChromeExecutable(configuredPath = process.env.AGENT_BROWSER_EXECUTABLE_PATH): string | undefined {
  const explicitPath = configuredPath?.trim();
  if (explicitPath) {
    return isExecutableFile(explicitPath) ? path.resolve(explicitPath) : undefined;
  }

  for (const candidate of systemChromeCandidates()) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** 返回各平台标准 Chrome 的候选路径，不包含测试浏览器和 Playwright 缓存。 */
function systemChromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
  }
  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ].filter(Boolean);
  }

  const executableNames = ['google-chrome', 'google-chrome-stable'];
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .flatMap((directory) => executableNames.map((name) => path.join(directory, name)));
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
