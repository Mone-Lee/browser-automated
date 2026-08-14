<!-- 本文通过同一登录任务对比 browser-opt、agent-browser 与 Playwright Skill 的执行边界，说明 browser-opt 如何减少进入大模型上下文的页面状态和交互过程。 -->

# browser-opt 为什么能够节省 Token 消耗

## 1. 结论

`browser-opt` 节省 Token 的主要原因不是 `agent-browser` 命令比 Playwright API 更短，而是它把以下工作放在本地确定性程序中完成：

- 自然语言步骤解析；
- 页面元素匹配；
- 浏览器动作执行；
- 动作后验证；
- 页面未稳定时的等待与重试；
- snapshot、截图和详细日志的落盘。

因此，大模型通常只需要提交一次完整流程，再读取最终的 `PASS`、`FAIL` 或 `HANDOFF` 状态。执行期间产生的页面 snapshot、元素引用、动作结果和重试信息不需要逐次进入模型上下文。

可以把三种方式概括为：

```text
browser-opt：
模型 → 提交整个任务 → 本地程序完成所有步骤 → 模型读取最终结果

直接使用 agent-browser：
模型 → 读取页面 → 选择元素 → 执行动作 → 再读页面 → 判断结果

使用 Playwright Skill：
模型 → 读取页面 → 设计 locator/动作 → 执行 → 再读页面 → 断言或修正
```

## 2. 对比任务

本文使用 Saucedemo 的公开演示登录页进行对比：

```text
访问 https://www.saucedemo.com/
用户名：standard_user
密码：secret_sauce
点击 Login
验证跳转到 /inventory.html，并显示 Products
```

三种方式执行的是同一项任务，区别仅在于浏览器执行过程是否需要大模型持续参与。

## 3. 使用 browser-opt

### 3.1 模型侧执行过程

按照当前项目的 browser-opt Skill，执行前先检查版本：

```bash
browser-opt check-update --json
```

随后将完整流程一次性交给 detached runner：

```bash
browser-opt start --flow '测试 https://www.saucedemo.com/ 的登录功能。

目标：
1. 在“Username”输入“standard_user”。
2. 在“Password”输入“secret_sauce”。
3. 点击“Login”。
4. 验证页面包含“Products”。' --json
```

命令返回一个稳定的 `runId`：

```json
{
  "runId": "<run-id>",
  "status": "RUNNING"
}
```

模型使用该 `runId` 查询状态：

```bash
browser-opt status --run-id "<run-id>" --json
```

正常完成后，模型只需要处理类似结果：

```json
{
  "status": "PASS",
  "reportJsonPath": "<artifact-dir>/report.json",
  "reportMarkdownPath": "<artifact-dir>/report.md"
}
```

### 3.2 browser-opt 内部执行过程

收到流程后，browser-opt 在本地完成以下操作。

第一步，将自然语言拆成独立步骤：

```text
在“Username”输入“standard_user”
在“Password”输入“secret_sauce”
点击“Login”
验证页面包含“Products”
```

第二步，把步骤解析成结构化动作：

```ts
{ type: 'fill', field: 'Username', value: 'standard_user' }
{ type: 'fill', field: 'Password', value: 'secret_sauce' }
{ type: 'click', target: 'Login' }
{ type: 'assert-text', text: 'Products' }
```

第三步，打开页面并获取机器可读 snapshot：

```text
agent-browser open https://www.saucedemo.com/
agent-browser snapshot -i --json
```

初始页面中的关键节点为：

```text
textbox "Username" [ref=e5]
textbox "Password" [ref=e6]
button "Login" [ref=e4]
```

第四步，本地匹配字段和元素引用，并执行确定性命令：

```text
Username → @e5 → fill @e5 standard_user
Password → @e6 → fill @e6 secret_sauce
Login → @e4 → click @e4
```

第五步，每个动作前后重新获取 snapshot、截图并验证动作效果。如果元素尚未渲染或引用失效，步骤执行器会等待后重新获取页面，再匹配新的引用并重试。

第六步，登录后在本地验证 URL 和页面文本。实际成功状态为：

```text
URL: https://www.saucedemo.com/inventory.html
页面文本包含：Products
```

