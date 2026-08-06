/**
 * Skill 安装目标解析逻辑，集中维护不同 Agent 对用户级 skills 目录的约定。
 * CLI 包只需要提供随包发布的 Skill 名称和用户参数，不各自复制目录规则。
 */
import { homedir } from 'node:os';
import * as path from 'node:path';

export type SkillInstallAgent = 'agents' | 'claude';

export interface SkillInstallTargetOptions {
  agent?: string;
  skillsDir?: string;
}

export interface SkillInstallTarget {
  label: string;
  rootDir: string;
  targetDir: string;
}

const DEFAULT_AGENT: SkillInstallAgent = 'agents';

/** 根据显式目录或 Agent 类型解析最终安装目录。 */
export function resolveSkillInstallTarget(skillName: string, options: SkillInstallTargetOptions): SkillInstallTarget {
  const customSkillsDir = options.skillsDir?.trim();
  if (customSkillsDir) {
    const rootDir = path.resolve(customSkillsDir);
    return {
      label: '自定义 Agent Skill',
      rootDir,
      targetDir: path.join(rootDir, skillName),
    };
  }

  const agent = normalizeSkillInstallAgent(options.agent);
  const rootDir = resolveSkillRootDir(agent);
  return {
    label: agent === 'claude' ? 'Claude Code Skill' : 'Agent Skill',
    rootDir,
    targetDir: path.join(rootDir, skillName),
  };
}

/** 将 CLI 传入的 agent 名称收敛到当前明确支持的安装目标。 */
export function normalizeSkillInstallAgent(agent?: string): SkillInstallAgent {
  const normalized = agent?.trim().toLowerCase() || DEFAULT_AGENT;
  if (normalized === 'agents') {
    return normalized;
  }

  // Codex 已改用共享目录，旧参数继续映射到新位置，避免升级后留下重复 Skill。
  if (normalized === 'codex') {
    return 'agents';
  }
  if (normalized === 'claude' || normalized === 'claude-code') {
    return 'claude';
  }

  throw new Error(`不支持的 Skill 安装目标：${agent}。可用值：agents、claude，或使用 --skills-dir <目录>。`);
}

/** 解析各 Agent 目标对应的用户级 skills 根目录。 */
function resolveSkillRootDir(agent: SkillInstallAgent): string {
  if (agent === 'claude') {
    return path.join(homedir(), '.claude', 'skills');
  }

  return path.join(homedir(), '.agents', 'skills');
}
