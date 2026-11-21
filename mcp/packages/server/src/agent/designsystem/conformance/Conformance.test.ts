import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
    AgentContext,
    ChatToolMessage,
    WorkflowClaudeRequest,
    WorkflowContext,
    WorkflowQuestion,
} from "@penpot/mcp-common";
import { ProjectWorkspace } from "../../workspace/ProjectWorkspace";
import { WorkspaceManager } from "../../workspace/WorkspaceManager";
import { workflow as bindWorkflow } from "../../workflows/design-system-bind";
import { workflow as checkWorkflow } from "../../workflows/design-system-check";
import { timing, workflow as missingWorkflow } from "../../workflows/design-system-missing";
import { workflow as redesignWorkflow } from "../../workflows/design-system-redesign";
import { BindingStore, type DesignSystemBinding } from "./Binding";
import { ConformanceChecker } from "./ConformanceChecker";
import { ConformanceScripts } from "./ConformanceScripts";
import { DesignMdPointer, POINTER_HEADING } from "./DesignMdPointer";
import { DesignSystemTool } from "./DesignSystemTool";
import { MissingItems } from "./MissingItems";
import { DesignSystemTurnCheck } from "./TurnCheck";
import type { RawLayer, SystemCatalog } from "./types";
import {
    boardLayer,
    FakeBoundPenpot,
    FakeLayer,
    FakeLibrary,
    rectLayer,
    textLayer,
    type FakeLibComponent,
} from "./testing/FakeBoundPenpot";

const PROJECT_ID = "5a6b7c8d-1111-4222-8333-944455556666";
const SYSTEMS_PROJECT_ID = "6b7c8d9e-2222-4333-8444-a55566667777";
const FILE_ID = "0f1e2d3c-4b5a-4697-8877-665544332211";
const DS_ID = "aa11bb22-cc33-4d44-8e55-ff6677889900";
const DS2_ID = "bb22cc33-dd44-4e55-8f66-0077889900aa";

let home: string;
let projectWs: ProjectWorkspace;
let systemsWs: ProjectWorkspace;
let project: FakeBoundPenpot;
let systemPenpot: FakeBoundPenpot;
let system: FakeLibrary;
let fixture: {
    card: FakeLayer;
    title: FakeLayer;
    body: FakeLayer;
    row: FakeLayer;
    pink: FakeLayer;
    drawnButton: FakeLayer;
    cardCopy: FakeLayer;
    deleteCopy: FakeLayer;
    deleteComponent: FakeLibComponent;
    screen: FakeLayer;
};

interface Harness {
    ctx: WorkflowContext;
    events: { kind: string; payload: any }[];
    questions: WorkflowQuestion[];
    prompts: WorkflowClaudeRequest[];
}

function context(fileId: string, projectId: string, fileName: string): AgentContext {
    return { fileId, fileName, projectId, teamId: "team-1", pageId: "page-1", persona: "designer", platform: "web" };
}

