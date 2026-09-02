import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyCiPolicy } from './verify-ci-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const rejected = (changed, message) => expect(() => verifyCiPolicy(changed, pkg)).toThrow(message);

describe('public CI policy', () => {
  it('accepts the current two-platform workflow', () => expect(verifyCiPolicy(workflow, pkg)).toBe(true));

  it('rejects missing triggers, read-only permission or timeout', () => {
    rejected(workflow.replace('branches: [main, codex/windows-support]', 'branches: [main]'), 'push 触发');
    rejected(workflow.replace('  pull_request:', '  # pull_request:'), 'Pull Request');
    rejected(workflow.replace('  workflow_dispatch:', '  # workflow_dispatch:'), '手动触发');
    rejected(workflow.replace('contents: read', 'contents: write'), '只读权限');
    rejected(workflow.replace('permissions:', '# permissions:'), '`permissions` 顶层结构');
    rejected(workflow.replace('timeout-minutes: 30', 'timeout-minutes: 0'), 'Windows 作业 缺少30 分钟超时');
  });

  it('requires every job to contain its own npm, verification, audit, packaging and UI steps', () => {
    const windowsOnly = workflow.replace('      - run: npm run verify:npm', '      # removed verify:npm');
    rejected(windowsOnly, 'Windows 作业 缺少npm 版本验证');
    const macStart = workflow.indexOf('  macos-test-and-package:');
    const macWithoutAudit = `${workflow.slice(0, macStart)}${workflow.slice(macStart).replace('      - run: npm run audit:security', '      # removed audit')}`;
    rejected(macWithoutAudit, 'macOS 作业 缺少依赖安全审计');
    rejected(workflow.replace('      - run: npm run pack:win', '      # removed pack:win'), 'Windows 目录包');
    rejected(workflow.replace('      - uses: actions/setup-node@v4', '      # removed setup-node'), 'Windows 作业 缺少Node 环境初始化');
    rejected(workflow.replace('          node-version-file: .nvmrc', '          # removed node version'), 'Windows 作业 缺少`.nvmrc` Node 版本');
    const macWithoutUi = `${workflow.slice(0, macStart)}${workflow.slice(macStart).replace('      - run: npm run test:ui:packaged', '      # removed packaged UI')}`;
    rejected(macWithoutUi, 'macOS 作业 缺少打包版离线 UI');
  });

  it('rejects real Codex inputs in executable workflow content', () => {
    rejected(`${workflow}\n      - run: echo CODEX_HOME`, '账号环境');
    rejected(`${workflow}\n      - run: npm run w3:real:basic-create`, '真实 W3');
    rejected(`${workflow}\n      - run: node scripts/qa-formal-flow.mjs`, '正式流程');
  });

  it('rejects any additional artifact upload or path', () => {
    rejected(workflow.replace('          if-no-files-found: error', '          if-no-files-found: error\n          path: reports/**'), '产物上传路径');
    rejected(`${workflow}\n      - uses: actions/upload-artifact@v4`, '产物上传步骤');
  });
});
