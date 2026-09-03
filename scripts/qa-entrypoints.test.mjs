import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const source = (name) => readFileSync(path.join(import.meta.dirname, name), 'utf8');
const formalTemporaryDirectories = () => readdirSync(tmpdir()).filter((name) => name.startsWith('codex-workboard-formal-flow-')).sort();

describe('QA entrypoint boundaries', () => {
  it('refuses formal flow before creating data or spawning a process', () => {
    const before = formalTemporaryDirectories();
    const environment = { ...process.env };
    delete environment.WORKBOARD_W5_REAL_FLOW;
    delete environment.WORKBOARD_PACKAGE_DIR;
    delete environment.WORKBOARD_QA_EVIDENCE_PATH;
    const run = spawnSync(process.execPath, [path.join(import.meta.dirname, 'qa-formal-flow.mjs')], { cwd: root, env: environment, encoding: 'utf8', windowsHide: true });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('正式流程默认拒绝');
    expect(formalTemporaryDirectories()).toEqual(before);
    const text = source('qa-formal-flow.mjs');
    expect(text.indexOf('validateFormalFlowGate(process.argv')).toBeLessThan(text.indexOf("await import('../dist-electron/codexBridge.js')"));
    expect(text.indexOf('validateFormalFlowGate(process.argv')).toBeLessThan(text.indexOf('mkdtempSync('));
    expect(text.indexOf('preflightEvidenceTarget(evidencePath)')).toBeLessThan(text.indexOf('mkdtempSync('));
  });

  it('keeps packaged and source launches explicit at their entrypoints', () => {
    const electron = source('qa-electron.mjs');
    const offline = source('qa-offline-ui.mjs');
    const governed = source('qa-governed-ui.mjs');
    const formal = source('qa-formal-flow.mjs');
    expect(electron).toContain("buildIsolatedQaEnvironment({ ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, userData)");
    expect(electron).toContain('copyPackagedDirectory(sourcePackage.packageDir, stagedPackageDir');
    expect(electron).toContain('buildOfflineLaunchConfiguration({ packaged: true');
    expect(electron).toContain('waitForDevToolsPort(child, launch.devToolsDataDir');
    expect(electron.indexOf('async function run()')).toBeLessThan(electron.indexOf("createQaTemporaryRoot('ui-')"));
    expect(electron).toContain('writeEvidenceAtomically(artifactPaths.WORKBOARD_QA_EVIDENCE_PATH');
    expect(offline).toContain('buildOfflineLaunchConfiguration({ packaged: packagedMode');
    expect(offline).toContain("codexCliPath: path.join(temporaryRoot, 'must-not-run-codex.exe')");
    expect(governed).toContain("createQaTemporaryRoot('governed-ui-')");
    expect(governed).toContain("WORKBOARD_QA_UI_HARNESS: '1'");
    expect(governed).toContain("codexCliPath: path.join(temporaryRoot, 'must-not-run-codex.exe')");
    expect(governed).toContain('buildOfflineLaunchConfiguration({ packaged: true');
    expect(governed.indexOf('await session.waitUntil(cardExpression')).toBeLessThan(governed.indexOf('const opened = await session.evaluate'));
    expect(governed).toContain('cardCount: document.querySelectorAll');
    const assertStagingOrder = (text, launchMarker) => {
      const run = text.slice(text.indexOf('async function run()'));
      const sourceCheck = run.indexOf("assertMacBundleRuntimeResources(sourcePackage.executable, { platform: sourcePackage.platform, stage: 'source' })");
      const copy = run.indexOf('copyPackagedDirectory(sourcePackage.packageDir, stagedPackageDir)');
      const stagedCheck = run.indexOf("assertMacBundleRuntimeResources(staged.executable, { platform: staged.platform, stage: 'staged' })");
      const launch = run.indexOf(launchMarker);
      expect(sourceCheck).toBeGreaterThanOrEqual(0);
      expect(sourceCheck).toBeLessThan(copy);
      expect(copy).toBeLessThan(stagedCheck);
      expect(stagedCheck).toBeLessThan(launch);
    };
    assertStagingOrder(electron, 'const launch = buildOfflineLaunchConfiguration');
    assertStagingOrder(offline, 'const launch = buildOfflineLaunchConfiguration');
    assertStagingOrder(governed, 'const first = await launch()');
    expect(formal).toContain('buildOfflineLaunchConfiguration({ packaged: true');
    expect(formal).toContain('waitForDevToolsPort(child, launch.devToolsDataDir');
  });

  it('keeps graceful close, connection close and writer lease checks in every lifecycle', () => {
    for (const name of ['qa-electron.mjs', 'qa-offline-ui.mjs', 'qa-formal-flow.mjs', 'qa-governed-ui.mjs']) {
      const text = source(name);
      const lifecycleText = name === 'qa-governed-ui.mjs' ? `${text}\n${source('qa-governed-session.mjs')}` : text;
      expect(lifecycleText).toContain('closeOwnedProcess(');
      expect(lifecycleText).toContain('writer lease');
      expect(text).toContain('canRemoveQaTemporaryData(');
    }
    expect(source('qa-formal-flow.mjs')).toContain('this.child.stdin.end()');
    expect(source('qa-electron.mjs')).toContain("method: 'Page.close'");
    expect(source('qa-offline-ui.mjs')).toContain("request('Page.close')");
  });
});