function harness(
    penpot: FakeBoundPenpot,
    workspace: ProjectWorkspace,
    options: { answers?: string[]; claude?: (request: WorkflowClaudeRequest) => Promise<void>; fileName?: string } = {}
): Harness {
    const events: Harness["events"] = [];
    const questions: WorkflowQuestion[] = [];
    const prompts: WorkflowClaudeRequest[] = [];
    const answers = [...(options.answers ?? [])];
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: context(penpot.fileId, workspace.projectId, options.fileName ?? "Shop"),
        runner: {
            run: async (request) => {
                prompts.push(request);
                await options.claude?.(request);
                return { text: "done" };
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
    return { ctx, events, questions, prompts };
}

/** The design system library "Acme DS" (shared with the system file's own fake). */
function buildSystem(): void {
    systemPenpot = new FakeBoundPenpot(DS_ID, "Acme DS");
    system = systemPenpot.library.local;
    system.addColor("primary", "#1d7fe0");
    system.addColor("surface", "#ffffff");
    system.addColor("text", "#111827");
    system.addTypography("Title", "Inter", "24", "700");
    system.addTypography("Body", "Inter", "16", "400");
    system.addTokens(
        { name: "color.primary", type: "color", value: "#1d7fe0" },
        { name: "radius.md", type: "borderRadius", value: "8" },
        { name: "spacing.md", type: "spacing", value: "16" },
        { name: "shadow.sm", type: "shadow", value: "0 1 2 #0000001a" }
    );
    const button = boardLayer("Button", textLayer("Label", "Button", "16", "400"));
    system.addComponent("Button", button);
    system.addComponent("Card", boardLayer("Card", rectLayer("Background", "#ffffff", 8)));
    systemPenpot.pages[0].add(button);
}

/** The project file: one screen with drift, a hand-drawn button, a local "Card" and "Delete Button". */
function buildProject(): void {
    project = new FakeBoundPenpot(FILE_ID, "Shop");
    project.available.set(DS_ID, system);
    const local = project.library.local;
    const localCard = local.addComponent("Card", boardLayer("Card", rectLayer("Bg", "#fafafa", 4)));
    const deleteComponent = local.addComponent(
        "Delete Button",
        boardLayer("Delete Button", textLayer("Label", "Delete"))
    );
    const card = rectLayer("Hero", "#1e88e5", 7);
    const title = textLayer("Title", "Welcome", "23", "700");
    const body = textLayer("Body", "Hello there", "15", "400", "Roboto");
    const row = boardLayer("Row", rectLayer("Dot", "#1d7fe0"));
    row.flex = { rowGap: 15, columnGap: 15, topPadding: 15, rightPadding: 15, bottomPadding: 15, leftPadding: 15 };
    const pink = rectLayer("Sticker", "#ff00aa");
    const drawnButton = boardLayer("Button", textLayer("Text", "Save"));
    const cardCopy = localCard.instance();
    const deleteCopy = deleteComponent.instance();
    const screen = boardLayer("Home", card, title, body, row, pink, drawnButton, cardCopy, deleteCopy);
    screen.fills = [{ fillColor: "#ffffff", fillOpacity: 1 }];
    const components = boardLayer("Components", localCard.main, deleteComponent.main);
    project.pages[0].add(screen, components);
    fixture = { card, title, body, row, pink, drawnButton, cardCopy, deleteCopy, deleteComponent, screen };
}

function binding(overrides: Partial<DesignSystemBinding> = {}): DesignSystemBinding {
    return {
        fileId: DS_ID,
        name: "Acme DS",
        projectId: SYSTEMS_PROJECT_ID,
        version: "12",
        linkedAt: "2026-11-21T10:00:00.000Z",
        previous: null,
        redesignPending: false,
        linkedFiles: [],
        ...overrides,
    };
}

async function linkSystem(): Promise<void> {
    await project.library.connectLibrary(DS_ID);
    project.library.tokensSource = system;
    await new BindingStore(projectWs).write(binding({ linkedFiles: [FILE_ID] }));
}

async function catalog(): Promise<SystemCatalog> {
    return (await project.execute(ConformanceScripts.catalogScript(DS_ID))) as SystemCatalog;
}

beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "penforge-w30-"));
    projectWs = new ProjectWorkspace(home, PROJECT_ID);
    await projectWs.ensure();
    systemsWs = new ProjectWorkspace(home, SYSTEMS_PROJECT_ID);
    await systemsWs.ensure();
    buildSystem();
    buildProject();
    timing.libraryPollMs = 10;
    timing.taskPollMs = 20;
    timing.libraryWaitMs = 2000;
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

