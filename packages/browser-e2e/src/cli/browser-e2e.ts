#!/usr/bin/env node
/**
 * browser-e2e 独立 CLI 入口，负责在 skill、run、gen 和 setup 之间做最小分发。
 * 入口不再依赖旧的总 index，保证发布包只包含 browser-e2e 自己的命令域。
 */
import { cmdBrowserE2E, cmdE2E, cmdE2EGen } from './commands/browser-e2e.js';
import { setupBrowserE2E } from './commands/setup.js';

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  switch (subcommand) {
    case 'setup':
      setupBrowserE2E({
        installSystemDependencies: rest.includes('--with-deps'),
        installSkill: !rest.includes('--skip-skill'),
      });
      return;
    case 'run':
      await cmdE2E(rest);
      return;
    case 'gen':
      await cmdE2EGen(rest);
      return;
    default:
      await cmdBrowserE2E(process.argv.slice(2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
