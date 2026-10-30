#!/usr/bin/env node
/** 提供 XMind 导入、引导生成与 Gherkin 解析入口；页面执行能力尚未开放。 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { VERSION, importXMind } from '../index.js';
import { createInterface } from 'node:readline/promises';
import { DRAFT_RULES, describeTodo, listTodos, renderDraftPreview, resolveTodo, draftFromAgentSteps, generateFeatureDraft, loadAgentSteps, loadCasesImport, validateFeatureDraft, reviewFeatureDraft, saveDirectFeatureDraft, saveFeatureDraft } from '../feature-gen.js';
import { prepareAddresses, confirmAddress } from '../feature-address.js';
import { findPendingConfirmations, parseFeatureFile } from '../feature.js';
import type { ExistingFeatureStrategy, FeatureDraft, DraftStep } from '../feature-gen.js';

const help = `browser-test ${VERSION}
用法：
  browser-test xmind list --xmind <文件> [--json]
  browser-test feature gen --xmind <文件> [--draft <草案名>]
  browser-test feature gen --cases <用例 JSON> [--draft <草案名>]
  browser-test feature gen --xmind <文件>|--cases <用例 JSON> --steps <步骤 JSON> --draft <草案名>
  browser-test feature gen --xmind <文件>|--cases <用例 JSON> [--steps <步骤 JSON>] --direct
  browser-test feature gen --review <草案名> [--merge | --overwrite] [--yes]
  browser-test feature addresses <草案名> [--id <编号> --url <完整地址> --application <应用> --page <页面> --environment <环境>]
  browser-test feature rules
  browser-test feature todos <草案名> [--id <编号>]
  browser-test feature resolve <草案名> <编号> keep|delete|"<Given|When|Then|And 完整步骤>"
  browser-test --help
  browser-test --version

所有持久产物都写入当前执行目录的 .browser-test/，且只保留可供人审阅的 Gherkin；目录不存在时自动创建。--json 将完整结果输出到标准输出，不写文件。
feature gen 默认支持逐项交互确认；--draft 将机器状态保存在系统临时目录，并在 .browser-test/ 写入可读预览；--direct 一次性创建可整文件编辑的 Gherkin。
--cases 读取与 xmind list --json 同构的 JSON（如图片还原结果）。
起草有两种方式：默认经 AI Gateway，需要 AI_GATEWAY_API_KEY、BROWSER_TEST_MODEL；或由当前 Agent 按 feature rules 输出的规则起草步骤 JSON，
再用 --steps 传入（无需网关配置，补全与原文核对同网关路径）。审阅无需 AI。
--draft 写出 <草案>.preview.feature（Gherkin 预览，待确认项带编号）；todos 以 Gherkin 上下文逐项展示待确认项，resolve 每次处理一项并刷新预览。
--direct 跳过逐项确认并保留 # TODO(确认)；调用方须直接修改生成文件，清除待确认项后才能执行。
审阅差异只输出到终端；默认不覆盖已有 feature，--merge 保留已有同名场景并追加缺失场景，--overwrite 整体覆盖。最终写入成功后自动删除草案预览和临时状态。
通过 --cases 生成的 feature 文件名追加来源后缀，避免图片还原用例与同模块的 XMind 用例冲突。
生成阶段按应用、页面和环境复用 .browser-test/ 中的已确认地址；缺失或冲突用 feature addresses 集中确认，确认一次应用于同页用例。
Gherkin 解析与待确认项拒绝已实现；run 的页面执行和报告尚未实现。
`;

/** 返回本次 CLI 调用的持久产物目录，仅承载可供人审阅的 Gherkin。 */
function artifactDirectory(): string {
  return resolve('.browser-test');
}

/** 草案机器状态按工作目录隔离在系统临时目录，不混入用户需要审阅的产物。 */
function draftStateDirectory(): string {
  const workspace = createHash('sha256').update(resolve('.')).digest('hex');
  return resolve(tmpdir(), 'browser-test', workspace);
}

