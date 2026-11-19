import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { WorkflowContext, WorkflowQuestion } from "@penpot/mcp-common";
import type { FakeComponent } from "../designmd/testing/FakePenpot";
import { DESIGN_SYSTEM_KEY, PLUGIN_NAMESPACE } from "../designsystem";
import type { Proposal, SourceMap } from "../designsystem/extract";
import { FakeProjectPenpot, ProjectNode, rect, text, vector } from "../designsystem/extract/testing/FakeProjectPenpot";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { EXTRACT_PUBLISH_OPTIONS, workflow } from "./design-system-extract";
import { WorkflowRegistry } from "./WorkflowRegistry";

const PROJECT_ID = "7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const FILE_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SOURCE_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

let projectsDir: string;
let workspace: ProjectWorkspace;
let penpot: FakeProjectPenpot;
let ids: { badge: string; oldBanner: string; cards: string[]; search: string; cart: string; pink: string };

interface Harness {
    ctx: WorkflowContext;
    events: { kind: string; payload: any }[];
    questions: WorkflowQuestion[];
}

function harness(answers: string[] = []): Harness {
    const events: Harness["events"] = [];
    const questions: WorkflowQuestion[] = [];
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: FILE_ID,
            fileName: "Shop (copy)",
            projectId: PROJECT_ID,
            teamId: "team-1",
            pageId: "page-1",
            persona: "designer",
            platform: "web",
        },
        runner: {
            run: async () => {
                throw new Error("no Claude turn expected");
            },
        },
        tools: penpot.tools(),
        workspace,
        signal: new AbortController().signal,
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async (question) => {
            questions.push(question);
            const answer = answers.shift();
            if (answer === undefined) {
                throw new Error("unexpected question");
            }
            return answer;
        },
    };
    return { ctx, events, questions };
}

function card(color: string, title: string): ProjectNode {
    const node = new ProjectNode("board", 160, 200, "Product Card").with(
        rect(color, 160, 120, 8),
        text(title, "16", "600", "#ffffff"),
        text("$10", "14", "400", "#ffffff")
    );
    node.flex = { topPadding: 12, rightPadding: 12, bottomPadding: 12, leftPadding: 12, rowGap: 0, columnGap: 0 };
    return node;
}

function screen(name: string, ...layers: ProjectNode[]): ProjectNode {
    const node = new ProjectNode("board", 375, 812, name).with(...layers);
    node.fills = [{ fillColor: "#ffffff", fillOpacity: 1 }];
    return node;
}

/**
 * The acceptance project: 5 screens on 2 pages, 3 used components (+1 unused), near-duplicate
 * blues, a card drawn 4 times in 2 looks on 2 screens, icons, an unused color and text style.
 */
