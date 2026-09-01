import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const schemaRoot = process.env.WORKBOARD_W2_SCHEMA_DIR
  ? path.resolve(process.env.WORKBOARD_W2_SCHEMA_DIR)
  : path.resolve(process.cwd(), '..', 'reports', 'W2', 'protocol-schema', 'typescript');

const requirements = [
  ['RequestId.ts', ['string | number']],
  ['InitializeCapabilities.ts', ['experimentalApi: boolean', 'requestAttestation: boolean']],
  ['InitializeResponse.ts', ['codexHome:', 'platformFamily: string', 'platformOs: string']],
  ['v2/GetAccountResponse.ts', ['account: Account | null', 'requiresOpenaiAuth: boolean']],
  ['v2/ModelListParams.ts', ['cursor?: string | null', 'limit?: number | null']],
  ['v2/ModelListResponse.ts', ['nextCursor: string | null']],
  ['v2/AskForApproval.ts', ['"untrusted"', '"on-request"', '"never"']],
  ['v2/SandboxPolicy.ts', ['writableRoots:', 'networkAccess: boolean', 'excludeTmpdirEnvVar: boolean', 'excludeSlashTmp: boolean']],
  ['v2/ToolRequestUserInputParams.ts', ['questions:', 'isBlocking: boolean', 'autoResolutionMs: number | null']],
  ['v2/ToolRequestUserInputResponse.ts', ['answers:']],
  ['v2/ServerRequestResolvedNotification.ts', ['requestId: RequestId']],
];

for (const [relativePath, fragments] of requirements) {
  const content = readFileSync(path.join(schemaRoot, relativePath), 'utf8');
  for (const fragment of fragments) {
    if (!content.includes(fragment)) throw new Error(`${relativePath} 缺少固定协议片段：${fragment}`);
  }
}

console.log(`W2 protocol contract PASS (${requirements.length} files checked)`);
