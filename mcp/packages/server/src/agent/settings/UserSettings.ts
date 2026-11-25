import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import type { PermissionMode } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { ClaudeCommandName } from "../claude/ClaudeCommandName";
import { renameWithRetry } from "../workspace/renameWithRetry";

/** Settings the user edits in the app. */
export interface UserSettingsValues {
    claudeCommand: string;
    permissionMode: PermissionMode;
}

/**
 * Settings of this computer the user edits in the app (`<PENFORGE_HOME>/settings.json`).
 *
 * A missing or damaged file, or a value that is not acceptable, counts as the default.
 */
export class UserSettings {
    private readonly logger = createLogger("UserSettings");
    private values: UserSettingsValues;
    /** writes one after the other, so that the last change ends up in the file */
    private writing: Promise<void> = Promise.resolve();

    /**
     * @param path - the settings file
     */
    constructor(private readonly path: string) {
        this.values = this.read();
    }

    /** The settings in force. */
    public get current(): Readonly<UserSettingsValues> {
        return this.values;
    }

    /**
     * Changes settings; they are in force at once and stored.
     *
     * @param changes - the settings to change
     */
    public async update(changes: Partial<UserSettingsValues>): Promise<void> {
        this.values = { ...this.values, ...changes };
        const write = this.writing.then(() => this.write());
        this.writing = write.catch(() => {});
        await write;
    }

    private read(): UserSettingsValues {
        let stored: Partial<Record<keyof UserSettingsValues, unknown>> = {};
        try {
            stored = (JSON.parse(readFileSync(this.path, "utf8")) ?? {}) as typeof stored;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.logger.warn("Settings file %s cannot be read; the defaults hold", this.path);
            }
        }
        const command = typeof stored.claudeCommand === "string" ? stored.claudeCommand : "";
        return {
            claudeCommand: ClaudeCommandName.parse(command) ?? ClaudeCommandName.DEFAULT,
            permissionMode: stored.permissionMode === "auto" ? "auto" : "manual",
        };
    }

    private async write(): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(this.values, null, 4)}\n`, { mode: 0o600 });
            await renameWithRetry(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