function buildProject(): void {
    const lib = penpot.library.local;
    const brand = lib.createColor();
    brand.name = "Brand Blue";
    brand.color = "#1e88e5";
    const pink = lib.createColor();
    pink.name = "Unused Pink";
    pink.color = "#ff00aa";
    const heading = lib.createTypography();
    Object.assign(heading, { name: "Heading", fontFamily: "Inter", fontSize: "28", fontWeight: "700" });
    const legacy = lib.createTypography();
    Object.assign(legacy, { name: "Legacy", fontFamily: "Inter", fontSize: "40", fontWeight: "300" });

    const buttonMain = (name: string, color: string) => {
        const node = new ProjectNode("board", 120, 40, name).with(
            rect(color, 120, 40, 8),
            text("Buy", "14", "600", "#ffffff")
        );
        return node;
    };
    const primary = buttonMain("Button Primary", "#1e88e5");
    const ghost = buttonMain("Button Ghost", "#1d87e4");
    const banner = new ProjectNode("board", 300, 80, "Old Banner").with(rect("#f5f5f5", 300, 80));
    const components = penpot.projectPage("Page 1");
    components.name = "Components";
    for (const node of [primary, ghost, banner]) {
        ProjectNode.prototype.appendChild.call(components.root, node);
    }
    const primaryComponent = penpot.makeComponent(primary);
    const ghostComponent = penpot.makeComponent(ghost);
    const bannerComponent = penpot.makeComponent(banner);

    const list = new ProjectNode("board", 300, 200, "List").with(rect("#1d87e4", 100, 20), rect("#1f89e6", 100, 20));
    list.flex = { topPadding: 16, rightPadding: 16, bottomPadding: 16, leftPadding: 16, rowGap: 8, columnGap: 0 };
    const cards = [card("#1e88e5", "Shoes"), card("#1e88e5", "Hat"), card("#1e88e5", "Bag"), card("#f5f5f5", "Socks")];
    const search = vector("icon/search");
    const searchAgain = vector("icon/search");
    const cart = vector("icon/cart");
    penpot.addPage(
        "Home",
        screen("Home", text("Welcome", "28", "700"), cards[0], cards[1], list, search, copy(primaryComponent)),
        screen(
            "Product",
            cards[2],
            cards[3],
            text("Soft and warm", "16", "400"),
            text("In stock", "16", "400"),
            searchAgain,
            cart
        )
    );

    const badge = new ProjectNode("board", 60, 20, "Component 1").with(
        rect("#e53935", 60, 20, 9999),
        text("New", "12", "600", "#ffffff")
    );
    const pay = screen("Pay", badge, copy(ghostComponent), text("Total", "16", "400"));
    const badgeComponent = penpot.makeComponent(badge);
    penpot.addPage(
        "Checkout",
        screen("Cart", copy(primaryComponent), text("Total", "16", "400"), copy(badgeComponent)),
        pay,
        screen("Done", copy(primaryComponent), copy(badgeComponent))
    );
    ids = {
        badge: badgeComponent.id,
        oldBanner: bannerComponent.id,
        cards: cards.map((c) => c.id),
        search: search.id,
        cart: cart.id,
        pink: pink.id,
    };
}

function copy(component: FakeComponent): ProjectNode {
    return penpot.copyOf(component, 120, 40);
}

function setMarker(source: object | null): void {
    const file = penpot.currentFile as unknown as { setSharedPluginData(ns: string, key: string, value: string): void };
    file.setSharedPluginData(
        PLUGIN_NAMESPACE,
        DESIGN_SYSTEM_KEY,
        JSON.stringify({
            version: 1,
            name: "Shop Design System",
            createdAt: "2026-11-19T09:00:00Z",
            ...(source ? { source } : {}),
        })
    );
}

function marker(): any {
    return JSON.parse(penpot.fileDataOf(PLUGIN_NAMESPACE, DESIGN_SYSTEM_KEY) || "null");
}

async function plan(): Promise<{ planId: string; proposals: Proposal[] }> {
    const h = harness();
    await workflow.run(h.ctx, { mode: "plan" });
    const result = h.events.find((e) => e.kind === "result")!.payload;
    assert.deepEqual(h.events.find((e) => e.kind === "plan")!.payload, result);
    return result;
}

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-dsx-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();
    penpot = new FakeProjectPenpot("Shop (copy)");
    Object.assign(penpot.currentFile, { id: FILE_ID });
    buildProject();
    setMarker({ fileId: SOURCE_ID, projectId: "proj-src", revn: 12 });
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

