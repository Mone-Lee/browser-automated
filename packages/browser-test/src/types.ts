/**
 * 定义导入用例；来源文件仅记录在 XMindImport.file，节点不重复携带来源、画布或节点 ID。
 */

/** 保留原文与层级的主题节点，既用于用例分组，也用于保存尚未识别的内容。 */
export interface XMindNode {
  title: string;
  /** 从画布根主题到当前主题的标题序列，包含当前标题，不含画布名称。 */
  path: string[];
  /** 按原始子主题类别分组，例如附属主题 attached、自由主题 detached。 */
  children: Record<string, XMindNode[]>;
  /** 原始主题中除 id、title、children 外的属性，如备注、标签、优先级标记。 */
  raw: Record<string, unknown>;
}

/** 按字段或嵌套布局识别出的用例；不定义业务用例编号，原文编号仅保留在主题内容中。 */
export interface XMindCase {
  title: string;
  /** 字段标记识别为 sections；依据前置条件及操作子树识别为 nested。 */
  structure: 'sections' | 'nested';
  /** 从根主题到用例父主题的标题序列，不含用例自身标题。 */
  modulePath: string[];
  /** 用例主题及完整子树，保留未归入前置、操作或预期分组的内容。 */
  node: XMindNode;
  /** 前置字段节点及其子树，同行内容保留在标题中；无字段时为空数组。 */
  preconditions: XMindNode[];
  /** 操作字段或嵌套布局中的操作节点，保留原有顺序与完整子树。 */
  steps: XMindNode[];
  /** 预期字段或操作的直属附属节点；嵌套布局中父操作与直属子预期通过路径及操作子树保持对应。 */
  expectedResults: XMindNode[];
}

/** 单个文件的导入结果，仅表达原文结构与识别情况，不包含执行结论。 */
export interface XMindImport {
  /** 导入文件的绝对路径。 */
  file: string;
  /** 按原文件顺序保存所有画布及完整主题树，包括未识别为用例的节点。 */
  sheets: { title: string; root: XMindNode }[];
  cases: XMindCase[];
  /** 需人工确认的非致命问题及其来源；格式错误则由导入接口抛出异常。 */
  warnings: { /** 触发提示的主题路径，便于不依赖 ID 定位。 */ path: string[]; message: string }[];
}
