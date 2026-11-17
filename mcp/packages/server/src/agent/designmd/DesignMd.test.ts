import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ClaudeAnswer } from "./ClaudeAnswer";
import { CssColor, CssValues } from "./CssValues";
import { DesignMdBody } from "./DesignMdBody";
import { DesignMdFromPenpot } from "./DesignMdFromPenpot";
import { DesignMdParser } from "./DesignMdParser";
import { DesignMdSerializer } from "./DesignMdSerializer";
import { DesignMdValidator } from "./DesignMdValidator";
import { DtcgTokens } from "./DtcgTokens";
import { parseDesignMd } from "./index";
import { PenpotImportPlanner } from "./PenpotImportPlan";
import { PenpotScripts, type ImportReport, type PenpotSnapshot, type TagReport } from "./PenpotScripts";
import { FakeComponent, FakePenpot } from "./testing/FakePenpot";
import { ACME_DESIGN_MD, buildButton } from "./testing/fixtures";

function parsed(text: string = ACME_DESIGN_MD) {
    const result = DesignMdParser.parse(text);
    assert.deepEqual(result.issues, []);
    return result.document;
}

describe("DesignMdParser and DesignMdSerializer", () => {
    test("the acceptance fixture parses without issues", () => {
        const { document, issues } = parseDesignMd(ACME_DESIGN_MD);

        assert.deepEqual(issues, []);
        assert.equal(Object.keys(document.tokens.colors).length, 8);
        assert.equal(Object.keys(document.tokens.typography).length, 4);
        assert.deepEqual(Object.keys(document.tokens.spacing), ["xs", "sm", "md", "lg", "xl", "columns"]);
        assert.equal(document.tokens.spacing.columns, 12);
        assert.equal(document.tokens.components["button-primary"].padding, "12px 24px");
        assert.equal(document.tokens.typography["display-lg"].fontWeight, 700);
        assert.deepEqual(
            document.sections.map((section) => section.heading),
            ["Overview", "Colors", "Typography", "Layout", "Components", "Do's and Don'ts"]
        );
        assert.equal(document.preamble, "");
    });

    test("serializing canonical text gives the same text back", () => {
        assert.equal(DesignMdSerializer.serialize(parsed()), ACME_DESIGN_MD);
    });

    test("parse(serialize(doc)) gives back the document", () => {
        const document = parsed();
        const again = DesignMdParser.parse(DesignMdSerializer.serialize(document));

        assert.deepEqual(again.issues, []);
        assert.deepEqual(again.document, document);
    });

    test("non-canonical text round trips through one normalization", () => {
        const text = [
            "---",
            "name: 'Odd: Name'",
            "version: '1.0'",
            "colors:",
            "  a: '#fff'",
            "  'b c': rgb(0, 0, 0)",
            "custom:",
            "  nested: [1, 2]",
            "---",
            "Intro text.",
            "",
            "",
            "## Overview  ",
            "",
            "```md",
            "## not a heading",
            "```",
        ].join("\r\n");
        const first = DesignMdParser.parse(text);
        const normalized = DesignMdSerializer.serialize(first.document);
        const second = DesignMdParser.parse(normalized);

        assert.deepEqual(second.document, first.document);
        assert.equal(DesignMdSerializer.serialize(second.document), normalized);
        assert.equal(first.document.tokens.name, "Odd: Name");
        assert.equal(first.document.tokens.version, "1.0");
        assert.deepEqual(first.document.tokens.extra, { custom: { nested: [1, 2] } });
        assert.equal(first.document.preamble, "Intro text.");
        assert.deepEqual(first.document.sections, [{ heading: "Overview", body: "```md\n## not a heading\n```" }]);
        assert.match(normalized, /^name: "Odd: Name"$/m);
        assert.match(normalized, /^version: "1.0"$/m);
        assert.match(normalized, /^ {2}"b c": "rgb\(0, 0, 0\)"$/m);
        assert.match(normalized, /^ {2}a: "#fff"$/m);
        assert.deepEqual(
            first.issues.map((issue) => issue.path),
            ["custom"]
        );
    });

    test("broken front matter is reported, the body is kept", () => {
        const missing = DesignMdParser.parse("# Title\n\n## Colors\n\nBlue.\n");
        assert.equal(missing.issues[0].severity, "error");
        assert.deepEqual(missing.document.sections, [{ heading: "Colors", body: "Blue." }]);

        const invalid = DesignMdParser.parse("---\ncolors: [\n---\n");
        assert.match(invalid.issues[0].message, /Invalid YAML/);

        const wrongType = DesignMdParser.parse("---\ncolors:\n  a: 3\ntypography:\n  b: big\n---\n");
        assert.deepEqual(
            wrongType.issues.map((issue) => issue.path),
            ["colors.a", "typography.b"]
        );
    });
});

