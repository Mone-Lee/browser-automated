/**
 * 校验 package-lock.json 是否保留 CI 必需的跨平台 optional 依赖。
 * 这类依赖容易在发版或不同 npm 环境中被裁剪，缺失时 npm ci 会在 GitHub Actions 上失败。
 */
import { readFileSync } from 'node:fs';

const REQUIRED_PACKAGES = [
  ['node_modules/@emnapi/core', '1.11.3'],
  ['node_modules/@emnapi/runtime', '1.11.3'],
];

const lockfile = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lockfile.packages ?? {};
const missingPackages = REQUIRED_PACKAGES.filter(([packagePath, version]) => {
  return packages[packagePath]?.version !== version;
});

if (missingPackages.length > 0) {
  const details = missingPackages
    .map(([packagePath, version]) => `- ${packagePath}@${version}`)
    .join('\n');

  console.error(`package-lock.json 缺少 CI 必需的 optional 依赖：\n${details}`);
  console.error('请在仓库根目录运行 npm install --package-lock-only --include=optional 后提交 package-lock.json。');
  process.exit(1);
}
