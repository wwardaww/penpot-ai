/**
 * One tidy-up at a time per Penpot file, in this process (the workflow and the chat's tool run in
 * the same daemon): a second run on a half-tidied page would read layers the first one is changing.
 */
export class CleanupLock {
    private static readonly held = new Set<string>();

    /**
     * Takes the lock of a file.
     *
     * @returns a release function, or null when a tidy-up of the file is running
     */
    public static acquire(fileKey: string): (() => void) | null {
        if (CleanupLock.held.has(fileKey)) {
            return null;
        }
        CleanupLock.held.add(fileKey);
        let released = false;
        return () => {
            if (!released) {
                released = true;
                CleanupLock.held.delete(fileKey);
            }
        };
    }
}