/** 将产物文件名解析到专用目录内，拒绝绝对路径和越过目录边界的相对路径。 */
function artifactFile(filename: string, label: string): string {
  const directory = artifactDirectory();
  const path = resolve(directory, filename);
  const pathRelativeToDirectory = relative(directory, path);
  if (!filename || isAbsolute(filename) || pathRelativeToDirectory === '' || pathRelativeToDirectory === '..' || pathRelativeToDirectory.startsWith(`..${sep}`)) {
    throw new Error(`${label} 必须是 .browser-test/ 下的文件名`);
  }
  return path;
}

/** 将草案名映射到系统临时状态文件，并沿用产物文件相同的越界检查。 */
function draftStateFile(filename: string, label: string): string {
  const directory = draftStateDirectory();
  const path = resolve(directory, filename);
  const pathRelativeToDirectory = relative(directory, path);
  if (!filename || /[\\/]/u.test(filename) || isAbsolute(filename) || pathRelativeToDirectory === '' || pathRelativeToDirectory === '..' || pathRelativeToDirectory.startsWith(`..${sep}`)) {
    throw new Error(`${label} 必须是简单草案名`);
  }
  return path;
}

/** 自动创建产物目录，避免调用方为常规生成流程预先准备目录。 */
async function ensureArtifactDirectory(): Promise<string> {
  const directory = artifactDirectory();
  await mkdir(directory, { recursive: true });
  return directory;
}

/** 创建当前工作目录对应的临时状态目录。 */
async function ensureDraftStateDirectory(): Promise<string> {
  const directory = draftStateDirectory();
  await mkdir(directory, { recursive: true });
  return directory;
}

/** 兼容保留 --out 参数，但只接受当前调用目录的固定产物目录。 */
function outputDirectory(output: string | undefined): string {
  const directory = artifactDirectory();
  if (output && resolve(output) !== directory) throw new Error(`--out 仅支持当前执行目录的 .browser-test：${directory}`);
  return directory;
}

/** 校验参数后导入指定文件，错误统一使用工具错误退出码。 */
async function main(args: string[]): Promise<void> {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(help);
    return;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    console.log(VERSION);
    return;
  }
  if (args[0] === 'feature' && args[1] === 'rules' && args.length === 2) {
    console.log(DRAFT_RULES);
    return;
  }
  if (args[0] === 'feature' && (args[1] === 'todos' || args[1] === 'resolve')) {
    await todos(args[1], args.slice(2));
    return;
  }
  if (args[0] === 'feature' && args[1] === 'addresses') {
    await addresses(args.slice(2));
    return;
  }
  if (args[0] === 'feature' && args[1] === 'gen') {
    await generate(args.slice(2));
    return;
  }
  if (args[0] === 'run') {
    await guardRun(args.slice(1));
    return;
  }
  if (args[0] === 'feature') {
    throw new Error('不支持的 feature 子命令，请使用 --help 查看用法');
  }
  if (args[0] !== 'xmind' || args[1] !== 'list') throw new Error('不支持的命令，请使用 --help 查看用法');
  let filename: string | undefined;
  let json = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--xmind' && filename === undefined && args[i + 1] && !args[i + 1].startsWith('--')) {
      filename = args[++i];
    } else if (args[i] === '--json' && !json) {
      json = true;
    } else {
      throw new Error(`无效或重复参数：${args[i]}`);
    }
  }
  if (!filename) throw new Error('缺少 --xmind <文件>');
  const result = await importXMind(filename);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`导入 ${result.sheets.length} 个画布，识别 ${result.cases.length} 条用例（来源：${result.file}）`);
    for (const item of result.cases) {
      console.log(`\n${item.title}\n  模块：${item.modulePath.join(' / ')}`);
      if (item.structure === 'nested') console.log('  结构：按父操作→直属子预期识别为嵌套布局');
    }
  }
  for (const warning of result.warnings) console.error(`提示 [${warning.path.join(' / ')}]：${warning.message}`);
}