describe("DesignMdValidator", () => {
    test("reports bad values, broken references, cycles and duplicate sections", () => {
        const text = `---
name: Broken
colors:
  a: "#12"
  b: "{colors.missing}"
  c: "{colors.d}"
  d: "{colors.c}"
  e: oklch(70% 0.1 200)
typography:
  body:
    fontFamily: Inter
    fontSize: big
    fontWeight: 2000
rounded:
  md: 8
spacing:
  md: "{rounded.md}"
components:
  card:
    shadow: big
    backgroundColor: "{colors.nope}"
---

## Colors

## Overview

## Colors
`;
        const issues = DesignMdValidator.validate(DesignMdParser.parse(text).document);
        const errors = issues.filter((issue) => issue.severity === "error").map((issue) => issue.path);
        const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.path);

        assert.deepEqual(errors, [
            "colors.a",
            "colors.b",
            "colors.c",
            "colors.d",
            "typography.body.fontSize",
            "typography.body.fontWeight",
            "rounded.md",
            "spacing.md",
            "components.card.backgroundColor",
            "Colors",
        ]);
        assert.deepEqual(warnings, ["colors.e", "components.card.shadow", "Overview"]);
    });
});

describe("CssColor and CssValues", () => {
    test("parses the supported color syntaxes", () => {
        assert.deepEqual(CssColor.parse("#ABC"), { hex: "#aabbcc", opacity: 1 });
        assert.deepEqual(CssColor.parse("#11223380"), { hex: "#112233", opacity: 0.502 });
        assert.deepEqual(CssColor.parse("rgb(255 0 0 / 50%)"), { hex: "#ff0000", opacity: 0.5 });
        assert.deepEqual(CssColor.parse("rgba(0, 128, 255, 0.25)"), { hex: "#0080ff", opacity: 0.25 });
        assert.deepEqual(CssColor.parse("hsl(120, 100%, 25%)"), { hex: "#008000", opacity: 1 });
        assert.deepEqual(CssColor.parse("White"), { hex: "#ffffff", opacity: 1 });
        assert.equal(CssColor.parse("oklch(70% 0.1 200)"), null);
        assert.equal(CssColor.parse("#12"), null);
        assert.equal(CssColor.format({ hex: "#2b59c3", opacity: 0.5 }), "#2B59C380");
        assert.equal(CssColor.equivalent("#fff", "rgb(255,255,255)"), true);
    });

    test("converts dimensions and line heights", () => {
        assert.equal(CssValues.toPx("2.5rem"), 40);
        assert.equal(CssValues.toPx("0.02em", 14), 0.28);
        assert.equal(CssValues.toPx("-0.5px"), -0.5);
        assert.equal(CssValues.toPx("12"), 12);
        assert.equal(CssValues.toPx("big"), null);
        assert.equal(CssValues.lineHeightMultiplier("32px", 24), 4 / 3);
        assert.equal(CssValues.lineHeightMultiplier(1.5, 16), 1.5);
        assert.equal(CssValues.formatNumber(4 / 3), "1.3333");
        assert.equal(CssValues.formatPx(-0), "0px");
    });
});

