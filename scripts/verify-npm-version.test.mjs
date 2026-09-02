import { describe, expect, it } from 'vitest';
import { verifyNpmVersion } from './verify-npm-version.mjs';

describe('npm version verifier', () => {
  it('accepts only the exact declared version', () => {
    expect(verifyNpmVersion({ expected: '11.17.0', actual: '11.17.0' })).toEqual({ expected: '11.17.0', actual: '11.17.0' });
    expect(() => verifyNpmVersion({ expected: '11.17.0', actual: '11.6.2' })).toThrow('版本不匹配');
  });
});
