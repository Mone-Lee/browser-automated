# browser-opt Skill 使用与调试说明

本文档说明 `browser-opt` 在其他项目中作为 Codex Skill 使用时的安装方式，以及当前项目中如何区分 CLI、真实 `agent-browser` 调用和 Codex Skill 触发链路的测试。

## 在其他项目使用 /browser-opt

`/browser-opt` 要在其他项目中可用，需要同时满足两个条件：

- Codex 能发现 `skills/browser-opt`。
- `browser-opt` CLI 命令能在目标项目中执行。

推荐在本项目执行：

```bash
cd /Users/lee/Documents/project/browser-automated
npm install
npm run build
npm link
ln -sfn /Users/lee/Documents/project/browser-automated/skills/browser-opt ~/.codex/skills/browser-opt
```

其中：

- `npm link` 让其他项目可以直接调用 `browser-opt` 命令。
- `ln -sfn ... ~/.codex/skills/browser-opt` 让 Codex 能发现 `/browser-opt` Skill。

完成后，重开 Codex 会话，在其他项目中即可输入：

```text
/browser-opt 测试 https://example.com。

目标：
1. 打开首页。
2. 验证页面包含 "Example"。
```

开发期在普通终端里可以使用全局 `npm link` 后的 `browser-opt ...` 命令。正式环境统一通过
`npx` 调用，并固定 npmjs 官方源：

```bash
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest install --agent codex
```

该命令会保持 `browser-opt` 通过 `npx @latest` 获取最新版本，同时预装或更新全局 `agent-browser` 运行时。卸载运行时和 Skill：

```bash
npx --yes --registry=https://registry.npmjs.org/ browser-opt@latest uninstall --agent codex
```

Codex 通过软链 Skill 触发时会按 Skill 统一使用 `npx`。只有需要验证尚未发布的本地源码时，
才显式调用当前仓库的构建产物：

```bash
/Users/lee/.nvm/versions/node/v24.11.1/bin/node /Users/lee/Documents/project/browser-automated/packages/browser-opt/dist/cli/browser-opt.js
```

注意：跨项目触发的 Skill sandbox 可能没有权限读取本仓库的 `package.json`，
所以不要在 Skill 调用时执行 `npm --prefix ... run build`。需要在本仓库安装、
更新或修改源码后，先回到本仓库执行 `npm run build`。

如果不使用全局 `npm link`，也可以在目标项目中安装本地包：

```bash
npm install -D /Users/lee/Documents/project/browser-automated
```

然后可以通过项目脚本、`node_modules/.bin/browser-opt "<自然语言流程>"` 或统一的 `npx` 命令执行 CLI。

## 保存并一句话调用 Workflow

可复用流程默认保存在执行命令项目的 `.browser-opt/workflows/` 目录：

```bash
browser-opt save "创建安选公开直播流程" --flow "测试 https://example.com/live/create。

目标：
1. 打开创建页面。
2. 验证页面显示直播间名称。"
```

同名流程默认拒绝覆盖；确认更新时显式添加 `--force`。如需使用其他目录，
保存、匹配和运行时都传入同一个 `--workflow-dir <目录>`。

查看和匹配已保存流程：

```bash
browser-opt list
browser-opt match "执行创建安选公开直播流程" --json
browser-opt run "执行创建安选公开直播流程"
```

在 Codex 中可以直接输入：

```text
/browser-opt 执行创建安选公开直播流程
```

Skill 会先匹配当前项目中的 Workflow。名称精确命中或唯一候选足够强时才直接执行；
相似但不够强的候选会先展示并等待选择，最多展示最接近的三个；未命中时展示当前可用流程，
不会把缺少 URL 的短句误当成即时流程执行。

## 登录态与 handoff

`browser-opt` 默认优先使用当前项目 `.browser-opt/states/` 下保存的 state 文件，只复用 cookies/storage，不恢复历史 Chrome 标签页。首次没有 state 时，唯一主 agent 直接使用 `--profile Default` 打开目标页并保存 state，不会先开一个导入窗口再切换窗口。

当已有默认 state 打开目标页面后被拦到登录页时，CLI 关闭当前 state 窗口，切换到所选 Chrome Profile 的可见实例后再进入 handoff，以便人工使用 Chrome 密码管理器：

1. 在可见浏览器里手动完成登录、验证码、OAuth 或 MFA。
2. 回到终端输入 `done`、`ok`、`继续` 或 `完成`。
3. `browser-opt` 恢复同一 session，等待页面离开登录态后保存新的 state，再继续后续步骤。

终端直接运行时，handoff 后应把 `done` 写回同一个进程。Codex 执行已保存 Workflow 时应通过 `start --workflow-id ... --json` 启动后台 runner，保存返回的 `runId`；用户确认后调用 `resume --run-id ...`，不要依赖跨 turn 会失效的 PTY session，也不要重新执行 workflow。

