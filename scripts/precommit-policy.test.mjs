import { describe, expect, it } from 'vitest';
import { hasForbiddenWindowsUserPath, isForbiddenRuntimeFile } from './precommit-policy.mjs';

describe('precommit policy', () => {
  it('rejects Windows user paths outside explicit test fixtures', () => {
    const pathFor = (user, slash = '\\') => ['C:', 'Users', user, '.codex'].join(slash);
    expect(hasForbiddenWindowsUserPath('src/config.ts', `const home = '${pathFor('real-user')}'`)).toBe(true);
    expect(hasForbiddenWindowsUserPath('src/config.ts', `const home = '${pathFor('real-user', '\\\\')}'`)).toBe(true);
    expect(hasForbiddenWindowsUserPath('src/config.test.ts', `const home = '${pathFor('tester')}'`)).toBe(false);
    expect(hasForbiddenWindowsUserPath('src/config.test.ts', `const home = '${pathFor('actual-name')}'`)).toBe(true);
    const escaped = '\\\\';
    const realHome = ['C:', 'Users', 'dongh'].join(escaped);
    const changedW3 = `export const W3_APPROVED_CODEX_HOME = '${[realHome, 'other-home'].join(escaped)}';`;
    expect(hasForbiddenWindowsUserPath('scripts/w3-qa-safety.mjs', changedW3)).toBe(true);
    expect(hasForbiddenWindowsUserPath('scripts/w3-qa-safety.test.mjs', `expect(value).toBe('${[realHome, 'other-home'].join(escaped)}')`)).toBe(true);
  });

  it('rejects source-local process evidence and runtime directories', () => {
    for (const file of ['artifacts/app.zip', 'evidence/result.json', 'reports/run.md', 'runtime/data.db', 'captures/ui.png']) expect(isForbiddenRuntimeFile(file)).toBe(true);
    expect(isForbiddenRuntimeFile('src/main.ts')).toBe(false);
  });
});
