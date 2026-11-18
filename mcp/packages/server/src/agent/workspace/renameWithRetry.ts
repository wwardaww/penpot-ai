import { rename } from "fs/promises";

/** Error codes Windows reports while another process (antivirus, indexer, a reader) holds a file. */
const LOCKED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Renames a file, retrying while the target is locked.
 *
 * On Windows a rename over an existing file fails with `EPERM`/`EACCES`/`EBUSY` when another
 * process has the target open for a moment (antivirus scanning a freshly written file, another
 * write in flight). The lock is short, so a few retries with a growing delay are enough.
 *
 * @param from - the source path
 * @param to - the target path
 * @param attempts - how many times to try in total
 * @param delayMs - base delay; the n-th retry waits `n * delayMs`
 */
export async function renameWithRetry(from: string, to: string, attempts = 8, delayMs = 25): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !LOCKED_CODES.has(code) || attempt >= attempts) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
        }
    }
}
