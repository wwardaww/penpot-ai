import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeTemporal } from './ses-guard.js';

const globalThisAny = globalThis as any;
const originalTemporal = globalThisAny.Temporal;

describe('normalizeTemporal', () => {
  afterEach(() => {
    if (originalTemporal === undefined) {
      delete globalThisAny.Temporal;
    } else {
      globalThisAny.Temporal = originalTemporal;
    }
    vi.restoreAllMocks();
  });

  it('keeps a standard Temporal namespace object', () => {
    const temporal = { Now: {} };
    globalThisAny.Temporal = temporal;

    normalizeTemporal();

    expect(globalThisAny.Temporal).toBe(temporal);
  });

  it('fixes the prototype of an injected Temporal object', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class FakeTemporal {}
    const temporal = new FakeTemporal();
    globalThisAny.Temporal = temporal;

    normalizeTemporal();

    expect(globalThisAny.Temporal).toBe(temporal);
    expect(Object.getPrototypeOf(globalThisAny.Temporal)).toBe(
      Object.prototype,
    );
  });

  it('removes an injected Temporal that is not an object', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThisAny.Temporal = function FakeTemporal() {
      return undefined;
    };

    normalizeTemporal();

    expect(globalThisAny.Temporal).toBeUndefined();
  });

  it('does nothing when Temporal is absent', () => {
    delete globalThisAny.Temporal;

    expect(() => normalizeTemporal()).not.toThrow();
    expect(globalThisAny.Temporal).toBeUndefined();
  });
});
