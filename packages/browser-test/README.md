# browser-test

面向 Web 与微信小程序的用例驱动测试工具。当前设计从“用户只有一个包含测试用例的 XMind 文件”出发：导入原文、确认 Gherkin、执行步骤并输出证据报告。

已实现第 1、2 步：无配置导入 XMind 并列出用例，以及 Skill 调用入口。尚不能生成或执行 Gherkin。

```bash
npm run build -w browser-test
node packages/browser-test/dist/cli/browser-test.js xmind list --xmind /path/to/cases.xmind
node packages/browser-test/dist/cli/browser-test.js xmind list --xmind /path/to/cases.xmind --json
node packages/browser-test/dist/cli/browser-test.js xmind list --xmind /path/to/cases.xmind --output /path/to/cases.json
```

## 当前阶段的使用边界

- 生成只依赖 XMind 原文及用户对用例语义的确认，不读取业务路由源码，不要求业务仓库、应用映射或 `project.json`。
- 用例中的页面名称与导航操作保留为自然语言，不强制补齐路由；原文已有 URL 时保留。
- 执行时缺少访问地址再请求用户提供；通过实际页面菜单、链接和按钮导航，无法唯一定位时请求确认或 BLOCKED。
- 登录与验证码按需人工接管，不要求预先制作登录态文件。非交互执行缺必要信息则 BLOCKED。
- 用例的数据前提仍须核对；当前不建设 mock 场景或要求业务代码接入。
- 先打通单应用 Web 只读闭环，再接入用户已打开的微信小程序；跨应用与业务写操作暂不执行。

以上生成与执行能力均为目标设计，尚未实现。后续目标命令为：

```bash
browser-test feature gen --xmind cases.xmind --out features/
browser-test run features/service-type-list.feature
```

## 当前实现状态

支持含 `content.json` 的现代 XMind ZIP 文件。旧版仅含 `content.xml` 的文件会提示使用新版 XMind 另存；损坏文件、非法节点及命令参数返回退出码 2，导入成功返回 0。

识别规则：主题的直属子节点中存在“操作／步骤／操作步骤／测试步骤”或“预期／预期结果／预期输出”字段时，将该主题列为用例；“前置条件／前提条件”作为前置字段。支持独立分组名、冒号同行内容（如“操作步骤：点击保存”）以及制表符分隔的内容，输出保留完整原文，不拆分标题。不完整用例会提示缺少分组。

没有操作、预期字段时，若直属节点包含前置条件，且其他直属节点至少有一个含附属子节点，则按“操作→预期”嵌套布局提取：前置条件以外的直属节点作为操作，其直属附属节点作为预期。用例编号不参与导入识别，也不作为结构化字段；原文中的编号仅随主题内容保留，缺失时不自动补造。操作的完整子树和路径保留对应关系；部分操作没有直属预期时按用例提示一次。此规则是布局识别，语义仍需确认，文本列表会标明依据。其他未识别的叶节点保留在主题树并提示人工确认。

`--json` 向标准输出写入 JSON，`--output <文件>` 将相同内容直接写入指定文件，两者不能同时使用。结果包含 `sheets`（完整主题树）、`cases`（用例及前置、步骤、预期节点）和 `warnings`。用例的 `structure` 为 `sections`（字段标记）或 `nested`（嵌套布局）。节点保留标题及整个子树，不将嵌套文本拼接或改写。节点包含原始属性 `raw`（备注、标签等）、原文路径 `path` 和 `source`（绝对文件路径、画布 ID、节点 ID）。导入结果不包含 `caseId`；内部回溯使用绝对文件路径、画布 ID 和节点 ID，不向调用方暴露无业务含义的自动编号。支持多画布及自由主题；主题深度最多 256 层，`content.json` 最多 32 MiB。默认文本模式输出用例标题、模块路径和来源，提示写入 stderr。

程序接口：

```ts
import { importXMind } from 'browser-test';
const { cases, sheets, warnings } = await importXMind('/path/to/cases.xmind');
```

导入只读取指定文件，不写中间资产，不读取 `project.json` 或业务源码，不需要 AI、浏览器、登录态或业务仓库。

工作区中的 `.browser-test/project.json` 属于历史业务资料，不是本工具的输入，使用者无需准备此文件。

项目预设、源码辅助和可复现数据配置，等实际使用证明能够提高效率后再评估，不预先规定配置协议。

完整流程及验收标准见[技术设计](../../docs/browser-test-technical-plan.md)。
