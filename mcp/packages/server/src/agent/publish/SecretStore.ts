import { spawn, spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync } from "fs";
import { chmod, mkdir, open, readFile, rm } from "fs/promises";
import { dirname, join } from "path";
import { createLogger } from "../../logger";
import { ChildEnvironment } from "../build/ChildEnvironment";
import { renameWithRetry } from "../workspace/renameWithRetry";

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

interface Accounts {
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
     * Lets only the current user read and write a file: mode 0600 on POSIX; on Windows an ACL
     * without inherited entries that grants the user's SID alone full control.
     *
     * @param path - the file
     * @returns whether the restriction was applied
     */
    public async restrict(path: string): Promise<boolean> {
        if (this.platform !== "win32") {
            await chmod(path, 0o600);
            return true;
        }
        const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
        const who = spawnSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
            windowsHide: true,
            encoding: "utf8",
        });
        const sid = /"(S-1-[0-9-]+)"/.exec(who.stdout ?? "")?.[1];
        if (!sid) {
            this.logger.warn("Could not read the user's SID (whoami exit %s)", String(who.status));
            return false;
        }
        const result = spawnSync(join(system32, "icacls.exe"), [path, "/inheritance:r", "/grant:r", `*${sid}:F`], {
            windowsHide: true,
            encoding: "utf8",
        });
        if (result.status !== 0) {
            this.logger.warn("Could not restrict the access to %s (icacls exit %s)", path, String(result.status));
            return false;
        }
        return true;
    }
}

/**
 * Encryption of the secrets file at rest (a strategy).
 */
export interface SecretCipher {
    /** name stored in the file, or null when the cipher stores plain JSON */
    readonly kind: string | null;
    /** Tells whether the cipher works on this machine. */
    available(): Promise<boolean>;
    protect(plain: Buffer): Promise<Buffer>;
    unprotect(sealed: Buffer): Promise<Buffer>;
}

/** No encryption (POSIX: the owner-only file mode protects the tokens). */
export class PlainCipher implements SecretCipher {
    public readonly kind = null;

    public async available(): Promise<boolean> {
        return true;
    }

    public async protect(plain: Buffer): Promise<Buffer> {
        return plain;
    }

    public async unprotect(sealed: Buffer): Promise<Buffer> {
        return sealed;
    }
}

/**
 * Windows DPAPI encryption bound to the current user (`ProtectedData`, scope CurrentUser).
 *
 * Runs Windows PowerShell with the bytes on stdin (never in arguments or the environment). A
 * plain read of the file gives nothing usable; a program running as the same user can still ask
 * DPAPI to decrypt, which no local mechanism prevents.
 */
export class DpapiCipher implements SecretCipher {
    public readonly kind = "dpapi";
    private static readonly SCRIPT = (method: "Protect" | "Unprotect") =>
        [
            "$ErrorActionPreference = 'Stop'",
            "Add-Type -AssemblyName System.Security",
            "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
            "$entropy = [Text.Encoding]::UTF8.GetBytes('penforge-secrets-v1')",
            `$out = [Security.Cryptography.ProtectedData]::${method}($data, $entropy, ` +
                "[Security.Cryptography.DataProtectionScope]::CurrentUser)",
            "[Console]::Out.Write([Convert]::ToBase64String($out))",
        ].join("; ");

    private works?: Promise<boolean>;

    /**
     * @param platform - DPAPI exists on Windows only
     */
    constructor(private readonly platform: NodeJS.Platform = process.platform) {}

    public available(): Promise<boolean> {
        this.works ??=
            this.platform !== "win32"
                ? Promise.resolve(false)
                : this.protect(Buffer.from("check"))
                      .then((sealed) => this.unprotect(sealed))
                      .then((plain) => plain.toString() === "check")
                      .catch(() => false);
        return this.works;
    }

    public protect(plain: Buffer): Promise<Buffer> {
        return this.run("Protect", plain);
    }

    public unprotect(sealed: Buffer): Promise<Buffer> {
        return this.run("Unprotect", sealed);
    }

    private run(method: "Protect" | "Unprotect", input: Buffer): Promise<Buffer> {
        const powershell = join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        );
        const encoded = Buffer.from(DpapiCipher.SCRIPT(method), "utf16le").toString("base64");
        return new Promise((resolve, reject) => {
            const child = spawn(
                existsSync(powershell) ? powershell : "powershell.exe",
                ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
                { env: ChildEnvironment.scrub(process.env), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
            );
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => {
                out += chunk.toString("utf8");
            });
            child.once("error", reject);
            child.once("close", (code) => {
                if (code === 0 && out.trim().length > 0) {
                    resolve(Buffer.from(out.trim(), "base64"));
                } else {
                    reject(new Error(`DPAPI ${method} failed (exit ${code})`));
                }
            });
            child.stdin.end(input.toString("base64"));
        });
    }
}