describe("PenpotImportPlanner", () => {
    test("plans library entries and tokens with Penpot units", () => {
        const plan = PenpotImportPlanner.plan(parsed());

        assert.equal(plan.setName, "DESIGN.md");
        assert.equal(plan.colors.length, 8);
        assert.deepEqual(
            plan.colors.find((color) => color.name === "link"),
            {
                name: "link",
                hex: "#2b59c3",
                opacity: 1,
            }
        );
        assert.deepEqual(
            plan.typographies.find((typography) => typography.name === "display-lg"),
            {
                name: "display-lg",
                fontFamily: "Work Sans",
                fontSize: "40",
                fontWeight: "700",
                fontStyle: "normal",
                lineHeight: "1.2",
                letterSpacing: "-0.5",
            }
        );
        assert.equal(plan.typographies.find((typography) => typography.name === "headline-md")?.lineHeight, "1.3333");
        assert.equal(plan.typographies.find((typography) => typography.name === "label-md")?.letterSpacing, "0.28");
        const tokens = Object.fromEntries(plan.tokens.map((token) => [token.name, token]));
        assert.deepEqual(tokens["color.link"], { name: "color.link", type: "color", value: "{color.primary}" });
        assert.deepEqual(tokens["radius.full"], { name: "radius.full", type: "borderRadius", value: "9999" });
        assert.deepEqual(tokens["spacing.md"], { name: "spacing.md", type: "spacing", value: "16" });
        assert.deepEqual(tokens["spacing.columns"], { name: "spacing.columns", type: "number", value: "12" });
        assert.equal(plan.tokens.at(-1)?.name, "color.link", "aliases come last");
        assert.equal(plan.tokens.length, 8 + 3 + 6);
        assert.deepEqual(plan.skipped, []);
    });
});

describe("PenpotScripts against a fake Penpot", () => {
    test("import creates library entries, tokens, set and theme; a second run changes nothing", async () => {
        const penpot = new FakePenpot();
        const script = PenpotScripts.importScript(PenpotImportPlanner.plan(parsed()));

        const first = (await penpot.execute(script)) as ImportReport;

        assert.deepEqual(first.warnings, []);
        assert.equal(first.colors.created.length, 8);
        assert.equal(first.typographies.created.length, 4);
        assert.equal(first.tokens.created.length, 17);
        const library = penpot.library.local;
        assert.equal(library.color("error")?.color, "#ba1a1a");
        assert.equal(library.typography("headline-md")?.fontWeight, "600");
        assert.equal(library.typography("headline-md")?.fontFamily, "Work Sans");
        assert.equal(library.typography("headline-md")?.lineHeight, "1.3333");
        const set = library.tokens.sets[0];
        assert.equal(set.name, "DESIGN.md");
        assert.equal(set.active, true);
        assert.equal(library.tokens.themes[0].active, true);
        assert.deepEqual(library.tokens.themes[0].activeSets, [set]);

        const second = (await penpot.execute(script)) as ImportReport;

        assert.equal(second.colors.unchanged.length, 8);
        assert.equal(second.typographies.unchanged.length, 4);
        assert.equal(second.tokens.unchanged.length, 17);
        assert.equal(library.colors.length, 8);
        assert.equal(library.tokens.themes.length, 1);
    });

    test("import updates changed values and reports missing fonts", async () => {
        const penpot = new FakePenpot();
        const library = penpot.library.local;
        const old = library.createColor();
        old.name = "primary";
        old.color = "#000000";
        const document = parsed(
            ACME_DESIGN_MD.replace(
                "fontFamily: Work Sans\n    fontSize: 16px",
                "fontFamily: Nope Sans\n    fontSize: 16px"
            )
        );

        const report = (await penpot.execute(
            PenpotScripts.importScript(PenpotImportPlanner.plan(document))
        )) as ImportReport;

        assert.deepEqual(report.colors.updated, ["primary"]);
        assert.equal(library.color("primary")?.color, "#2b59c3");
        assert.deepEqual(report.warnings, ["typography body-md: font Nope Sans was not found"]);
    });

    test("import leaves tokens alone when they come from a library", async () => {
        const penpot = new FakePenpot();
        penpot.library.local.tokens.isEditableTokens = false;

        const report = (await penpot.execute(
            PenpotScripts.importScript(PenpotImportPlanner.plan(parsed()))
        )) as ImportReport;

        assert.equal(penpot.library.local.tokens.sets.length, 0);
        assert.match(report.warnings[0], /^tokens: /);
        assert.equal(report.colors.created.length, 8);
    });

    test("tagging links components by name or slug and lists missing ones", async () => {
        const penpot = new FakePenpot();
        penpot.library.local.components.push(new FakeComponent("Button Primary", "", null));

        const report = (await penpot.execute(
            PenpotScripts.tagComponentsScript(["button-primary", "card"])
        )) as TagReport;

        assert.deepEqual(
            report.tagged.map((entry) => entry.key),
            ["button-primary"]
        );
        assert.deepEqual(report.missing, ["card"]);
        assert.equal(
            penpot.library.local.components[0].getSharedPluginData("penforge", "designMdComponent"),
            "button-primary"
        );
    });
});

