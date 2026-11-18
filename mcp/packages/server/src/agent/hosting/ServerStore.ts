import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { chmod, mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { SecretBox } from "./SecretBox";

/** Limits of server mode; `0` disables a limit. */
export interface ServerLimits {
    /** Claude turns one user may run at the same time */
    concurrentTurnsPerUser: number;
    /** Claude turns one user may start per minute */
    turnsPerMinutePerUser: number;
    /** Claude turns one user may start per day (UTC) */
    turnsPerDayPerUser: number;
    /** input + output tokens one team may use per month (UTC) */
    monthlyTokensPerTeam: number;
}

/** Settings an admin edits (stored in `<home>/server/settings.json`). */
export interface ServerSettingsValues {
    limits: ServerLimits;
    /** Claude model; the SDK default when empty */
    model?: string;
}

/** Content of `<home>/server/secrets.enc.json`. */
interface SecretsFile {
    /** sealed install API key */
    apiKey?: string;
    /** sealed API keys of single teams */
    teamApiKeys?: Record<string, string>;
}

/** What the admin page may show about a key: never the key itself. */
export interface ApiKeyStatus {
    configured: boolean;
    /** last four characters */
    hint?: string;
}

/**
 * Store of the server-mode settings and secrets on the data volume.
 *
 * API keys are sealed with the master key ({@link SecretBox}) and only ever leave the store
 * towards the credential proxy. Writes go through a temporary file and a rename, one at a time,
 * with owner-only file access.
 */
export class ServerStore {
    /** Defaults for a new install. */
    public static readonly DEFAULT_LIMITS: ServerLimits = {
        concurrentTurnsPerUser: 2,
        turnsPerMinutePerUser: 6,
        turnsPerDayPerUser: 300,
        monthlyTokensPerTeam: 0,
    };

    private static readonly INSTALL_KEY = "api-key:install";
    private static readonly TEAM_KEY = "api-key:team:";

    private writes: Promise<void> = Promise.resolve();
    private settingsCache?: ServerSettingsValues;

    /**
     * @param box - seals the secrets
     * @param settingsPath - path of `settings.json`
     * @param secretsPath - path of `secrets.enc.json`
     */
    constructor(
        private readonly box: SecretBox,
        private readonly settingsPath: string,
        private readonly secretsPath: string
    ) {}

    /** Current settings (defaults for missing values). */
    public async settings(): Promise<ServerSettingsValues> {
        if (!this.settingsCache) {
            const file = await ServerStore.readJson<Partial<ServerSettingsValues>>(this.settingsPath, {});
            this.settingsCache = {
                limits: ServerStore.limits({ ...ServerStore.DEFAULT_LIMITS, ...(file.limits ?? {}) }),
                model: typeof file.model === "string" && file.model.trim() ? file.model.trim() : undefined,
            };
        }
        return this.settingsCache;
    }

    /**
     * Changes settings.
     *
     * @param change - the values to change; `model: ""` resets the model
     */
    public async updateSettings(change: {
        limits?: Partial<ServerLimits>;
        model?: string;
    }): Promise<ServerSettingsValues> {
        const current = await this.settings();
        const next: ServerSettingsValues = {
            limits: ServerStore.limits({ ...current.limits, ...(change.limits ?? {}) }),
            model: change.model === undefined ? current.model : change.model.trim() || undefined,
        };
        await this.write(this.settingsPath, next);
        this.settingsCache = next;
        return next;
    }

    /**
     * Gets the API key for a team: the team's own key, else the install key.
     *
     * @param teamId - the team; the install key when omitted
     */
    public async apiKey(teamId?: string): Promise<string | undefined> {
        const file = await ServerStore.readJson<SecretsFile>(this.secretsPath, {});
        const teamSealed = teamId ? file.teamApiKeys?.[teamId] : undefined;
        if (teamSealed) {
            return this.box.open(teamSealed, ServerStore.TEAM_KEY + teamId);
        }
        return file.apiKey ? this.box.open(file.apiKey, ServerStore.INSTALL_KEY) : undefined;
    }

    /** Tells whether the install key is set, with its last characters. */
    public async apiKeyStatus(): Promise<ApiKeyStatus> {
        const key = await this.apiKey();
        return key ? { configured: true, hint: key.slice(-4) } : { configured: false };
    }

    /**
     * Sets or removes an API key.
     *
     * @param key - the key; removes it when empty
     * @param teamId - the team; the install key when omitted
     */
    public async setApiKey(key: string, teamId?: string): Promise<void> {
        const value = key.trim();
        if (value && !/^[\x21-\x7e]{8,512}$/.test(value)) {
            throw new Error("The API key has unexpected characters");
        }
        await this.mutate(async () => {
            const file = await ServerStore.readJson<SecretsFile>(this.secretsPath, {});
            if (teamId) {
                const teams = { ...(file.teamApiKeys ?? {}) };
                if (value) {
                    teams[teamId] = this.box.seal(value, ServerStore.TEAM_KEY + teamId);
                } else {
                    delete teams[teamId];
                }
                file.teamApiKeys = teams;
            } else if (value) {
                file.apiKey = this.box.seal(value, ServerStore.INSTALL_KEY);
            } else {
                delete file.apiKey;
            }
            await this.writeNow(this.secretsPath, file);
        });
    }

    private static limits(values: ServerLimits): ServerLimits {
        const clean = (value: unknown, max: number) => {
            const number = Math.floor(Number(value));
            return Number.isFinite(number) && number >= 0 ? Math.min(number, max) : 0;
        };
        return {
            concurrentTurnsPerUser: clean(values.concurrentTurnsPerUser, 100),
            turnsPerMinutePerUser: clean(values.turnsPerMinutePerUser, 10_000),
            turnsPerDayPerUser: clean(values.turnsPerDayPerUser, 1_000_000),
            monthlyTokensPerTeam: clean(values.monthlyTokensPerTeam, 1e12),
        };
    }

    private write(path: string, value: unknown): Promise<void> {
        return this.mutate(() => this.writeNow(path, value));
    }

    private mutate(change: () => Promise<void>): Promise<void> {
        const next = this.writes.then(change);
        this.writes = next.catch(() => {});
        return next;
    }

    private async writeNow(path: string, value: unknown): Promise<void> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
        await chmod(temp, 0o600).catch(() => {});
        await rename(temp, path);
    }

    private static async readJson<T>(path: string, fallback: T): Promise<T> {
        if (!existsSync(path)) {
            return fallback;
        }
        try {
            return JSON.parse(await readFile(path, "utf8")) as T;
        } catch (error) {
            throw new Error(`Unreadable server file ${path}: ${String(error)}`);
        }
    }
}
