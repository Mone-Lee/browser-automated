#!/usr/bin/env node
/** 提供 XMind 导入与引导生成入口；执行能力尚未开放。 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION, importXMind } from '../index.js';
import { createInterface } from 'node:readline/promises';
import { DRAFT_RULES, describeTodo, listTodos, renderDraftPreview, resolveTodo, draftFromAgentSteps, generateFeatureDraft, loadAgentSteps, loadCasesImport, validateFeatureDraft, reviewFeatureDraft, saveFeatureDraft } from '../feature-gen.js';
import { prepareAddresses, confirmAddress } from '../feature-address.js';
import type { FeatureDraft, DraftStep } from '../feature-gen.js';

const help = `browser-test ${VERSION}
用法：
  browser-test xmind list --xmind <文件> [--json | --output <JSON 文件>]
  browser-test feature gen --xmind <文件> --out <目录> [--draft <草案 JSON>]
  browser-test feature gen --cases <用例 JSON> --out <目录> [--draft <草案 JSON>]
  browser-test feature gen --xmind <文件>|--cases <用例 JSON> --steps <步骤 JSON> --out <目录> --draft <草案 JSON>
  browser-test feature gen --review <草案 JSON> --out <目录> [--yes]
  browser-test feature addresses <草案 JSON> --out <目录> [--id <编号> --url <完整地址> --application <应用> --page <页面> --environment <环境>]
  browser-test feature rules
  browser-test feature todos <草案 JSON> [--id <编号>]
  browser-test feature resolve <草案 JSON> <编号> keep|delete|"<Given|When|Then|And 完整步骤>"
  browser-test --help
  browser-test --version

--json 将完整结果输出到标准输出；--output 将相同内容写入 JSON 文件。
feature gen 支持交互确认；非交互生成须用 --draft 保存草案，再用 --review 审阅。
--cases 读取与 xmind list --json 同构的 JSON（如图片还原结果）。
起草有两种方式：默认经 AI Gateway，需要 AI_GATEWAY_API_KEY、BROWSER_TEST_MODEL；或由当前 Agent 按 feature rules 输出的规则起草步骤 JSON，
再用 --steps 传入（无需网关配置，补全与原文核对同网关路径）。审阅无需 AI。
--draft 同时写出 <草案>.preview.feature（Gherkin 预览，待确认项带编号）；todos 以 Gherkin 上下文逐项展示待确认项，resolve 每次处理一项并刷新预览。
生成阶段按应用、页面和环境复用 --out 中的已确认地址；缺失或冲突用 feature addresses 集中确认，确认一次应用于同页用例。
Gherkin 解析、run 和报告尚未实现。
`;

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
  if (args[0] === 'feature' || args[0] === 'run') {
    throw new Error('该能力尚未实现：当前支持 XMind 导入和 feature gen；解析、执行和报告将在后续阶段开放');
  }
  if (args[0] !== 'xmind' || args[1] !== 'list') throw new Error('不支持的命令，请使用 --help 查看用法');
  let filename: string | undefined;
  let json = false;
  let output: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--xmind' && filename === undefined && args[i + 1] && !args[i + 1].startsWith('--')) {
      filename = args[++i];
    } else if (args[i] === '--json' && !json) {
      json = true;
    } else if (args[i] === '--output' && output === undefined && args[i + 1] && !args[i + 1].startsWith('--')) {
      output = args[++i];
    } else {
      throw new Error(`无效或重复参数：${args[i]}`);
    }
  }
  if (!filename) throw new Error('缺少 --xmind <文件>');
  if (json && output) throw new Error('--json 与 --output 不能同时使用');
  const result = await importXMind(filename);
  if (output) {
    const outputFile = resolve(output);
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`JSON 已写入 ${outputFile}`);
  } else if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`导入 ${result.sheets.length} 个画布，识别 ${result.cases.length} 条用例（来源：${result.file}）`);
    for (const item of result.cases) {
      console.log(`\n${item.title}\n  模块：${item.modulePath.join(' / ')}`);
      if (item.structure === 'nested') console.log('  结构：按前置条件与操作子树识别为操作→预期嵌套布局，语义待确认');
    }
  }
  for (const warning of result.warnings) console.error(`提示 [${warning.path.join(' / ')}]：${warning.message}`);
}

/** 终端交互与 Agent 分阶段共用同一草案：交互时逐项确认后写入，非交互时先 --draft 保存，用户审阅后 --review --yes 落盘。 */
async function generate(args: string[]): Promise<void> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const isFlag = key === '--yes';
    if (!['--xmind', '--cases', '--steps', '--out', '--draft', '--review', '--yes'].includes(key) || key in options
      || (!isFlag && (!args[i + 1] || args[i + 1].startsWith('--')))) throw new Error(`无效或重复参数：${key}`);
    options[key] = isFlag ? 'true' : args[++i];
  }
  if (!options['--out'] || [options['--xmind'], options['--cases'], options['--review']].filter(Boolean).length !== 1) throw new Error('需要 --out，并且 --xmind、--cases 与 --review 三选一');
  if ((options['--draft'] && options['--review']) || (options['--yes'] && !options['--review'])) throw new Error('--draft 仅用于生成，--yes 仅用于审阅');
  if (options['--steps'] && options['--review']) throw new Error('--steps 仅用于生成');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options['--review'] && !options['--draft'] && !interactive) throw new Error('非交互生成请提供 --draft <草案 JSON>，待用户审阅后再用 --review');
  const draft: FeatureDraft = options['--review']
    ? JSON.parse(await readFile(resolve(options['--review']), 'utf8'))
    : await buildDraft(options);
  validateFeatureDraft(draft);
  let addressRequests = await prepareAddresses(draft, options['--out']);
  if (options['--draft']) {
    await writeFile(resolve(options['--draft']), `${JSON.stringify(draft, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const preview = await writePreview(options['--draft'], draft);
    console.log(`草案已保存：${resolve(options['--draft'])}；Gherkin 预览：${preview}\n地址待确认 ${addressRequests.length} 组（使用 feature addresses）；语义待确认 ${listTodos(draft).length} 项，请用 feature todos 逐项确认，再使用 --review。尚未写入 feature。`);
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
        addressRequests = await prepareAddresses(draft, options['--out']);
      }
      await resolveTodos(draft, rl);
    }
    if (addressRequests.length) console.log(`尚有 ${addressRequests.length} 组地址待确认，请使用 feature addresses <草案 JSON> --out <目录>`);
    const review = await reviewFeatureDraft(draft, options['--out']);
    console.log(review.diff);
    if (rl) {
      if ((await rl.question('\n确认以上全部内容并创建新文件？输入 yes：')).trim() !== 'yes') throw new Error('已取消，未写入 feature');
    } else if (!options['--yes']) {
      console.log('\n请在用户确认后加 --yes 落盘；待确认项必须先解决。');
      return;
    }
    const written = await saveFeatureDraft(draft, options['--out']);
    console.log(`已写入 ${written.length} 个新文件；已有文件未覆盖。${written.length ? '\n' + written.join('\n') : ''}`);
  } finally {
    rl?.close();
  }
}

/** 地址按页面集中确认；每次读取最新历史记录并刷新草案，供 Agent 分阶段交互使用。 */
async function addresses(args: string[]): Promise<void> {
  const [file, ...rest] = args;
  if (!file || file.startsWith('--')) throw new Error('需要草案 JSON');
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    if (!['--out', '--id', '--url', '--application', '--page', '--environment'].includes(name) || name in options || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`无效参数：${name}`);
    options[name] = rest[i + 1];
  }
  if (!options['--out'] || Boolean(options['--id']) !== Boolean(options['--url'])) throw new Error('需要 --out；确认时同时提供 --id 和 --url');
  if (!options['--id'] && ['--application', '--page', '--environment'].some(name => name in options)) throw new Error('页面身份须与 --id 和 --url 一起提供');
  const draft: FeatureDraft = JSON.parse(await readFile(resolve(file), 'utf8'));
  validateFeatureDraft(draft);
  let requests = await prepareAddresses(draft, options['--out']);
  if (options['--id']) {
    const request = requests.find(item => item.id === options['--id']);
    if (!request) throw new Error('没有该地址待确认项，请重新列出');
    confirmAddress(request, options['--url'], options['--application'], options['--page'], options['--environment']);
    requests = await prepareAddresses(draft, options['--out']);
  }
  validateFeatureDraft(draft);
  await writeFile(resolve(file), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  await writePreview(file, draft);
  console.log(JSON.stringify({ pending: requests.map(request => ({ id: request.id, ...request.visit, scenarios: request.scenarios.map(s => s.title), candidates: request.candidates })), confirmed: draft.scenarios.filter(s => s.visit?.url).map(s => ({ title: s.title, ...s.visit })) }, null, 2));
}

/** 预览文件是草案的派生视图，每次都按最新草案覆盖；最终 feature 仍只经 --review --yes 创建。 */
async function writePreview(draftFile: string, draft: FeatureDraft): Promise<string> {
  const preview = resolve(draftFile).replace(/\.json$/i, '') + '.preview.feature';
  await writeFile(preview, renderDraftPreview(draft), 'utf8');
  return preview;
}

/** todos 以 Gherkin 上下文展示待确认项（可用 --id 只看一项）；resolve 每次只改一项并刷新预览，改动后须重新列出编号。 */
async function todos(command: 'todos' | 'resolve', args: string[]): Promise<void> {
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error('缺少草案 JSON');
  const draft: FeatureDraft = JSON.parse(await readFile(resolve(file), 'utf8'));
  validateFeatureDraft(draft);
  if (command === 'todos') {
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--id')) throw new Error('用法：feature todos <草案 JSON> [--id <编号>]');
    const ids = args.length === 3 ? [args[2]] : listTodos(draft).map(item => item.id);
    console.log(ids.length ? ids.map(id => describeTodo(draft, id)).join('\n\n') : '无待确认项');
    return;
  }
  const [, id, action, ...rest] = args;
  if (!id || !action || rest.length) throw new Error('用法：feature resolve <草案 JSON> <编号> keep|delete|"<完整步骤>"');
  if (action === 'keep' || action === 'delete') resolveTodo(draft, id, action);
  else {
    const match = /^(Given|When|Then|And) (.+)$/.exec(action);
    if (!match) throw new Error('替换内容须为完整步骤：Given|When|Then|And 原文');
    resolveTodo(draft, id, { replace: { keyword: match[1] as DraftStep['keyword'], text: match[2] } });
  }
  await writeFile(resolve(file), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
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