/** 支持逐项交互、结构化草案审阅和直接生成三种入口，并保持相同的起草与校验规则。 */
async function generate(args: string[]): Promise<void> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const isFlag = ['--yes', '--direct', '--merge', '--overwrite'].includes(key);
    if (!['--xmind', '--cases', '--steps', '--out', '--draft', '--review', '--yes', '--direct', '--merge', '--overwrite'].includes(key) || key in options
      || (!isFlag && (!args[i + 1] || args[i + 1].startsWith('--')))) throw new Error(`无效或重复参数：${key}`);
    options[key] = isFlag ? 'true' : args[++i];
  }
  if ([options['--xmind'], options['--cases'], options['--review']].filter(Boolean).length !== 1) throw new Error('--xmind、--cases 与 --review 三选一');
  if ([options['--draft'], options['--review'], options['--direct']].filter(Boolean).length > 1 || (options['--yes'] && !options['--review'])) throw new Error('--draft、--review 与 --direct 互斥，--yes 仅用于审阅');
  if (options['--merge'] && options['--overwrite']) throw new Error('--merge 与 --overwrite 互斥');
  if ((options['--merge'] || options['--overwrite']) && !options['--review']) throw new Error('--merge 与 --overwrite 仅用于 --review');
  if (options['--steps'] && options['--review']) throw new Error('--steps 仅用于生成');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options['--review'] && !options['--draft'] && !options['--direct'] && !interactive) throw new Error('非交互生成请提供 --draft <草案名> 或 --direct');
  const out = outputDirectory(options['--out']);
  const strategy: ExistingFeatureStrategy = options['--merge'] ? 'merge' : options['--overwrite'] ? 'overwrite' : 'create';
  const draft: FeatureDraft = options['--review']
    ? JSON.parse(await readFile(draftStateFile(options['--review'], '--review'), 'utf8'))
    : await buildDraft(options);
  validateFeatureDraft(draft);
  let addressRequests = await prepareAddresses(draft, out);
  if (options['--direct']) {
    await ensureArtifactDirectory();
    const review = await reviewFeatureDraft(draft, out);
    const written = await saveDirectFeatureDraft(draft, out);
    const writtenSet = new Set(written);
    const pending = review.files.flatMap(file => findPendingConfirmations(file.previous ?? file.content));
    const skipped = review.files.filter(file => !writtenSet.has(file.path)).map(file => file.path);
    console.log(`已直接生成 ${written.length} 个 Gherkin 文件；已有 ${skipped.length} 个文件未覆盖。${written.length ? `\n${written.join('\n')}` : ''}${skipped.length ? `\n未覆盖：\n${skipped.join('\n')}` : ''}`);
    if (pending.length) console.log(`检测到 ${pending.length} 项待确认，已停止后续流程。请直接修改生成的 feature，清除 # TODO(确认) 或 # 待确认 后再执行。`);
    else console.log('生成文件中没有待确认项；执行能力开放后可直接运行。');
    return;
  }
  if (options['--draft']) {
    const draftFile = draftStateFile(options['--draft'], '--draft');
    await ensureDraftStateDirectory();
    await ensureArtifactDirectory();
    await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const preview = await writePreview(options['--draft'], draft);
    console.log(`Gherkin 草案预览：${preview}\n地址待确认 ${addressRequests.length} 组（使用 feature addresses）；语义待确认 ${listTodos(draft).length} 项，请用 feature todos 逐项确认，再使用 --review。机器状态保存在系统临时目录，尚未写入最终 feature。`);
    return;
  }
  const rl = options['--review'] ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (rl) {
      while (addressRequests.length) {
        const request = addressRequests[0];
        console.log(JSON.stringify({ id: request.id, ...request.visit, scenarios: request.scenarios.map(s => s.title), candidates: request.candidates }, null, 2));
        const application = request.visit.application || (await rl.question('应用名称：')).trim();
        const page = request.visit.page || (await rl.question('页面名称：')).trim();
        const environment = (await rl.question(`环境（回车保留${request.visit.environment ?? '未区分环境'}）：`)).trim() || request.visit.environment;
        const url = (await rl.question('本次访问完整 URL（应用于以上用例）：')).trim();
        confirmAddress(request, url, application, page, environment);
        addressRequests = await prepareAddresses(draft, out);
      }
      await resolveTodos(draft, rl);
    }
    if (addressRequests.length) console.log(`尚有 ${addressRequests.length} 组地址待确认，请使用 feature addresses <草案名>`);
    const review = await reviewFeatureDraft(draft, out, strategy);
    console.log(review.diff);
    if (rl) {
      if ((await rl.question('\n确认以上全部内容并创建新文件？输入 yes：')).trim() !== 'yes') throw new Error('已取消，未写入 feature');
    } else if (!options['--yes']) {
      console.log('\n请在用户确认后加 --yes 落盘；待确认项必须先解决。');
      return;
    }
    await ensureArtifactDirectory();
    const written = await saveFeatureDraft(draft, out, strategy);
    if (options['--review']) await cleanupDraft(options['--review']);
    const action = strategy === 'merge' ? '合并' : strategy === 'overwrite' ? '覆盖' : '新建';
    console.log(`已${action} ${written.length} 个文件。${written.length ? '\n' + written.join('\n') : ''}`);
  } finally {
    rl?.close();
  }
}

