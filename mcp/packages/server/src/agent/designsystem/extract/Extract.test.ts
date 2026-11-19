import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ColorMath } from "./ColorMath";
import type { RawGroup, RawInventory } from "./ExtractModel";
import { ExtractPlanner } from "./ExtractPlanner";
import { SourceMapFile } from "./SourceMap";

function inventory(patch: Partial<RawInventory> = {}): RawInventory {
    return {
        fileName: "Shop",
        truncated: false,
        pages: [{ id: "p1", name: "Page 1", screens: 3, mains: 0, overview: null }],
        components: [],
        colors: [],
        typographies: [],
        tokenSets: [],
        values: { fills: {}, strokes: {}, fonts: [], spacing: {}, radius: {}, shadows: [] },
        groups: [],
        icons: [],
        ...patch,
    };
}

function group(id: string, screenId: string, patch: Partial<RawGroup> = {}): RawGroup {
    return {
        id,
        pageId: "p1",
        screenId,
        name: "Card",
        type: "board",
        hash: "card",
        look: "blue",
        width: 160,
        height: 200,
        texts: 2,
        ancestors: [],
        ...patch,
    };
}

describe("ColorMath", () => {
    test("normalizes hex colors", () => {
        assert.equal(ColorMath.normalize("#ABC"), "#aabbcc");
        assert.equal(ColorMath.normalize("#1E88E5FF"), "#1e88e5");
        assert.equal(ColorMath.normalize("rgb(1,2,3)"), null);
    });

    test("finds near-duplicates and names plain colors", () => {
        assert.ok(ColorMath.distance("#1e88e5", "#1d87e4") < ColorMath.NEAR);
        assert.ok(ColorMath.distance("#1e88e5", "#e53935") > ColorMath.NEAR);
        assert.equal(ColorMath.plainName("#ffffff"), "white");
        assert.equal(ColorMath.plainName("#111827"), "neutral-900");
        assert.equal(ColorMath.plainName("#f5f5f5"), "neutral-50");
        assert.equal(ColorMath.plainName("#e53935"), "red-400");
        assert.ok(ColorMath.isNeutral("#6b7280"));
        assert.ok(!ColorMath.isNeutral("#1e88e5"));
    });
});

