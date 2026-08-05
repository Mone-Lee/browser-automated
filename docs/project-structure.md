# 项目结构与发版边界

本文档说明当前 monorepo 的文件布局、源码职责和发版规则。两个 CLI 是独立 package，共享底层代码保持为仓库内源码，并在构建时进入各自的发布物。

## 对外产物

项目只对外发布两个 npm package：

| 包 | 定位 | 是否直接面向用户 |
| --- | --- | --- |
| `browser-opt` | 带截图、snapshot 和 PASS/FAIL 报告的自然语言浏览器工作流 CLI | 是 |
| `browser-e2e` | 自然语言驱动的 E2E 测试匹配、执行与 Playwright 生成 CLI | 是 |

`packages/browser-core/src` 只承载两个 CLI 共用的底层源码，不含 `package.json`，也不是 npm workspace。构建脚本会把它编译到目标 CLI 的 `dist/browser-core`，所以发布包没有额外的 core 依赖。

## 当前目录职责

```text
packages/
  browser-core/
    src/
      agent.ts           agent-browser 命令封装、session、可见浏览器、handoff/resume
      proxy-env.ts       agent-browser 子进程代理环境变量整理
      types.ts           TestCase、StepResult、AgentOptions 等共享类型
      index.ts           core 稳定导出

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
  build-package.mjs      将共享底层代码编译进指定 CLI，再构建 CLI 自身
  release.mjs            两个 CLI 的发版编排
  release-check.mjs      发版前检查和 npm pack 预演
```

## 源码与构建产物

- `packages/*/src` 只放源码。TypeScript 源码目录中不要提交 `.js`、`.d.ts`、`.map`。
- `packages/browser-opt/dist` 和 `packages/browser-e2e/dist` 是构建产物，由 `npm run build` 或单包构建生成。
- 两个 CLI 通过包内 `#browser-core` imports 映射访问随包发布的底层代码；npm 不会把它解析成外部依赖。

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

只改共享底层代码并需要刷新本地运行产物时：

```bash
npm run build -w browser-opt
npm run build -w browser-e2e
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

目标参数支持 `all`、`browser-opt`、`browser-e2e`；版本参数支持 `patch`、`minor`、`major`，默认是 `all patch`。

## 共享底层代码的发版规则

执行 `npm run release -- browser-opt patch` 或 `npm run release -- browser-e2e patch` 时，共享底层代码会直接进入目标包。修改共享代码后，需要发布哪些 CLI 由发版目标决定；`all` 会同时发布两个 CLI。

发版脚本会执行 typecheck、build、npm pack 预演、npm publish、git commit/tag/push。正式发版前建议只保留本次发布相关改动，避免把无关工作一起提交。

## 推荐阅读顺序

1. `README.md`：了解两个用户入口和快速命令。
2. `docs/project-structure.md`：确认 package 边界、源码目录和发版规则。
3. `packages/browser-core/src/agent.ts`：理解底层浏览器能力。
4. `packages/browser-opt/src/browser-opt/runner/index.ts`：理解 browser-opt 执行闭环。
5. `packages/browser-e2e/src/browser-e2e/test-reuse/service.ts`：理解 E2E 匹配、执行、生成闭环。
6. `packages/browser-e2e/src/browser-e2e/deterministic.ts`：理解确定性步骤和 handoff。
