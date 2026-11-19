/**
 * Limits of an icon set import (W29). The daemon downloads archives from GitHub; these bounds
 * keep a hostile or huge repository from filling the disk, the memory or the Penpot file.
 */
export interface IconLimits {
    /** largest SVG file kept, in bytes (larger ones are skipped) */
    maxFileBytes: number;
    /** most icons kept from one source */
    maxIcons: number;
    /** largest download, in bytes (the transfer stops beyond it) */
    maxDownloadBytes: number;
    /** largest total of unpacked bytes read from an archive (zip/gzip bombs) */
    maxUnpackedBytes: number;
    /** largest license file read, in bytes */
    maxLicenseBytes: number;
    /** time budget of the whole download, in milliseconds */
    downloadTimeoutMs: number;
}

/** Limits from the W29 brief: 5 MB per file, 3000 icons, 200 MB downloaded. */
export const DEFAULT_ICON_LIMITS: IconLimits = {
    maxFileBytes: 5 * 1024 * 1024,
    maxIcons: 3000,
    maxDownloadBytes: 200 * 1024 * 1024,
    maxUnpackedBytes: 1024 * 1024 * 1024,
    maxLicenseBytes: 256 * 1024,
    downloadTimeoutMs: 5 * 60 * 1000,
};

/**
 * Failure of an icon import that the client can explain: a stable code, parameters and an
 * English message.
 */
export class IconImportError extends Error {
    constructor(
        public readonly code: IconImportErrorCode,
        message: string,
        public readonly params: Record<string, string | number> = {}
    ) {
        super(message);
    }
}

/** Codes of {@link IconImportError}. */
export type IconImportErrorCode =
    "bad-url" | "host-not-allowed" | "download-failed" | "too-large" | "bad-archive" | "no-icons" | "cancelled";
