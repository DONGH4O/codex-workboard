import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function expectedNpmVersion(checkoutRoot = path.resolve(import.meta.dirname, '..')) {
  const pkg = JSON.parse(readFileSync(path.join(checkoutRoot, 'package.json'), 'utf8'));
  const match = /^npm@(.+)$/.exec(pkg.packageManager ?? '');
  if (!match) throw new Error('package.json packageManager 未锁定 npm 版本');
  return match[1];
}

export function activeNpmVersion(environment = process.env, execute = execFileSync) {
  if (environment.npm_execpath) {
    return execute(process.execPath, [environment.npm_execpath, '--version'], { encoding: 'utf8' }).trim();
  }
  return execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' }).trim();
}

export function verifyNpmVersion(options = {}) {
  const expected = options.expected ?? expectedNpmVersion(options.checkoutRoot);
  const actual = options.actual ?? activeNpmVersion(options.environment, options.execute);
  if (actual !== expected) throw new Error(`npm 版本不匹配：期望 ${expected}，实际 ${actual}`);
  return { expected, actual };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = verifyNpmVersion();
  console.log(`NPM_VERSION_OK ${result.actual}`);
}