describe("ConformanceChecker", () => {
    test("fixes near values with explanations, reports far ones, lists local components", async () => {
        await linkSystem();
        const scan = (await project.execute(ConformanceScripts.scanScript({ pages: "current" }))) as {
            layers: RawLayer[];
        };
        const report = new ConformanceChecker(await catalog(), { mode: "check", fileId: FILE_ID }).check(scan.layers);

        const color = report.fixes.find((fix) => fix.layerId === fixture.card.id && fix.code === "color");
        assert.ok(color, "near color fixed");
        assert.match(color.text, /#1e88e5; the system has color\.primary #1d7fe0, so I used that/);
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.card.id && fix.code === "radius"));
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.title.id && fix.code === "typography"));
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.body.id && fix.code === "typography"));
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.row.id && fix.code === "spacing"));
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.drawnButton.id && fix.code === "component"));
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.cardCopy.id && fix.code === "swap"));
        // the screen's white fill matches "surface" exactly: linked quietly
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.screen.id && fix.quiet));

        assert.ok(
            report.findings.some((finding) => finding.layerId === fixture.pink.id && finding.code === "off-color")
        );
        assert.deepEqual(
            report.missing.map((item) => item.name),
            ["Delete Button"]
        );
        // nothing inside the hand-drawn button is checked on its own (it is replaced)
        const drawnText = fixture.drawnButton.children[0].id;
        assert.ok(!report.fixes.some((fix) => fix.layerId === drawnText));
        assert.match(ConformanceChecker.summary(report), /I matched the design to the design system/);
    });

    test("redesign mode maps far values too; kept components are left alone", async () => {
        await linkSystem();
        const scan = (await project.execute(ConformanceScripts.scanScript({ pages: "all" }))) as { layers: RawLayer[] };
        const kept = new Set([fixture.deleteComponent.id]);
        const report = new ConformanceChecker(await catalog(), {
            mode: "redesign",
            fileId: FILE_ID,
            keptComponentIds: kept,
        }).check(scan.layers);
        assert.ok(report.fixes.some((fix) => fix.layerId === fixture.pink.id && fix.code === "color"));
        assert.equal(report.missing.length, 0);
        assert.ok(!report.findings.some((finding) => finding.params.name === "Delete Button"));
    });

    test("normalize and missing ids", () => {
        assert.equal(ConformanceChecker.normalize("Buttons / Primary_Button"), "primary button");
        assert.equal(ConformanceChecker.missingId("component", "Delete  Button"), "component:delete-button");
    });
});

describe("design-system-check", () => {
    test("applies the fixes in one undo step and lists what is left", async () => {
        await linkSystem();
        const { ctx, events } = harness(project, projectWs);
        await checkWorkflow.run(ctx, {});
        const result = events.find((event) => event.kind === "result")!.payload;

        assert.equal(fixture.card.tokens.fill, "color.primary", "a color token wins over the library color");
        assert.equal(fixture.card.fills[0].fillColor, "#1d7fe0");
        // the screen's white has only a library color: linked by reference
        assert.equal(fixture.screen.fills[0].fillColorRefFile, DS_ID);
        assert.equal(fixture.card.tokens.borderRadiusTopLeft, "radius.md");
        assert.equal(fixture.title.typographyApplied, system.typographies[0].id);
        assert.equal(fixture.body.fontFamily, "Inter");
        assert.equal(fixture.row.flex!.rowGap, 16);
        assert.equal(fixture.cardCopy.copyOf!.libraryId, DS_ID);
        // the hand-drawn button became an instance of the system's and kept its text
        assert.ok(fixture.drawnButton.removed);
        const instance = fixture.screen.children.find((layer) => layer.copyOf?.name === "Button")!;
        assert.equal(instance.children[0].characters, "Save");
        assert.equal(project.undoBlocks.length, 1);

        assert.ok(result.total >= 6);
        assert.ok(result.remaining.some((item: { code: string }) => item.code === "off-color"));
        assert.deepEqual(
            result.missing.map((item: { name: string }) => item.name),
            ["Delete Button"]
        );
    });

    test("fails plainly without a design system", async () => {
        const { ctx, events } = harness(project, projectWs);
        await assert.rejects(() => checkWorkflow.run(ctx, {}));
        assert.equal(events.find((event) => event.kind === "failed")!.payload.code, "not-linked");
    });
});

