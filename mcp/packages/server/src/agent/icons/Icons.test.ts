import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    DEFAULT_ICON_LIMITS,
    GitHubIcons,
    IconCollector,
    IconImportError,
    SafeFetch,
    detectLicense,
    parseIconSource,
    readTarGz,
    readZip,
    sanitizeSvg,
    type HttpAnswer,
    type HttpGet,
} from ".";
import { strokeIcon, tarGz, zip } from "./testing/archives";

const MIT =
    "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software";
const ISC =
    "ISC License\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee";

async function* chunks(buffer: Buffer, size: number = 1000): AsyncGenerator<Buffer> {
    for (let index = 0; index < buffer.length; index += size) {
        yield buffer.subarray(index, index + size);
    }
}

function answer(status: number, body?: Buffer, headers: Record<string, string> = {}): HttpAnswer {
    return {
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        body: body ? chunks(body, 4096) : null,
    };
}

/** HTTP stand-in: answers by URL, records the requested URLs. */
function fakeHttp(routes: Record<string, () => HttpAnswer>, requested: string[] = []): HttpGet {
    return async (url) => {
        requested.push(url);
        const route = routes[url];
        if (!route) {
            return answer(404);
        }
        return route();
    };
}

describe("parseIconSource", () => {
    test("repository, folder, release tag, release asset, file and codeload links", () => {
        assert.deepEqual(pick(parseIconSource("https://github.com/lucide-icons/lucide")), {
            kind: "archive",
            url: "https://github.com/lucide-icons/lucide/archive/HEAD.tar.gz",
            ref: "HEAD",
            folder: "",
        });
        assert.deepEqual(pick(parseIconSource("github.com/tabler/tabler-icons/tree/main/icons/outline")), {
            kind: "archive",
            url: "https://github.com/tabler/tabler-icons/archive/main.tar.gz",
            ref: "main",
            folder: "icons/outline",
        });
        assert.equal(parseIconSource("https://github.com/tailwindlabs/heroicons/releases/tag/v2.1.5").ref, "v2.1.5");
        const asset = parseIconSource(
            "https://github.com/lucide-icons/lucide/releases/download/0.460.0/lucide-icons-0.460.0.zip"
        );
        assert.equal(asset.kind, "zip");
        assert.equal(
            asset.url,
            "https://github.com/lucide-icons/lucide/releases/download/0.460.0/lucide-icons-0.460.0.zip"
        );
        const file = parseIconSource("https://github.com/lucide-icons/lucide/blob/main/icons/x.svg");
        assert.equal(file.kind, "svg");
        assert.equal(file.url, "https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/x.svg");
        assert.equal(parseIconSource("https://codeload.github.com/a/b/tar.gz/refs/heads/main").kind, "archive");
    });

    test("refuses other hosts, missing repositories and relative paths", () => {
        for (const url of [
            "https://gitlab.com/a/b",
            "https://evil.example/github.com/a/b",
            "https://objects.githubusercontent.com/x",
            "https://github.com/a",
            "https://github.com/a/b/tree/main/../../x",
            "ftp://github.com/a/b",
            "not a url at all",
        ]) {
            assert.throws(() => parseIconSource(url), IconImportError, url);
        }
    });
});

