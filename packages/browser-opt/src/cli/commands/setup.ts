/**
 * 安装 browser-opt 运行所需的浏览器与 Codex Skill，使调用方只需执行一次 setup。
 * 该命令只在用户显式调用时写入本机目录，不影响普通工作流执行。
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface BrowserOptSetupOptions {
  installSystemDependencies: boolean;
  installSkill: boolean;
}

/** 执行 agent-browser 安装，并在需要时把 browser-opt Skill 放到 Codex 的用户级目录。 */
export function setupBrowserOpt(options: BrowserOptSetupOptions): void {
  const installArgs = ['install', ...(options.installSystemDependencies ? ['--with-deps'] : [])];
  const result = spawnSync('agent-browser', installArgs, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`无法启动 agent-browser：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`agent-browser install 失败（退出码 ${result.status ?? 'unknown'}）。`);
  }

  if (options.installSkill) {
    const targetDir = path.join(process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'), 'skills', 'browser-opt');
    fs.cpSync(resolveBundledSkillDir(), targetDir, { recursive: true, force: true });
    console.log(`已安装 Codex Skill：${targetDir}`);
  }
  console.log('browser-opt 已就绪。');
}

/** 从编译后的 CLI 位置反查 npm 包内随包发布的 browser-opt Skill。 */
function resolveBundledSkillDir(): string {
  const commandDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(commandDir, '../../../skills/browser-opt');
}
