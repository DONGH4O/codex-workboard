import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createPackage } from '@electron/asar';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectWindowsPackage, main } from './verify-windows-package.mjs';

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workboard-package-'));
  mkdirSync(path.join(root, 'resources'), { recursive: true });
  writeFileSync(path.join(root, 'Codex Workboard.exe'), 'exe');
  const application = mkdtempSync(path.join(os.tmpdir(), 'workboard-application-'));
  mkdirSync(path.join(application, 'dist-electron'), { recursive: true });
  mkdirSync(path.join(application, 'dist-renderer'), { recursive: true });
  writeFileSync(path.join(application, 'package.json'), '{}');
  writeFileSync(path.join(application, 'dist-electron', 'main.js'), 'main');
  writeFileSync(path.join(application, 'dist-electron', 'preload.cjs'), 'preload');
  writeFileSync(path.join(application, 'dist-renderer', 'index.html'), 'renderer');
  await createPackage(application, path.join(root, 'resources', 'app.asar'));
  return root;
}

describe('Windows directory package inspection', () => {
  it('accepts a complete directory package without a bundled Codex CLI', async () => {
    const root = await fixture();
    expect(inspectWindowsPackage(root)).toMatchObject({ missing: [], missingArchiveEntries: [], forbidden: [] });
    expect(() => main([root], () => {})).not.toThrow();
  });

  it('rejects application test files inside app.asar', async () => {
    const root = await fixture();
    const application = mkdtempSync(path.join(os.tmpdir(), 'workboard-application-'));
    mkdirSync(path.join(application, 'dist-electron'), { recursive: true });
    mkdirSync(path.join(application, 'dist-renderer'), { recursive: true });
    writeFileSync(path.join(application, 'package.json'), '{}');
    writeFileSync(path.join(application, 'dist-electron', 'main.js'), 'main');
    writeFileSync(path.join(application, 'dist-electron', 'preload.cjs'), 'preload');
    writeFileSync(path.join(application, 'dist-electron', 'main.test.js'), 'test');
    writeFileSync(path.join(application, 'dist-renderer', 'index.html'), 'renderer');
    await createPackage(application, path.join(root, 'resources', 'app.asar'));
    expect(() => main([root], () => {})).toThrow('不应包含应用测试');
  });

  it('rejects an incomplete package or a bundled Codex executable', async () => {
    const incomplete = mkdtempSync(path.join(os.tmpdir(), 'workboard-package-'));
    expect(inspectWindowsPackage(incomplete).missing).toContain('Codex Workboard.exe');
    const root = await fixture();
    mkdirSync(path.join(root, 'resources', 'bin'));
    writeFileSync(path.join(root, 'resources', 'bin', 'codex.exe'), 'forbidden');
    expect(() => main([root], () => {})).toThrow('不应捆绑 Codex CLI');
  });
});
