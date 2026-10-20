#!/usr/bin/env node
/** 提供版本查询与无配置的 XMind 用例列表入口；生成和执行命令尚未开放。 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION, importXMind } from '../index.js';

const help = `browser-test ${VERSION}
用法：
  browser-test xmind list --xmind <文件> [--json | --output <JSON 文件>]
  browser-test --help
  browser-test --version

--json 将完整结果输出到标准输出；--output 将相同内容写入 JSON 文件。
当前仅支持 XMind 导入；feature gen、Gherkin 解析、run 和报告尚未实现。
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
  if (args[0] === 'feature' || args[0] === 'run') {
    throw new Error('该能力尚未实现：当前仅支持 XMind 导入，请使用 xmind list --xmind <文件>；生成、解析、执行和报告将在后续阶段开放');
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
    console.log(`导入 ${result.sheets.length} 个画布，识别 ${result.cases.length} 条用例`);
    for (const item of result.cases) {
      console.log(`\n${item.title}\n  模块：${item.modulePath.join(' / ')}\n  来源：${item.source.file}#${item.source.nodeId}（画布 ${item.source.sheetId}）`);
      if (item.structure === 'nested') console.log('  结构：按前置条件与操作子树识别为操作→预期嵌套布局，语义待确认');
    }
  }
  for (const warning of result.warnings) console.error(`提示 [${warning.source.sheetId}/${warning.source.nodeId}]：${warning.message}`);
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
