#!/usr/bin/env node
/**
 * 作为 CLI 总入口统一承载命令分发与可执行文件识别，不再直接堆叠各命令实现细节。
 * 具体命令逻辑已按领域拆分到独立模块中，index 只保留入口协调职责。
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cmdBrowserE2E, cmdE2E, cmdE2EGen } from './commands/browser-e2e.js';
import { cmdBrowserOpt } from './commands/browser-opt.js';
import { cmdChat, cmdGen, cmdRun } from './commands/legacy.js';
import { printUsage } from './utils/output.js';

export async function runCli(command: string | undefined, args: string[]): Promise<void> {
  switch (command) {
    case 'run':
      await cmdRun(args);
      break;
    case 'gen':
      await cmdGen(args);
      break;
    case 'chat':
      await cmdChat(args);
      break;
    case 'browser-e2e':
      await cmdBrowserE2E(args);
      break;
    case 'browser-opt':
      await cmdBrowserOpt(args);
      break;
    case 'e2e':
      await cmdE2E(args);
      break;
    case 'e2e-gen':
      await cmdE2EGen(args);
      break;
    default:
      printUsage(command);
      process.exit(1);
  }
}

export async function runBrowserOptCli(args: string[]): Promise<void> {
  await cmdBrowserOpt(args);
}

export async function runBrowserE2ECli(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand) {
    await cmdBrowserE2E([]);
    return;
  }

  switch (subcommand) {
    case 'run':
      await cmdE2E(rest);
      return;
    case 'gen':
      await cmdE2EGen(rest);
      return;
    case 'skill':
      await cmdBrowserE2E(rest);
      return;
    default:
      await cmdBrowserE2E(args);
  }
}

function resolveMainEntrypoint(): { command: string | undefined; args: string[] } {
  const executable = path.basename(process.argv[1] ?? '');
  if (executable === 'browser-opt' || executable === 'browser-opt-cli.ts') {
    return { command: 'browser-opt', args: process.argv.slice(2) };
  }
  if (executable === 'browser-e2e' || executable === 'browser-e2e-cli.ts') {
    return { command: 'browser-e2e-bin', args: process.argv.slice(2) };
  }

  const [, , command, ...args] = process.argv;
  return { command, args };
}

async function main(): Promise<void> {
  const entrypoint = resolveMainEntrypoint();
  if (entrypoint.command === 'browser-e2e-bin') {
    await runBrowserE2ECli(entrypoint.args);
    return;
  }
  await runCli(entrypoint.command, entrypoint.args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
