# browser-automated

同一代码库下维护两个独立 npm CLI 包：

- `browser-opt`：带截图、snapshot 和 PASS/FAIL 报告的自然语言浏览器工作流 CLI，负责即时执行与保存/复用 Workflow。
- `browser-e2e`：自然语言驱动的 E2E 测试匹配、执行与 Playwright 生成 CLI。

两者共享 `packages/browser-core/src` 中的底层实现，但该目录不是 npm package。构建时共享代码会分别进入两个 CLI 的发布物，因此它们都能独立安装和运行。

## 安装与环境初始化

`browser-opt` 的环境安装与 Workflow 执行使用独立命令，无需全局安装：

```bash
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install
```

`install` 默认检查并使用系统标准 Chrome，同时安装 Agent Skill；不会下载 Chrome for Testing。机器确实没有标准 Chrome 且接受测试浏览器时，才显式添加 `--download-browser`。所有命令统一通过 `npx` 调用，并显式指定 npmjs 官方源。

`browser-e2e`：

```bash
npx --yes browser-e2e setup
```

Linux 无桌面或缺少浏览器系统库，并明确使用下载浏览器时：

```bash
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --download-browser --with-deps
npx --yes browser-e2e setup --with-deps
```

`install`（`setup` 保留为兼容别名）默认把 browser-opt Skill 安装到 `~/.agents/skills/browser-opt`。若要安装到 Codex 专用目录，可在引导命令后传 `--agent codex`；若要写入其他 Agent 的 skills 根目录，可传 `--skills-dir <目录>`；若只需要 CLI，可传 `--skip-skill`。

常见 Agent 安装示例：

```bash
# Claude Code
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --skills-dir ~/.claude/skills
npx --yes browser-e2e setup --skills-dir ~/.claude/skills

# Codex
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --agent codex
npx --yes browser-e2e setup --agent codex

# GitHub Copilot
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --skills-dir ~/.copilot/skills
npx --yes browser-e2e setup --skills-dir ~/.copilot/skills

# Gemini
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --skills-dir ~/.gemini/skills
npx --yes browser-e2e setup --skills-dir ~/.gemini/skills

# Qoder
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --skills-dir ~/.qoder/skills
npx --yes browser-e2e setup --skills-dir ~/.qoder/skills
```

需要 Node.js 24 或更高版本。

## 使用

`browser-opt`：

```bash
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest "测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 验证页面包含 \"Example\"。"
```

保存并复用项目级 Workflow：

```bash
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest save "示例首页验证流程" --flow "测试 https://example.com。\n1. 验证页面包含 \"Example\"。"
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest run "执行示例首页验证流程"
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

- `packages/browser-core/src`：两个 CLI 共用的底层浏览器适配、session、handoff 与基础类型；不包含 package 配置，不独立发布
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

只改共享底层代码并需要刷新某个 CLI 的本地构建产物时：

```bash
npm run build -w browser-opt
npm run build -w browser-e2e
```

## 发版

```bash
npm run release:check
npm run release:dry-run -- all patch
npm run release -- browser-opt patch
npm run release -- browser-e2e patch
npm run release -- all minor
```

`browser-opt` 和 `browser-e2e` 的构建都会把共享底层代码编译进各自的 `dist/browser-core`。发版只发布这两个用户入口，不再发布或拉取独立的 core 包。

更多结构和发版边界见 `docs/project-structure.md`。
