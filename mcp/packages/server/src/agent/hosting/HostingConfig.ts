import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Settings of server mode (`PENFORGE_MODE=server`), read from the environment.
 *
 * Server mode serves a team install behind one TLS entry point: users are Penpot users (their
 * Penpot session authenticates them), Claude runs with the install's Anthropic API key, and
 * project folders are kept per team.
 */
export class HostingConfig {
    /** Default Anthropic API base URL the credential proxy forwards to. */
    public static readonly DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

    /**
     * @param values - the settings
     */
    constructor(
        public readonly values: {
            /** Penforge data folder */
            home: string;
            /** internal URL of the Penpot backend (`http://penpot-backend:6060`) */
            backendUri: string;
            /** master key encrypting stored secrets and signing tokens (32 bytes) */
            secretKey: Buffer;
            /** emails of the profiles that may open the admin page (lower case) */
            adminEmails: string[];
            /** Anthropic API base URL (`PENFORGE_ANTHROPIC_BASE_URL`) */
            anthropicUrl: string;
            /** name of the Penpot session cookie */
            cookieName: string;
            /** URL of the sandbox controller running generated code; none disables it */
            sandboxUrl?: string;
            /** domain whose subdomains serve the previews (`<project-id>.<domain>`) */
            previewDomain?: string;
        }
    ) {}

    public get home(): string {
        return this.values.home;
    }

    public get backendUri(): string {
        return this.values.backendUri;
    }

    public get secretKey(): Buffer {
        return this.values.secretKey;
    }

    /** Folder of the server-mode files (encrypted secrets, settings, usage). */
    public get serverDir(): string {
        return join(this.values.home, "server");
    }

    /** Folder holding the team folders (`teams/<team-id>/projects/<project-id>`). */
    public get teamsDir(): string {
        return join(this.values.home, "teams");
    }

    /**
     * Checks whether an email belongs to an admin.
     *
     * @param email - the profile's email
     */
    public isAdmin(email: string): boolean {
        return this.values.adminEmails.includes(email.trim().toLowerCase());
    }

    /**
     * Tells whether the environment asks for server mode.
     *
     * @param env - the environment
     */
    public static isServerMode(env: Record<string, string | undefined>): boolean {
        return env.PENFORGE_MODE?.trim().toLowerCase() === "server";
    }

    /**
     * Reads the server-mode settings.
     *
     * @param env - the environment
     * @param home - the Penforge data folder
     * @throws Error when a required setting is missing or invalid
     */
    public static load(env: Record<string, string | undefined>, home: string): HostingConfig {
        const backendUri = HostingConfig.nonBlank(env.PENFORGE_PENPOT_BACKEND_URI);
        if (!backendUri || !/^https?:\/\//i.test(backendUri)) {
            throw new Error("Server mode needs PENFORGE_PENPOT_BACKEND_URI (e.g. http://penpot-backend:6060)");
        }
        return new HostingConfig({
            home,
            backendUri: backendUri.replace(/\/+$/, ""),
            secretKey: HostingConfig.secretKey(env),
            adminEmails: (HostingConfig.nonBlank(env.PENFORGE_ADMIN_EMAILS) ?? "")
                .split(",")
                .map((email) => email.trim().toLowerCase())
                .filter((email) => email.length > 0),
            anthropicUrl: (
                HostingConfig.nonBlank(env.PENFORGE_ANTHROPIC_BASE_URL) ?? HostingConfig.DEFAULT_ANTHROPIC_URL
            ).replace(/\/+$/, ""),
            cookieName: HostingConfig.nonBlank(env.PENFORGE_PENPOT_COOKIE) ?? "auth-token",
            sandboxUrl: HostingConfig.nonBlank(env.PENFORGE_SANDBOX_URL),
            previewDomain: HostingConfig.nonBlank(env.PENFORGE_PREVIEW_DOMAIN),
        });
    }

    /**
     * Reads the master key: `PENFORGE_SECRET_KEY` (base64) or the file named by
     * `PENFORGE_SECRET_KEY_FILE` (a Docker secret).
     */
    private static secretKey(env: Record<string, string | undefined>): Buffer {
        const file = HostingConfig.nonBlank(env.PENFORGE_SECRET_KEY_FILE);
        const encoded = file
            ? existsSync(file)
                ? readFileSync(file, "utf8").trim()
                : undefined
            : HostingConfig.nonBlank(env.PENFORGE_SECRET_KEY);
        if (!encoded) {
            throw new Error(
                "Server mode needs PENFORGE_SECRET_KEY or PENFORGE_SECRET_KEY_FILE (32 random bytes, base64; " +
                    "e.g. `openssl rand -base64 32`)"
            );
        }
        const key = Buffer.from(encoded, "base64");
        if (key.length !== 32) {
            throw new Error("PENFORGE_SECRET_KEY must be 32 bytes, base64 encoded");
        }
        return key;
    }

    private static nonBlank(value: string | undefined): string | undefined {
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
    }
}
