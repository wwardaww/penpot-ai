import type { PermissionMode } from "@penpot/mcp-common";

/**
 * Permission mode in force, for everything that would ask the user.
 *
 * The local daemon has one, shared by every connection; in server mode each connection has its own.
 */
export class PermissionModeState {
    private readonly listeners = new Set<() => void>();

    /**
     * @param current - the mode to start with
     */
    constructor(private current: PermissionMode = "manual") {}

    /** The mode. */
    public get mode(): PermissionMode {
        return this.current;
    }

    /** Whether nothing may wait for the user, who may be away. */
    public get unattended(): boolean {
        return this.current === "auto";
    }

    /**
     * Changes the mode and tells the listeners, unless it is the mode in force.
     *
     * @param mode - the new mode
     */
    public set(mode: PermissionMode): void {
        if (mode !== this.current) {
            this.current = mode;
            for (const listener of [...this.listeners]) {
                listener();
            }
        }
    }

    /**
     * Follows changes of the mode.
     *
     * @param listener - called after each change
     * @returns stops following
     */
    public onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}
