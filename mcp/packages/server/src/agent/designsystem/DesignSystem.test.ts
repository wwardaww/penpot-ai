import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PenpotImportPlanner, PenpotScripts, parseDesignMd } from "../designmd";
import { ACME_DESIGN_MD } from "../designmd/testing/fixtures";
import { IconScripts, type IconChunkReport, type IconTokenReport } from "../icons";
import { strokeIcon } from "../icons/testing/archives";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import {
    DESIGN_SYSTEM_KEY,
    DesignSystemScripts,
    PLUGIN_NAMESPACE,
    designSystemDesignMd,
    designSystemWorkspace,
    type DesignSystemMarker,
    type DesignSystemSummary,
    type OverviewReport,
} from ".";
import { FakeDesignSystemPenpot, type FakeNode } from "./testing/FakeDesignSystemPenpot";

const FILE_ID = "8d3c1f20-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

let projectsDir: string;
let workspace: ProjectWorkspace;

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-ds-"));
    workspace = new ProjectWorkspace(projectsDir, "5b0d7a2e-3c4f-4e8a-9a51-2f1e0c9d8b70");
    await workspace.ensure();
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

async function imported(penpot: FakeDesignSystemPenpot): Promise<void> {
    const plan = DesignSystemScripts.extendPlan(PenpotImportPlanner.plan(parseDesignMd(ACME_DESIGN_MD).document));
    await penpot.execute(DesignSystemScripts.undoable(PenpotScripts.importScript(plan)));
}

describe("design system workspace", () => {
    test("puts each design system's DESIGN.md in its own folder of the design repo", async () => {
        const view = designSystemWorkspace(workspace, FILE_ID.toUpperCase());
        assert.equal(view.designDir, join(workspace.designDir, "systems", FILE_ID));
        assert.equal(view.projectId, workspace.projectId);
        assert.throws(() => designSystemWorkspace(workspace, "../../etc"));

        const repository = designSystemDesignMd(workspace, FILE_ID);
        await repository.write("---\nname: X\n---\n");
        const commit = await repository.commit("save");
        assert.match(commit ?? "", /^[0-9a-f]{40}$/);
        assert.equal(await repository.read(), "---\nname: X\n---\n");
        assert.equal(await designSystemDesignMd(workspace, "11111111-2222-3333-4444-555555555555").read(), null);
    });
});

describe("DesignSystemScripts", () => {
    test("typography tokens from the text styles, without duplicates", () => {
        const plan = PenpotImportPlanner.plan(parseDesignMd(ACME_DESIGN_MD).document);
        const extended = DesignSystemScripts.extendPlan(plan);
        const extra = extended.tokens.slice(plan.tokens.length);
        assert.ok(extra.length > 0);
        assert.ok(extra.every((t) => /^font-(size|weight|family)\./.test(t.name)));
        assert.equal(new Set(extended.tokens.map((t) => t.name)).size, extended.tokens.length);
        const first = plan.typographies[0];
        assert.ok(extra.some((t) => (t.type as string) === "fontSizes" && t.value === first.fontSize));
    });

    test("the import is one undo step and creates the typography tokens", async () => {
        const penpot = new FakeDesignSystemPenpot();
        await imported(penpot);
        assert.deepEqual(penpot.undo, { opened: 1, closed: 1, open: 0 });
        const set = penpot.library.local.tokens.sets.find((s) => s.name === "DESIGN.md");
        assert.ok(set?.tokens.some((t) => t.type === "fontSizes"));
        assert.ok(set?.tokens.some((t) => t.type === "fontFamilies"));
    });

    test("the marker merges into the file's shared plugin data", async () => {
        const penpot = new FakeDesignSystemPenpot();
        const first = (await penpot.execute(
            DesignSystemScripts.markerScript({ name: "Acme" }, "2026-11-19T10:00:00Z")
        )) as DesignSystemMarker;
        assert.deepEqual(first, { version: 1, name: "Acme", createdAt: "2026-11-19T10:00:00Z" });
        await penpot.execute(DesignSystemScripts.markerScript({ publishAsked: true }, "2026-11-20T00:00:00Z"));
        const stored = JSON.parse(penpot.fileDataOf(PLUGIN_NAMESPACE, DESIGN_SYSTEM_KEY));
        assert.deepEqual(stored, { version: 1, name: "Acme", createdAt: "2026-11-19T10:00:00Z", publishAsked: true });
        assert.deepEqual(await penpot.execute(DesignSystemScripts.readMarkerScript()), stored);
    });

    test("overview pages show every color, text style and token, and replace their old board", async () => {
        const penpot = new FakeDesignSystemPenpot();
        await imported(penpot);
        const colors = (await penpot.execute(DesignSystemScripts.overviewScript("colors"))) as OverviewReport;
        assert.equal(colors.items, penpot.library.local.colors.length);
        const page = penpot.page("Colors")!;
        const board = page.root.children[0];
        const swatches = board.children.filter((c: FakeNode) => c.type === "rectangle");
        assert.equal(swatches.length, colors.items);
        assert.ok(swatches.every((s: FakeNode) => s.fills[0]?.fillColor?.startsWith("#")));

        await penpot.execute(DesignSystemScripts.overviewScript("colors"));
        assert.equal(page.root.children.length, 1, "the old board is replaced");

        const typography = (await penpot.execute(DesignSystemScripts.overviewScript("typography"))) as OverviewReport;
        assert.equal(typography.items, penpot.library.local.typographies.length);
        const samples = penpot.page("Typography")!.root.children[0].children.filter((c: FakeNode) => c.typography);
        assert.equal(samples.length, typography.items);

        const tokens = (await penpot.execute(DesignSystemScripts.overviewScript("tokens"))) as OverviewReport;
        const count = penpot.library.local.tokens.sets.reduce((n, s) => n + s.tokens.length, 0);
        assert.equal(tokens.items, count);
        const bound = penpot.page("Tokens")!.root.children[0].children.filter((c: FakeNode) => c.tokens.fill);
        assert.ok(bound.length > 0, "color swatches are bound to their token");
        assert.equal(penpot.undo.open, 0);
        assert.equal(penpot.undo.opened, 5);
    });

    test("summary counts the library", async () => {
        const penpot = new FakeDesignSystemPenpot();
        await imported(penpot);
        const summary = (await penpot.execute(DesignSystemScripts.summaryScript())) as DesignSystemSummary;
        assert.equal(summary.colors, penpot.library.local.colors.length);
        assert.equal(summary.components, 0);
        assert.ok(summary.tokens > 0);
    });
});

