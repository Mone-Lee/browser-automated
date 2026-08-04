#!/usr/bin/env node
/**
 * browser-e2e 独立 CLI 入口，负责在 skill、run、gen 和 setup 之间做最小分发。
 * 入口不再依赖旧的总 index，保证发布包只包含 browser-e2e 自己的命令域。
 */
import { cmdBrowserE2E, cmdE2E, cmdE2EGen } from './commands/browser-e2e.js';
import { setupBrowserE2E } from './commands/setup.js';
import { getBooleanFlag, getStringFlag, parseCliArgs } from './utils/args.js';

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);

  switch (subcommand) {
    case 'setup': {
      const parsed = parseCliArgs(rest);
      setupBrowserE2E({
        installSystemDependencies: getBooleanFlag(parsed.flags, 'with-deps'),
        installSkill: !getBooleanFlag(parsed.flags, 'skip-skill'),
        agent: getStringFlag(parsed.flags, 'agent'),
        skillsDir: getStringFlag(parsed.flags, 'skills-dir'),
      });
      return;
    }
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