describe("design-system-bind", () => {
    test("links, makes the tokens source, records the binding and asks about the existing design", async () => {
        const dsDir = join(systemsWs.designDir, "systems", DS_ID);
        mkdirSync(dsDir, { recursive: true });
        writeFileSync(join(dsDir, "DESIGN.md"), "---\nname: Acme DS\n---\n\n## Colors\n\n- primary: #1d7fe0\n");
        await projectWs.writeJson("project.json", { projectId: PROJECT_ID, fileIds: [FILE_ID], platform: "web" });

        const { ctx, events, questions } = harness(project, projectWs, { answers: ["later"] });
        await bindWorkflow.run(ctx, {
            action: "link",
            fileId: DS_ID,
            name: "Acme DS",
            projectId: SYSTEMS_PROJECT_ID,
            version: 12,
        });
        const result = events.find((event) => event.kind === "result")!.payload;

        assert.ok(project.library.connected.includes(system));
        assert.equal(project.library.tokensSource, system);
        assert.equal(questions.length, 1);
        assert.equal(result.redesign, "pending");
        const info = JSON.parse(readFileSync(join(projectWs.metaDir, "project.json"), "utf8"));
        assert.equal(info.platform, "web", "other keys stay");
        assert.equal(info.designSystem.fileId, DS_ID);
        assert.equal(info.designSystem.redesignPending, true);
        const designMd = readFileSync(join(projectWs.designDir, "DESIGN.md"), "utf8");
        assert.match(designMd, /primary: #1d7fe0/);
        assert.ok(designMd.includes(POINTER_HEADING));

        const status = harness(project, projectWs);
        await bindWorkflow.run(status.ctx, { action: "status" });
        const statusResult = status.events.find((event) => event.kind === "result")!.payload;
        assert.equal(statusResult.binding.name, "Acme DS");
        assert.equal(statusResult.fileLinked, true);
    });

    test("an empty new file links without a question", async () => {
        const empty = new FakeBoundPenpot(FILE_ID, "New");
        empty.available.set(DS_ID, system);
        empty.pages[0].add(boardLayer("Desktop"));
        const { ctx, events, questions } = harness(empty, projectWs);
        await bindWorkflow.run(ctx, { action: "link", fileId: DS_ID, name: "Acme DS", projectId: SYSTEMS_PROJECT_ID });
        assert.equal(questions.length, 0);
        assert.equal(events.find((event) => event.kind === "result")!.payload.redesign, "none");
    });

    test("switching to another system and applying now restyles the file", async () => {
        await linkSystem();
        const other = new FakeLibrary(DS2_ID, "Brand 2");
        other.addColor("accent", "#ff0088");
        other.addTypography("Body", "Inter", "16", "400");
        other.addComponent("Card", boardLayer("Card"));
        project.available.set(DS2_ID, other);
        const { ctx, events, prompts } = harness(project, projectWs, { answers: ["apply"] });
        await bindWorkflow.run(ctx, { action: "link", fileId: DS2_ID, name: "Brand 2", projectId: SYSTEMS_PROJECT_ID });
        const result = events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.redesign, "done");
        assert.equal(result.binding.previous.fileId, DS_ID);
        assert.equal(result.binding.redesignPending, false);
        assert.equal(fixture.pink.fills[0].fillColorRefFile, DS2_ID, "every color maps in redesign mode");
        assert.equal(project.versions.length, 1, "one checkpoint");
        assert.ok(prompts.every((prompt) => prompt.promptName === "design-system-redesign"));
    });

    test("a system made from this file swaps 1:1 with the source map and asks nothing", async () => {
        const localCard = project.library.local.components[0];
        const systemCard = system.components.find((c) => c.name === "Card")!;
        const dsDir = join(systemsWs.designDir, "systems", DS_ID);
        mkdirSync(dsDir, { recursive: true });
        writeFileSync(
            join(dsDir, "source-map.json"),
            JSON.stringify({
                version: 1,
                createdAt: "x",
                source: { fileId: FILE_ID, projectId: PROJECT_ID, revn: 3 },
                designSystem: { fileId: DS_ID, projectId: SYSTEMS_PROJECT_ID, name: "Acme DS" },
                components: { [localCard.id]: { componentId: systemCard.id, name: "Card", path: "", status: "kept" } },
                layers: {},
                colors: {},
                typographies: {},
                values: { colors: {}, spacing: {}, radius: {}, shadows: {} },
                textStyles: [],
                merged: [],
            })
        );
        const { ctx, events, questions } = harness(project, projectWs);
        await bindWorkflow.run(ctx, { action: "link", fileId: DS_ID, name: "Acme DS", projectId: SYSTEMS_PROJECT_ID });
        const result = events.find((event) => event.kind === "result")!.payload;
        assert.equal(questions.length, 0);
        assert.equal(result.redesign, "mapped");
        assert.equal(fixture.cardCopy.copyOf, systemCard);
    });
});

