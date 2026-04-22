# browser-automated

浏览器自动化，支持 e2e 测试、e2e 测试用例生成、浏览器自动化操作。  
底层使用 [agent-browser](https://agent-browser.dev)（Vercel）对浏览器进行操作，支持通过**自然语言**描述来执行 e2e 自动化测试。

## 功能特性

- 🗣️ **自然语言 e2e 测试**：用自然语言描述测试步骤，由 `agent-browser chat` 驱动执行
- 📝 **测试用例生成**：根据自然语言描述自动生成结构化测试用例（JSON 格式）
- 🧠 **Skills 风格编排**：自然语言触发时优先命中已有 Playwright 用例，未命中时回退到一次性 NL 测试
- 🧩 **代码沉淀闭环**：一次性 NL 测试通过后可自动生成并注册 Playwright 测试代码
- 🤖 **BrowserAgent**：封装 `agent-browser` CLI 的 TypeScript 接口，支持 snapshot、screenshot、batch 等操作
- 🙋 **User Handoff**：遇到验证码/OAuth/MFA 或连续失败时，自动切到真实浏览器由用户接管，完成后恢复自动化
- 🔧 **CLI 工具**：`browser-automated run / gen / chat / e2e / e2e-gen`

## 安装

```bash
npm install
# 安装 agent-browser 所需的 Chrome（首次使用）
npx agent-browser install
```

## 快速开始

### 运行测试用例文件

```bash
npx browser-automated run examples/google-search.json
```

### 生成测试用例

```bash
npx browser-automated gen https://example.com "填写联系表单并提交"
```

### 执行单条自然语言指令

```bash
npx browser-automated chat https://example.com "点击登录按钮"
```

### Skills 模式执行 e2e（优先代码用例）

```bash
npx browser-automated e2e https://example.com "打开 pricing 页面并进入 contact 页面" --assert "Contact 页面应可见"
npx browser-automated e2e https://example.com "登录并验证仪表盘" --live-viewport
```

一次性 `browser-e2e` / `e2e` 流程默认会使用可见浏览器窗口执行，便于你实时观察自动化过程。`--live-viewport` 现在可以视为显式声明该行为。

### 复杂场景接管（User Handoff）

当一次性自动化无法继续时（例如 CAPTCHA、OAuth 授权、多因素登录），`browser-e2e`/`e2e` 流程会在连续失败 3 次后自动触发接管。

流程如下：

1. 优先执行 `handoff`；如果当前 `agent-browser` 版本不支持该命令，则自动回退到同一 session 的可见浏览器窗口。
2. CLI 提示你手动完成复杂步骤。
3. 你输入 `done`（或 `ok`/`继续`/`完成`）后，自动执行 `resume`；如果该命令不可用，则直接沿用当前 session 继续跑后续动作。

在动作失败提示时，也可手动输入 `handoff` 立即接管，不必等到 3 次失败。

推荐自然语言用例模板：

```text
测试网站 <url> 的<功能>。

目标：
1. <步骤1>
2. <步骤2>
3. <步骤3>
4. <验证步骤>
```

登录示例：

```text
测试网站 https://example.com/login 的登录功能。

目标：
1. 打开登录页面。
2. 输入用户名 "testuser" 和密码 "password123"。
3. 点击登录按钮。
4. 验证是否跳转到仪表盘页面（URL 包含 /dashboard 或看到欢迎文字）。
```

### 从自然语言直接生成 Playwright 测试代码

```bash
npx browser-automated e2e-gen https://example.com "打开 pricing 页面并进入 contact 页面" --name "pricing contact flow" --tags marketing,navigation
```

生成产物：

- `tests/generated/*.spec.ts`（Playwright 测试代码）
- `tests/generated/index.json`（测试元数据索引，供下次自然语言触发优先命中）

## 测试用例格式

测试用例为 JSON 文件，支持数组（多个用例）或单个对象：

```json
[
  {
    "name": "Google 搜索",
    "url": "https://www.google.com",
    "steps": [
      {
        "instruction": "在搜索框中输入 \"TypeScript\" 并按 Enter"
      },
      {
        "instruction": "点击第一条搜索结果",
        "assertion": "应跳转到非 Google 页面"
      }
    ]
  }
]
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 测试用例名称 |
| `url` | string | 测试起始 URL |
| `steps[].instruction` | string | 自然语言操作指令 |
| `steps[].assertion` | string（可选）| 执行步骤后的断言描述 |
| `timeout` | number（可选）| 超时毫秒数，默认 60000 |

## 编程接口

```typescript
import { NaturalLanguageTestRunner, TestCaseGenerator, BrowserAgent } from 'browser-automated';

// 运行自然语言测试
const runner = new NaturalLanguageTestRunner({ screenshotOnFailure: true });
const result = await runner.runOne({
  name: '登录流程',
  url: 'https://example.com/login',
  steps: [
    { instruction: '输入用户名 "admin"' },
    { instruction: '输入密码 "password123"' },
    { instruction: '点击登录按钮', assertion: '页面应跳转到 Dashboard' },
  ],
});
console.log(result.passed ? 'PASS ✓' : 'FAIL ✗');

// 生成测试用例
const generator = new TestCaseGenerator();
const testCase = await generator.generate(
  'https://example.com',
  '填写并提交注册表单',
);
console.log(JSON.stringify(testCase, null, 2));

// 直接使用 BrowserAgent
const agent = new BrowserAgent();
agent.open('https://example.com');
const snapshot = agent.snapshot();
agent.chat('点击右上角的用户头像');
agent.close();
```

## 开发

```bash
npm run build      # 编译 TypeScript
npm test           # 运行单元测试
npm run typecheck  # 类型检查
```

## Copilot 开发环境

`.github/workflows/copilot-setup-steps.yml` 会在 Copilot Coding Agent 开始工作前自动安装 Node.js 依赖和 Chrome 浏览器，无需手动配置。