describe("IconScripts", () => {
    test("the icon token refers to the system's text color and is created once", async () => {
        const penpot = new FakeDesignSystemPenpot();
        await imported(penpot);
        const first = (await penpot.execute(IconScripts.ensureTokenScript())) as IconTokenReport;
        assert.equal(first.created, true);
        assert.match(first.value, /^\{color\..+\}$|^#/);
        const second = (await penpot.execute(IconScripts.ensureTokenScript())) as IconTokenReport;
        assert.equal(second.created, false);
    });

    test("icons become 24px components under Icons, token bound, one undo step per chunk, no duplicates", async () => {
        const penpot = new FakeDesignSystemPenpot();
        await penpot.execute(IconScripts.ensureTokenScript());
        const icons = [
            { id: "arrow", name: "arrow", path: "Icons", svg: strokeIcon().replace("currentColor", "#000000") },
            {
                id: "solid/star",
                name: "star",
                path: "Icons / solid",
                svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M1 1" fill="#000000"/></svg>',
            },
            { id: "broken", name: "broken", path: "Icons", svg: "<svg><path d='unreadable'/></svg>" },
        ];
        const report = (await penpot.execute(IconScripts.importChunkScript(icons))) as IconChunkReport;
        assert.deepEqual(
            report.imported.map((i) => i.id),
            ["arrow", "solid/star"]
        );
        assert.deepEqual(
            report.skipped.map((s) => [s.name, s.reason]),
            [["broken", "unreadable"]]
        );
        assert.equal(report.tokenBound, true);
        assert.deepEqual(penpot.undo, { opened: 1, closed: 1, open: 0 });

        const components = penpot.library.local.components;
        assert.deepEqual(
            components.map((c) => [c.name, c.path, c.getSharedPluginData("penforge", "icon")]),
            [
                ["arrow", "Icons", "arrow"],
                ["star", "Icons / solid", "solid/star"],
            ]
        );
        const boards = penpot.page("Icons")!.root.children;
        assert.ok(boards.every((b: FakeNode) => b.width === 24 && b.height === 24));
        const star = boards[1].children[0];
        assert.equal(star.width, 24, "a 48px icon is scaled to 24px");
        assert.equal(boards[0].children[0].children[0].tokens.strokeColor, "color.icon");
        assert.equal(star.children[0].tokens.fill, "color.icon");

        const again = (await penpot.execute(IconScripts.importChunkScript(icons.slice(0, 1)))) as IconChunkReport;
        assert.deepEqual(
            again.skipped.map((s) => s.reason),
            ["exists"]
        );
    });
});