describe("DesignMdFromPenpot", () => {
    async function importedFile(): Promise<{ penpot: FakePenpot; snapshot: PenpotSnapshot }> {
        const penpot = new FakePenpot("Acme");
        await penpot.execute(PenpotScripts.importScript(PenpotImportPlanner.plan(parsed())));
        buildButton(penpot);
        await penpot.execute(PenpotScripts.tagComponentsScript(["button-primary"]));
        const snapshot = (await penpot.execute(PenpotScripts.snapshotScript())) as PenpotSnapshot;
        return { penpot, snapshot };
    }

    test("import then export gives the same DESIGN.md text (round trip)", async () => {
        const { snapshot } = await importedFile();

        const exported = DesignMdFromPenpot.build(snapshot, parsed());

        assert.equal(DesignMdSerializer.serialize(exported), ACME_DESIGN_MD);
    });

    test("without a previous DESIGN.md, export gives equivalent tokens and a Button spec", async () => {
        const { snapshot } = await importedFile();

        const exported = DesignMdFromPenpot.build(snapshot, null);
        const { tokens } = exported;

        assert.equal(tokens.name, "Acme");
        assert.equal(tokens.version, "alpha");
        assert.deepEqual(Object.keys(tokens.colors), Object.keys(parsed().tokens.colors));
        assert.equal(tokens.colors.link, "{colors.primary}");
        for (const [name, value] of Object.entries(parsed().tokens.colors)) {
            if (!value.startsWith("{")) {
                assert.equal(CssColor.equivalent(tokens.colors[name], value), true, name);
            }
        }
        assert.deepEqual(tokens.typography["display-lg"], {
            fontFamily: "Work Sans",
            fontSize: "40px",
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: "-0.5px",
        });
        assert.equal(tokens.typography["headline-md"].lineHeight, 1.3333);
        assert.deepEqual(tokens.rounded, { sm: "4px", md: "8px", full: "9999px" });
        assert.deepEqual(tokens.spacing, { xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "32px", columns: 12 });
        assert.deepEqual(tokens.components["button-primary"], {
            backgroundColor: "{colors.primary}",
            textColor: "{colors.on-primary}",
            typography: "{typography.label-md}",
            rounded: "{rounded.md}",
            padding: "12px 24px",
            height: "44px",
        });
        assert.deepEqual(
            exported.sections.map((section) => section.heading),
            ["Overview", "Colors", "Typography", "Layout", "Shapes", "Components", "Do's and Don'ts"]
        );
        assert.deepEqual(
            DesignMdValidator.validate(exported).filter((issue) => issue.severity === "error"),
            []
        );
    });

    test("changed values in the file win, unbuilt component specs stay", async () => {
        const { penpot } = await importedFile();
        penpot.library.local.color("secondary")!.color = "#00ff00";
        const set = penpot.library.local.tokens.sets[0];
        set.tokens.find((token) => token.name === "color.secondary")!.value = "#00FF00";
        set.tokens.find((token) => token.name === "radius.md")!.value = "12";
        const previous = parsed(
            ACME_DESIGN_MD.replace("components:\n", 'components:\n  card:\n    backgroundColor: "{colors.surface}"\n')
        );
        const snapshot = (await penpot.execute(PenpotScripts.snapshotScript())) as PenpotSnapshot;

        const exported = DesignMdFromPenpot.build(snapshot, previous);

        assert.equal(exported.tokens.colors.secondary, "#00FF00");
        assert.equal(exported.tokens.rounded.md, "12px");
        assert.deepEqual(exported.tokens.components.card, { backgroundColor: "{colors.surface}" });
        assert.equal(exported.tokens.components["button-primary"].rounded, "{rounded.md}");
    });
});