describe("ExtractPlanner", () => {
    test("merges almost-equal colors under the library name and names the rest", () => {
        const { plan, details } = ExtractPlanner.build(
            inventory({
                colors: [{ id: "c1", name: "Brand Blue", path: "", hex: "#1e88e5", opacity: 1, uses: 5 }],
                values: {
                    fills: { "#1e88e5": 5, "#1d87e4": 2, "#1f89e6": 1, "#ffffff": 9, "#e53935": 3 },
                    strokes: {},
                    fonts: [],
                    spacing: {},
                    radius: {},
                    shadows: [],
                },
            })
        );
        const merge = plan.proposals.find((p) => p.kind === "merge-colors")!;
        assert.equal(merge.id, "merge:#1e88e5");
        assert.deepEqual(merge.params.colors, ["#1e88e5", "#1d87e4", "#1f89e6"]);
        assert.match(merge.text, /3 colors are almost the same .* I will keep one, color\.brand-blue/);
        const tokens = Object.fromEntries(details.colors.map((c) => [c.hex, c.token]));
        assert.deepEqual(tokens, {
            "#ffffff": "color.white",
            "#1e88e5": "color.brand-blue",
            "#e53935": "color.primary",
        });
        assert.equal(details.colors.find((c) => c.hex === "#1e88e5")!.libraryColorId, "c1");
    });

    test("a skipped merge gives the other values tokens of their own", () => {
        const { details } = ExtractPlanner.build(
            inventory({
                values: {
                    fills: { "#1e88e5": 5, "#1d87e4": 2 },
                    strokes: {},
                    fonts: [],
                    spacing: {},
                    radius: {},
                    shadows: [],
                },
            })
        );
        const kept = ExtractPlanner.accepted(details, ["merge:#1e88e5"]);
        assert.equal(kept.merges.length, 0);
        assert.deepEqual(
            kept.colors.map((c) => [c.hex, c.token]),
            [
                ["#1e88e5", "color.primary"],
                ["#1d87e4", "color.primary-alt"],
            ]
        );
        const none = ExtractPlanner.accepted(details, ["color:#1e88e5"]);
        assert.equal(none.colors.length, 0, "an unchecked color also drops its merge");
        assert.equal(none.merges.length, 0);
    });

    test("repeated groups become one component with a variant per look; outer groups win", () => {
        const { plan, details } = ExtractPlanner.build(
            inventory({
                groups: [
                    group("g1", "s1"),
                    group("g2", "s1"),
                    group("g3", "s2", { look: "gray" }),
                    group("g4", "s2"),
                    // inner rows of the cards repeat too, but the cards win
                    group("r1", "s1", { hash: "row", ancestors: ["g1"], width: 100, height: 20, name: "Row" }),
                    group("r2", "s2", { hash: "row", ancestors: ["g3"], width: 100, height: 20, name: "Row" }),
                    // drawn once: not a candidate
                    group("x1", "s3", { hash: "other" }),
                ],
            })
        );
        const components = plan.proposals.filter((p) => p.kind === "component");
        assert.equal(components.length, 1);
        assert.equal(components[0].code, "component-variants");
        assert.match(components[0].text, /"Card" is drawn 4 times on 2 screens .* with 2 variants/);
        const planned = details.components[0].component;
        assert.deepEqual(
            planned.variants.map((v) => [v.name, v.members]),
            [
                ["Default", ["g1", "g2", "g4"]],
                ["Style 2", ["g3"]],
            ]
        );
    });

    test("renames generic components, groups related ones, lists icons and unused items", () => {
        const component = (id: string, name: string, patch = {}) => ({
            id,
            name,
            path: "",
            mainId: `m-${id}`,
            pageId: "p1",
            instances: 2,
            variantContainerId: null,
            firstText: "",
            iconLike: false,
            width: 120,
            height: 40,
            ...patch,
        });
        const { plan, details } = ExtractPlanner.build(
            inventory({
                components: [
                    component("k1", "Component 1", { firstText: "new badge" }),
                    component("k2", "Button Primary"),
                    component("k3", "Button Ghost"),
                    component("k4", "Old Banner", { instances: 0 }),
                    component("k5", "Star", { iconLike: true, width: 24, height: 24 }),
                ],
                typographies: [
                    {
                        id: "t1",
                        name: "Legacy",
                        path: "",
                        fontFamily: "Inter",
                        fontSize: "40",
                        fontWeight: "300",
                        lineHeight: "1.2",
                        letterSpacing: "0",
                        uses: 0,
                    },
                ],
                icons: [
                    { id: "i1", pageId: "p1", name: "icon/search", width: 24, height: 24, hash: "a" },
                    { id: "i2", pageId: "p1", name: "icon/search", width: 24, height: 24, hash: "a" },
                    { id: "i3", pageId: "p1", name: "Vector", width: 20, height: 20, hash: "b" },
                ],
            })
        );
        assert.deepEqual(details.renames, [{ proposalId: "rename:k1", componentId: "k1", name: "New Badge" }]);
        assert.deepEqual(
            details.groups.map((g) => [g.path, g.componentIds]),
            [["Button", ["k3", "k2"]]]
        );
        assert.deepEqual(
            details.icons.shapes.map((s) => s.name),
            ["search", "icon-1"]
        );
        assert.deepEqual(details.icons.componentIds, ["k5"]);
        assert.deepEqual(
            details.unused.map((u) => [u.kind, u.name]),
            [
                ["typography", "Legacy"],
                ["component", "Old Banner"],
            ]
        );
        assert.ok(plan.proposals.find((p) => p.id === "icons")!.text.includes("3 icons"));
    });

    test("tokens for spacing, radius and shadows; text styles by size", () => {
        const { plan, details } = ExtractPlanner.build(
            inventory({
                typographies: [
                    {
                        id: "t1",
                        name: "Heading",
                        path: "",
                        fontFamily: "Inter",
                        fontSize: "28",
                        fontWeight: "700",
                        lineHeight: "1.2",
                        letterSpacing: "0",
                        uses: 3,
                    },
                ],
                values: {
                    fills: {},
                    strokes: {},
                    fonts: [
                        {
                            fontFamily: "Inter",
                            fontSize: "28",
                            fontWeight: "700",
                            lineHeight: "1.2",
                            letterSpacing: "0",
                            count: 3,
                        },
                        {
                            fontFamily: "Inter",
                            fontSize: "16",
                            fontWeight: "400",
                            lineHeight: "1.5",
                            letterSpacing: "0",
                            count: 8,
                        },
                        {
                            fontFamily: "Inter",
                            fontSize: "16",
                            fontWeight: "400",
                            lineHeight: "1.2",
                            letterSpacing: "0",
                            count: 2,
                        },
                        {
                            fontFamily: "Inter",
                            fontSize: "12",
                            fontWeight: "600",
                            lineHeight: "1.2",
                            letterSpacing: "0",
                            count: 2,
                        },
                        {
                            fontFamily: "Inter",
                            fontSize: "20",
                            fontWeight: "600",
                            lineHeight: "1.2",
                            letterSpacing: "0",
                            count: 1,
                        },
                    ],
                    spacing: { "16": 6, "8": 4, "13": 1 },
                    radius: { "8": 5, "9999": 2 },
                    shadows: [
                        { offsetX: 0, offsetY: 4, blur: 12, spread: 0, hex: "#000000", opacity: 0.2, count: 3 },
                        { offsetX: 0, offsetY: 1, blur: 2, spread: 0, hex: "#000000", opacity: 0.1, count: 2 },
                    ],
                },
            })
        );
        assert.deepEqual(
            details.textStyles.map((t) => [t.style.name, t.style.fontSize, t.style.lineHeight]),
            [
                ["Body", "16", "1.5"],
                ["Caption Strong", "12", "1.2"],
            ]
        );
        assert.deepEqual(
            details.tokens.map((t) => t.token.name),
            ["spacing.8", "spacing.16", "radius.8", "radius.full", "shadow.sm", "shadow.md"]
        );
        assert.deepEqual(details.tokens.at(-1)!.token.penpotValue, [
            { offsetX: "0", offsetY: "4", blur: "12", spread: "0", color: "rgba(0, 0, 0, 0.2)", inset: "false" },
        ]);
        assert.match(plan.planId, /^[0-9a-f]{12}$/);
    });

    test("the plan id changes with the proposals only", () => {
        const one = ExtractPlanner.build(
            inventory({
                values: { fills: { "#1e88e5": 2 }, strokes: {}, fonts: [], spacing: {}, radius: {}, shadows: [] },
            })
        );
        const same = ExtractPlanner.build(
            inventory({
                values: { fills: { "#1e88e5": 2 }, strokes: {}, fonts: [], spacing: {}, radius: {}, shadows: [] },
            })
        );
        const other = ExtractPlanner.build(
            inventory({
                values: { fills: { "#1e88e5": 3 }, strokes: {}, fonts: [], spacing: {}, radius: {}, shadows: [] },
            })
        );
        assert.equal(one.plan.planId, same.plan.planId);
        assert.notEqual(one.plan.planId, other.plan.planId);
    });
});

