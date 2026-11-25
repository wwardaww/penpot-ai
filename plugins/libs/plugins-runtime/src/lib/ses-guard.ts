// Browser extensions (crypto wallets and similar) may inject their own
// `Temporal` global before Penpot loads. SES only accepts a `Temporal`
// namespace object whose prototype is `Object.prototype`, and otherwise
// throws during `repairIntrinsics`, which aborts the whole libs bundle
// and leaves the app on a blank screen.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalThisAny = globalThis as any;

/**
 * Make an injected `Temporal` acceptable to SES, or remove it when that is
 * not possible. A native `Temporal` is left untouched.
 */
export function normalizeTemporal(): void {
  const temporal = globalThisAny.Temporal;

  if (temporal === undefined) {
    return;
  }

  try {
    if (
      typeof temporal === 'object' &&
      temporal !== null &&
      Object.getPrototypeOf(temporal) === Object.prototype
    ) {
      return;
    }

    if (typeof temporal === 'object' && temporal !== null) {
      Object.setPrototypeOf(temporal, Object.prototype);
      if (Object.getPrototypeOf(temporal) === Object.prototype) {
        console.warn(
          '[PLUGINS] Fixed the prototype of a non-standard Temporal global ' +
            '(probably injected by a browser extension).',
        );
        return;
      }
    }
  } catch {
    // Fall through and remove the global.
  }

  try {
    delete globalThisAny.Temporal;
    console.warn(
      '[PLUGINS] Removed a non-standard Temporal global ' +
        '(probably injected by a browser extension).',
    );
  } catch (err) {
    console.warn('[PLUGINS] Could not neutralize the Temporal global', err);
  }
}
