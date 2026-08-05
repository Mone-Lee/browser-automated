/**
 * monorepo 发版入口，按目标发布两个自包含的 CLI package。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
const RELEASE_TYPES = new Set(['patch', 'minor', 'major']);
const TARGETS = new Set(['all', 'browser-opt', 'browser-e2e']);
const PACKAGE_BY_TARGET = {
  'browser-opt': {
    name: 'browser-opt',
    dir: 'packages/browser-opt',
    tagPrefix: 'browser-opt',
  },
  'browser-e2e': {
    name: 'browser-e2e',
    dir: 'packages/browser-e2e',
    tagPrefix: 'browser-e2e',
  },
};

function run(command) {
  console.log(`\n$ ${command}`);
  return execSync(command, { stdio: 'inherit', encoding: 'utf8' }) ?? '';
}

function runCapture(command) {
  return execSync(command, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((arg) => arg !== '--dry-run');
  const first = positional[0];
  const second = positional[1];

  const target = first && TARGETS.has(first) ? first : 'all';
  const releaseType = first && RELEASE_TYPES.has(first) ? first : second ?? 'patch';

  if (!RELEASE_TYPES.has(releaseType)) {
    console.error(`\nInvalid release type: "${releaseType}"`);
    console.error('Usage: npm run release -- [all|browser-opt|browser-e2e] [patch|minor|major]');
    console.error('Dry run: npm run release:dry-run -- [target] [patch|minor|major]');
    process.exit(1);
  }

  if (first && !TARGETS.has(first) && !RELEASE_TYPES.has(first)) {
    console.error(`\nInvalid release target: "${first}"`);
    console.error('Usage: npm run release -- [all|browser-opt|browser-e2e] [patch|minor|major]');
    process.exit(1);
  }

  return { target, releaseType, dryRun };
}

function resolveReleaseTargets(target) {
  return target === 'all'
    ? ['browser-opt', 'browser-e2e']
    : [target];
}

function readPackageJson(packageDir) {
  const url = new URL(`../${packageDir}/package.json`, import.meta.url);
  return {
    url,
    json: JSON.parse(readFileSync(url, 'utf8')),
  };
}

/** 使用统一参数刷新 lockfile，并立即用 npm ci 校验可选依赖没有被错误裁剪。 */
function refreshAndVerifyLockfile(dryRun) {
  const installCommand = 'npm install --package-lock-only --ignore-scripts --include=optional';
  const verifyCommand = 'npm ci --ignore-scripts';

  if (dryRun) {
    console.log(`\n$ ${installCommand}`);
    console.log(`\n$ ${verifyCommand}`);
    return;
  }

  run(installCommand);
  run(verifyCommand);
}

function ensureNpmPublishPreflight(dryRun) {
  const configuredRegistry = runCapture('npm config get registry');
  if (configuredRegistry !== NPMJS_REGISTRY) {
    console.warn(`\nWarning: current npm registry is ${configuredRegistry}`);
    console.warn(`Release publish target is fixed to ${NPMJS_REGISTRY}`);
  }

  if (dryRun) {
    console.log('\nDry run: skipping npm authentication and registry ping.');
    return;
  }

  try {
    const npmUser = runCapture(`npm whoami --registry=${NPMJS_REGISTRY}`);
    console.log(`\nPublish preflight passed. npmjs user: ${npmUser}`);
  } catch {
    console.warn('\nRelease preflight failed: npmjs authentication is missing or expired.');
    console.warn(`Starting interactive login: npm login --registry=${NPMJS_REGISTRY}`);

    try {
      run(`npm login --registry=${NPMJS_REGISTRY}`);
      const npmUser = runCapture(`npm whoami --registry=${NPMJS_REGISTRY}`);
      console.log(`\nPublish preflight passed after login. npmjs user: ${npmUser}`);
    } catch {
      console.error('\nRelease preflight failed: npmjs authentication is still unavailable after login.');
      console.error(`Please verify manually: npm whoami --registry=${NPMJS_REGISTRY}`);
      process.exit(1);
    }
  }

  try {
    runCapture(`npm ping --registry=${NPMJS_REGISTRY}`);
    console.log(`Publish preflight passed. npmjs registry reachable: ${NPMJS_REGISTRY}`);
  } catch {
    console.error('\nRelease preflight failed: npmjs registry is not reachable from current network.');
    console.error(`Please check proxy/network and retry: npm ping --registry=${NPMJS_REGISTRY}`);
    process.exit(1);
  }
}

function readVersion(target) {
  return readPackageJson(PACKAGE_BY_TARGET[target].dir).json.version;
}

function bumpPackageVersion(target, releaseType, dryRun) {
  const packageInfo = PACKAGE_BY_TARGET[target];
  if (dryRun) {
    console.log(`\n$ npm version ${releaseType} --no-git-tag-version -w ${packageInfo.name}`);
    return `${readVersion(target)}+${releaseType}`;
  }
  run(`npm version ${releaseType} --no-git-tag-version -w ${packageInfo.name}`);
  return readVersion(target);
}

function publishPackage(target) {
  const packageInfo = PACKAGE_BY_TARGET[target];
  run(`npm publish -w ${packageInfo.name} --registry=${NPMJS_REGISTRY}`);
}

function hasStagedOrWorkingChanges() {
  try {
    execSync('git diff --quiet && git diff --cached --quiet', { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

function commitCurrentChangesIfNeeded(dryRun) {
  if (!hasStagedOrWorkingChanges()) {
    console.log('\nNo local changes to commit before release.');
    return;
  }

  if (dryRun) {
    console.log('\nDry run: skipping pre-release git commit.');
    return;
  }

  run('git add -A');
  run('git commit -m "chore: prepare release"');
}

function commitAndTagRelease(targets, dryRun) {
  if (dryRun) {
    console.log('\nDry run: skipping git commit, tags, and push.');
    return;
  }

  run('git add package.json package-lock.json packages/*/package.json');
  run('git commit -m "release: publish browser packages"');

  for (const target of targets) {
    const version = readVersion(target);
    const tag = `${PACKAGE_BY_TARGET[target].tagPrefix}-v${version}`;
    run(`git tag ${tag}`);
  }
}

const { target, releaseType, dryRun } = parseArgs();
const releaseTargets = resolveReleaseTargets(target);

console.log(`Release target: ${target}`);
console.log(`Release type: ${releaseType}`);
console.log(`Packages: ${releaseTargets.map((item) => PACKAGE_BY_TARGET[item].name).join(', ')}`);

ensureNpmPublishPreflight(dryRun);
run('npm run typecheck');
commitCurrentChangesIfNeeded(dryRun);

for (const releaseTarget of releaseTargets) {
  bumpPackageVersion(releaseTarget, releaseType, dryRun);
}

refreshAndVerifyLockfile(dryRun);
run('npm run build');

for (const releaseTarget of releaseTargets) {
  run(`npm pack --dry-run -w ${PACKAGE_BY_TARGET[releaseTarget].name}`, { dryRun });
}

commitAndTagRelease(releaseTargets, dryRun);

if (!dryRun) {
  for (const releaseTarget of releaseTargets) {
    publishPackage(releaseTarget);
  }

  console.log('\nnpm publish succeeded, pushing commits and tags to GitHub...');
  run('git push');
  run('git push --tags');
}

console.log('\nRelease finished.');