describe("design-system-redesign", () => {
    test("clears the pending re-design and reports what is left", async () => {
        await linkSystem();
        await new BindingStore(projectWs).write(binding({ redesignPending: true, linkedFiles: [FILE_ID] }));
        const { ctx, events } = harness(project, projectWs);
        await redesignWorkflow.run(ctx, { noRestyle: true });
        const result = events.find((event) => event.kind === "result")!.payload;
        assert.equal((await new BindingStore(projectWs).read())!.redesignPending, false);
        assert.ok(result.swapped >= 1);
        assert.equal(result.checkpoint?.n, 1);
    });
});

describe("design-system-missing", () => {
    test("Don't add keeps the project's component out of later checks", async () => {
        await linkSystem();
        await checkWorkflow.run(harness(project, projectWs).ctx, { mode: "check" });
        const items = new MissingItems(projectWs, DS_ID);
        const [item] = await items.open();
        await missingWorkflow.run(harness(project, projectWs).ctx, { action: "keep", ids: [item.id] });
        assert.deepEqual(await items.open(), []);
        assert.ok((await items.keptComponentIds()).has(fixture.deleteComponent.id));
    });

    test("Add to design system: the system tab builds, the project swaps to the new component", async () => {
        await linkSystem();
        await checkWorkflow.run(harness(project, projectWs).ctx, { mode: "check" });
        const [item] = await new MissingItems(projectWs, DS_ID).open();

        const projectRun = harness(project, projectWs);
        const adding = missingWorkflow.run(projectRun.ctx, { action: "add", ids: [item.id] });
        // the client opens the design system file in a new tab when it sees this event
        let open: any;
        for (let i = 0; i < 200 && !open; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            open = projectRun.events.find((event) => event.kind === "open-design-system")?.payload;
        }
        assert.ok(open, "open event sent");
        assert.equal(open.fileId, DS_ID);

        const pendingRun = harness(systemPenpot, systemsWs, { fileName: "Acme DS" });
        await missingWorkflow.run(pendingRun.ctx, { action: "pending" });
        const pending = pendingRun.events.find((event) => event.kind === "result")!.payload;
        assert.equal(pending.taskId, open.taskId, "the system tab finds the task by itself");
        assert.equal(pending.count, 1);

        const systemRun = harness(systemPenpot, systemsWs, {
            fileName: "Acme DS",
            claude: async (request) => {
                assert.match(request.prompt, /Delete Button/);
                assert.match(request.prompt, /item id `component:delete-button`/);
                const main = boardLayer("Delete Button", textLayer("Label", "Delete"));
                systemPenpot.pages[0].add(main);
                system.createComponent([main]);
                main.setSharedPluginData("penforge", "designSystemItem", item.id);
            },
        });
        await missingWorkflow.run(systemRun.ctx, { action: "build", taskId: open.taskId });
        await adding;

        const result = projectRun.events.find((event) => event.kind === "result")!.payload;
        assert.equal(result.created.length, 1);
        assert.equal(fixture.deleteCopy.copyOf!.libraryId, DS_ID);
        const [stored] = await new MissingItems(projectWs, DS_ID).all();
        assert.equal(stored.status, "added");
        assert.equal(systemPenpot.versions.length, 1, "checkpoint in the system file");
    });
});

