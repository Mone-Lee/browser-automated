# browser-test

面向 Web 与微信小程序的用例驱动测试工具。当前设计从“用户只有一个包含测试用例的 XMind 文件”出发：导入原文、确认 Gherkin、执行步骤并输出证据报告。

CLI 目前仅提供帮助和版本查询，尚不能生成或执行用例。

```bash
npm run build -w browser-test
node packages/browser-test/dist/cli/browser-test.js --help
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
browser-test feature gen --xmind cases.xmind --case TC-001 --out features/
browser-test run features/service-type-list.feature
```

## 当前实现状态

当前仅保留包入口和 CLI 帮助、版本查询。此前的项目预设类型、校验与读取 API 已移除，代码不读取 `project.json`，也不解析业务路由源码。XMind 导入将作为下一步实现。

工作区中的 `.browser-test/project.json` 属于历史业务资料，不是本工具的输入，使用者无需准备此文件。

项目预设、源码辅助和可复现数据配置，等实际使用证明能够提高效率后再评估，不预先规定配置协议。

完整流程及验收标准见[技术设计](../../docs/browser-test-technical-plan.md)。