describe("sanitizeSvg", () => {
    test("keeps shapes and paint, replaces currentColor", () => {
        const result = sanitizeSvg(strokeIcon());
        assert.ok(result.ok);
        assert.match(result.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
        assert.match(result.svg, /stroke="#000000"/);
        assert.match(result.svg, /<path d="M5 12h14"\/>/);
        assert.equal(result.removed, 0);
    });

    test("drops scripts, handlers, links, images, styles, foreign content and entities", () => {
        const input = `<?xml version="1.0"?>
<!DOCTYPE svg [<!ENTITY lol "lol">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24" onload="alert(1)">
  <script>alert(1)</script>
  <style>path{fill:red}</style>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <image href="https://evil.example/x.png"/>
  <use xlink:href="https://evil.example/s.svg#a"/>
  <a href="javascript:alert(1)"><path d="M0 0h1"/></a>
  <path d="M1 1h2" fill="url(https://evil.example/#g)" style="stroke: red; behavior: url(x.htc)" data-x="&lol;"/>
  <circle cx="12" cy="12" r="4" fill="url(#grad)" onclick="x()"/>
</svg>`;
        const result = sanitizeSvg(input);
        assert.ok(result.ok);
        for (const bad of [
            "script",
            "style>",
            "foreignObject",
            "image",
            "use",
            "href",
            "onload",
            "onclick",
            "evil",
            "javascript",
            "lol",
            "<a",
        ]) {
            assert.ok(!result.svg.includes(bad), `${bad} in ${result.svg}`);
        }
        assert.match(result.svg, /<path d="M1 1h2" stroke="red"\/>/);
        assert.match(result.svg, /<circle cx="12" cy="12" r="4" fill="url\(#grad\)"\/>/);
        assert.ok(result.removed >= 8);
    });

    test("refuses what is not a well formed SVG with shapes", () => {
        assert.deepEqual(sanitizeSvg("<html><body/></html>"), { ok: false, reason: "not-svg" });
        assert.deepEqual(sanitizeSvg("<svg><path d='M0 0'></svg>"), { ok: false, reason: "malformed" });
        assert.deepEqual(sanitizeSvg("<svg><g></g></svg>"), { ok: false, reason: "empty" });
        assert.deepEqual(sanitizeSvg("just text"), { ok: false, reason: "not-svg" });
    });
});

describe("license detection", () => {
    test("recognizes the usual icon licenses", () => {
        assert.equal(detectLicense(MIT), "MIT");
        assert.equal(detectLicense(ISC), "ISC");
        assert.equal(detectLicense("Apache License\nVersion 2.0, January 2004"), "Apache-2.0");
        assert.equal(detectLicense("Creative Commons Attribution 4.0 International"), "CC-BY-4.0");
        assert.equal(detectLicense("All rights reserved."), null);
    });
});

describe("archives", () => {
    test("reads wanted files of a tar.gz, with long pax names, skipping the rest", async () => {
        const long = `repo-main/${"deep/".repeat(30)}icon.svg`;
        const archive = tarGz([
            { path: "repo-main/README.md", content: "x".repeat(5000) },
            { path: "repo-main/icons/a.svg", content: strokeIcon() },
            { path: long, content: strokeIcon("M1 1") },
        ]);
        const seen: string[] = [];
        for await (const entry of readTarGz(chunks(archive, 333), {
            wanted: (path) => path.endsWith(".svg"),
            maxEntryBytes: () => 1024 * 1024,
            maxUnpackedBytes: 10 * 1024 * 1024,
        })) {
            seen.push(entry.path);
            assert.ok(entry.data && entry.data.toString().startsWith("<svg"));
        }
        assert.deepEqual(seen, ["repo-main/icons/a.svg", long]);
    });

    test("reports a too large entry without its bytes and stops at the unpacked limit", async () => {
        const archive = tarGz([{ path: "r/big.svg", content: "y".repeat(3000) }]);
        const entries = [];
        for await (const entry of readTarGz(chunks(archive), {
            wanted: () => true,
            maxEntryBytes: () => 1000,
            maxUnpackedBytes: 1024 * 1024,
        })) {
            entries.push(entry);
        }
        assert.deepEqual(entries, [{ path: "r/big.svg", data: null, size: 3000 }]);

        await assert.rejects(
            async () => {
                for await (const _ of readTarGz(chunks(tarGz([{ path: "r/a.svg", content: "z".repeat(50000) }])), {
                    wanted: () => true,
                    maxEntryBytes: () => 1e9,
                    maxUnpackedBytes: 4096,
                })) {
                    // drain
                }
            },
            (error: unknown) => error instanceof IconImportError && error.code === "too-large"
        );
    });

    test("reads stored and deflated zip entries", () => {
        const archive = zip([
            { path: "icons/a.svg", content: strokeIcon() },
            { path: "icons/b.svg", content: strokeIcon("M2 2") },
            { path: "LICENSE", content: MIT },
        ]);
        const entries = readZip(archive, { wanted: () => true, maxEntryBytes: () => 1e6, maxUnpackedBytes: 1e7 });
        assert.deepEqual(
            entries.map((e) => e.path),
            ["icons/a.svg", "icons/b.svg", "LICENSE"]
        );
        assert.equal(entries[1].data?.toString(), strokeIcon("M2 2"));
        assert.throws(
            () =>
                readZip(Buffer.from("not a zip"), { wanted: () => true, maxEntryBytes: () => 1, maxUnpackedBytes: 1 }),
            IconImportError
        );
    });
});

describe("IconCollector", () => {
    test("names icons after folder and file, picks the closest license, drops duplicates and caps the count", () => {
        const collector = new IconCollector("icons", { ...DEFAULT_ICON_LIMITS, maxIcons: 2 }, true);
        assert.equal(collector.wanted("r/icons/outline/a.svg"), true);
        assert.equal(collector.wanted("r/docs/a.svg"), false);
        assert.equal(collector.wanted("r/LICENSE"), true);
        assert.equal(collector.wanted("r/other/LICENSE"), false);
        collector.add({ path: "r/LICENSE", data: Buffer.from(MIT), size: 10 });
        collector.add({ path: "r/icons/LICENSE.md", data: Buffer.from(ISC), size: 10 });
        collector.add({ path: "r/icons/outline/arrow.svg", data: Buffer.from(strokeIcon()), size: 10 });
        collector.add({ path: "r/icons/bad.svg", data: Buffer.from("<html/>"), size: 7 });
        collector.add({ path: "r/icons/x.svg", data: Buffer.from(strokeIcon()), size: 10 });
        collector.add({ path: "r/icons/y.svg", data: Buffer.from(strokeIcon()), size: 10 });
        const result = collector.result();
        assert.deepEqual(
            result.icons.map((i) => [i.id, i.path, i.name]),
            [
                ["outline/arrow", "Icons / outline", "arrow"],
                ["x", "Icons", "x"],
            ]
        );
        assert.equal(result.license?.spdx, "ISC");
        assert.equal(result.license?.file, "icons/LICENSE.md");
        assert.deepEqual(result.skipped, [{ name: "bad", reason: "not-svg" }]);
        assert.equal(result.truncated, true);
        assert.equal(result.found, 4);
    });
});

describe("GitHubIcons", () => {
    const archive = tarGz([
        { path: "lucide-main/LICENSE", content: ISC },
        { path: "lucide-main/icons/a-arrow-down.svg", content: strokeIcon("M3 3") },
        { path: "lucide-main/icons/zap.svg", content: strokeIcon("M4 4") },
        { path: "lucide-main/docs/logo.svg", content: strokeIcon("M5 5") },
        { path: "lucide-main/icons/a-arrow-down.json", content: "{}" },
    ]);

    test("follows GitHub's redirect to codeload and collects the folder's icons with the license", async () => {
        const requested: string[] = [];
        const http = fakeHttp(
            {
                "https://github.com/lucide-icons/lucide/archive/main.tar.gz": () =>
                    answer(302, undefined, {
                        location: "https://codeload.github.com/lucide-icons/lucide/tar.gz/refs/heads/main",
                    }),
                "https://codeload.github.com/lucide-icons/lucide/tar.gz/refs/heads/main": () => answer(200, archive),
            },
            requested
        );
        const set = await new GitHubIcons(new SafeFetch(http)).fetch(
            "https://github.com/lucide-icons/lucide/tree/main/icons",
            new AbortController().signal
        );
        assert.deepEqual(
            set.icons.map((i) => i.id),
            ["a-arrow-down", "zap"]
        );
        assert.equal(set.license?.spdx, "ISC");
        assert.equal(requested.length, 2);
    });

    test("refuses a redirect off the allowlist", async () => {
        const http = fakeHttp({
            "https://github.com/a/b/archive/HEAD.tar.gz": () =>
                answer(302, undefined, { location: "https://evil.example/x.tgz" }),
        });
        await assert.rejects(
            new GitHubIcons(new SafeFetch(http)).fetch("https://github.com/a/b", new AbortController().signal),
            (error: unknown) => error instanceof IconImportError && error.code === "host-not-allowed"
        );
    });

    test("stops a download beyond the size limit and reports missing icons", async () => {
        const big = fakeHttp({
            "https://github.com/a/b/archive/HEAD.tar.gz": () =>
                answer(200, archive, { "content-length": String(10 ** 10) }),
        });
        await assert.rejects(
            new GitHubIcons(new SafeFetch(big)).fetch("https://github.com/a/b", new AbortController().signal),
            (error: unknown) => error instanceof IconImportError && error.code === "too-large"
        );
        const empty = fakeHttp({
            "https://github.com/a/b/archive/HEAD.tar.gz": () =>
                answer(200, tarGz([{ path: "b-x/README.md", content: "hi" }])),
        });
        await assert.rejects(
            new GitHubIcons(new SafeFetch(empty)).fetch("https://github.com/a/b", new AbortController().signal),
            (error: unknown) => error instanceof IconImportError && error.code === "no-icons"
        );
        const missing = fakeHttp({});
        await assert.rejects(
            new GitHubIcons(new SafeFetch(missing)).fetch("https://github.com/a/b", new AbortController().signal),
            (error: unknown) => error instanceof IconImportError && error.code === "download-failed"
        );
    });

    test("reads a release zip asset after the redirect to GitHub's asset host", async () => {
        const asset = zip([
            { path: "LICENSE", content: MIT },
            { path: "check.svg", content: strokeIcon("M6 6") },
        ]);
        const http = fakeHttp({
            "https://github.com/h/i/releases/download/v1/icons.zip": () =>
                answer(302, undefined, { location: "https://release-assets.githubusercontent.com/x/icons.zip?sig=1" }),
            "https://release-assets.githubusercontent.com/x/icons.zip?sig=1": () => answer(200, asset),
        });
        const set = await new GitHubIcons(new SafeFetch(http)).fetch(
            "https://github.com/h/i/releases/download/v1/icons.zip",
            new AbortController().signal
        );
        assert.deepEqual(
            set.icons.map((i) => i.id),
            ["check"]
        );
        assert.equal(set.license?.spdx, "MIT");
    });
});

describe("SafeFetch.checkUrl", () => {
    test("accepts https GitHub hosts only", () => {
        SafeFetch.checkUrl("https://codeload.github.com/a/b/tar.gz/main");
        for (const url of [
            "http://github.com/a/b",
            "https://github.com:8443/a",
            "https://user:pw@github.com/a",
            "https://example.com/",
        ]) {
            assert.throws(() => SafeFetch.checkUrl(url), IconImportError, url);
        }
    });
});

function pick(source: ReturnType<typeof parseIconSource>) {
    return { kind: source.kind, url: source.url, ref: source.ref, folder: source.folder };
}