describe("hooks and tool", () => {
    test("a chat turn gets the fix summary and the missing items as step lines", async () => {
        await linkSystem();
        const sent: ChatToolMessage[] = [];
        await DesignSystemTurnCheck.afterChatTurn((message) => sent.push(message), "conv-1", {
            tools: project.tools(),
            workspace: projectWs,
            context: context(FILE_ID, PROJECT_ID, "Shop"),
        });
        assert.deepEqual(
            sent.map((message) => message.code),
            ["design-system-fixed", "design-system-missing"]
        );
        assert.match(sent[0].summary, /color\.primary/);
        assert.equal((sent[1].params!.items as { name: string }[])[0].name, "Delete Button");
    });

    test("no design system: the hooks do nothing", async () => {
        const sent: ChatToolMessage[] = [];
        await DesignSystemTurnCheck.afterChatTurn((message) => sent.push(message), "conv-1", {
            tools: project.tools(),
            workspace: projectWs,
            context: context(FILE_ID, PROJECT_ID, "Shop"),
        });
        assert.equal(sent.length, 0);
        const { ctx, events } = harness(project, projectWs);
        await DesignSystemTurnCheck.afterWorkflow(ctx, "generate-screen");
        assert.equal(events.length, 0);
    });

    test("the workflow hook reports as log events of design workflows only", async () => {
        await linkSystem();
        const { ctx, events } = harness(project, projectWs);
        await DesignSystemTurnCheck.afterWorkflow(ctx, "auto-name");
        assert.equal(events.length, 0);
        await DesignSystemTurnCheck.afterWorkflow(ctx, "generate-screen");
        assert.deepEqual(
            events.map((event) => event.payload.code),
            ["design-system-fixed", "design-system-missing"]
        );
    });

    test("penforge_design_system: inventory and missing", async () => {
        await linkSystem();
        const tools = project.tools();
        const inventory = await DesignSystemTool.handle({ fileId: FILE_ID, action: "inventory" }, tools, projectWs);
        assert.match(inventory, /Design system "Acme DS"/);
        assert.match(inventory, /primary #1d7fe0/);
        assert.match(inventory, /Components \(2\): Button/);
        const answer = JSON.parse(
            await DesignSystemTool.handle(
                {
                    fileId: FILE_ID,
                    action: "missing",
                    items: [{ name: "Date picker", reason: "The form asks for a date." }],
                },
                tools,
                projectWs
            )
        );
        assert.deepEqual(answer.recorded, ["Date picker"]);
        const none = JSON.parse(
            await DesignSystemTool.handle({ fileId: FILE_ID, action: "inventory" }, tools, undefined)
        );
        assert.equal(none.linked, false);
    });

    test("context.set keeps the binding in project.json", async () => {
        await new BindingStore(projectWs).write(binding());
        await new WorkspaceManager(home).open(context(FILE_ID, PROJECT_ID, "Shop"));
        assert.equal((await new BindingStore(projectWs).read())?.fileId, DS_ID);
    });

    test("DESIGN.md section is replaced, not added twice", () => {
        const once = DesignMdPointer.withSection("---\nname: X\n---\n\n## Colors\n\n- a: #fff\n", binding());
        const twice = DesignMdPointer.withSection(
            `${once}\n## Do's and Don'ts\n\n- keep\n`,
            binding({ name: "Other" })
        );
        assert.equal(twice.split(POINTER_HEADING).length, 2);
        assert.match(twice, /"Other"/);
        assert.match(twice, /## Do's and Don'ts/);
    });
});
