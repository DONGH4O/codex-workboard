import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const NETWORK_FAILURE_MARKERS = [
  /audit network timeout/i,
  /audit endpoint returned an error/i,
];
const VULNERABILITY_REPORT_MARKERS = [
  /# npm audit report/i,
  /\b[1-9]\d*\s+(?:(?:low|moderate|high|critical)\s+severity\s+)?vulnerabilit(?:y|ies)\b/i,
];

export function isRetryableAuditEndpointFailure(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return NETWORK_FAILURE_MARKERS.every((pattern) => pattern.test(output))
    && !VULNERABILITY_REPORT_MARKERS.some((pattern) => pattern.test(output));
}

export function buildNpmAuditInvocation(npmCliPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (typeof npmCliPath !== 'string' || !platformPath.isAbsolute(npmCliPath)) {
    throw new Error('npm 安全审计需要由 npm script 提供绝对路径 npm_execpath。');
  }
  return {
    executable: options.executable ?? process.execPath,
    args: [npmCliPath, 'audit', '--registry=https://registry.npmjs.org', '--audit-level=high'],
  };
}

export function runSecurityAudit(options = {}) {
  const npmCliPath = options.npmCliPath ?? process.env.npm_execpath;
  const writeOut = options.writeOut ?? ((value) => process.stdout.write(value));
  const writeErr = options.writeErr ?? ((value) => process.stderr.write(value));
  let invocation;
  try {
    invocation = buildNpmAuditInvocation(npmCliPath, options);
  } catch (error) {
    writeErr(`${error.message}\n`);
    return 1;
  }
  const { executable, args } = invocation;
  const execute = options.execute ?? (() => spawnSync(executable, args, { encoding: 'utf8', windowsHide: true }));

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = execute({ executable, args, attempt });
    if (result.stdout) writeOut(result.stdout);
    if (result.stderr) writeErr(result.stderr);
    if (result.error) writeErr(`${result.error.message}\n`);
    if (result.status === 0) return 0;
    if (attempt === 1 && isRetryableAuditEndpointFailure(result)) {
      writeErr('npm 安全审计端点暂时不可用，将进行唯一一次重试。\n');
      continue;
    }
    return Number.isInteger(result.status) ? result.status : 1;
  }
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runSecurityAudit();
}
