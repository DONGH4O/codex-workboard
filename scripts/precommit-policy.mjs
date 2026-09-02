export function hasForbiddenWindowsUserPath(relative, content) {
  const separator = '\\\\';
  const approvedHome = ['C:', 'Users', 'dongh'].join(separator);
  const exactExceptions = relative === 'scripts/w3-qa-safety.mjs' ? [
    `export const W3_APPROVED_CODEX_CLI = '${[approvedHome, 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'b99306303521e97e', 'codex.exe'].join(separator)}';`,
    `export const W3_APPROVED_CODEX_HOME = '${[approvedHome, '.codex'].join(separator)}';`,
  ] : relative === 'scripts/w3-qa-safety.test.mjs' ? [
    `      error: new Error('thread-123 ${approvedHome} secret reply'),`,
    `    expect(serialized).not.toContain('${approvedHome}');`,
  ] : [];
  let inspected = content;
  for (const exact of exactExceptions) inspected = inspected.replace(exact, '');
  const matches = inspected.match(/\b[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+(?:\\{1,2}|(?=['"\s]))/g) ?? [];
  if (!matches.length) return false;
  const usernames = matches.map((match) => match.match(/Users\\{1,2}([A-Za-z0-9._-]+)(?:\\{1,2}|$)/)?.[1]);
  if (/\.test\.(?:mjs|js|ts|tsx)$/.test(relative) && usernames.every((name) => ['tester', 'qa', 'private'].includes(name))) return false;
  return true;
}

export function isForbiddenRuntimeFile(file) {
  return /^(?:runtime|reports|state|data|artifacts|evidence|qa|screenshots|captures)(?:\/|$)/i.test(file)
    || /^scripts\/qa-.*-evidence\.json$/i.test(file)
    || /\.(?:sqlite|sqlite3|db|dmp)$/i.test(file);
}