默认 state 每轮最多回退一次 profile，后续的 handoff、resume 和自动化都复用该 profile 实例。显式传 `--state <path>` 表示使用隔离 state，不会自动回退到 profile。

## 修改后的生效规则

如果已经执行过 `npm link`，当前项目继续修改 CLI 或 Skill 后，生效规则如下：

- 修改 `src/**` 中的 CLI 或执行逻辑后，需要在当前项目重新执行 `npm run build`。
- 修改 `skills/browser-opt/SKILL.md` 或 `skills/browser-opt/manifest.json` 后，软链会直接指向最新文件，不需要复制或重新 build。
- Codex 会话通常在启动时加载 Skill 列表和触发说明；修改 Skill 文档、触发词或 manifest 后，建议重开 Codex 会话。

最稳的本地更新流程：

```bash
cd /Users/lee/Documents/project/browser-automated
npm run build
```

如果这次也改了 `skills/browser-opt/*`，再重开使用 `/browser-opt` 的 Codex 会话。

## 当前项目即时测试

当前项目中可以按三层测试 `browser-opt`。

### 1. 测 CLI 参数和报告生成逻辑

```bash
npm test -- tests/cli/browser-opt.test.ts
```

这个测试不会真的打开浏览器。测试文件会注入一个假的 `agent-browser` 命令，用来覆盖参数处理、模板输出、报告目录生成等用户侧行为。

### 2. 测真实 agent-browser 执行

```bash
npm run build
node packages/browser-opt/dist/cli/browser-opt.js "测试 https://example.com。

目标：
1. 打开首页。
2. 验证页面包含 \"Example\"。" --output-dir ./.browser-opt/artifacts/smoke
```

这个命令会真正调用 `agent-browser` CLI，执行浏览器打开、snapshot、确定性动作、截图和报告生成。`browser-opt` 默认显示并保留真实浏览器窗口，便于观察操作流程和执行后的页面状态，但不会打开 agent-browser 的 `http://localhost:4848` 截图面板；如需无头执行，可额外传 `--no-live-viewport`。如需旧的 `agent-browser chat` 路径，可额外传 `--agent-chat`，但这可能需要 `AI_GATEWAY_API_KEY`。

测试受保护页面时，如果终端提示 `Browser Opt Handoff`，请在当前可见浏览器中完成登录，然后在同一个终端输入 `done` 继续。恢复后会继续使用同一 session，不会重新打开目标页面覆盖用户刚完成的登录状态。

执行后检查产物：

```bash
ls ./.browser-opt/artifacts/smoke
```

预期能看到 `report.json`、`report.md`、截图和 snapshot 文件。

### 3. 测 Codex 按 Skill 规则执行

如果当前 Codex 会话还没有加载 `browser-opt` Skill，可以直接要求 Agent 按本仓库的 Skill 文档执行：

```text
按 skills/browser-opt/SKILL.md 的规则，运行 browser-opt 测试 https://example.com，目标：验证页面包含 Example。
```

这种方式可以测试两件事：

- Agent 是否遵守 `skills/browser-opt/SKILL.md` 中定义的执行和报告要求。
- CLI 是否真正触发 `agent-browser`。

如果要测试 `/browser-opt` 这个 slash 入口本身是否被 Codex 自动识别，需要先建立 `~/.codex/skills/browser-opt` 软链，并重开 Codex 会话后再输入 `/browser-opt ...`。

## 常见判断

- 已执行 `npm link`：优先直接使用 `browser-opt ...`，这是当前项目联调其他仓库时最稳的方式。
- 软链 Skill 在 Codex 中触发：优先按 `SKILL.md` 使用绝对路径调用当前仓库的 `packages/browser-opt/dist/cli/browser-opt.js`，避免执行环境没有全局 npm bin。
- 目标项目安装了本地包：使用 `node_modules/.bin/browser-opt ...`；已全局安装时直接使用 `browser-opt ...`。
- 只跑 `npm test -- tests/cli/browser-opt.test.ts`：测试 CLI 包装层，不触发真实浏览器。
- 直接跑 `node packages/browser-opt/dist/cli/browser-opt.js ...`：触发真实 `agent-browser`，但不测试 Codex Skill 自动发现。
- 在 Codex 中按 `skills/browser-opt/SKILL.md` 要求执行：测试 Agent 遵守 Skill 文档以及真实 `agent-browser` 调用。
- 重开 Codex 后输入 `/browser-opt ...`：测试完整的 Skill 发现、触发、执行链路。
- 登录态失效并看到 handoff：在当前浏览器里完成登录；终端直接运行时输入 `done`，Codex Workflow 则对原 `runId` 执行 `resume`；不要重跑保存流程命令。
