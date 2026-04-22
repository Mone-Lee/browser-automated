/**
 * A single step in a test case, described in natural language.
 */
export interface TestStep {
  /** Natural language instruction for the step (e.g., "Click the login button"). */
  instruction: string;
  /** Optional assertion to verify after the step (e.g., "The page title should be 'Dashboard'"). */
  assertion?: string;
}

/**
 * A complete e2e test case described in natural language.
 */
export interface TestCase {
  /** Unique name for the test case. */
  name: string;
  /** Starting URL for the test. */
  url: string;
  /** Sequence of steps to execute. */
  steps: TestStep[];
  /** Timeout in milliseconds for the entire test (default: 60000). */
  timeout?: number;
}

/**
 * Result of a single test step execution.
 */
export interface StepResult {
  /** The natural language instruction that was executed. */
  instruction: string;
  /** Whether this step passed. */
  passed: boolean;
  /** Output from the agent-browser command. */
  output?: string;
  /** Error message if the step failed. */
  error?: string;
}

/**
 * Result of a complete test case execution.
 */
export interface TestResult {
  /** Name of the test case. */
  name: string;
  /** Whether the entire test case passed. */
  passed: boolean;
  /** Duration in milliseconds. */
  duration: number;
  /** Top-level error message if the test setup failed. */
  error?: string;
  /** Results for each step. */
  steps: StepResult[];
}

/**
 * Summary of a test run containing multiple test cases.
 */
export interface TestRunSummary {
  /** Total number of test cases. */
  total: number;
  /** Number of passed test cases. */
  passed: number;
  /** Number of failed test cases. */
  failed: number;
  /** Total duration in milliseconds. */
  duration: number;
  /** Individual test results. */
  results: TestResult[];
}

/**
 * Options for the BrowserAgent.
 */
export interface AgentOptions {
  /** Session ID to isolate browser instances (default: auto-generated). */
  sessionId?: string;
  /** Timeout in milliseconds for each command (default: 30000). */
  timeout?: number;
  /** Whether to run in headless mode (default: true). */
  headless?: boolean;
  /** Whether to show a visible browser window while executing commands. */
  headed?: boolean;
  /** Alias for headed execution when the caller wants a live visible viewport. */
  liveViewport?: boolean;
  /** Chrome profile name/path reused by agent-browser (e.g. Default). */
  profile?: string;
}

/**
 * Options for the NaturalLanguageTestRunner.
 */
export interface RunnerOptions {
  /** Whether to take a screenshot on test failure (default: false). */
  screenshotOnFailure?: boolean;
  /** Directory to save screenshots (default: current directory). */
  screenshotDir?: string;
  /** Whether to stop after the first failure (default: false). */
  bail?: boolean;
}
