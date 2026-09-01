import { describe, expect, it, vi } from 'vitest';
import { parseWorkboardRunArgs } from './runControl.js';

describe('Workboard run control arguments', () => {
  it('accepts a complete isolated Windows binding', () => {
    expect(parseWorkboardRunArgs([
      '--workboard-run-id=12345678-abcd',
      '--workboard-data-dir=F:\\isolated\\data',
      '--workboard-control-pipe=\\\\.\\pipe\\codex-workboard-12345678-abcd',
    ])).toMatchObject({ runId: '12345678-abcd', dataDir: 'F:\\isolated\\data' });
  });

  it('rejects partial, relative, or unrelated pipe bindings', () => {
    expect(() => parseWorkboardRunArgs(['--workboard-run-id=12345678'])).toThrow();
    expect(() => parseWorkboardRunArgs(['--workboard-run-id=12345678', '--workboard-data-dir=.\\data', '--workboard-control-pipe=\\\\.\\pipe\\codex-workboard-12345678'])).toThrow('绝对路径');
    expect(() => parseWorkboardRunArgs(['--workboard-run-id=12345678', '--workboard-data-dir=F:\\data', '--workboard-control-pipe=untrusted'])).toThrow('控制管道');
  });
});
