import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tempDir } from "../testing/helpers";
import { GoogleFonts } from "./GoogleFonts";

describe("GoogleFonts", () => {
    it("answers 502 at once when Google Fonts cannot be reached", async () => {
        const temp = tempDir();
        try {
            const fonts = new GoogleFonts({
                cacheDir: temp.dir,
                fetch: async () => {
                    throw new Error("offline");
                },
            });
            assert.equal((await fonts.answer("/internal/gfonts/css", "?family=Inter")).status, 502);
            assert.equal((await fonts.answer("/internal/gfonts/font/inter/v1/a.woff2", "")).status, 502);
        } finally {
            temp.cleanup();
        }
    });

    it("refuses odd font paths and empty CSS queries without a request", async () => {
        const temp = tempDir();
        let asked = 0;
        try {
            const fonts = new GoogleFonts({
                cacheDir: temp.dir,
                fetch: async () => {
                    asked++;
                    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) };
                },
            });
            assert.equal((await fonts.answer("/internal/gfonts/font/a//b.ttf", "")).status, 404);
            assert.equal((await fonts.answer("/internal/gfonts/font/a/%2e%2e/b.ttf", "")).status, 404);
            assert.equal((await fonts.answer("/internal/gfonts/css", "")).status, 400);
            assert.equal(asked, 0);
        } finally {
            temp.cleanup();
        }
    });

    it("passes a missing font on as 404", async () => {
        const temp = tempDir();
        try {
            const fonts = new GoogleFonts({
                cacheDir: temp.dir,
                fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
            });
            assert.equal((await fonts.answer("/internal/gfonts/font/none/v1/x.ttf", "")).status, 404);
        } finally {
            temp.cleanup();
        }
    });
});
