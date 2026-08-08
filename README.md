# browser-automated

同一代码库下维护两个独立 npm CLI 包：

- `browser-opt`：面向“现在就让浏览器把这件事跑完”。它执行自然语言工作流，产出截图、snapshot、运行证据和 PASS/FAIL 报告，也能保存/复用 Workflow。
- `browser-e2e`：面向“把自然语言需求沉淀成可重复测试”。它匹配已有 E2E 用例、执行测试，并生成 Playwright 测试代码。

两者共享 `packages/browser-core/src` 中的底层实现，但该目录不是 npm package。构建时共享代码会分别进入两个 CLI 的发布物，因此它们都能独立安装和运行。

## browser-opt 与 browser-e2e 怎么选

| 你想做的事 | 使用 | 结果 |
| --- | --- | --- |
| 让浏览器立刻完成一次操作、调试页面、拿到执行证据 | `browser-opt` | 一次运行报告、截图、snapshot、PASS/FAIL |
| 把常见流程保存下来，下次用一句话复跑 | `browser-opt save` / `browser-opt run` | 项目级 `.browser-opt/workflows/` |
| 复用或生成可进 CI 的端到端测试 | `browser-e2e` | Playwright 测试匹配、执行或生成 |
| 想要人工接管后继续同一次浏览器流程 | `browser-opt` | handoff 后恢复原运行 |

简单说：`browser-opt` 是执行器和证据记录器；`browser-e2e` 是测试资产管理和 Playwright 生成器。前者更适合临时验证、运营流程和人工协作，后者更适合沉淀自动化测试。

## 安装与环境初始化

### browser-opt

#### 临时试用

只想试用、不安装 cli 和 Skill，可直接运行：

```bash
npx -p browser-opt@latest -p agent-browser@latest browser-opt "
执行创建药品分类商品流程
目标：
1. 打开页面https://test-ecmiddle.ifengqun.com/#/Home/goodsManage/GoodsDetaiManage/preFill?type=1&page=goodManage
2. 商品标题输入“自动化创建药品分类商品”
"
```

#### 安装

首次安装执行：

```bash
npx browser-opt@latest install --registry=https://registry.npmjs.org/
```

该命令会一次性安装或更新全局 `browser-opt`、`agent-browser` 及 `browser-opt` Skill。默认 Skill 目录为 `~/.agents/skills/browser-opt`，Codex、GitHub Copilot、Gemini CLI 和 Qoder 可共用，无需分别安装。Claude Code 使用自己的目录：

```bash
npx browser-opt@latest install --registry=https://registry.npmjs.org/ --agent claude
```

#### 更新

后续更新所有已安装组件：

```bash
browser-opt update
```

如果安装时用了 `--agent claude`，更新时也传入同一参数。

```bash
browser-opt update --agent claude
```

`browser-opt update` 会优先更新当前正在执行这条命令的那份安装前缀，避免机器上存在多个全局前缀时把包装到别处。只有当当前 shell 仍解析到旧二进制、`update` 不可用，或你明确要绕过现有全局命令时，才回退到下面这条安装命令：

```bash
npx browser-opt@latest install --registry=https://registry.npmjs.org/
```

#### 卸载

卸载首次安装写入的全局 CLI、运行时和 Skill：

```bash
browser-opt uninstall
```

如果安装时用了 `--agent claude`，卸载时也传入同一参数。

```bash
browser-opt uninstall --agent claude
```

只有确认要删除当前项目的 `.browser-opt` 登录态、报告和 handoff 记录时，卸载才追加 `--all-data`。 
 
```bash
browser-opt uninstall --all-data
```

#### 环境说明

`install`、`update` 和试用命令默认使用系统标准 Chrome，不会下载 Chrome for Testing。机器没有标准 Chrome 且接受测试浏览器时，安装或更新可追加 `--download-browser`；试用前则需自行准备 Chrome。若执行 `install` 或 `update` 后 shell 仍指向旧的 `browser-opt`，请按命令输出提示调整 PATH 或重开终端。

### browser-e2e

#### 初始化

`browser-e2e` 不依赖上面的 `browser-opt install`。只在需要 E2E 测试匹配、执行或生成时单独初始化：

```bash
npx --yes browser-e2e setup
```

Linux 无桌面或缺少浏览器系统库，并明确使用下载浏览器时：

```bash
npx browser-opt@latest install --registry=https://registry.npmjs.org/ --download-browser --with-deps
npx --yes browser-e2e setup --with-deps
```

`install`（`setup` 保留为兼容别名）还支持 `--skills-dir <目录>` 自定义 Skill 根目录、`--skip-skill` 只处理运行时，以及 `--skip-runtime` 只安装 Skill。Skill 每次执行前会用 `browser-opt check-update --json` 轻量检查新版本。

需要 Node.js 24 或更高版本。

## 使用

### browser-opt：一次性执行与 Workflow 复用

```bash
browser-opt "测试 https://example.com 的搜索功能。

目标：
1. 打开首页。
2. 验证页面包含 \"Example\"。"
```

保存并复用项目级 Workflow：

```bash
browser-opt save "示例首页验证流程" --flow "测试 https://example.com。\n1. 验证页面包含 \"Example\"。"
browser-opt run "执行示例首页验证流程"
```

Workflow 默认保存到调用项目的 `.browser-opt/workflows/`；运行证据默认保存到 `.browser-opt/artifacts/`。

### browser-e2e：E2E 测试复用与 Playwright 生成

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
