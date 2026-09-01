import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const SUPPORTED_CODEX_VERSION = 'codex-cli 0.151.0-alpha.7.2';

export type CodexDriverSource = 'explicit' | 'desktopApp' | 'systemPath' | 'bundled';

export interface CodexDriverCandidate {
  executablePath: string;
  source: CodexDriverSource;
}

export interface CodexDriverResolution extends CodexDriverCandidate {
  codexHome: string;
}

export interface CodexDriverDiscoveryInput {
  explicitPath?: string;
  bundledPath?: string;
  pathValue?: string;
  home?: string;
  localAppData?: string;
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
  codexHome?: string;
  approvedWindowsPaths?: string[];
  listDirectories?: (directory: string) => string[];
  isExecutableFile?: (candidate: string) => boolean;
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value).toLocaleLowerCase();
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function desktopAppCandidates(input: CodexDriverDiscoveryInput, platform: NodeJS.Platform): CodexDriverCandidate[] {
  if (platform !== 'win32') {
    return [
      { executablePath: '/Applications/ChatGPT.app/Contents/Resources/codex', source: 'desktopApp' },
      { executablePath: '/Applications/Codex.app/Contents/Resources/codex', source: 'desktopApp' },
    ];
  }
  const root = path.win32.join(input.localAppData ?? process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
  if (!path.win32.isAbsolute(root)) return [];
  const listDirectories = input.listDirectories ?? ((directory: string) => readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name));
  try {
    return listDirectories(root)
      .sort((left, right) => right.localeCompare(left))
      .map((directory) => ({ executablePath: path.win32.join(root, directory, 'codex.exe'), source: 'desktopApp' as const }));
  } catch {
    return [];
  }
}

export function codexDriverCandidates(input: CodexDriverDiscoveryInput = {}): CodexDriverCandidate[] {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const delimiter = input.pathDelimiter ?? (platform === 'win32' ? ';' : ':');
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const fromPath = (input.pathValue ?? process.env.PATH ?? '')
    .split(delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean)
    .map((directory) => ({ executablePath: pathApi.join(directory, executableName), source: 'systemPath' as const }));
  const approvedWindowsPaths = new Set((input.approvedWindowsPaths ?? []).map((candidate) => path.win32.normalize(candidate).toLocaleLowerCase()));
  const candidates = [
    ...(input.explicitPath || process.env.CODEX_CLI_PATH ? [{ executablePath: input.explicitPath ?? process.env.CODEX_CLI_PATH ?? '', source: 'explicit' as const }] : []),
    ...(input.bundledPath ? [{ executablePath: input.bundledPath, source: 'bundled' as const }] : []),
    ...(platform !== 'win32' || approvedWindowsPaths.size ? desktopAppCandidates(input, platform) : []),
    ...fromPath,
    ...(platform === 'win32' ? [] : [
      { executablePath: '/opt/homebrew/bin/codex', source: 'systemPath' as const },
      { executablePath: '/usr/local/bin/codex', source: 'systemPath' as const },
      { executablePath: path.posix.join(home, '.local/bin/codex'), source: 'systemPath' as const },
      { executablePath: path.posix.join(home, '.npm-global/bin/codex'), source: 'systemPath' as const },
    ]),
  ];
  return unique(platform === 'win32'
    ? candidates.filter((candidate) => candidate.source === 'explicit' || candidate.source === 'bundled' || approvedWindowsPaths.has(path.win32.normalize(candidate.executablePath).toLocaleLowerCase()))
    : candidates, (candidate) => candidate.executablePath);
}

function defaultIsExecutableFile(candidate: string): boolean {
  accessSync(candidate, fsConstants.X_OK);
  return statSync(candidate).isFile();
}

export function resolveCodexDriver(input: CodexDriverDiscoveryInput = {}): CodexDriverResolution {
  const platform = input.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const isExecutableFile = input.isExecutableFile ?? defaultIsExecutableFile;
  if (platform === 'win32' && input.explicitPath && !path.win32.isAbsolute(input.explicitPath)) throw new Error('CODEX_CLI_PATH 必须是已确认的绝对路径');
  if (platform === 'win32' && input.bundledPath && !path.win32.isAbsolute(input.bundledPath)) throw new Error('项目固定驱动路径必须是绝对路径');
  const codexHome = input.codexHome ?? process.env.CODEX_HOME ?? pathApi.join(input.home ?? homedir(), '.codex');
  if (!pathApi.isAbsolute(codexHome)) throw new Error('CODEX_HOME 必须是绝对路径');
  for (const candidate of codexDriverCandidates(input)) {
    if (platform === 'win32' && path.win32.extname(candidate.executablePath).toLocaleLowerCase() !== '.exe') continue;
    try {
      if (isExecutableFile(candidate.executablePath)) {
        return {
          ...candidate,
          executablePath: pathApi.normalize(candidate.executablePath),
          codexHome: pathApi.normalize(codexHome),
        };
      }
    } catch {
      // Continue through the documented candidate order.
    }
  }
  throw new Error('未找到受支持的 Codex 原生驱动。请安装 Codex 桌面应用，或通过 CODEX_CLI_PATH 指定原生可执行文件。');
}

export function isSupportedCodexVersion(version: string): boolean {
  return version.trim() === SUPPORTED_CODEX_VERSION;
}

export function codexDriverEnvironment(codexHome: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, CODEX_HOME: codexHome };
}
