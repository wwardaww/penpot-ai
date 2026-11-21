import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ProjectFonts } from "./ProjectFonts";
import { SourceInventory } from "./SourceInventory";

describe("ProjectFonts", () => {
    test("finds the Google Fonts a project loads", () => {
        const layout = [
            'import { Archivo_Black, Inter as Sans, Space_Mono } from "next/font/google";',
            '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&amp;family=Fira%20Code&display=swap">',
            "@import url('https://fonts.googleapis.com/css?family=Lato:400,700|Open+Sans');",
            'import "@fontsource/plus-jakarta-sans/600.css";',
            '"@fontsource-variable/manrope": "^5.0.0", "@expo-google-fonts/poppins": "^0.2.3"',
        ].join("\n");
        assert.deepEqual(
            new Set(ProjectFonts.googleFamilies(layout)),
            new Set([
                "Archivo Black",
                "Inter",
                "Space Mono",
                "DM Sans",
                "Fira Code",
                "Lato",
                "Open Sans",
                "Plus Jakarta Sans",
                "Manrope",
                "Poppins",
            ])
        );
        assert.deepEqual(ProjectFonts.googleFamilies('const a = "no fonts here";'), []);
    });

    test("guesses a family from a font file name", () => {
        assert.equal(ProjectFonts.familyOf("public/fonts/Inter-SemiBold.ttf"), "Inter");
        assert.equal(ProjectFonts.familyOf("fonts/GeneralSans-BoldItalic.woff2"), "General Sans");
        assert.equal(ProjectFonts.familyOf("a/Satoshi-Variable.woff2"), "Satoshi");
        assert.equal(ProjectFonts.familyOf("a/brand_font_700.otf"), "brand font");
        assert.equal(ProjectFonts.familyOf("a/Regular.ttf"), "Regular");
    });

    test("collects fonts from an inventory and sends the best format of each file", async () => {
        const root = mkdtempSync(join(tmpdir(), "penforge-fonts-"));
        try {
            mkdirSync(join(root, "app"), { recursive: true });
            mkdirSync(join(root, "public", "fonts"), { recursive: true });
            mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
            writeFileSync(
                join(root, "app", "layout.tsx"),
                'import { Inter } from "next/font/google";\nexport default function L() { return null; }'
            );
            writeFileSync(join(root, "package.json"), '{"name":"x"}');
            writeFileSync(join(root, "public", "fonts", "Brand-Bold.woff2"), "w2");
            writeFileSync(join(root, "public", "fonts", "Brand-Bold.ttf"), "ttf");
            writeFileSync(join(root, "public", "fonts", "Brand-Regular.woff2"), "w2r");
            writeFileSync(join(root, "node_modules", "pkg", "Hidden.ttf"), "no");
            const index = await new SourceInventory(root, "existing", null).build();
            assert.deepEqual(index.fonts!.sort(), [
                "public/fonts/Brand-Bold.ttf",
                "public/fonts/Brand-Bold.woff2",
                "public/fonts/Brand-Regular.woff2",
            ]);

            const info = await ProjectFonts.collect(root, index);
            assert.deepEqual(info.google, ["Inter"]);
            assert.deepEqual(new Set(info.files.map((file) => file.family)), new Set(["Brand"]));

            const sent = await ProjectFonts.filesToSend(root, info);
            assert.deepEqual(sent.map((file) => file.name).sort(), ["Brand-Bold.ttf", "Brand-Regular.woff2"]);
            assert.equal(Buffer.from(sent.find((f) => f.name === "Brand-Bold.ttf")!.data, "base64").toString(), "ttf");

            const lines = ProjectFonts.promptLines(info).join("\n");
            assert.match(lines, /Google Fonts the code loads: Inter/);
            assert.match(lines, /Font files the project ships: Brand/);
            assert.deepEqual(ProjectFonts.promptLines({ google: [], files: [] }), []);
            assert.deepEqual(ProjectFonts.promptLines(null), []);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
