import { describe, it, expect } from 'vitest';

describe('smoke', () => {
  it('basic sanity', () => {
    expect(1 + 1).toBe(2);
  });

  it('node version >= 22', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