/**
 * Store of the provider tokens (GitHub, Vercel, Netlify), owned by the daemon.
 *
 * Keeps them in `<PENFORGE_HOME>/secrets.json`, apart from `config.json` and outside every project
 * folder and git repository. On Windows the content is encrypted with DPAPI for the current user
 * and the file gets an owner-only ACL; elsewhere the file has mode 0600. Without DPAPI, tokens are
 * stored only when the owner-only restriction could be applied. Writes go to a new temporary file
 * that is restricted before any token is written, then replace the old file; a failed write
 * removes the temporary file. Changes run one at a time. The tokens never leave this class except
 * to the provider clients: {@link accounts} reports logins only, and {@link knownTokens} feeds the
 * masking of texts.
 *
 * Limit: a program running as the same user (the generated app's scripts included) can read the
 * file and, on Windows, ask DPAPI to decrypt it; only a separate OS account would prevent that.
 */
export class SecretStore {
    private readonly logger = createLogger("SecretStore");
    private cache?: Accounts;
    private queue: Promise<unknown> = Promise.resolve();

    /**
     * @param path - the secrets file
     * @param access - restricts new files to the user
     * @param cipher - encryption at rest; DPAPI on Windows, none elsewhere
     */
    constructor(
        public readonly path: string,
        private readonly access: OwnerOnlyAccess = new OwnerOnlyAccess(),
        private readonly cipher: SecretCipher = process.platform === "win32" ? new DpapiCipher() : new PlainCipher()
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
    public save(provider: ProviderId, token: string, login: string): Promise<AccountInfo> {
        return this.change(async (file) => {
            const account: StoredAccount = { provider, login, savedAt: new Date().toISOString(), token };
            await this.write({ accounts: { ...file.accounts, [provider]: account } });
            return { provider, login, savedAt: account.savedAt };
        });
    }

    /**
     * Forgets the token of a provider.
     *
     * @param provider - the provider
     * @returns whether an account was connected
     */
    public remove(provider: ProviderId): Promise<boolean> {
        return this.change(async (file) => {
            if (!file.accounts[provider]) {
                return false;
            }
            const accounts = { ...file.accounts };
            delete accounts[provider];
            await this.write({ accounts });
            return true;
        });
    }

    /** Gets the stored tokens known so far, for masking texts. */
    public knownTokens(): string[] {
        return Object.values(this.cache?.accounts ?? {})
            .map((account) => account?.token)
            .filter((token): token is string => typeof token === "string");
    }

    /** Runs a read-modify-write after the previous one. */
    private change<T>(step: (file: Accounts) => Promise<T>): Promise<T> {
        const next = this.queue.then(async () => step(await this.read()));
        this.queue = next.catch(() => undefined);
        return next;
    }

    private async read(): Promise<Accounts> {
        if (this.cache) {
            return this.cache;
        }
        let raw: Buffer;
        try {
            raw = await readFile(this.path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                this.cache = { accounts: {} };
                return this.cache;
            }
            throw error;
        }
        try {
            const parsed = JSON.parse(raw.toString("utf8")) as {
                protection?: unknown;
                data?: unknown;
                accounts?: unknown;
            };
            let content: unknown = parsed;
            if (typeof parsed.protection === "string" && typeof parsed.data === "string") {
                const cipher = parsed.protection === this.cipher.kind ? this.cipher : new DpapiCipher();
                const plain = await cipher.unprotect(Buffer.from(parsed.data, "base64"));
                content = JSON.parse(plain.toString("utf8"));
            }
            this.cache = SecretStore.validate(content);
            return this.cache;
        } catch {
            // the content is never echoed: it holds tokens
            throw new Error(`The Penforge secrets file ${this.path} cannot be read; delete it and connect again`);
        }
    }

    private async write(file: Accounts): Promise<void> {
        const encrypted = this.cipher.kind !== null && (await this.cipher.available());
        const plain = Buffer.from(JSON.stringify({ version: 1, accounts: file.accounts }), "utf8");
        const body = encrypted
            ? JSON.stringify({
                  version: 2,
                  protection: this.cipher.kind,
                  data: (await this.cipher.protect(plain)).toString("base64"),
              })
            : JSON.stringify({ version: 1, accounts: file.accounts }, null, 2);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        let written = false;
        try {
            // restricted before the tokens are written
            const restricted = await this.access.restrict(temporary);
            if (!restricted && !encrypted) {
                throw new Error("The secrets file cannot be limited to your user account, so the token was not stored");
            }
            if (!restricted) {
                this.logger.warn("The secrets file keeps the default access rights; its content is encrypted");
            }
            await handle.writeFile(`${body}\n`, "utf8");
            await handle.close();
            written = true;
            await renameWithRetry(temporary, this.path);
        } catch (error) {
            if (!written) {
                await handle.close().catch(() => undefined);
            }
            await rm(temporary, { force: true }).catch(() => undefined);
            throw error;
        }
        this.cache = file;
    }

    private static validate(value: unknown): Accounts {
        const accounts: Accounts["accounts"] = {};
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
        return { accounts };
    }
}
