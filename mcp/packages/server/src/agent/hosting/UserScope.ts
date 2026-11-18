import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Penpot user a request of a server-mode session runs for.
 */
export class PenpotUser {
    /**
     * @param profileId - the Penpot profile id
     * @param email - the profile's email (lower case)
     * @param fullname - the profile's display name
     */
    constructor(
        public readonly profileId: string,
        public readonly email: string,
        public readonly fullname: string
    ) {}
}

/** User and team a request runs for. */
export interface UserScopeValue {
    user: PenpotUser;
    /** team of the project the session works on, once its context is checked */
    teamId?: string;
}

/**
 * Scope of the Penpot user a server-mode request runs for.
 *
 * The session runs each request inside {@link run}, so services deep below it (the API key
 * runner, the rate limiter, the usage ledger) know the user without new parameters on every
 * call. Outside a scope (local mode, tests) {@link current} is undefined.
 */
export class UserScope {
    private static readonly storage = new AsyncLocalStorage<UserScopeValue>();

    /**
     * Runs a function in a user's scope.
     *
     * @param value - the user and team
     * @param fn - the function
     */
    public static run<T>(value: UserScopeValue, fn: () => T): T {
        return UserScope.storage.run(value, fn);
    }

    /** The scope of the running request, if any. */
    public static current(): UserScopeValue | undefined {
        return UserScope.storage.getStore();
    }
}
