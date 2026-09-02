import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hasForbiddenWindowsUserPath, isForbiddenRuntimeFile } from './precommit-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const requiredFiles = ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
const failures = [];

for (const file of requiredFiles) {
  if (!existsSync(path.join(root, file))) failures.push(`缺少 ${file}`);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== '1.0.0') failures.push('package.json 版本不是 1.0.0');
if (pkg.license !== 'MIT') failures.push('package.json 未声明 MIT License');
if (pkg.author !== 'new school') failures.push('package.json 作者不是 new school');
if (!pkg.build?.mac?.target?.includes('dmg') || !pkg.build?.mac?.target?.includes('zip')) failures.push('macOS Release 未同时配置 DMG 和 ZIP');
const windowsTarget = pkg.build?.win?.target?.find((target) => target?.target === 'nsis');
if (!windowsTarget?.arch?.includes('x64')) failures.push('Windows Release 未配置 NSIS x64');
if (!pkg.scripts?.['pack:win']?.includes('--win dir') || !pkg.scripts?.['pack:win']?.includes('--x64')) failures.push('Windows 目录打包入口不完整');
if (!pkg.scripts?.['dist:win']?.includes('--win nsis') || !pkg.scripts?.['dist:win']?.includes('--x64')) failures.push('Windows NSIS 打包入口不完整');
if (pkg.build?.nsis?.deleteAppDataOnUninstall !== false) failures.push('NSIS 卸载未明确默认保留用户数据');
if (process.platform === 'win32' && pkg.build?.win?.icon !== 'build/icon.png') failures.push('Windows 图标配置不完整');

try {
  execFileSync('git', ['diff', '--check'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['diff', '--cached', '--check'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
} catch (error) {
  failures.push(`Git 差异包含空白或补丁格式问题：${error.stdout || error.stderr || error.message}`);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const candidates = [...new Set([...tracked, ...untracked])];
const forbidden = [
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, label: 'macOS 用户绝对路径' },
  { pattern: /(?:api[_-]?key|token|password|secret)\s*[:=]\s*["'][^"']{8,}["']/i, label: '疑似凭据' },
];

for (const relative of candidates) {
  if (relative === 'package-lock.json' || relative.startsWith('.git/')) continue;
  const absolute = path.join(root, relative);
  let content = '';
  try {
    content = readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) failures.push(`${relative} 包含${rule.label}`);
  }
  if (hasForbiddenWindowsUserPath(relative, content)) failures.push(`${relative} 包含 Windows 用户目录绝对路径`);
}

const forbiddenRuntimeFiles = candidates.filter(isForbiddenRuntimeFile);
if (forbiddenRuntimeFiles.length) failures.push(`提交范围包含运行数据或过程证据：${forbiddenRuntimeFiles.join(', ')}`);

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('GITHUB_RELEASE_READY');