/** 先完成正式解析与待确认项阻断；页面执行开放前仍明确返回能力边界。 */
async function guardRun(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0].startsWith('--')) throw new Error('用法：browser-test run <feature 文件>');
  const feature = await parseFeatureFile(args[0]);
  throw new Error(`run 尚未实现：已解析 Feature「${feature.title}」的 ${feature.scenarios.length} 个场景，但页面执行与报告将在后续阶段开放`);
}

/** 地址按页面集中确认；每次读取最新历史记录并刷新草案，供 Agent 分阶段交互使用。 */
async function addresses(args: string[]): Promise<void> {
  const [file, ...rest] = args;
  if (!file || file.startsWith('--')) throw new Error('需要草案名');
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!['--out', '--id', '--url', '--application', '--page', '--environment'].includes(name) || name in options || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`无效参数：${name}`);
    options[name] = rest[i + 1];
  }
  if (Boolean(options['--id']) !== Boolean(options['--url'])) throw new Error('确认时同时提供 --id 和 --url');
  if (!options['--id'] && ['--application', '--page', '--environment'].some(name => name in options)) throw new Error('页面身份须与 --id 和 --url 一起提供');
  const draftFile = draftStateFile(file, '草案');
  const out = outputDirectory(options['--out']);
  const draft: FeatureDraft = JSON.parse(await readFile(draftFile, 'utf8'));
  validateFeatureDraft(draft);
  let requests = await prepareAddresses(draft, out);
  if (options['--id']) {
    const request = requests.find(item => item.id === options['--id']);
    if (!request) throw new Error('没有该地址待确认项，请重新列出');
    confirmAddress(request, options['--url'], options['--application'], options['--page'], options['--environment']);
    requests = await prepareAddresses(draft, out);
  }
  validateFeatureDraft(draft);
  await ensureDraftStateDirectory();
  await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  await writePreview(file, draft);
  console.log(JSON.stringify({ pending: requests.map(request => ({ id: request.id, ...request.visit, scenarios: request.scenarios.map(s => s.title), candidates: request.candidates })), confirmed: draft.scenarios.filter(s => s.visit?.url).map(s => ({ title: s.title, ...s.visit })) }, null, 2));
}

