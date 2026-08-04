/**
 * 覆盖 agent-browser 子进程代理环境的解析与合并行为，避免代理例外在不同系统上丢失。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAgentBrowserEnvironment,
  mergeNoProxyEntries,
  parseMacOSProxyExceptions,
  parseWindowsProxyExceptions,
} from '../../packages/browser-core/dist/proxy-env.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue('');
});

describe('代理绕过环境', () => {
  it('解析 macOS 系统代理例外列表', () => {
    const output = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : *.ifengqun.com
    2 : 10.0.0.0/8
  }
  HTTPEnable : 1
}`;

    expect(parseMacOSProxyExceptions(output)).toEqual([
      'localhost',
      '*.ifengqun.com',
      '10.0.0.0/8',
    ]);
  });

  it('合并代理绕过项时保留顺序并忽略大小写重复项', () => {
    expect(mergeNoProxyEntries(
      ['localhost', '.existing.com'],
      ['LOCALHOST', '.lowercase.com'],
      ['*.ifengqun.com'],
    )).toBe('localhost,.existing.com,.lowercase.com,*.ifengqun.com');
  });

  it('解析 Windows 当前用户的系统代理例外列表', () => {
    const output = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyOverride    REG_SZ    localhost;*.ifengqun.com;10.*;<local>
`;

    expect(parseWindowsProxyExceptions(output)).toEqual([
      'localhost',
      '*.ifengqun.com',
      '10.*',
      '<local>',
    ]);
  });

  it('合并现有环境变量和 macOS 系统例外', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.stubEnv('NO_PROXY', 'localhost,.existing.com');
    vi.stubEnv('no_proxy', '.lowercase.com,localhost');
    mockExecFileSync.mockReturnValue(`<dictionary> {
  ExceptionsList : <array> {
    0 : *.ifengqun.com
    1 : .existing.com
  }
}`);

    expect(createAgentBrowserEnvironment()).toEqual(expect.objectContaining({
      NO_PROXY: 'localhost,.existing.com,.lowercase.com,*.ifengqun.com',
      no_proxy: 'localhost,.existing.com,.lowercase.com,*.ifengqun.com',
    }));
  });

  it('合并现有环境变量和 Windows 系统例外', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('NO_PROXY', 'localhost,.existing.com');
    mockExecFileSync.mockReturnValue(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyOverride    REG_SZ    *.ifengqun.com;<local>;localhost
`);

    expect(createAgentBrowserEnvironment()).toEqual(expect.objectContaining({
      NO_PROXY: 'localhost,.existing.com,*.ifengqun.com,<local>',
      no_proxy: 'localhost,.existing.com,*.ifengqun.com,<local>',
    }));
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'reg.exe',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v',
        'ProxyOverride',
      ],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});
