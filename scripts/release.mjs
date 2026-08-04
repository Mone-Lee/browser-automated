/**
 * monorepo 发版入口，按目标包发布，并在 core 有变化时自动先发布 core。
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
const RELEASE_TYPES = new Set(['patch', 'minor', 'major']);
const TARGETS = new Set(['all', 'browser-core', 'browser-opt', 'browser-e2e']);
const PACKAGE_BY_TARGET = {
  'browser-core': {
    name: '@browser-automated/browser-core',
    dir: 'packages/browser-core',
    tagPrefix: 'browser-core',
  },
  'browser-opt': {
    name: 'browser-opt',
    dir: 'packages/browser-opt',
    tagPrefix: 'browser-opt',
    dependsOnCore: true,
  },
  'browser-e2e': {
    name: 'browser-e2e',
    dir: 'packages/browser-e2e',
    tagPrefix: 'browser-e2e',
    dependsOnCore: true,
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
    console.error('Usage: npm run release -- [all|browser-core|browser-opt|browser-e2e] [patch|minor|major]');
    console.error('Dry run: npm run release:dry-run -- [target] [patch|minor|major]');
    process.exit(1);
  }

  if (first && !TARGETS.has(first) && !RELEASE_TYPES.has(first)) {
    console.error(`\nInvalid release target: "${first}"`);
    console.error('Usage: npm run release -- [all|browser-core|browser-opt|browser-e2e] [patch|minor|major]');
    process.exit(1);
  }

  return { target, releaseType, dryRun };
}

function hasGitHead() {
  try {
    runCapture('git rev-parse --verify HEAD');
    return true;
  } catch {
    return false;
  }
}

function hasPackageChanges(packageDir) {
  if (!hasGitHead()) {
    return true;
  }

  const trackedChanges = runCapture(`git diff --name-only HEAD -- ${packageDir}`);
  const untrackedChanges = runCapture(`git ls-files --others --exclude-standard -- ${packageDir}`);
  return Boolean(trackedChanges || untrackedChanges);
}

function resolveReleaseTargets(target) {
  const requestedTargets = target === 'all'
    ? ['browser-opt', 'browser-e2e']
    : [target];
  const needsCore = requestedTargets.includes('browser-core') ||
    (requestedTargets.some((item) => PACKAGE_BY_TARGET[item].dependsOnCore) &&
      hasPackageChanges(PACKAGE_BY_TARGET['browser-core'].dir));

  return [
    ...(needsCore ? ['browser-core'] : []),
    ...requestedTargets.filter((item) => item !== 'browser-core'),
  ];
}

function readPackageJson(packageDir) {
  const url = new URL(`../${packageDir}/package.json`, import.meta.url);
  return {
    url,
    json: JSON.parse(readFileSync(url, 'utf8')),
  };
}

function writePackageJson(url, json) {
  writeFileSync(url, `${JSON.stringify(json, null, 2)}\n`);
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

function updateCoreDependents(targets, coreVersion, dryRun) {
  for (const target of targets) {
    const packageInfo = PACKAGE_BY_TARGET[target];
    if (!packageInfo.dependsOnCore) {
      continue;
    }

    const { url, json } = readPackageJson(packageInfo.dir);
    json.dependencies = json.dependencies ?? {};
    json.dependencies['@browser-automated/browser-core'] = coreVersion;
    if (!dryRun) {
      writePackageJson(url, json);
    }
    console.log(`Updated ${packageInfo.name} dependency @browser-automated/browser-core -> ${coreVersion}`);
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

function publishPackage(target, dryRun) {
  const packageInfo = PACKAGE_BY_TARGET[target];
  const accessFlag = target === 'browser-core' ? ' --access public' : '';
  const dryRunFlag = dryRun ? ' --dry-run' : '';
  run(`npm publish -w ${packageInfo.name} --registry=${NPMJS_REGISTRY}${accessFlag}${dryRunFlag}`);
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

let newCoreVersion = null;
if (releaseTargets.includes('browser-core')) {
  newCoreVersion = bumpPackageVersion('browser-core', releaseType, dryRun);
  updateCoreDependents(releaseTargets, newCoreVersion, dryRun);
}

for (const releaseTarget of releaseTargets) {
  if (releaseTarget === 'browser-core') {
    continue;
  }
  bumpPackageVersion(releaseTarget, releaseType, dryRun);
}

if (dryRun) {
  console.log('\n$ npm install --package-lock-only --ignore-scripts');
} else {
  run('npm install --package-lock-only --ignore-scripts');
}

run('npm run build');

for (const releaseTarget of releaseTargets) {
  run(`npm pack --dry-run -w ${PACKAGE_BY_TARGET[releaseTarget].name}`, { dryRun });
}

for (const releaseTarget of releaseTargets) {
  if (dryRun) {
    publishPackage(releaseTarget, dryRun);
  }
}

commitAndTagRelease(releaseTargets, dryRun);

if (!dryRun) {
  for (const releaseTarget of releaseTargets) {
    publishPackage(releaseTarget, dryRun);
  }

  console.log('\nnpm publish succeeded, pushing commits and tags to GitHub...');
  run('git push');
  run('git push --tags');
}

console.log('\nRelease finished.');
