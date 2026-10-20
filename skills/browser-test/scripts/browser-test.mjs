/** 定位本地仓库并透传参数到已构建的命令入口，让链接或复制安装的技能使用同一套实现。 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const repositoryRoot = process.env.BROWSER_TEST_REPO
    ? resolve(process.env.BROWSER_TEST_REPO)
    : resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../..');
  const cli = resolve(repositoryRoot, 'packages/browser-test/dist/cli/browser-test.js');
  if (!existsSync(cli)) {
    throw new Error(
      `未找到本地 CLI：${cli}\n请在仓库安装依赖并执行 npm run build -w browser-test；复制安装的 Skill 需设置 BROWSER_TEST_REPO 为仓库绝对路径。`,
    );
  }
  const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`本地 CLI 被信号 ${result.signal} 中断`);
  process.exitCode = result.status ?? 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
