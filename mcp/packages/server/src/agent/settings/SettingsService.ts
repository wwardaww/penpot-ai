import type {
    SettingsGetMessage,
    SettingsMessage,
    SettingsSetMessage,
    SettingsTestedMessage,
    SettingsTestMessage,
} from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { AgentError } from "../AgentClient";
import { ClaudeCommandName } from "../claude/ClaudeCommandName";
import type { ClaudeSource } from "../claude/ClaudeSource";
import { PermissionModeState } from "../permissions/PermissionModeState";
import type { UserSettings } from "./UserSettings";

/** Connection that reads or changes settings. */
export interface SettingsClient {
    /** whether the client runs on the same computer as the daemon */
    readonly isLocal: boolean;
    /** permission mode of the connection, from {@link SettingsService.modeForConnection} */
    readonly permissionMode: PermissionModeState;
    send(message: SettingsMessage | SettingsTestedMessage): void;
}

/** What the local daemon keeps for its user. */
export interface LocalSettings {
    settings: UserSettings;
    claude: ClaudeSource;
}

/**
 * Handler of the settings messages: `settings.get`, `settings.set`, `settings.test`.
 *
 * The local daemon stores the settings on this computer; they hold for all its connections. In
 * server mode a connection only has a permission mode of its own, which starts as `manual`, and the
 * Claude command can be neither read nor set.
 */
export class SettingsService {
    private readonly logger = createLogger("SettingsService");
    private readonly machineMode: PermissionModeState | null;
    private readonly clients = new Set<SettingsClient>();

    /**
     * @param local - the settings of this computer, or null in server mode
     */
    constructor(private readonly local: LocalSettings | null) {
        this.machineMode = local ? new PermissionModeState(local.settings.current.permissionMode) : null;
    }

    /** Gets the permission mode of a new connection. */
    public modeForConnection(): PermissionModeState {
        return this.machineMode ?? new PermissionModeState();
    }

    /**
     * Adds an authenticated client, which is told about changes other clients make.
     *
     * @returns removes it
     */
    public connect(client: SettingsClient): () => void {
        this.clients.add(client);
        return () => this.clients.delete(client);
    }

    /** Handles `settings.get`. */
    public get(client: SettingsClient, message: SettingsGetMessage): void {
        client.send(this.state(client, message.rid));
    }

    /** Handles `settings.set`. */
    public async set(client: SettingsClient, message: SettingsSetMessage): Promise<void> {
        // checked first: a refused command changes nothing else either
        const claudeCommand =
            message.claudeCommand === undefined ? undefined : this.acceptCommand(client, message.claudeCommand);
        const { permissionMode } = message;
        if (this.local) {
            await this.local.settings.update({
                ...(claudeCommand === undefined ? {} : { claudeCommand }),
                ...(permissionMode === undefined ? {} : { permissionMode }),
            });
        }
        if (permissionMode !== undefined) {
            this.logger.info("Permission mode: %s", permissionMode);
            client.permissionMode.set(permissionMode);
        }
        if (claudeCommand !== undefined) {
            this.logger.info("Claude command: %s", claudeCommand);
        }
        client.send(this.state(client, message.rid));
        if (this.local) {
            for (const other of this.clients) {
                if (other !== client) {
                    other.send(this.state(other));
                }
            }
        }
    }

    /** Handles `settings.test`. */
    public async test(client: SettingsClient, message: SettingsTestMessage): Promise<void> {
        const claudeCommand = this.acceptCommand(client, message.claudeCommand);
        const { found, command, version, problem } = await this.local!.claude.check(claudeCommand);
        client.send({
            type: "settings.tested",
            rid: message.rid,
            claudeCommand,
            found,
            ...(command ? { kind: command.kind } : {}),
            ...(command?.path !== undefined ? { path: command.path } : {}),
            ...(version !== undefined ? { version } : {}),
            ...(problem !== undefined ? { problem } : {}),
        });
    }

    private state(client: SettingsClient, rid?: string): SettingsMessage {
        return {
            type: "settings",
            ...(rid !== undefined ? { rid } : {}),
            scope: this.local ? "machine" : "session",
            permissionMode: client.permissionMode.mode,
            ...(this.local && client.isLocal ? { claudeCommand: this.local.settings.current.claudeCommand } : {}),
        };
    }

    private acceptCommand(client: SettingsClient, value: string): string {
        if (!this.local || !client.isLocal) {
            throw new AgentError("forbidden", "The Claude command belongs to the computer the daemon runs on");
        }
        const command = ClaudeCommandName.parse(value);
        if (command === null) {
            throw new AgentError(
                "bad-request",
                "Use the name of a command or an absolute path, without arguments",
                "claude-command"
            );
        }
        return command;
    }
}
