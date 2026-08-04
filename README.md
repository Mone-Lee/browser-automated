# browser-automated

同一代码库下维护两个独立 npm CLI 包：

- `browser-opt`：带截图、snapshot 和 PASS/FAIL 报告的自然语言浏览器工作流 CLI，负责即时执行与保存/复用 Workflow。
- `browser-e2e`：自然语言驱动的 E2E 测试匹配、执行与 Playwright 生成 CLI。

两者共享 `packages/browser-core` 中的浏览器适配和基础类型，但各自独立发布、独立安装 Skill、独立维护 CLI 边界。

## 安装与首次初始化

`browser-opt`：

```bash
npx --yes browser-opt setup
```

`browser-e2e`：

```bash
npx --yes browser-e2e setup
```

Linux 无桌面或缺少浏览器系统库时，两者都支持：

```bash
npx --yes browser-opt setup --with-deps
npx --yes browser-e2e setup --with-deps
```

`setup` 默认分别安装到 `${CODEX_HOME:-~/.codex}/skills/browser-opt` 和 `${CODEX_HOME:-~/.codex}/skills/browser-e2e`。若只需要 CLI，可传 `--skip-skill`。

需要 Node.js 24 或更高版本。

## 使用

`browser-opt`：

```bash
npx --yes browser-opt "测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 验证页面包含 \"Example\"。"
```

保存并复用项目级 Workflow：

```bash
npx --yes browser-opt save "示例首页验证流程" --flow "测试 https://example.com。\n1. 验证页面包含 \"Example\"。"
npx --yes browser-opt run "执行示例首页验证流程"
```

Workflow 默认保存到调用项目的 `.browser-opt/workflows/`；运行证据默认保存到 `.browser-opt/artifacts/`。

`browser-e2e`：

```bash
npx --yes browser-e2e "测试网站 https://example.com/login 的登录功能。

目标：
1. 打开登录页面。
2. 输入用户名 \"testuser\" 和密码 \"password123\"。
3. 点击登录按钮。
4. 验证 URL 包含 /dashboard。"
```

也支持显式的 `run` / `gen` 子命令：

```bash
npx --yes browser-e2e run https://example.com "打开 pricing 页面并进入 contact 页面" --assert "Contact 页面应可见"
npx --yes browser-e2e gen https://example.com "打开 pricing 页面并进入 contact 页面" --name "pricing contact flow"
```

## 仓库结构

- `packages/browser-core/src`：两个 CLI 共享的浏览器适配、session、handoff 与基础类型；`src` 只保留 `.ts` 源码
- `packages/browser-opt/src`：`browser-opt` 包源码与 CLI
- `packages/browser-e2e/src`：`browser-e2e` 包源码与 CLI
- `packages/*/dist`：构建产物，由 `npm run build` 生成
- `packages/*/skills`：随对应 npm 包发布的 Skill

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
npm pack --dry-run -w browser-opt
npm pack --dry-run -w browser-e2e
```

只改 `browser-core` 并需要刷新本地构建产物时：

```bash
npm run build -w @browser-automated/browser-core
```

## 发版

```bash
npm run release:check
npm run release:dry-run -- all patch
npm run release -- browser-opt patch
npm run release -- browser-e2e patch
npm run release -- all minor
```

发 `browser-opt` / `browser-e2e` 时，脚本会自动探测 `packages/browser-core` 是否有变更；如果有，会先 bump、打包并发布 `@browser-automated/browser-core`，再把本次发布目标里的 core 依赖更新到新版本后继续发布。

更多结构和发版边界见 `docs/project-structure.md`。
