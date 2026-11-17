---
name: browser-test-draft
description: 起草或修改 browser-test 的 Gherkin（feature gen、--steps 步骤 JSON、agent-request 起草请求、XMind 用例转 Gherkin）时必须先加载。规定如何读取当次生成规则、拆分前提、审查数据依赖并回传 rulesVersion，否则 CLI 会拒绝草案。
---

# browser-test-draft

任何 Gherkin 起草工作都先按本流程做，再回到 `browser-test` skill 执行落盘与确认。

## 必做流程

1. 运行 `browser-test feature rules`，完整阅读输出。输出末尾的 `rulesVersion` 每次以当次输出为准，不得凭记忆或沿用旧值。
2. 逐条用例起草步骤，严格遵守规则输出中的拆分、断言、写操作与数据审查要求。
3. 结果 JSON 顶层写入 `"rulesVersion"`；每条 case 写入 `dataReview: {required, basis, missing}`。
4. 通过 `--steps` 传入，或在 agent-request 中回复同样结构。
5. CLI 拒绝草案时，按报错逐条修正后重新提交，不要绕过校验，不要通过放宽措辞让校验通过。

## CLI 会拒绝的情况

- 缺少或过期的 `rulesVersion`。
- case 缺少有效 `dataReview`（`required` 为布尔值、`basis` 为非空单行、`missing` 为字符串数组）。
- 登录与进入页面、搜索、定位混写在同一个前提步骤里。
- 待确认问题（todo）笼统，例如“证据不足”“请确认”。

## 起草要点

输入生效方式不属于 Gherkin 生成阶段的确认范围：不推测或追问失焦、回车、等待等输入生效细节，不将其写入 todo 或 dataReview.missing，也不留下“按确认后的事件使输入生效”等占位表述。原文明示的操作可以保留；业务上的提交、确认和保存仍按原文处理。

- 前提按职责拆分：已登录、已进入页面、目标对象已定位分别写成独立 Given/And。
- 原文没有的数据（账号、业务库、SKU 集合、修改前值）不得补造；把缺口写进 `missing`，并在相关步骤给出具体 todo，例如“请提供业务库名称、成功添加的 SKU 编码，以及用于核验的页面”。
- 集合断言区分“展示集合中没有不符合项”和“全部符合项均展示”，不得把“仅”擅自加强。
- 数值断言保留同一对象、字段、基准来源与取证顺序，缺口用 todo 提问。
- 写操作写在 When（或继承 When 的 And），对应结果写在 Then；仅打开设置或修改页面属于导航，不补写保存。
- 每条预期独立表达一个可观察结果，不使用“正常”“成功”“符合预期”等笼统描述。
