import { getPluginRuntimeFailure } from './ses-guard.js';

let isLockedDown = false;

export const ses = {
  hardenIntrinsics: () => {
    const failure = getPluginRuntimeFailure();
    if (failure !== null) {
      throw new Error('Plugin system is disabled: SES failed to initialize', {
        cause: failure,
      });
    }
    if (!isLockedDown) {
      isLockedDown = true;
      hardenIntrinsics();
    }
  },
  createCompartment: (globals?: object) => {
    return new Compartment(globals);
  },
  harden: (obj: object) => {
    return harden(obj);
  },
  safeReturn<T>(value: T): T {
    if (value === null || value === undefined) {
      return value;
    }

    return harden(value) as T;
  },
};
