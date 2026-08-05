/**
 * 安装 browser-e2e 运行所需的浏览器与 Agent Skill，使调用方只需执行一次 setup。
 * 该命令只在用户显式调用时写入本机目录，不影响普通测试匹配和执行流程。
 */
import { resolveSkillInstallTarget } from '#browser-core/skill-install';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface BrowserE2ESetupOptions {
  installSystemDependencies: boolean;
  installSkill: boolean;
  agent?: string;
  skillsDir?: string;
}

/** 执行 agent-browser 安装，并在需要时把 browser-e2e Skill 放到目标 Agent 的用户级目录。 */
export function setupBrowserE2E(options: BrowserE2ESetupOptions): void {
  const installArgs = ['install', ...(options.installSystemDependencies ? ['--with-deps'] : [])];
  const result = spawnSync('agent-browser', installArgs, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`无法启动 agent-browser：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`agent-browser install 失败（退出码 ${result.status ?? 'unknown'}）。`);
  }

  if (options.installSkill) {
    const { label, targetDir } = resolveSkillInstallTarget('browser-e2e', {
      agent: options.agent,
      skillsDir: options.skillsDir,
    });
    fs.cpSync(resolveBundledSkillDir(), targetDir, { recursive: true, force: true });
    console.log(`已安装 ${label}：${targetDir}`);
  }
  console.log('browser-e2e 已就绪。');
}

/** 从编译后的 CLI 位置反查 npm 包内随包发布的 browser-e2e Skill。 */
function resolveBundledSkillDir(): string {
  const commandDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(commandDir, '../../../skills/browser-e2e');
}