describe("design-system-extract", () => {
    test("is registered", () => {
        assert.ok(WorkflowRegistry.withShippedWorkflows().names().includes("design-system-extract"));
    });

    test("plan: ONE list with merged colors, tokens, the card as a component, icons and unused items", async () => {
        const result = await plan();
        const byId = new Map(result.proposals.map((p) => [p.id, p]));
        const merge = byId.get("merge:#1e88e5")!;
        assert.deepEqual(merge.params.colors, ["#1e88e5", "#1d87e4", "#1f89e6"]);
        assert.equal(merge.params.token, "color.brand-blue");
        assert.ok(byId.has("color:#ffffff"));
        assert.ok(byId.has("spacing:12") && byId.has("spacing:16") && byId.has("radius:8"));
        const cardProposal = result.proposals.find((p) => p.kind === "component")!;
        assert.equal(cardProposal.params.name, "Product Card");
        assert.equal(cardProposal.params.count, 4);
        assert.equal(cardProposal.params.variants, 2);
        assert.equal(byId.get(`rename:${ids.badge}`)!.params.to, "New");
        assert.ok(byId.has("group:button"));
        assert.equal(byId.get("icons")!.params.drawn, 2, "the same icon drawn twice counts once");
        assert.ok(byId.has(`unused:color:${ids.pink}`));
        assert.ok(byId.has(`unused:component:${ids.oldBanner}`));
        assert.ok(result.proposals.every((p) => typeof p.text === "string" && p.text.length > 0 && p.code));
        assert.equal(penpot.undo.opened, 0, "the plan changes nothing");
        assert.equal(penpot.pages.length, 3);
    });

    test("apply: stages, unchecked items left out, screens removed, DESIGN.md and source map saved", async () => {
        const listed = await plan();
        const h = harness([EXTRACT_PUBLISH_OPTIONS.publish]);
        const skip = [`unused:component:${ids.oldBanner}`];
        await workflow.run(h.ctx, { mode: "apply", planId: listed.planId, skip });
        const result = h.events.find((e) => e.kind === "result")!.payload;
        assert.deepEqual(
            h.events.filter((e) => e.kind === "log").map((e) => [e.payload.code, e.payload.text]),
            [],
            "no stage failed or left items out"
        );
        assert.deepEqual(
            h.events
                .filter((e) => e.kind === "progress" && typeof e.payload.step === "string")
                .map((e) => e.payload.step),
            [
                "inventory",
                "checkpoint",
                "tokens",
                "colors",
                "typography",
                "components",
                "icons",
                "pages",
                "pages",
                "pages",
                "screens",
                "design-md",
                "source-map",
                "publish",
            ]
        );

        // pages: the design system pages, components pages, no screens
        const names = penpot.pages.map((p) => p.name);
        for (const page of ["Colors", "Typography", "Tokens", "Icons", "Components"]) {
            assert.ok(names.includes(page), `${page} in ${names.join(", ")}`);
        }
        const screens = penpot.pages
            .flatMap((p) => p.root.children)
            .filter((n) => /^(Home|Product|Cart|Pay|Done)$/.test(n.name));
        assert.deepEqual(screens, [], "no screen left");
        assert.ok(result.pages.removedLayers >= 5);

        // the unchecked item stays, the checked unused ones are gone
        const components = penpot.library.local.components;
        assert.ok(
            components.some((c) => c.id === ids.oldBanner),
            "unchecked: Old Banner kept"
        );
        assert.ok(!penpot.library.local.colors.some((c) => c.id === ids.pink), "unused color dropped");
        assert.ok(!penpot.library.local.typographies.some((t) => t.name === "Legacy"));
        assert.ok(!penpot.library.local.colors.some((c) => c.color === "#1d87e4"), "merged color not in the library");

        // the card became one component per look, combined as variants
        const created = result.components.created[0];
        assert.equal(created.name, "Product Card");
        assert.equal(created.variants, true);
        assert.equal(created.components.length, 2);
        assert.equal(penpot.containers.length, 1);

        // tokens bound and colors merged on the mains
        const ghost = components.find((c) => c.name === "Button Ghost") as any;
        const ghostRect = ghost.mainNode.children[0];
        assert.equal(ghostRect.fills[0].fillColor, "#1e88e5", "near-duplicate replaced by the kept color");
        assert.equal(ghostRect.tokens.fill, "color.brand-blue");
        assert.equal(ghostRect.tokens.borderRadiusTopLeft, "radius.8");
        assert.equal(ghost.mainNode.children[1].typography, "Body Strong 2", "text bound to its new text style");
        assert.ok(result.components.bound.typography > 0);
        assert.equal(ghost.path, "Button", "grouped");
        const badge = components.find((c) => c.id === ids.badge)!;
        assert.equal(badge.name, "New", "renamed");
        assert.equal((badge as any).mainNode.parent.name, "root", "moved out of its screen");

        // tokens and text styles
        const tokenNames = penpot.library.local.tokens.sets.flatMap((s) => s.tokens.map((t) => t.name));
        for (const name of ["color.brand-blue", "color.white", "spacing.12", "spacing.16", "radius.8"]) {
            assert.ok(tokenNames.includes(name), name);
        }
        assert.ok(tokenNames.some((n) => n.startsWith("font-size.")));
        assert.ok(penpot.library.local.typographies.some((t) => t.name === "Body"));

        // icons
        assert.equal(result.icons.imported, 2);
        assert.ok(components.some((c) => c.path === "Icons"));

        // one undo step per stage, all closed
        assert.equal(penpot.undo.open, 0);
        assert.ok(penpot.undo.opened >= 8);
        assert.ok(penpot.currentFile.versions.length >= 1, "checkpoint saved first");

        // files and marker
        const folder = join(workspace.designDir, "systems", FILE_ID);
        assert.ok(existsSync(join(folder, "DESIGN.md")));
        const map: SourceMap = JSON.parse(readFileSync(join(folder, "source-map.json"), "utf8"));
        assert.deepEqual(map.source, { fileId: SOURCE_ID, projectId: "proj-src", revn: 12 });
        assert.equal(map.components[ids.badge].status, "renamed");
        assert.equal(map.components[ids.badge].componentId, ids.badge, "kept components keep their id");
        assert.equal(map.components[ids.oldBanner].status, "kept");
        for (const id of ids.cards) {
            assert.ok(map.layers[id], `card ${id} mapped`);
            assert.equal(map.layers[id].kind, "component");
        }
        assert.ok(map.layers[ids.search] && map.layers[ids.cart], "icons mapped");
        assert.equal(map.values.colors["#1d87e4"], "color.brand-blue");
        assert.equal(map.colors[ids.pink].colorId, null);
        const log = execFileSync("git", ["log", "--format=%s"], { cwd: workspace.designDir, encoding: "utf8" });
        assert.match(log, /penforge\(design-system\): map the source project/);
        assert.match(log, /penforge\(design-md\): save the design system/);
        assert.equal(result.sourceMap.path, "source-map.json");
        assert.ok(marker().extractedAt);
        assert.equal(marker().publishAsked, true);
        assert.equal(result.publish, true);
        assert.equal(h.questions.length, 1);
    });

    test("a changed file refuses the old list and sends the new one", async () => {
        const listed = await plan();
        penpot.projectPage("Home").root.children[0].appendChild(rect("#e53935"));
        penpot.projectPage("Home").root.children[0].appendChild(rect("#e53935"));
        const h = harness();
        await assert.rejects(workflow.run(h.ctx, { mode: "apply", planId: listed.planId }));
        assert.equal(h.events.find((e) => e.kind === "failed")!.payload.code, "plan-changed");
        assert.ok(h.events.find((e) => e.kind === "plan")!.payload.planId !== listed.planId);
        assert.equal(penpot.undo.opened, 0, "nothing changed");
    });

    test("never runs outside a copy", async () => {
        setMarker(null);
        const h = harness();
        await assert.rejects(workflow.run(h.ctx, { mode: "plan" }));
        assert.equal(h.events.find((e) => e.kind === "failed")!.payload.code, "not-a-copy");

        setMarker({ fileId: FILE_ID, projectId: PROJECT_ID, revn: 1 });
        const same = harness();
        await assert.rejects(workflow.run(same.ctx, { mode: "apply", planId: "x" }));
        assert.equal(same.events.find((e) => e.kind === "failed")!.payload.code, "not-a-copy");
        assert.equal(penpot.undo.opened, 0);
    });

    test("a skipped merge keeps the near colors apart", async () => {
        const listed = await plan();
        const h = harness([EXTRACT_PUBLISH_OPTIONS.later]);
        await workflow.run(h.ctx, { mode: "apply", planId: listed.planId, skip: ["merge:#1e88e5"] });
        const tokenNames = penpot.library.local.tokens.sets.flatMap((s) => s.tokens.map((t) => t.name));
        assert.ok(tokenNames.includes("color.brand-blue-alt"));
        const ghost = penpot.library.local.components.find((c) => c.name === "Button Ghost") as any;
        assert.equal(ghost.mainNode.children[0].fills[0].fillColor, "#1d87e4");
        assert.equal(h.events.find((e) => e.kind === "result")!.payload.publish, false);
    });
});
