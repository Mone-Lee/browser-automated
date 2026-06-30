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

如果不使用全局 `npm link`，也可以在目标项目中安装本地包：

```bash
npm install -D /Users/lee/Documents/project/browser-automated
```

然后通过 `npx browser-opt "<自然语言流程>"` 执行 CLI。

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
node dist/cli/browser-opt.js "测试 https://example.com。

目标：
1. 打开首页。
2. 验证页面包含 \"Example\"。" --output-dir ./artifacts/browser-opt/smoke
```

这个命令会真正调用 `agent-browser` CLI，执行浏览器打开、snapshot、确定性动作、截图和报告生成。`browser-opt` 默认显示并保留真实浏览器窗口，便于观察操作流程和执行后的页面状态，但不会打开 agent-browser 的 `http://localhost:4848` 截图面板；如需无头执行，可额外传 `--no-live-viewport`。如需旧的 `agent-browser chat` 路径，可额外传 `--agent-chat`，但这可能需要 `AI_GATEWAY_API_KEY`。

执行后检查产物：

```bash
ls ./artifacts/browser-opt/smoke
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

- 只跑 `npm test -- tests/cli/browser-opt.test.ts`：测试 CLI 包装层，不触发真实浏览器。
- 直接跑 `node dist/cli/browser-opt.js ...`：触发真实 `agent-browser`，但不测试 Codex Skill 自动发现。
- 在 Codex 中按 `skills/browser-opt/SKILL.md` 要求执行：测试 Agent 遵守 Skill 文档以及真实 `agent-browser` 调用。
- 重开 Codex 后输入 `/browser-opt ...`：测试完整的 Skill 发现、触发、执行链路。
