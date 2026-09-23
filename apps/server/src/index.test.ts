import { describe, expect, it } from 'vitest';

import { resolveWebDist } from './static';

describe('server', () => {
  it('resolves a web dist directory', () => {
    expect(resolveWebDist()).toMatch(/web[\\/]dist$/);
  });
});
