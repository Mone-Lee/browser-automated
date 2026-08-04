# 项目结构与发版边界

本文档说明当前 monorepo 的文件布局、包职责和发版规则。项目已经从根 `src/` 拆分到 `packages/*/src`，源码应保持在各自 package 内，构建产物统一输出到对应的 `dist/`。

## 对外产物

项目对外发布三个 npm package，其中 `browser-core` 是内部共享基础包，另外两个是用户直接使用的 CLI / Skill：

| 包 | 定位 | 是否直接面向用户 |
| --- | --- | --- |
| `@browser-automated/browser-core` | 封装 `agent-browser`、浏览器 session、handoff 和共享类型 | 否 |
| `browser-opt` | 带截图、snapshot 和 PASS/FAIL 报告的自然语言浏览器工作流 CLI | 是 |
| `browser-e2e` | 自然语言驱动的 E2E 测试匹配、执行与 Playwright 生成 CLI | 是 |

`browser-opt` 和 `browser-e2e` 都依赖 `@browser-automated/browser-core`。本地开发通过 npm workspaces 直接引用本地包，不需要每次修改 core 都发布；只有正式发版给仓库外使用时才发布 core。

## 当前目录职责

```text
packages/
  browser-core/
    src/
      agent.ts           agent-browser 命令封装、session、可见浏览器、handoff/resume
      proxy-env.ts       agent-browser 子进程代理环境变量整理
      types.ts           TestCase、StepResult、AgentOptions 等共享类型
      index.ts           core 稳定导出
    dist/                构建产物，只由 tsc 生成
    package.json         @browser-automated/browser-core 包配置

  browser-opt/
    src/
      browser-opt/
        runner/          browser-opt 主流程、步骤执行、证据采集、handoff
        workflow/        Workflow 保存、匹配和读取
        type.ts          browser-opt 本地类型
        utils.ts         步骤解析、节点匹配、验证辅助
        index.ts         browser-opt 稳定导出
      cli/               browser-opt bin 入口、命令解析和输出
    skills/browser-opt/  随包发布的 Codex/Agent Skill
    dist/                构建产物

  browser-e2e/
    src/
      browser-e2e/
        deterministic.ts 确定性步骤执行和 handoff
        generate.ts      自然语言描述到 TestCase 的生成
        runner.ts        结构化 JSON TestCase 运行器
        test-reuse/      已生成测试匹配、索引、Playwright spec 生成
        index.ts         browser-e2e 稳定导出
      cli/               browser-e2e bin 入口、命令解析和输出
    skills/browser-e2e/  随包发布的 Codex/Agent Skill
    dist/                构建产物

skills/
  browser-opt/           仓库级 Skill 源文件副本
  browser-e2e/           仓库级 Skill 源文件副本

tests/
  core/                  core 共享能力测试
  browser-opt/           browser-opt 执行闭环测试
  browser-e2e/           E2E 执行、生成与测试复用链路测试
  cli/                   CLI 用户侧行为测试
  generated/             自动生成的 Playwright 测试与索引

docs/
  project-structure.md   当前结构、职责和发版边界
  implementation-plan.md 阶段规划
  browser-opt-debug.md   browser-opt 调试说明

scripts/
  release.mjs            发版编排，自动探测 core 变更
  release-check.mjs      发版前检查和 npm pack 预演
```

## 源码与构建产物

- `packages/*/src` 只放源码。TypeScript 包中不要提交 `.js`、`.d.ts`、`.map`。
- `packages/*/dist` 是构建产物，由 `npm run build` 或单包 `npm run build -w <package>` 生成。
- package 的 `main`、`types`、`exports` 指向 `dist`，源码内跨包导入使用 workspace 包名，例如 `@browser-automated/browser-core/agent`。

## 修改边界

- 改 `agent-browser` 命令封装、session、代理环境、共享类型时，优先改 `packages/browser-core/src`。
- 改一次性自然语言网页操作、证据报告、Workflow 时，优先改 `packages/browser-opt/src`。
- 改 E2E 用例生成、复用索引、Playwright spec 生成时，优先改 `packages/browser-e2e/src`。
- 不要把 `browser-opt` 或 `browser-e2e` 的业务编排放进 core；core 只承载共享底层能力。

## 本地开发

```bash
npm ci
npm run typecheck
npm run build
npm test
```

只改 core 并需要刷新本地运行产物时：

```bash
npm run build -w @browser-automated/browser-core
```

## 发版命令

完整检查：

```bash
npm run release:check
```

预演发版：

```bash
npm run release:dry-run -- browser-opt patch
npm run release:dry-run -- browser-e2e patch
npm run release:dry-run -- all patch
```

正式发版：

```bash
npm run release -- browser-opt patch
npm run release -- browser-e2e patch
npm run release -- all minor
```

目标参数支持 `all`、`browser-core`、`browser-opt`、`browser-e2e`；版本参数支持 `patch`、`minor`、`major`，默认是 `all patch`。

## core 自动发版规则

执行 `npm run release -- browser-opt patch` 或 `npm run release -- browser-e2e patch` 时，脚本会检查 `packages/browser-core` 相对当前 `HEAD` 是否有 tracked 或 untracked 变更。

- 如果 core 没有变化，只发布目标包。
- 如果 core 有变化，先发布 `@browser-automated/browser-core`。
- core 发布后，脚本会把本次发布目标中依赖 core 的包的 `@browser-automated/browser-core` 版本更新为新的精确版本，再继续发布目标包。
- `all` 会发布 `browser-opt` 和 `browser-e2e`，并在 core 有变化时自动把 core 插到最前面。

发版脚本会执行 typecheck、build、npm pack 预演、npm publish、git commit/tag/push。正式发版前建议只保留本次发布相关改动，避免把无关工作一起提交。

## 推荐阅读顺序

1. `README.md`：了解两个用户入口和快速命令。
2. `docs/project-structure.md`：确认 package 边界、源码目录和发版规则。
3. `packages/browser-core/src/agent.ts`：理解底层浏览器能力。
4. `packages/browser-opt/src/browser-opt/runner/index.ts`：理解 browser-opt 执行闭环。
5. `packages/browser-e2e/src/browser-e2e/test-reuse/service.ts`：理解 E2E 匹配、执行、生成闭环。
6. `packages/browser-e2e/src/browser-e2e/deterministic.ts`：理解确定性步骤和 handoff。
