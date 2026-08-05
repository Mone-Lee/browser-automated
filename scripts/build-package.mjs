/**
 * 将共享底层代码编译进指定 CLI 的发布目录，再构建或检查该 CLI 自身代码。
 * browser-core 只保留源码职责，不作为独立 npm package 参与安装和发布。
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAMES = new Set(['browser-opt', 'browser-e2e']);
const packageName = process.argv[2];
const typecheckOnly = process.argv.includes('--typecheck');

if (!packageName || !PACKAGE_NAMES.has(packageName)) {
  console.error('Usage: node scripts/build-package.mjs <browser-opt|browser-e2e> [--typecheck]');
  process.exit(1);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = resolve(repositoryRoot, 'packages', packageName);
const outputDir = resolve(packageDir, 'dist');
const sharedOutputDir = resolve(outputDir, 'browser-core');
const tscBin = resolve(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc');

if (!typecheckOnly) {
  rmSync(outputDir, { recursive: true, force: true });
}
execFileSync(process.execPath, [
  tscBin,
  '-p',
  resolve(repositoryRoot, 'packages/browser-core/tsconfig.json'),
  '--outDir',
  sharedOutputDir,
], { cwd: repositoryRoot, stdio: 'inherit' });

const packageArgs = [tscBin, '-p', resolve(packageDir, 'tsconfig.json')];
if (typecheckOnly) {
  packageArgs.push('--noEmit');
}
execFileSync(process.execPath, packageArgs, { cwd: repositoryRoot, stdio: 'inherit' });