/** 预览文件是草案的派生视图，每次都按最新草案覆盖；最终 feature 仍只经 --review --yes 创建。 */
async function writePreview(draftName: string, draft: FeatureDraft): Promise<string> {
  await ensureArtifactDirectory();
  const preview = artifactFile(draftName.replace(/\.json$/iu, '') + '.preview.feature', '草案预览');
  await writeFile(preview, renderDraftPreview(draft), 'utf8');
  return preview;
}

/** 最终 Gherkin 成功写入后清除草案机器状态与派生预览，目录中只留下最终文件。 */
async function cleanupDraft(draftName: string): Promise<void> {
  const state = draftStateFile(draftName, '草案');
  const preview = artifactFile(draftName.replace(/\.json$/iu, '') + '.preview.feature', '草案预览');
  await Promise.all([rm(state, { force: true }), rm(preview, { force: true })]);
}

/** todos 以 Gherkin 上下文展示待确认项（可用 --id 只看一项）；resolve 每次只改一项并刷新预览，改动后须重新列出编号。 */
async function todos(command: 'todos' | 'resolve', args: string[]): Promise<void> {
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error('缺少草案名');
  const draftFile = draftStateFile(file, '草案');
  const draft: FeatureDraft = JSON.parse(await readFile(draftFile, 'utf8'));
  validateFeatureDraft(draft);
  if (command === 'todos') {
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--id')) throw new Error('用法：feature todos <草案名> [--id <编号>]');
    const ids = args.length === 3 ? [args[2]] : listTodos(draft).map(item => item.id);
    console.log(ids.length ? ids.map(id => describeTodo(draft, id)).join('\n\n') : '无待确认项');
    return;
  }
  const [, id, action, ...rest] = args;
  if (!id || !action || rest.length) throw new Error('用法：feature resolve <草案名> <编号> keep|delete|"<完整步骤>"');
  if (action === 'keep' || action === 'delete') resolveTodo(draft, id, action);
  else {
    const match = /^(Given|When|Then|And) (.+)$/.exec(action);
    if (!match) throw new Error('替换内容须为完整步骤：Given|When|Then|And 原文');
    resolveTodo(draft, id, { replace: { keyword: match[1] as DraftStep['keyword'], text: match[2] } });
  }
  await ensureDraftStateDirectory();
  await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  const preview = await writePreview(file, draft);
  console.log(`已处理 ${id}；剩余待确认 ${listTodos(draft).length} 项（编号可能已变化，请重新 feature todos）。预览：${preview}`);
}

/** 有 --steps 时使用当前 Agent 起草的步骤，否则经 AI Gateway 起草；两者之后的校验与审阅流程一致。 */
async function buildDraft(options: Record<string, string>): Promise<FeatureDraft> {
  const input = options['--cases'] ? await loadCasesImport(options['--cases']) : options['--xmind'];
  return options['--steps'] ? draftFromAgentSteps(input, await loadAgentSteps(options['--steps'])) : generateFeatureDraft(input);
}

/** 逐条询问草案中的待确认项：替换步骤、删除或确认保留现有文字。 */
async function resolveTodos(draft: FeatureDraft, rl: ReturnType<typeof createInterface>): Promise<void> {
  for (const scenario of draft.scenarios) {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (!step.todo) continue;
      console.log(`\n${scenario.modulePath.join(' / ')} / ${scenario.title}\n${step.keyword} ${step.text}\n待确认：${step.todo}`);
      const answer = (await rl.question('输入完整替换步骤（Given/When/Then/And 原文）、delete 删除、keep 确认现有文字，或回车取消：')).trim();
      if (!answer) throw new Error('已取消，未写入 feature');
      if (answer === 'delete') { scenario.steps.splice(i--, 1); continue; }
      if (answer === 'keep' && step.text) { delete step.todo; continue; }
      const match = /^(Given|When|Then|And) (.+)$/.exec(answer);
      if (!match) throw new Error('确认输入无效，未写入 feature');
      scenario.steps[i] = { keyword: match[1] as DraftStep['keyword'], text: match[2] };
    }
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
