#!/usr/bin/env node
/**
 * CLI for the browser-automated natural language e2e test runner.
 *
 * Usage:
 *   browser-automated run    <test-file.json>    Run test cases from a JSON file
 *   browser-automated gen    <url> <description> Generate a test case from a description
 *   browser-automated chat   <url> <instruction> Run a one-shot natural language instruction
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NaturalLanguageTestRunner } from './runner.js';
import { TestCaseGenerator } from './generate.js';
import { BrowserAgent } from './agent.js';
import type { TestCase, TestRunSummary } from './types.js';

const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
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
    default:
      printUsage();
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRun(args: string[]): Promise<void> {
  const [filePath, ...flags] = args;

  if (!filePath) {
    console.error('Usage: browser-automated run <test-file.json> [--bail] [--screenshot-on-failure]');
    process.exit(1);
  }

  const bail = flags.includes('--bail');
  const screenshotOnFailure = flags.includes('--screenshot-on-failure');

  let testCases: TestCase[];
  try {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    testCases = Array.isArray(parsed) ? (parsed as TestCase[]) : [parsed as TestCase];
  } catch (err) {
    console.error(`Failed to read test file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
    return; // unreachable but satisfies TypeScript definite assignment
  }

  const runner = new NaturalLanguageTestRunner({ bail, screenshotOnFailure });
  const summary = await runner.run(testCases);

  printSummary(summary);
  process.exit(summary.failed > 0 ? 1 : 0);
}

async function cmdGen(args: string[]): Promise<void> {
  const [url, ...descParts] = args;
  const description = descParts.join(' ');

  if (!url || !description) {
    console.error('Usage: browser-automated gen <url> <description>');
    process.exit(1);
  }

  const generator = new TestCaseGenerator();
  const testCase = await generator.generate(url, description);
  console.log(JSON.stringify(testCase, null, 2));
}

async function cmdChat(args: string[]): Promise<void> {
  const [url, ...instrParts] = args;
  const instruction = instrParts.join(' ');

  if (!url || !instruction) {
    console.error('Usage: browser-automated chat <url> <instruction>');
    process.exit(1);
  }

  const agent = new BrowserAgent();
  try {
    agent.open(url);
    const output = agent.chat(instruction);
    console.log(output);
  } finally {
    agent.close();
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printSummary(summary: TestRunSummary): void {
  console.log('\n=== Test Run Summary ===');
  console.log(`Total:  ${summary.total}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`Duration: ${summary.duration}ms\n`);

  for (const result of summary.results) {
    const icon = result.passed ? '✓' : '✗';
    console.log(`${icon} ${result.name} (${result.duration}ms)`);

    for (const step of result.steps) {
      const stepIcon = step.passed ? '  ✓' : '  ✗';
      console.log(`${stepIcon} ${step.instruction}`);
      if (step.error) {
        console.log(`      Error: ${step.error}`);
      }
    }

    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  }
}

function printUsage(): void {
  console.log(`
Usage: browser-automated <command> [options]

Commands:
  run  <test-file.json>  [--bail] [--screenshot-on-failure]
       Run e2e test cases defined in a JSON file.

  gen  <url> <description>
       Generate a test case JSON from a natural language description.

  chat <url> <instruction>
       Execute a single natural language instruction in the browser.

Examples:
  browser-automated run tests/login.json --screenshot-on-failure
  browser-automated gen https://example.com "Fill the contact form and submit"
  browser-automated chat https://example.com "Click the sign-in button"
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