describe("SourceMapFile.build", () => {
    test("maps components, layers, colors and values of the source", () => {
        const inv = inventory({
            components: [
                {
                    id: "k1",
                    name: "Component 1",
                    path: "",
                    mainId: "m1",
                    pageId: "p1",
                    instances: 1,
                    variantContainerId: null,
                    firstText: "badge",
                    iconLike: false,
                    width: 60,
                    height: 20,
                },
                {
                    id: "k4",
                    name: "Old Banner",
                    path: "",
                    mainId: "m4",
                    pageId: "p1",
                    instances: 0,
                    variantContainerId: null,
                    firstText: "",
                    iconLike: false,
                    width: 300,
                    height: 80,
                },
            ],
            colors: [
                { id: "c1", name: "Brand Blue", path: "", hex: "#1e88e5", opacity: 1, uses: 4 },
                { id: "c2", name: "Near Blue", path: "", hex: "#1d87e4", opacity: 1, uses: 1 },
                { id: "c3", name: "Pink", path: "", hex: "#ff00aa", opacity: 1, uses: 0 },
            ],
            values: {
                fills: { "#1e88e5": 4, "#1d87e4": 1 },
                strokes: {},
                fonts: [],
                spacing: { "16": 3 },
                radius: {},
                shadows: [],
            },
            groups: [group("g1", "s1"), group("g2", "s2")],
        });
        const { details } = ExtractPlanner.build(inv);
        const map = SourceMapFile.build(
            {
                source: { fileId: "src", projectId: "proj", revn: 7 },
                designSystem: { fileId: "copy", projectId: "ds", name: "Shop DS" },
                inventory: inv,
                details,
                components: {
                    created: [
                        {
                            proposalId: details.components[0].proposalId,
                            name: "Card",
                            variants: false,
                            components: [{ componentId: "new-card", variant: "Default", sampleId: "g1" }],
                        },
                    ],
                    bound: { fill: 0, stroke: 0, radius: 0, spacing: 0, typography: 0, recolored: 0 },
                    renamed: 1,
                    grouped: 0,
                    dropped: ["k4"],
                    relocated: 0,
                    warnings: [],
                },
                libraryColors: { "#1e88e5": "c1" },
                typographies: {},
                icons: {},
            },
            "2026-11-19T10:00:00.000Z"
        );
        assert.deepEqual(map.source, { fileId: "src", projectId: "proj", revn: 7 });
        assert.deepEqual(map.components.k1, { componentId: "k1", name: "Badge", path: "", status: "renamed" });
        assert.deepEqual(map.components.k4, { componentId: null, name: "Old Banner", path: "", status: "dropped" });
        assert.deepEqual(map.layers.g1, { componentId: "new-card", name: "Card", variant: null, kind: "component" });
        assert.deepEqual(map.layers.g2, map.layers.g1);
        assert.deepEqual(map.colors.c1, { token: "color.brand-blue", colorId: "c1" });
        assert.deepEqual(map.colors.c2, { token: "color.brand-blue", colorId: "c1" }, "merged into the kept color");
        assert.deepEqual(map.colors.c3, { token: null, colorId: null });
        assert.equal(map.values.colors["#1d87e4"], "color.brand-blue");
        assert.equal(map.values.spacing["16"], "spacing.16");
        assert.deepEqual(map.merged, [{ token: "color.brand-blue", keep: "#1e88e5", from: ["#1d87e4"] }]);
    });
});
