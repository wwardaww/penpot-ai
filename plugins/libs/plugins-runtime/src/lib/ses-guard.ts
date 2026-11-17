// Browser extensions (crypto wallets and similar) may inject their own
// `Temporal` global before Penpot loads. SES only accepts a `Temporal`
// namespace object whose prototype is `Object.prototype`, and otherwise
// throws during `repairIntrinsics`, which aborts the whole libs bundle
// and leaves the app on a blank screen.

let repairFailure: unknown = null;

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

/**
 * Run SES `repairIntrinsics` without letting a failure break the host
 * application. When it fails, the plugin system stays disabled.
 */
export function safeRepairIntrinsics(options: object): void {
  normalizeTemporal();

  try {
    globalThisAny.repairIntrinsics(options);
  } catch (err) {
    repairFailure = err;
    console.error(
      '[PLUGINS] Plugin system disabled: SES could not initialize. ' +
        'A browser extension may be modifying JavaScript built-ins; ' +
        'try a window without extensions.',
      err,
    );
  }
}

export function isPluginRuntimeAvailable(): boolean {
  return repairFailure === null;
}

export function getPluginRuntimeFailure(): unknown {
  return repairFailure;
}
