import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index';

describe('protocol', () => {
  it('exposes a version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
