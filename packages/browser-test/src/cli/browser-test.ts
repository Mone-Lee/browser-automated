#!/usr/bin/env node
/** browser-test CLI 入口，当前仅提供 --help／--version，后续命令按技术设计文档逐步加入。 */
import { VERSION } from '../index.js';

const help = `browser-test ${VERSION}
用法：browser-test [--help] [--version]
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
} else {
  console.log(help);
}
