/**
 * 发版前检查入口，集中执行类型检查、构建和 npm 打包预演。
 */
import { execSync } from 'node:child_process';

const PACKAGES = [
  'browser-opt',
  'browser-e2e',
];

function run(command) {
  console.log(`\n$ ${command}`);
  execSync(command, { stdio: 'inherit' });
}

run('npm run typecheck');
run('npm run build');

for (const packageName of PACKAGES) {
  run(`npm pack --dry-run -w ${packageName}`);
}

console.log('\nRelease checks passed.');
