import { posix } from "path";

/**
 * Checker of the Claude command a user may set.
 *
 * The value decides which program this computer runs, so it holds a name or a path and nothing
 * else: no arguments, no shell syntax, no relative path.
 */
export class ClaudeCommandName {
    /** Command used until the user sets another one. */
    public static readonly DEFAULT = "claude";

    private static readonly NAME = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,63}$/;
    private static readonly MAX_PATH_LENGTH = 1024;
    /** characters no path may hold: control characters and shell syntax */
    private static readonly PATH_REFUSED = /[\u0000-\u001f\u007f"'`$;&|<>*?!^{}[\]#~%=]/;
    /** a space before a dash starts an argument */
    private static readonly ARGUMENT = /\s-/;

    /**
     * Checks a command.
     *
     * @param value - the text the user typed
     * @param platform - the platform whose path rules apply
     * @returns the command without surrounding spaces ({@link DEFAULT} for an empty text), or null
     *   when it is neither a bare name nor an absolute path
     */
    public static parse(value: string, platform: NodeJS.Platform = process.platform): string | null {
        const command = value.trim();
        if (command === "") {
            return ClaudeCommandName.DEFAULT;
        }
        if (ClaudeCommandName.NAME.test(command)) {
            return command;
        }
        return ClaudeCommandName.isPath(command, platform) ? command : null;
    }

    /**
     * Whether a command is an acceptable absolute path.
     *
     * @param command - the command
     * @param platform - the platform whose path rules apply
     */
    public static isPath(command: string, platform: NodeJS.Platform = process.platform): boolean {
        if (
            command.length > ClaudeCommandName.MAX_PATH_LENGTH ||
            ClaudeCommandName.PATH_REFUSED.test(command) ||
            ClaudeCommandName.ARGUMENT.test(command)
        ) {
            return false;
        }
        if (platform === "win32") {
            // a path on a drive: no share, no device, no file stream
            return /^[A-Za-z]:[\\/][^:]+$/.test(command);
        }
        return posix.isAbsolute(command) && !/[\\()]/.test(command);
    }
}
