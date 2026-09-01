import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_CODEX_VERSION,
  codexDriverCandidates,
  codexDriverEnvironment,
  isSupportedCodexVersion,
  resolveCodexDriver,
} from './codexDriver.js';

describe('Codex native driver discovery', () => {
  it('uses Windows delimiters and only native executable names on Windows', () => {
    const candidates = codexDriverCandidates({
      platform: 'win32',
      explicitPath: 'D:\\tools\\codex.exe',
      localAppData: 'C:\\Users\\tester\\AppData\\Local',
      listDirectories: () => ['release-b', 'release-a'],
      pathValue: 'C:\\first;D:\\second',
      approvedWindowsPaths: [
        'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\release-b\\codex.exe',
        'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\release-a\\codex.exe',
        'C:\\first\\codex.exe',
        'D:\\second\\codex.exe',
      ],
    });
    expect(candidates.map((candidate) => candidate.executablePath)).toEqual([
      'D:\\tools\\codex.exe',
      'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\release-b\\codex.exe',
      'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\release-a\\codex.exe',
      'C:\\first\\codex.exe',
      'D:\\second\\codex.exe',
    ]);
  });

  it('keeps the documented explicit, bundled, desktop, PATH priority', () => {
    const candidates = codexDriverCandidates({
      platform: 'win32',
      explicitPath: 'D:\\explicit\\codex.exe',
      bundledPath: 'D:\\project\\driver\\codex.exe',
      localAppData: 'C:\\Local',
      listDirectories: () => ['desktop'],
      pathValue: 'C:\\system',
      approvedWindowsPaths: ['C:\\Local\\OpenAI\\Codex\\bin\\desktop\\codex.exe', 'C:\\system\\codex.exe'],
    });
    expect(candidates.map((candidate) => candidate.source)).toEqual(['explicit', 'bundled', 'desktopApp', 'systemPath']);
  });

  it('rejects wrappers and selects the first existing native Windows file', () => {
    const checked: string[] = [];
    const resolution = resolveCodexDriver({
      platform: 'win32',
      explicitPath: 'D:\\tools\\codex.cmd',
      bundledPath: 'D:\\project\\codex.exe',
      localAppData: 'C:\\Local',
      listDirectories: () => [],
      pathValue: '',
      home: 'C:\\Users\\tester',
      isExecutableFile: (candidate) => {
        checked.push(candidate);
        return candidate === 'D:\\project\\codex.exe';
      },
    });
    expect(checked).toEqual(['D:\\project\\codex.exe']);
    expect(resolution).toEqual({
      executablePath: 'D:\\project\\codex.exe',
      source: 'bundled',
      codexHome: 'C:\\Users\\tester\\.codex',
    });
  });

  it('pins the supported driver version and passes one explicit CODEX_HOME', () => {
    expect(isSupportedCodexVersion(SUPPORTED_CODEX_VERSION)).toBe(true);
    expect(isSupportedCodexVersion('codex-cli 0.130.0')).toBe(false);
    expect(codexDriverEnvironment('C:\\Users\\tester\\.codex', { PATH: 'x', CODEX_HOME: 'old' })).toEqual({
      PATH: 'x',
      CODEX_HOME: 'C:\\Users\\tester\\.codex',
    });
  });

  it('requires absolute approved Windows paths and never auto-selects another desktop release directory', () => {
    expect(() => resolveCodexDriver({ platform: 'win32', explicitPath: '.\\codex.exe', pathValue: '', isExecutableFile: () => true })).toThrow('绝对路径');
    expect(() => resolveCodexDriver({ platform: 'win32', bundledPath: '.\\bundled\\codex.exe', pathValue: '', isExecutableFile: () => true })).toThrow('项目固定驱动路径必须是绝对路径');
    expect(() => resolveCodexDriver({ platform: 'win32', explicitPath: 'C:\\Codex\\codex.exe', codexHome: '.\\relative-home', pathValue: '', isExecutableFile: () => true })).toThrow('CODEX_HOME 必须是绝对路径');
    const candidates = codexDriverCandidates({
      platform: 'win32',
      localAppData: 'C:\\Local',
      listDirectories: () => ['same-version-other-release'],
      pathValue: 'C:\\system',
    });
    expect(candidates).toEqual([]);
  });

  it('fails clearly when every approved driver candidate is missing', () => {
    expect(() => resolveCodexDriver({
      platform: 'win32',
      explicitPath: 'C:\\Missing\\codex.exe',
      bundledPath: 'D:\\Project\\driver\\codex.exe',
      pathValue: '',
      codexHome: 'C:\\Users\\tester\\.codex',
      isExecutableFile: () => false,
    })).toThrow('未找到受支持的 Codex 原生驱动');
  });
});