这些步骤产生的完整 snapshot 和截图被保存到 `.browser-opt/artifacts/`，不会在正常成功路径中完整输出到模型上下文。

### 3.3 Token 消耗边界

在正常成功路径中，大模型主要处理：

1. 用户提供的完整流程；
2. `start` 返回的短 JSON；
3. 一次或少量几次 `status` 返回；
4. 最终状态和报告路径。

以下内容由本地进程消费，不构成模型输入 Token：

- 登录页 snapshot；
- `e5`、`e6`、`e4` 等元素引用；
- 每个动作的执行输出；
- 动作前后截图；
- 输入值、选中状态和点击效果验证；
- 普通失败后的等待、重新 snapshot 和重试。

## 4. 直接使用 agent-browser

直接使用 agent-browser 时，模型负责浏览器编排和页面判断。

### 4.1 打开页面并读取 snapshot

```bash
agent-browser batch \
  "open https://www.saucedemo.com/" \
  "snapshot -i"
```

模型需要读取：

```text
- generic "Swag Labs..." [ref=e1] clickable
  - textbox "Username" [ref=e5]
  - textbox "Password" [ref=e6]
  - button "Login" [ref=e4]
  - heading "Accepted usernames are:" [ref=e3]
  - heading "Password for all users:" [ref=e2]
```

然后由模型判断：

```text
Username 对应 @e5
Password 对应 @e6
Login 对应 @e4
```

### 4.2 执行登录

模型根据第一次 snapshot 生成下一组命令：

```bash
agent-browser batch \
  "fill @e5 standard_user" \
  "fill @e6 secret_sauce" \
  "click @e4" \
  "wait --url **/inventory.html"
```

### 4.3 重新读取页面并判断结果

```bash
agent-browser batch \
  "get url" \
  "snapshot -i"
```

模型需要再次读取登录后的页面结构，并判断 URL 是否包含 `/inventory.html`、页面是否包含 `Products`。

如果 `@e4` 已失效，错误会先返回模型。模型还要重新请求 snapshot、寻找新的 Login 引用并再次点击。因此，页面结构、错误信息和重试过程都会消耗模型 Token。

## 5. 使用 Playwright Skill

当前项目没有独立实现 Playwright Skill。本节所说的 Playwright Skill，是指常见的、由大模型调用 Playwright 浏览器工具完成页面操作的方式，不是项目中的 `browser-e2e`。

### 5.1 逐步工具调用方式

模型首先导航到登录页：

```text
playwright.navigate({
  url: "https://www.saucedemo.com/"
})
```

工具通常会返回当前页面的可访问性快照。模型读取快照后填写表单：

```text
playwright.fillForm({
  fields: [
    {
      role: "textbox",
      name: "Username",
      value: "standard_user"
    },
    {
      role: "textbox",
      name: "Password",
      value: "secret_sauce"
    }
  ]
})
```

接着由模型选择并点击按钮：

```text
playwright.click({
  locator: "getByRole('button', { name: 'Login' })"
})
```

页面跳转后，模型再次读取页面状态并执行断言：

```ts
await expect(page).toHaveURL(/\/inventory\.html$/);
await expect(page.getByText('Products')).toBeVisible();
```

在这种模式中，页面快照、locator 设计和操作后的页面判断通常都需要模型参与。

### 5.2 一次性生成 Playwright 脚本

另一种方式是让模型生成完整代码：

```ts
import { test, expect } from '@playwright/test';

test('Saucedemo 登录', async ({ page }) => {
  await page.goto('https://www.saucedemo.com/');

  await page
    .getByRole('textbox', { name: 'Username' })
    .fill('standard_user');

  await page
    .getByRole('textbox', { name: 'Password' })
    .fill('secret_sauce');

  await page
    .getByRole('button', { name: 'Login' })
    .click();

  await expect(page).toHaveURL(/\/inventory\.html$/);
  await expect(page.getByText('Products')).toBeVisible();
});
```

这种方式减少了逐步浏览器工具调用，但模型需要生成完整代码；如果 locator、等待条件或断言失败，错误信息和修改后的代码仍会继续进入模型上下文。

