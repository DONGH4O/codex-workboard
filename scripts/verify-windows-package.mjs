import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage } from '@electron/asar';

export function inspectWindowsPackage(packageDir) {
  const root = path.resolve(packageDir);
  const required = [
    'Codex Workboard.exe',
    'resources/app.asar',
  ];
  const missing = required.filter((relative) => !existsSync(path.join(root, relative)));
  const archivePath = path.join(root, 'resources', 'app.asar');
  const archiveEntries = existsSync(archivePath) ? listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/')) : [];
  const requiredArchiveEntries = [
    '/package.json',
    '/dist-electron/main.js',
    '/dist-electron/preload.cjs',
    '/dist-renderer/index.html',
  ];
  const missingArchiveEntries = requiredArchiveEntries.filter((entry) => !archiveEntries.includes(entry));
  const forbiddenArchiveEntries = archiveEntries.filter((entry) => /^\/dist-electron\/.+\.test\.js$/i.test(entry)
    || /^\/dist-electron\/.+\.d\.(?:ts|cts)$/i.test(entry));
  const forbidden = readdirSync(root, { recursive: true })
    .map(String)
    .filter((relative) => /(^|[\\/])codex\.exe$/i.test(relative));
  const files = readdirSync(root, { recursive: true })
    .map(String)
    .filter((relative) => statSync(path.join(root, relative)).isFile())
    .sort();
  return { root, missing, missingArchiveEntries, forbiddenArchiveEntries, forbidden, files };
}

export function main(argv = process.argv.slice(2), output = console.log) {
  const packageDir = argv[0] ?? path.resolve(import.meta.dirname, '..', 'dist', 'win-unpacked');
  const result = inspectWindowsPackage(packageDir);
  if (result.missing.length) throw new Error(`Windows 目录包缺少必要文件：${result.missing.join(', ')}`);
  if (result.missingArchiveEntries.length) throw new Error(`app.asar 缺少应用入口：${result.missingArchiveEntries.join(', ')}`);
  if (result.forbiddenArchiveEntries.length) throw new Error('app.asar 不应包含应用测试或 TypeScript 声明文件');
  if (result.forbidden.length) throw new Error('Windows 目录包不应捆绑 Codex CLI');
  output(JSON.stringify({ result: 'PASS', fileCount: result.files.length, requiredFilesPresent: true, codexCliBundled: false }, null, 2));
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
