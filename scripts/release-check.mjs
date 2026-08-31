import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, label: 'macOS 用户绝对路径' },
  { pattern: /(?:api[_-]?key|token|password|secret)\s*[:=]\s*["'][^"']{8,}["']/i, label: '疑似凭据' },
];

for (const relative of tracked) {
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
}

if (tracked.some((file) => /^scripts\/qa-.*-evidence\.json$/.test(file))) failures.push('仓库仍跟踪本机 QA 证据 JSON');

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('GITHUB_RELEASE_READY');
