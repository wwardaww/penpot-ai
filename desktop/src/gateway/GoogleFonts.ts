import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Fetches a URL; replaceable in tests. */
export type FontFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface GoogleFontsOptions {
    /** Folder that keeps downloaded font files, so a font loads again without the network. */
    cacheDir: string;
    fetch?: FontFetch;
    /** How long one upstream request may take (ms). */
    timeoutMs?: number;
}

export interface FontAnswer {
    status: number;
    contentType: string;
    body: Buffer;
    /** `Cache-Control` of the answer. */
    cache: string;
}

const CSS_PREFIX = "/internal/gfonts/css";
const FONT_PREFIX = "/internal/gfonts/font/";
/** Google serves woff2 in its CSS only to browsers it knows. */
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/** Font file path under fonts.gstatic.com/s/: family folder, version, file name. */
const FONT_FILE = /^[A-Za-z0-9._\-/]{1,300}$/;
const MAX_FONT_BYTES = 20 * 1024 * 1024;

/**
 * The Google Fonts routes Penpot expects from its web server (nginx in the docker images):
 * `/internal/gfonts/css?...` answers the Google Fonts CSS and `/internal/gfonts/font/<file>` the
 * font files of fonts.gstatic.com. Without them the desktop app could not load any Google font:
 * texts fell back to a font without Turkish letters and waited for the font forever.
 *
 * Font files are kept on disk once downloaded.
 */
export class GoogleFonts {
    private readonly fetch: FontFetch;
    private readonly timeoutMs: number;

    constructor(private readonly options: GoogleFontsOptions) {
        this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
        this.timeoutMs = options.timeoutMs ?? 20_000;
    }

    /** Whether `path` is one of the Google Fonts routes. */
    public static handles(path: string): boolean {
        return path === CSS_PREFIX || path.startsWith(FONT_PREFIX);
    }

    /**
     * Answers a Google Fonts route.
     *
     * @param path - the request path
     * @param search - the query string with its `?`, or ""
     */
    public async answer(path: string, search: string): Promise<FontAnswer> {
        if (path === CSS_PREFIX) {
            return this.css(search);
        }
        const file = path.slice(FONT_PREFIX.length);
        if (!FONT_FILE.test(file) || file.split("/").some((part) => part === ".." || part === "")) {
            return GoogleFonts.text(404, "not found");
        }
        return this.font(file);
    }

    private async css(search: string): Promise<FontAnswer> {
        const query = search.startsWith("?") ? search.slice(1) : search;
        if (query.length === 0 || query.length > 4000) {
            return GoogleFonts.text(400, "bad request");
        }
        const upstream = await this.get(`https://fonts.googleapis.com/css?${query}`);
        if (!upstream) {
            return GoogleFonts.text(502, "Google Fonts is not reachable");
        }
        if (upstream.status !== 200) {
            return GoogleFonts.text(upstream.status === 400 ? 400 : 404, "not found");
        }
        return { status: 200, contentType: "text/css; charset=utf-8", body: upstream.body, cache: "max-age=86400" };
    }

    private async font(file: string): Promise<FontAnswer> {
        const cached = join(this.options.cacheDir, createHash("sha256").update(file).digest("hex"));
        const type = GoogleFonts.fontType(file);
        const kept = await readFile(cached).catch(() => null);
        if (kept) {
            return { status: 200, contentType: type, body: kept, cache: "max-age=31536000, immutable" };
        }
        const upstream = await this.get(`https://fonts.gstatic.com/s/${file}`);
        if (!upstream) {
            return GoogleFonts.text(502, "Google Fonts is not reachable");
        }
        if (upstream.status !== 200 || upstream.body.length > MAX_FONT_BYTES) {
            return GoogleFonts.text(404, "not found");
        }
        await this.keep(cached, upstream.body);
        return { status: 200, contentType: type, body: upstream.body, cache: "max-age=31536000, immutable" };
    }

    /** GETs `url`; null when the network fails or times out. */
    private async get(url: string): Promise<{ status: number; body: Buffer } | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetch(url, {
                headers: { "user-agent": USER_AGENT, accept: "*/*" },
                signal: controller.signal,
            });
            return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Writes a cache file; a failed write only means the next load downloads again. */
    private async keep(file: string, body: Buffer): Promise<void> {
        try {
            await mkdir(this.options.cacheDir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await writeFile(tmp, body);
            await rename(tmp, file);
        } catch {
            // the font was served; caching is best effort
        }
    }

    private static fontType(file: string): string {
        const lower = file.toLowerCase();
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".otf")) return "font/otf";
        return "font/ttf";
    }

    private static text(status: number, message: string): FontAnswer {
        return { status, contentType: "text/plain; charset=utf-8", body: Buffer.from(message), cache: "no-store" };
    }
}
