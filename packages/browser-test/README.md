# browser-test

面向 Web 与微信小程序的用例驱动测试工具。当前设计从“用户只有一个包含测试用例的 XMind 文件，或者从其中截取的局部用例图片”出发：导入或解释原文、确认 Gherkin、执行步骤并输出证据报告。

已实现第 1–3 步：XMind 导入、Skill 入口与引导生成 Gherkin。尚不能解析或执行 Gherkin。

Skill 入口也支持解释从大型 XMind 中截取的局部用例图片：Agent 只还原图中可见的层级、操作和预期，并将裁切或模糊内容标记为待确认。图片不经 CLI 导入；如需继续生成 Gherkin，由 Agent 将还原结果保存为与 `xmind list --json` 同构的 JSON，再用 `feature gen --cases`。XMind 文件仍使用下方 CLI。

```bash
npm run build -w browser-test
node packages/browser-test/dist/cli/browser-test.js xmind list --xmind /path/to/cases.xmind
node packages/browser-test/dist/cli/browser-test.js xmind list --xmind /path/to/cases.xmind --json
node packages/browser-test/dist/cli/browser-test.js xmind list --xmind /path/to/cases.xmind --output cases.json
```

## 当前阶段的使用边界

- 生成只依赖 XMind 原文及用户对用例语义的确认，不读取业务路由源码，不要求业务仓库、应用映射或 `project.json`。
- 用例中的页面名称与导航操作保留为自然语言，不强制补齐路由；原文已有 URL 时保留。
- 生成时复用已确认地址，缺失或冲突时按页面集中请求用户确认；通过实际页面菜单、链接和按钮导航，无法唯一定位时请求确认或 BLOCKED。
- 登录与验证码按需人工接管，不要求预先制作登录态文件。非交互执行缺必要信息则 BLOCKED。
- 用例的数据前提仍须核对；当前不建设 mock 场景或要求业务代码接入。
- 先打通单应用 Web 只读闭环，再接入用户已打开的微信小程序；跨应用与业务写操作暂不执行。

生成已实现，执行仍为后续目标：

```bash
browser-test feature gen --xmind cases.xmind
browser-test run .browser-test/service-type-list.feature
```

## 当前实现状态

支持含 `content.json` 的现代 XMind ZIP 文件。旧版仅含 `content.xml` 的文件会提示使用新版 XMind 另存；损坏文件、非法节点及命令参数返回退出码 2，导入成功返回 0。

识别规则：主题的直属子节点中存在“操作／步骤／操作步骤／测试步骤”或“预期／预期结果／预期输出”字段时，将该主题列为用例；“前置条件／前提条件”作为前置字段。支持独立分组名、冒号同行内容（如“操作步骤：点击保存”）以及制表符分隔的内容，输出保留完整原文，不拆分标题。不完整用例会提示缺少分组。

没有操作、预期字段时，若直属节点包含前置条件，且其他直属节点至少有一个含附属子节点，则按“操作→预期”嵌套布局提取：前置条件以外的直属母节点作为操作，其直属子节点作为该操作的预期。生成时按原文顺序输出每组 When→Then/And，不因嵌套布局本身要求语义确认。用例编号不参与导入识别，也不作为结构化字段；原文中的编号仅随主题内容保留，缺失时不自动补造。操作的完整子树和路径保留对应关系；部分操作没有直属预期时按用例提示一次。其他未识别的叶节点保留在主题树并提示人工确认。

`--json` 向标准输出写入 JSON，`--output <文件名>` 将相同内容写入当前执行目录的 `.browser-test/`，两者不能同时使用。所有 browser-test 生成产物都固定写入该目录，目录不存在时自动创建；输入文件仍可位于任意位置。结果包含 `sheets`（完整主题树）、`cases`（用例及前置、步骤、预期节点）和 `warnings`。用例的 `structure` 为 `sections`（字段标记）或 `nested`（嵌套布局）。节点保留标题及整个子树，不将嵌套文本拼接或改写。节点包含原始属性 `raw`（备注、标签、优先级等，不含 id、title、children）和原文路径 `path`。来源文件记录在顶层 `file`，用例通过模块路径和标题定位。支持多画布及自由主题；主题深度最多 256 层，`content.json` 最多 32 MiB。默认文本模式输出用例标题和模块路径，并在汇总行标注来源文件，提示写入 stderr。

程序接口：

```ts
import { importXMind } from 'browser-test';
const { cases, sheets, warnings } = await importXMind('/path/to/cases.xmind');
```

导入只读取指定文件，不写中间资产，不读取 `project.json` 或业务源码，不需要 AI、浏览器、登录态或业务仓库。

`.browser-test/` 是本工具的固定产物目录；其中历史遗留的 `project.json` 不是本工具输入，使用者无需准备此文件。

项目预设、源码辅助和可复现数据配置，等实际使用证明能够提高效率后再评估，不预先规定配置协议。

完整流程及验收标准见[技术设计](../../docs/browser-test-technical-plan.md)。

## 引导生成与确认

