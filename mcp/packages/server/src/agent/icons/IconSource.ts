import { IconImportError } from "./IconLimits";

/**
 * What to download for a GitHub icon set URL:
 * - `archive`: a `.tar.gz` of a repository at a ref (repository, folder, release tag);
 * - `zip`: a `.zip` (release asset or archive link);
 * - `svg`: one SVG file.
 */
export interface IconSource {
    kind: "archive" | "zip" | "svg";
    /** URL to download (https, allowlisted host) */
    url: string;
    owner: string;
    repo: string;
    /** branch, tag or commit; `HEAD` for the default branch */
    ref: string;
    /** folder inside the repository the icons come from ("" = whole repository) */
    folder: string;
    /** the URL the user gave */
    given: string;
}

/** Hosts the daemon may download from (redirects included). */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    "github.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
    // release assets: github.com/<o>/<r>/releases/download/… redirects to one of these
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
]);

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._\/-]{1,200}$/;

/**
 * Parses a GitHub URL into an {@link IconSource}.
 *
 * Accepted forms:
 * - `https://github.com/<owner>/<repo>` (default branch)
 * - `https://github.com/<owner>/<repo>/tree/<ref>/<folder…>` (the first segment after `tree` is
 *   the ref)
 * - `https://github.com/<owner>/<repo>/releases/tag/<tag>` (source of the tag)
 * - `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>.zip|.tar.gz|.tgz|.svg`
 * - `https://github.com/<owner>/<repo>/archive/<ref>.zip|.tar.gz`
 * - `https://github.com/<owner>/<repo>/blob/<ref>/<path>.svg` and
 *   `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.svg` (one icon)
 * - `https://codeload.github.com/<owner>/<repo>/tar.gz|zip/<ref>`
 *
 * @throws IconImportError `bad-url` or `host-not-allowed`
 */
export function parseIconSource(input: string): IconSource {
    const given = String(input ?? "").trim();
    let url: URL;
    try {
        url = new URL(given.includes("://") ? given : `https://${given}`);
    } catch {
        throw new IconImportError("bad-url", `Not a URL: ${given.slice(0, 200)}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new IconImportError("bad-url", "Only https URLs are accepted");
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!ALLOWED_HOSTS.has(host) || (host.endsWith("githubusercontent.com") && host !== "raw.githubusercontent.com")) {
        throw new IconImportError("host-not-allowed", `Only GitHub URLs are accepted, not ${host}`, { host });
    }
    const segments = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                throw new IconImportError("bad-url", "The URL has a broken escape sequence");
            }
        });
    if (segments.some((segment) => segment === ".." || segment === "." || segment.includes("\\"))) {
        throw new IconImportError("bad-url", "The URL has a relative path");
    }
    const [owner, rawRepo] = segments;
    const repo = rawRepo?.replace(/\.git$/, "");
    if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
        throw new IconImportError("bad-url", "The URL names no GitHub repository");
    }
    const rest = segments.slice(2);
    const base = { owner, repo, given };
    const archive = (ref: string, folder: string): IconSource => {
        checkRef(ref);
        return {
            ...base,
            kind: "archive",
            url: `https://github.com/${owner}/${repo}/archive/${encodePath(ref)}.tar.gz`,
            ref,
            folder: cleanFolder(folder),
        };
    };

    if (host === "raw.githubusercontent.com") {
        const [ref, ...path] = rest;
        if (!ref || path.length === 0 || !/\.svg$/i.test(path.at(-1)!)) {
            throw new IconImportError("bad-url", "A raw GitHub link must point to an .svg file");
        }
        checkRef(ref);
        return {
            ...base,
            kind: "svg",
            url: `https://raw.githubusercontent.com/${owner}/${repo}/${encodePath(ref)}/${encodePath(path.join("/"))}`,
            ref,
            folder: cleanFolder(path.slice(0, -1).join("/")),
        };
    }

    if (host === "codeload.github.com") {
        const [format, ...refParts] = rest;
        const ref = refParts.join("/") || "HEAD";
        checkRef(ref);
        if (format === "tar.gz" || format === "legacy.tar.gz") {
            return { ...base, kind: "archive", url: url.toString(), ref, folder: "" };
        }
        if (format === "zip" || format === "legacy.zip") {
            return { ...base, kind: "zip", url: url.toString(), ref, folder: "" };
        }
        throw new IconImportError("bad-url", "Unknown codeload link");
    }

    if (host !== "github.com") {
        throw new IconImportError("host-not-allowed", `Give the github.com page of the icon set, not ${host}`, {
            host,
        });
    }

    if (rest.length === 0) {
        return archive("HEAD", "");
    }
    const [section, ...tail] = rest;
    switch (section) {
        case "tree": {
            const [ref, ...folder] = tail;
            if (!ref) {
                throw new IconImportError("bad-url", "The folder link names no branch");
            }
            return archive(ref, folder.join("/"));
        }
        case "blob": {
            const [ref, ...path] = tail;
            if (!ref || path.length === 0) {
                throw new IconImportError("bad-url", "The file link names no file");
            }
            if (!/\.svg$/i.test(path.at(-1)!)) {
                return archive(ref, path.slice(0, -1).join("/"));
            }
            checkRef(ref);
            return {
                ...base,
                kind: "svg",
                url: `https://raw.githubusercontent.com/${owner}/${repo}/${encodePath(ref)}/${encodePath(path.join("/"))}`,
                ref,
                folder: cleanFolder(path.slice(0, -1).join("/")),
            };
        }
        case "releases": {
            const [what, tag, ...asset] = tail;
            if (what === "tag" && tag) {
                return archive(tag, "");
            }
            if (what === "download" && tag && asset.length === 1) {
                checkRef(tag);
                const name = asset[0];
                const assetUrl = `https://github.com/${owner}/${repo}/releases/download/${encodePath(tag)}/${encodeURIComponent(name)}`;
                if (/\.zip$/i.test(name)) {
                    return { ...base, kind: "zip", url: assetUrl, ref: tag, folder: "" };
                }
                if (/\.(tar\.gz|tgz)$/i.test(name)) {
                    return { ...base, kind: "archive", url: assetUrl, ref: tag, folder: "" };
                }
                if (/\.svg$/i.test(name)) {
                    return { ...base, kind: "svg", url: assetUrl, ref: tag, folder: "" };
                }
                throw new IconImportError("bad-url", "A release asset must be a .zip, .tar.gz or .svg file");
            }
            if (what === "latest" || (what === undefined && tag === undefined)) {
                return archive("HEAD", "");
            }
            throw new IconImportError("bad-url", "Unknown release link");
        }
        case "archive": {
            const file = tail.join("/");
            const zip = file.match(/^(.+)\.zip$/i);
            if (zip) {
                checkRef(zip[1]);
                return {
                    ...base,
                    kind: "zip",
                    url: `https://github.com/${owner}/${repo}/archive/${encodePath(zip[1])}.zip`,
                    ref: zip[1],
                    folder: "",
                };
            }
            const tar = file.match(/^(.+)\.tar\.gz$/i);
            if (tar) {
                return archive(tar[1], "");
            }
            throw new IconImportError("bad-url", "Unknown archive link");
        }
        default:
            throw new IconImportError("bad-url", "Give the repository, a folder or a release of the icon set");
    }
}

function checkRef(ref: string): void {
    if (!REF.test(ref) || ref.split("/").some((part) => part === ".." || part === "")) {
        throw new IconImportError("bad-url", "The branch or tag name is not valid");
    }
}

function cleanFolder(folder: string): string {
    return folder.replace(/^\/+|\/+$/g, "");
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}
