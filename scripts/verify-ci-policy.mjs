import { readFileSync } from 'node:fs';
import path from 'node:path';

function uncommented(source) {
  return source.split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

function jobBlock(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`缺少独立作业 ${name}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start, end).join('\n');
}

function requirePatterns(block, jobName, requirements, failures) {
  for (const [label, pattern] of requirements) if (!pattern.test(block)) failures.push(`${jobName} 缺少${label}`);
}

export function verifyCiPolicy(rawSource, pkg) {
  const source = uncommented(rawSource);
  const failures = [];
  for (const [label, pattern] of [
    ['`on` 顶层结构', /^on:\s*$/m],
    ['`permissions` 顶层结构', /^permissions:\s*$/m],
    ['`jobs` 顶层结构', /^jobs:\s*$/m],
    ['main 与功能分支 push 触发', /push:\s*[\s\S]*?branches:\s*\[main, codex\/windows-support\]/],
    ['Pull Request 触发', /pull_request:/],
    ['手动触发', /workflow_dispatch:/],
    ['只读权限', /permissions:\s*\n\s+contents:\s+read/],
  ]) if (!pattern.test(source)) failures.push(`缺少${label}`);

  let windows = '';
  let macos = '';
  try { windows = jobBlock(source, 'windows-test-and-package'); } catch (error) { failures.push(error.message); }
  try { macos = jobBlock(source, 'macos-test-and-package'); } catch (error) { failures.push(error.message); }
  const common = [
    ['仓库检出', /uses:\s+actions\/checkout@v4/],
    ['Node 环境初始化', /uses:\s+actions\/setup-node@v4/],
    ['`.nvmrc` Node 版本', /node-version-file:\s+\.nvmrc/],
    ['npm 缓存', /cache:\s+npm/],
    ['30 分钟超时', /timeout-minutes:\s+30/],
    ['npm 11.17.0 启用', /npm install --global npm@11\.17\.0/],
    ['npm 版本验证', /npm run verify:npm/],
    ['锁文件依赖安装', /npm ci/],
    ['单元测试与构建验证', /npm run ci:verify/],
    ['依赖安全审计', /npm run audit:security/],
    ['打包版离线 UI', /npm run test:ui:packaged/],
    ['受控目录包 UI', /npm run test:ui:governed/],
    ['产物上传', /uses:\s+actions\/upload-artifact@v4/],
  ];
  requirePatterns(windows, 'Windows 作业', [['Windows 运行器', /runs-on:\s+windows-latest/], ...common, ['Windows 目录包', /npm run pack:win/], ['Windows 包验证', /npm run verify:win-package/]], failures);
  requirePatterns(macos, 'macOS 作业', [['macOS 运行器', /runs-on:\s+macos-14/], ...common, ['macOS 目录包', /npm run pack:mac/]], failures);

  for (const [label, pattern] of [
    ['真实 W3 场景', /w3:real:/i],
    ['正式流程', /qa-formal-flow|test:flow/i],
    ['Codex 账号环境', /CODEX_HOME|CODEX_CLI_PATH|secrets\./i],
  ]) if (pattern.test(source)) failures.push(`公开 CI 不得包含${label}`);

  const uploads = [...source.matchAll(/^\s+path:\s+(.+)\s*$/gm)].map((match) => match[1].trim());
  const approvedUploads = ['dist/win-unpacked/**', 'dist/mac*/Codex Workboard.app/**'];
  if (uploads.length !== approvedUploads.length || approvedUploads.some((item) => !uploads.includes(item))) failures.push(`产物上传路径必须且只能是：${approvedUploads.join('、')}`);
  if ((source.match(/uses:\s+actions\/upload-artifact@v4/g) ?? []).length !== 2) failures.push('产物上传步骤必须恰好两个');

  for (const name of ['ci:verify', 'ci:local']) {
    const command = pkg.scripts?.[name] ?? '';
    if (!command) failures.push(`缺少 ${name} 脚本`);
    if (/w3:real:|test:flow|qa-formal-flow/i.test(command)) failures.push(`${name} 不得连接真实 Codex`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const root = path.resolve(import.meta.dirname, '..');
  verifyCiPolicy(readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'), JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')));
  console.log('CI_POLICY_OK');
}
