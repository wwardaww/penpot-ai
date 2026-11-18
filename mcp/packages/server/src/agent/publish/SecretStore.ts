import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "fs/promises";
import { userInfo } from "os";
import { dirname } from "path";
import { createLogger } from "../../logger";

/** Accounts Penforge can publish to. */
export type ProviderId = "github" | "vercel" | "netlify";

/** All providers, in display order. */
export const PROVIDERS: readonly ProviderId[] = ["github", "vercel", "netlify"];

/** What the browser may know about a connected account (never the token). */
export interface AccountInfo {
    provider: ProviderId;
    login: string;
    savedAt: string;
}

interface StoredAccount extends AccountInfo {
    token: string;
}

interface SecretsFile {
    version: 1;
    accounts: Partial<Record<ProviderId, StoredAccount>>;
}

/**
 * Restricter of a file to its owner (a strategy, so tests run without `icacls`).
 */
export class OwnerOnlyAccess {
    private readonly logger = createLogger("OwnerOnlyAccess");

    /**
     * @param platform - the platform whose mechanism applies
     */
    constructor(private readonly platform: NodeJS.Platform = process.platform) {}

    /**
     * Lets only the current user read and write a file: mode 0600 on POSIX; on Windows (best
     * effort) an ACL without inherited entries that grants the user alone full control.
     *
     * @param path - the file
     */
    public async restrict(path: string): Promise<void> {
        if (this.platform !== "win32") {
            await chmod(path, 0o600);
            return;
        }
        const user = userInfo().username;
        const result = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], {
            windowsHide: true,
            encoding: "utf8",
        });
        if (result.status !== 0) {
            this.logger.warn("Could not restrict the access to %s (icacls exit %s)", path, String(result.status));
        }
    }
}

/**
 * Store of the provider tokens (GitHub, Vercel, Netlify), owned by the daemon.
 *
 * Keeps them in `<PENFORGE_HOME>/secrets.json`, apart from `config.json` and outside every project
 * folder and git repository, readable by the user only ({@link OwnerOnlyAccess}). Writes go to a
 * new restricted file that then replaces the old one. The tokens never leave this class except
 * to the provider clients: {@link accounts} reports logins only, and {@link knownTokens} feeds the
 * masking of texts.
 */
export class SecretStore {
    private cache?: SecretsFile;

    /**
     * @param path - the secrets file
     * @param access - restricts new files to the user
     */
    constructor(
        public readonly path: string,
        private readonly access: OwnerOnlyAccess = new OwnerOnlyAccess()
    ) {}

    /** Gets the connected accounts, without tokens. */
    public async accounts(): Promise<AccountInfo[]> {
        const file = await this.read();
        return Object.values(file.accounts)
            .filter((account): account is StoredAccount => account !== undefined)
            .map(({ provider, login, savedAt }) => ({ provider, login, savedAt }));
    }

    /**
     * Gets the account of a provider, without its token.
     *
     * @param provider - the provider
     */
    public async account(provider: ProviderId): Promise<AccountInfo | null> {
        return (await this.accounts()).find((account) => account.provider === provider) ?? null;
    }

    /**
     * Gets the token of a provider.
     *
     * @param provider - the provider
     * @returns the token, or null when the account is not connected
     */
    public async token(provider: ProviderId): Promise<string | null> {
        return (await this.read()).accounts[provider]?.token ?? null;
    }

    /**
     * Stores a checked token.
     *
     * @param provider - the provider
     * @param token - the token
     * @param login - the account name the provider reported for it
     */
    public async save(provider: ProviderId, token: string, login: string): Promise<AccountInfo> {
        const file = await this.read();
        const account: StoredAccount = { provider, login, savedAt: new Date().toISOString(), token };
        await this.write({ version: 1, accounts: { ...file.accounts, [provider]: account } });
        return { provider, login, savedAt: account.savedAt };
    }

    /**
     * Forgets the token of a provider.
     *
     * @param provider - the provider
     * @returns whether an account was connected
     */
    public async remove(provider: ProviderId): Promise<boolean> {
        const file = await this.read();
        if (!file.accounts[provider]) {
            return false;
        }
        const accounts = { ...file.accounts };
        delete accounts[provider];
        await this.write({ version: 1, accounts });
        return true;
    }

    /** Gets the stored tokens known so far, for masking texts. */
    public knownTokens(): string[] {
        return Object.values(this.cache?.accounts ?? {})
            .map((account) => account?.token)
            .filter((token): token is string => typeof token === "string");
    }

    private async read(): Promise<SecretsFile> {
        if (this.cache) {
            return this.cache;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readFile(this.path, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                this.cache = { version: 1, accounts: {} };
                return this.cache;
            }
            // the content is never echoed: it holds tokens
            throw new Error(`The Penforge secrets file ${this.path} cannot be read; delete it and connect again`);
        }
        this.cache = SecretStore.validate(parsed);
        return this.cache;
    }

    private async write(file: SecretsFile): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            // restricted before the tokens are written
            await this.access.restrict(temporary);
            await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        } catch (error) {
            await handle.close();
            await rm(temporary, { force: true });
            throw error;
        }
        await handle.close();
        await rename(temporary, this.path);
        this.cache = file;
    }

    private static validate(value: unknown): SecretsFile {
        const accounts: SecretsFile["accounts"] = {};
        const raw = (value as { accounts?: unknown })?.accounts;
        if (typeof raw === "object" && raw !== null) {
            for (const provider of PROVIDERS) {
                const entry = (raw as Record<string, unknown>)[provider] as Partial<StoredAccount> | undefined;
                if (typeof entry?.token === "string" && typeof entry.login === "string") {
                    accounts[provider] = {
                        provider,
                        token: entry.token,
                        login: entry.login,
                        savedAt: typeof entry.savedAt === "string" ? entry.savedAt : "",
                    };
                }
            }
        }
        return { version: 1, accounts };
    }
}