describe("DesignMdBody", () => {
    test("adds notes only for components without them and fills empty sections", () => {
        const document = parsed();

        const withNotes = DesignMdBody.addComponentNotes(document, {
            "button-primary": "ignored",
            card: "## Card\nHolds content.",
        });
        const filled = DesignMdBody.fillSection(withNotes, "Shapes", "Rounded corners everywhere.");
        const overview = DesignMdBody.fillSection(filled, "Overview", "replaced?");

        const components = DesignMdBody.section(overview, "Components")!.body;
        assert.match(
            components,
            /### button-primary\n\nMain call to action\. One per screen\.\n\n### card\n\n#### Card\nHolds content\.$/
        );
        assert.deepEqual(
            overview.sections.map((section) => section.heading),
            ["Overview", "Colors", "Typography", "Layout", "Shapes", "Components", "Do's and Don'ts"]
        );
        assert.equal(DesignMdBody.section(overview, "Overview")!.body, document.sections[0].body);
        assert.deepEqual([...DesignMdBody.componentNoteKeys(overview)], ["button-primary", "card"]);
        assert.notEqual(withNotes, document);
        assert.equal(document.sections.length, 6, "the input is not changed");
    });
});

describe("DtcgTokens", () => {
    test("exports W3C tokens named like the Penpot tokens", () => {
        const tokens = DtcgTokens.fromDocument(parsed()) as any;

        assert.deepEqual(tokens.color.link, { $type: "color", $value: "{color.primary}" });
        assert.deepEqual(tokens.radius.md, { $type: "dimension", $value: "8px" });
        assert.deepEqual(tokens.spacing.columns, { $type: "number", $value: 12 });
        assert.equal(tokens.typography["label-md"].$value.letterSpacing, "0.02em");
    });
});

describe("ClaudeAnswer", () => {
    test("extracts a DESIGN.md with or without a wrapping fence", () => {
        const file = "---\nname: X\n---\n\n## Overview\n\n```css\na {}\n```\n";

        assert.equal(ClaudeAnswer.designMd(file), file);
        assert.equal(ClaudeAnswer.designMd("```markdown\n" + file + "```"), file);
        assert.equal(ClaudeAnswer.designMd("Here it is:\n\n" + file), file);
        assert.equal(ClaudeAnswer.designMd("no file here"), null);
    });

    test("extracts the JSON object of an answer", () => {
        assert.deepEqual(ClaudeAnswer.json('Sure.\n```json\n{"a": 1}\n```'), { a: 1 });
        assert.deepEqual(ClaudeAnswer.json('{"components": {"x": "y"}}'), { components: { x: "y" } });
        assert.equal(ClaudeAnswer.json("nothing"), null);
    });
});
