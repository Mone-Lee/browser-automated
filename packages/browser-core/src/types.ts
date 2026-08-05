/**
 * 定义 browser-opt 与 browser-e2e 共享的测试用例、执行结果和 agent 配置类型。
 */
/**
 * 自然语言测试用例中的单个步骤。
 */
export interface TestStep {
  /** 步骤的自然语言操作指令。 */
  instruction: string;
  /** 步骤完成后的可选断言描述。 */
  assertion?: string;
}

/**
 * 完整的自然语言 E2E 测试用例。
 */
export interface TestCase {
  /** 测试用例名称。 */
  name: string;
  /** 测试起始 URL。 */
  url: string;
  /** 需要顺序执行的步骤。 */
  steps: TestStep[];
  /** 单条底层命令的超时时间。 */
  timeout?: number;
}

/**
 * 单个步骤的执行结果。
 */
export interface StepResult {
  /** 已执行的自然语言指令。 */
  instruction: string;
  /** 步骤是否通过。 */
  passed: boolean;
  /** 底层 agent-browser 输出。 */
  output?: string;
  /** 失败时的错误信息。 */
  error?: string;
}

/**
 * 完整 TestCase 的执行结果。
 */
export interface TestResult {
  /** 测试用例名称。 */
  name: string;
  /** 整个用例是否通过。 */
  passed: boolean;
  /** 执行耗时，单位毫秒。 */
  duration: number;
  /** 用例级失败信息。 */
  error?: string;
  /** 每个步骤的执行结果。 */
  steps: StepResult[];
}

/**
 * 多个 TestCase 的执行汇总。
 */
export interface TestRunSummary {
  /** 已执行用例总数。 */
  total: number;
  /** 通过用例数。 */
  passed: number;
  /** 失败用例数。 */
  failed: number;
  /** 总耗时，单位毫秒。 */
  duration: number;
  /** 每个用例的执行结果。 */
  results: TestResult[];
}

/**
 * BrowserAgent 的运行参数。
 */
export interface AgentOptions {
  /** 用于隔离浏览器会话的 session id。 */
  sessionId?: string;
  /** 隔离 agent-browser 后台进程，避免连接到其他工具启动的测试浏览器。 */
  namespace?: string;
  /** 按名称自动保存和恢复 cookies 与 localStorage。 */
  sessionName?: string;
  /** 每条命令的超时时间。 */
  timeout?: number;
  /** 是否以无头模式运行。 */
  headless?: boolean;
  /** 是否显示可见浏览器窗口。 */
  headed?: boolean;
  /** 可见浏览器窗口的语义化别名。 */
  liveViewport?: boolean;
  /** 是否自动打开 agent-browser 的实时截图面板。 */
  openLiveDashboard?: boolean;
  /** agent-browser 复用的 Chrome profile 名称或路径。 */
  profile?: string;
  /** 标准 Chrome 可执行文件路径；默认自动探测系统安装，不使用 Chrome for Testing。 */
  executablePath?: string;
  /** 直接加载的登录态 state 文件路径，优先于 profile 和 auto-connect。 */
  statePath?: string;
  /** 是否优先连接到当前正在运行的 Chrome，而不是新起一个独立窗口。 */
  reuseRunningBrowser?: boolean;
  /** 仅在首次拉起浏览器时附加的启动参数，用于控制窗口与恢复行为。 */
  browserArgs?: string[];
}

/**
 * NaturalLanguageTestRunner 的运行参数。
 */
export interface RunnerOptions {
  /** 失败时是否截图。 */
  screenshotOnFailure?: boolean;
  /** 失败截图保存目录。 */
  screenshotDir?: string;
  /** 是否在第一个失败后停止。 */
  bail?: boolean;
}