生成使用 Vercel AI Gateway 的 [Chat Completions 接口](https://vercel.com/docs/ai-gateway/openai-compat/rest-api)，无需新增 SDK。环境变量 `AI_GATEWAY_API_KEY` 为网关密钥，`BROWSER_TEST_MODEL` 为可用模型标识（提供商/模型）。不默认选择模型；导入、草案审阅与落盘无需这些变量。

### 起草方式切换：网关 / 当前 Agent

起草步骤有两种可随时切换的方式，之后的草案校验、`--review`、`--yes` 流程完全一致：

- **AI Gateway（默认）**：配置上述两个环境变量，不带 `--steps`。
- **当前 Agent 代跑**：`browser-test feature rules` 输出与网关共用的起草规则；Agent 按规则写出步骤 JSON `{"cases":[{"modulePath":[],"title":"","steps":[{"keyword":"Given","text":"..."}]}]}`，再传入 `--steps`。无需网关配置，且同样经过缺失操作/预期补全和原文核对。

```bash
browser-test feature gen --cases cases.json --steps .browser-test/steps.agent.json --draft cases.draft.agent.json
```

### 逐项确认

`--draft` 保存草案 JSON 的同时写出 `<草案>.preview.feature`（Gherkin 预览，待确认项带 `# TODO(确认 #编号)`）。用 `feature todos <草案>` 查看每项待确认内容及所在场景的完整步骤，用 `feature resolve <草案> <编号> keep|delete|"<完整步骤>"` 每次处理一项并刷新预览；处理后编号可能变化，须重新列出。

两种方式对同一份用例各自保存草案（如 `*.draft.agent.json` 与 `*.draft.gateway.json`），可直接 diff 对比效果。

终端交互：

```bash
browser-test feature gen --xmind cases.xmind
```

逐项处理语义 TODO，输入完整替换步骤、`keep` 确认现有文字或 `delete` 删除；随后展示完整差异，输入 `yes` 才写入。取消或错误返回 2，不把草案当作已确认用例。原文多行按步骤拆分，页面名称保持自然语言，缺少 URL 可保存草案，但须在生成阶段确认后才能落盘为最终用例。相同模块路径下重名用例拒绝生成，须先区分来源。

Agent 或非交互环境分阶段操作：

```bash
browser-test feature gen --xmind cases.xmind --draft draft.json
# 向用户展示原文和草案；按回答修改步骤，清除已解决的 todo 或删除获准删除的步骤
browser-test feature gen --review draft.json
# 用户确认完整差异后追加 --yes 落盘
browser-test feature gen --review draft.json --yes
```

`--draft` 在 `.browser-test/` 下排他创建 JSON，并同时创建预览，不会写 feature。`--review` 不带 `--yes` 时仅展示差异。草案或已有文件变化后须重新审阅。所有待确认项必须处理完毕，才能落盘。

同一模块路径的用例合并为一个 feature，模块路径作为 Feature 名，文件头为 `# source: <文件> / <模块路径>`；文件名由模块路径组成。步骤文字若未在原文中找到会标为待确认。仅输出来源注释、Feature、Scenario、原文已有优先级和 Given/When/Then/And，不新增业务字段。已有文件只展示差异且从不覆盖，包括人工修改过的文件。首次创建用排他写入避免并发覆盖；如写入中断，已经创建的文件保留，再次审阅后可补齐剩余文件。

`--cases <用例 JSON>` 可替代 `--xmind`（三者 `--xmind`/`--cases`/`--review` 恰选其一），用法与 `--draft`、`--review` 相同；JSON 中标注“需确认”的内容会生成待确认项，`file` 作为来源。

草案格式为 `{ source, scenarios: [{ title, modulePath, priority?, steps: [{ keyword, text, todo? }] }] }`。这是生成阶段的审阅协议，不是第 4 步的 Gherkin 解析器。语义忠实度需人工核对；AI 输出错误或不完整时返回 2，不回退为伪造结果。

### 整文件确认

不希望逐项交互时，使用 `--direct` 一次性创建按模块拆分的 `.feature` 文件：

```bash
browser-test feature gen --cases cases.json --steps .browser-test/steps.agent.json --direct
```

该模式跳过地址和语义的逐项确认，所有不确定内容以 `# TODO(确认)` 留在 Gherkin 中，调用方直接编辑整个文件。它与最终落盘模式一样不会覆盖已有 `.feature`。只要文件仍含 `# TODO(确认)` 或 `# 待确认`，后续 `run` 就会列出文件与行号并停止；全部清除后才进入执行阶段。当前执行能力尚未实现，因此无待确认项时 `run` 仍会说明该能力尚未开放。

### 页面地址确认与复用

Web 草案生成时自动按应用、页面和环境合并地址问题，优先使用同批已确认地址，再读取 `.browser-test/` 中的最终 `.feature`。唯一匹配直接复用；缺失或冲突留待确认。不会读取预览草案、含待确认项的场景或符号链接，也不会猜测域名、拼接路由。

```bash
browser-test feature addresses draft.json
browser-test feature addresses draft.json --id 1 --url 'https://example.com/products'
# 原文身份不明确时，在确认地址时补齐；环境不同须明确指定
browser-test feature addresses draft.json --id 1 --url 'https://example.com/products' --application '中台管理系统' --page '供应链商品库管理列表' --environment '测试'
```

命令更新草案及预览，返回剩余地址分组和已确认地址来源。一次确认应用到该组所有场景；每个最终场景保存独立的地址 Given 和页面来源注释。仍缺地址时拒绝落盘，整体审阅与 `--review --yes` 流程不变。已有文件不覆盖。

Agent 步骤 JSON 可提供 `platform: "web" | "miniprogram" | "unsupported"`，以及 `visit: {application, page, environment?}`（仅提取原文身份）。旧草案默认 Web，常见“已登录应用”“进入页面”句式可自动提取；无法明确识别时通过上述参数确认。小程序明确标为 `miniprogram`，不要求 URL。
