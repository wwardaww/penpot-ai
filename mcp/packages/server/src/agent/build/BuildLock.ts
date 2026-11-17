/**
 * Per-project lock shared by `build-plan` and `build-run`, so a plan never rewrites `plan.json`
 * or `stack.json` while a build reads them, and two builds never write `app-src/` at once.
 *
 * Fails fast instead of waiting: the second caller gets null and reports "a build is already
 * running".
 */
export class BuildLock {
    private static readonly held = new Set<string>();

    /**
     * Takes the lock of a project.
     *
     * @param projectRoot - the project folder
     * @returns a function releasing the lock, or null when the lock is taken
     */
    public static tryAcquire(projectRoot: string): (() => void) | null {
        if (BuildLock.held.has(projectRoot)) {
            return null;
        }
        BuildLock.held.add(projectRoot);
        let released = false;
        return () => {
            if (!released) {
                released = true;
                BuildLock.held.delete(projectRoot);
            }
        };
    }
}
