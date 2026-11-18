import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Persona = "designer" | "developer";

/** Ports chosen at the last start; reused when still free so bookmarks and logs stay stable. */
export interface PortChoice {
    gateway?: number;
    postgres?: number;
    backend?: number;
    mediaProcessor?: number;
    mcp?: number;
    bridge?: number;
    agent?: number;
}

/** Answers of the first-run wizard. */
export interface WizardAnswers {
    done: boolean;
    fullname?: string;
    persona?: Persona;
    /** Projects folder of the daemon (`PENFORGE_HOME`). */
    projectsDir?: string;
}

/**
 * Settings of the desktop app kept in `<appData>/desktop.json` (owner-only file).
 *
 * The secrets are generated once per install: the local login secret (never handed to the
 * browser), the PostgreSQL password, the backend secret key (keeps sessions valid across
 * restarts) and the media-processor shared key.
 */
export interface DesktopStateData {
    version: 1;
    localLoginSecret: string;
    postgresPassword: string;
    backendSecretKey: string;
    mediaProcessorKey: string;
    ports: PortChoice;
    wizard: WizardAnswers;
}

export function randomSecret(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
}

export function freshState(): DesktopStateData {
    return {
        version: 1,
        localLoginSecret: randomSecret(),
        postgresPassword: randomSecret(24),
        backendSecretKey: randomSecret(48),
        mediaProcessorKey: randomSecret(),
        ports: {},
        wizard: { done: false },
    };
}

export class DesktopState {
    private constructor(
        private readonly file: string,
        public data: DesktopStateData,
    ) {}

    /** Reads the state file, or creates it with fresh secrets. A broken file is replaced. */
    public static load(file: string): DesktopState {
        let data: DesktopStateData | undefined;
        if (existsSync(file)) {
            try {
                const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DesktopStateData>;
                if (parsed.version === 1 && typeof parsed.localLoginSecret === "string") {
                    data = { ...freshState(), ...parsed, ports: parsed.ports ?? {}, wizard: parsed.wizard ?? { done: false } };
                }
            } catch {
                data = undefined;
            }
        }
        const state = new DesktopState(file, data ?? freshState());
        if (!data) {
            state.save();
        }
        return state;
    }

    public update(change: (data: DesktopStateData) => void): void {
        change(this.data);
        this.save();
    }

    /** Writes atomically (temporary file + rename) with owner-only permissions. */
    public save(): void {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, this.file);
    }
}
