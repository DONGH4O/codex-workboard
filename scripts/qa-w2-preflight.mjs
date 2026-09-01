import { CodexBridge } from '../dist-electron/codexBridge.js';

const bridge = new CodexBridge();
let failure = '';
try {
  await bridge.start();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
const status = bridge.status();
await bridge.stop();

if (status.state !== 'ready' && status.state !== 'auth_required') {
  throw new Error(`W2 preflight failed in ${status.state}: ${failure || status.error || 'unknown error'}`);
}
if (status.state === 'auth_required' && (status.connected || status.modelListChecked)) {
  throw new Error('AUTH_REQUIRED must not remain connected or call model/list');
}

console.log(JSON.stringify({
  result: 'PASS',
  state: status.state,
  connected: status.connected,
  source: status.source,
  executablePath: status.executablePath,
  codexHome: status.codexHome,
  version: status.version,
  expectedVersion: status.expectedVersion,
  platformFamily: status.platformFamily,
  platformOs: status.platformOs,
  accountChecked: status.accountChecked,
  modelListChecked: status.modelListChecked,
  windowsSandbox: status.windowsSandbox,
  message: failure || status.error || '',
}, null, 2));
