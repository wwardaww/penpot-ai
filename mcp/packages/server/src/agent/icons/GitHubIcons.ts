import { readTarGz, readZip } from "./ArchiveReader";
import { IconCollector, type IconCollection } from "./IconCollector";
import { DEFAULT_ICON_LIMITS, IconImportError, type IconLimits } from "./IconLimits";
import { parseIconSource, type IconSource } from "./IconSource";
import { SafeFetch } from "./SafeFetch";

/** Icons fetched from GitHub, with where they came from. */
export interface GitHubIconSet extends IconCollection {
    source: IconSource;
}

/**
 * Fetches an icon set from a GitHub URL (repository, folder, release or file): downloads the
 * archive from the allowlisted hosts, reads only the SVG and license files, sanitizes the SVGs.
 * No code of the repository runs and nothing is written to disk.
 */
export class GitHubIcons {
    /**
     * @param fetcher - the allowlisted downloader
     * @param limits - size and count limits
     */
    constructor(
        private readonly fetcher: SafeFetch = new SafeFetch(),
        private readonly limits: IconLimits = DEFAULT_ICON_LIMITS
    ) {}

    /**
     * Fetches the icons of a URL.
     *
     * @param url - the URL the user gave
     * @param signal - cancels the download
     * @throws IconImportError
     */
    public async fetch(url: string, signal: AbortSignal): Promise<GitHubIconSet> {
        const source = parseIconSource(url);
        const timeout = AbortSignal.timeout(this.limits.downloadTimeoutMs);
        const combined = AbortSignal.any([signal, timeout]);
        try {
            const collection = await this.collect(source, combined);
            if (collection.icons.length === 0) {
                throw new IconImportError(
                    "no-icons",
                    collection.found === 0
                        ? "No SVG files were found there"
                        : "None of the SVG files could be used as an icon",
                    { found: collection.found }
                );
            }
            return { ...collection, source };
        } catch (error) {
            if (timeout.aborted && !signal.aborted) {
                throw new IconImportError("download-failed", "The download took too long", { status: 0 });
            }
            throw error;
        }
    }

    private async collect(source: IconSource, signal: AbortSignal): Promise<IconCollection> {
        switch (source.kind) {
            case "svg": {
                const data = await this.fetcher.download(source.url, this.limits.maxFileBytes, signal);
                const collector = new IconCollector("", this.limits, false);
                const name = decodeURIComponent(new URL(source.url).pathname.split("/").at(-1) ?? "icon.svg");
                collector.add({ path: name, data, size: data.length });
                return collector.result();
            }
            case "zip": {
                const data = await this.fetcher.download(source.url, this.limits.maxDownloadBytes, signal);
                // a release asset may or may not wrap its files in one folder; archives always do
                const wrapped = source.url.includes("/archive/") || source.url.includes("codeload.github.com");
                const collector = new IconCollector(source.folder, this.limits, wrapped);
                const entries = readZip(data, {
                    wanted: (path) => collector.wanted(path),
                    maxEntryBytes: (path) => collector.maxEntryBytes(path),
                    maxUnpackedBytes: this.limits.maxUnpackedBytes,
                });
                for (const entry of entries) {
                    collector.add(entry);
                }
                return collector.result();
            }
            case "archive": {
                const wrapped = !source.url.includes("/releases/download/");
                const collector = new IconCollector(source.folder, this.limits, wrapped);
                const entries = readTarGz(this.fetcher.stream(source.url, this.limits.maxDownloadBytes, signal), {
                    wanted: (path) => collector.wanted(path),
                    maxEntryBytes: (path) => collector.maxEntryBytes(path),
                    maxUnpackedBytes: this.limits.maxUnpackedBytes,
                });
                for await (const entry of entries) {
                    collector.add(entry);
                    if (collector.full) {
                        break;
                    }
                }
                return collector.result();
            }
        }
    }
}