## 6. 实测页面数据

在同一环境中读取 Saucedemo 登录页，得到以下大小：

| 页面表达 | 大小 |
| --- | ---: |
| `agent-browser snapshot -i` | 346 bytes |
| `agent-browser snapshot -i --json` | 986 bytes |
| Playwright `page.content()` 完整 HTML | 2670 bytes |
| Playwright `ariaSnapshot()` | 287 bytes |

这些数据说明：

- 与完整 HTML 相比，agent-browser 的纯文本交互 snapshot 小约 87%；
- 即使包含 JSON 元数据，也比完整 HTML 小约 63%；
- 与 Playwright 的 `ariaSnapshot()` 相比，agent-browser snapshot 本身并没有明显的体积优势。

所以，不能简单地把 browser-opt 的 Token 优势归因于“snapshot 更小”。真正重要的是：browser-opt 的 snapshot 由本地进程读取和处理，并没有逐次发送给大模型。

字节数也不等于精确 Token 数。不同模型、语言和序列化格式的分词结果不同。这里的测量只用于比较传输内容规模，不能当作模型账单中的精确 Token 统计。

## 7. 三种方式的对比

| 对比项 | browser-opt | 直接 agent-browser | Playwright Skill |
| --- | --- | --- | --- |
| 模型提交内容 | 一次完整自然语言流程 | 多条 CLI 命令 | 多次工具调用或完整脚本 |
| 谁解析自然语言步骤 | browser-opt 本地代码 | 模型 | 模型 |
| 谁匹配页面元素 | browser-opt 本地代码 | 模型选择 `@ref` | 模型设计 locator |
| 模型是否读取 snapshot | 正常成功路径不读取 | 读取 | 通常读取 |
| 谁处理普通重试 | browser-opt 本地执行器 | 模型 | 模型或 Skill 编排层 |
| 谁验证动作结果 | browser-opt 本地验证器 | 模型 | 模型或 Playwright 断言 |
| 完整证据 | 自动落盘 | 需要额外命令 | 需要额外配置 |
| 模型工具往返 | `start` 加状态查询 | 通常三次以上 | 通常三至六次，或生成一次完整脚本 |

## 8. browser-opt 的主要节省项

按照对 Token 消耗的影响，可以从高到低归纳为：

1. 浏览器执行循环不经过模型；
2. 完整 snapshot、截图和详细日志落盘，不进入正常成功输出；
3. 自然语言解析和元素匹配由本地 TypeScript 完成；
4. 动作后验证、等待和普通重试由本地执行器完成；
5. 元素使用短 `@ref` 执行，不需要生成复杂 locator；
6. 保存为 Workflow 后，可以用短流程名称代替完整任务描述。

其中第一项是主要收益，其余几项是在此基础上的进一步压缩。

## 9. 适用边界

browser-opt 的 Token 优势主要体现在：

- 一次性网页操作；
- 运营后台流程；
- 页面探索和临时验证；
- 流程仍在频繁变化的阶段；
- 需要截图、snapshot 和 PASS/FAIL 证据，但不希望证据占据模型上下文的场景。

已经写好并在 CI 中直接运行的 Playwright 测试同样不需要大模型持续参与，因此其重复运行也可以接近零推理 Token。browser-opt 的定位不是替代所有 Playwright 测试，而是在流程尚未沉淀为固定测试代码时，用更少的模型交互完成真实浏览器操作。

## 10. 对应实现位置

- agent-browser 的 `click`、`fill`、`snapshotJson` 等窄接口：`packages/browser-core/src/agent.ts`
- 自然语言步骤拆分和结构化动作解析：`packages/browser-opt/src/browser-opt/utils.ts`
- snapshot 落盘和临时快照管理：`packages/browser-opt/src/browser-opt/runner/evidence.ts`
- 单步骤动作、验证和重试闭环：`packages/browser-opt/src/browser-opt/runner/step-executor.ts`
- 完整流程编排和报告生成：`packages/browser-opt/src/browser-opt/runner/index.ts`
- CLI 成功和失败结果输出：`packages/browser-opt/src/cli/utils/output.ts`
