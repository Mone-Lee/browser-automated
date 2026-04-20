# browser-automated

浏览器自动化，支持 e2e 测试、e2e 测试用例生成、浏览器自动化操作。  
底层使用 [agent-browser](https://agent-browser.dev)（Vercel）对无头浏览器进行操作，支持通过**自然语言**描述来执行 e2e 自动化测试。

## 功能特性

- 🗣️ **自然语言 e2e 测试**：用自然语言描述测试步骤，由 `agent-browser chat` 驱动执行
- 📝 **测试用例生成**：根据自然语言描述自动生成结构化测试用例（JSON 格式）
- 🤖 **BrowserAgent**：封装 `agent-browser` CLI 的 TypeScript 接口，支持 snapshot、screenshot、batch 等操作
- 🔧 **CLI 工具**：`browser-automated run / gen / chat`

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
