import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
    WorkflowClaudeRequest,
    WorkflowContext,
    WorkflowEventKind,
    WorkflowQuestion,
    WorkflowToolResult,
} from "@penpot/mcp-common";
import { PromptRegistry } from "../prompts/promptRegistry";
import { AdaptPluginCode, AdaptResponsive, workflow, type CheckResult } from "./adapt-responsive";

const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Minimal stand-in for a Plugin API shape: absolute geometry, children that move with their
 * parent, constraints applied on resize, and shared plugin data.
 */
class FakeShape {
    private static nextId = 1;
    public children: FakeShape[] = [];
    public parent: FakeShape | null = null;
    public hidden = false;
    public clipContent = true;
    public constraintsHorizontal: string | undefined = "left";
    public constraintsVertical: string | undefined = "top";
    public horizontalSizing: string | undefined;
    public verticalSizing: string | undefined;
    public fontSize: string | undefined;
    public flex: { bottomPadding: number } | null = null;
    public readonly pluginData = new Map<string, string>();
    public resizes = 0;

    constructor(
        public readonly type: string,
        public name: string,
        private _x: number,
        private _y: number,
        public width: number,
        public height: number,
        public readonly id = `shape-${FakeShape.nextId++}`
    ) {}

    get x(): number {
        return this._x;
    }

    set x(value: number) {
        const dx = value - this._x;
        this._x = value;
        this.children.forEach((child) => (child.x = child.x + dx));
    }

    get y(): number {
        return this._y;
    }

    set y(value: number) {
        const dy = value - this._y;
        this._y = value;
        this.children.forEach((child) => (child.y = child.y + dy));
    }

    get bounds() {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }

    add(...children: FakeShape[]): this {
        for (const child of children) {
            child.parent = this;
            this.children.push(child);
        }
        return this;
    }

    getSharedPluginData(namespace: string, key: string): string {
        return this.pluginData.get(`${namespace}:${key}`) ?? "";
    }

    setSharedPluginData(namespace: string, key: string, value: string): void {
        this.pluginData.set(`${namespace}:${key}`, value);
    }

    resize(width: number, height: number): void {
        const dw = width - this.width;
        const dh = height - this.height;
        const sx = width / this.width;
        const sy = height / this.height;
        for (const child of this.children) {
            const rx = child.x - this.x;
            const ry = child.y - this.y;
            switch (child.constraintsHorizontal) {
                case "right":
                    child.x = child.x + dw;
                    break;
                case "center":
                    child.x = child.x + dw / 2;
                    break;
                case "leftright":
                    child.width = child.width + dw;
                    break;
                case "scale":
                    child.x = this.x + rx * sx;
                    child.width = child.width * sx;
                    break;
            }
            switch (child.constraintsVertical) {
                case "bottom":
                    child.y = child.y + dh;
                    break;
                case "scale":
                    child.y = this.y + ry * sy;
                    child.height = child.height * sy;
                    break;
            }
        }
        this.width = width;
        this.height = height;
        this.resizes++;
    }

    clone(): FakeShape {
        const copy = this.copyTree();
        copy.parent = this.parent;
        this.parent?.children.push(copy);
        return copy;
    }

    private copyTree(): FakeShape {
        const copy = new FakeShape(this.type, this.name, this.x, this.y, this.width, this.height);
        copy.hidden = this.hidden;
        copy.clipContent = this.clipContent;
        copy.constraintsHorizontal = this.constraintsHorizontal;
        copy.constraintsVertical = this.constraintsVertical;
        copy.fontSize = this.fontSize;
        copy.horizontalSizing = this.horizontalSizing;
        copy.verticalSizing = this.verticalSizing;
        this.pluginData.forEach((value, key) => copy.pluginData.set(key, value));
        copy.add(...this.children.map((child) => child.copyTree()));
        return copy;
    }

    find(id: string): FakeShape | null {
        if (this.id === id) {
            return this;
        }
        for (const child of this.children) {
            const found = child.find(id);
            if (found) {
                return found;
            }
        }
        return null;
    }
}

/** Fake `penpot` global with one or more pages. */
class FakePenpot {
    public currentPage: { id: string; root: FakeShape; getShapeById(id: string): FakeShape | null };
    public readonly currentFile: { pages: FakePenpot["currentPage"][] };
    public opened: string[] = [];

    constructor(...roots: FakeShape[]) {
        const pages = roots.map((root, index) => ({
            id: `page-${index + 1}`,
            root,
            getShapeById: (id: string) => root.find(id),
        }));
        this.currentFile = { pages };
        this.currentPage = pages[0];
    }

    async openPage(page: FakePenpot["currentPage"]): Promise<void> {
        this.opened.push(page.id);
        this.currentPage = page;
    }
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

async function runCode(penpot: FakePenpot, code: string): Promise<any> {
    return new AsyncFunction("penpot", code)(penpot);
}

function root(): FakeShape {
    return new FakeShape("board", "Root", 0, 0, 0, 0, ROOT_ID);
}

/** Desktop landing page: header, three feature columns, footer. */
function landingPage(): { page: FakeShape; board: FakeShape; columns: FakeShape[] } {
    const board = new FakeShape("board", "Landing", 0, 0, 1440, 1024);
    const header = new FakeShape("board", "Header", 0, 0, 1440, 80);
    header.constraintsHorizontal = "leftright";
    const columns = [0, 1, 2].map((i) => {
        const column = new FakeShape("board", `Feature ${i + 1}`, 120 + i * 420, 200, 360, 400);
        column.constraintsHorizontal = "scale";
        column.add(new FakeShape("text", `Feature ${i + 1} title`, 140 + i * 420, 220, 320, 40));
        return column;
    });
    const footer = new FakeShape("board", "Footer", 0, 904, 1440, 120);
    footer.constraintsVertical = "bottom";
    board.add(header, ...columns, footer);
    const page = root().add(board);
    return { page, board, columns };
}

function prepareParams(boardId: string, extra: object = {}) {
    return {
        boardId,
        target: "mobile",
        sourceTarget: "desktop",
        label: "Mobile",
        width: 390,
        height: 844,
        gap: 100,
        allowExisting: false,
        ...extra,
    };
}

describe("AdaptResponsive.parseParams", () => {
    it("accepts a board and a target and fills the preset width", () => {
        assert.deepEqual(AdaptResponsive.parseParams({ boardId: " b1 ", target: "mobile" }), {
            boardId: "b1",
            target: "mobile",
            width: 390,
        });
        assert.equal(AdaptResponsive.parseParams({ boardId: "b1", target: "desktop" }).width, 1440);
        assert.equal(AdaptResponsive.parseParams({ boardId: "b1", target: "mobile", width: 412 }).width, 412);
    });

    it("rejects missing or invalid params", () => {
        assert.throws(() => AdaptResponsive.parseParams(undefined), /boardId/);
        assert.throws(() => AdaptResponsive.parseParams({ boardId: "", target: "mobile" }), /boardId/);
        assert.throws(() => AdaptResponsive.parseParams({ boardId: "b1", target: "tablet" }), /target/);
        assert.throws(() => AdaptResponsive.parseParams({ boardId: "b1", target: "mobile", width: 12.5 }), /width/);
        assert.throws(() => AdaptResponsive.parseParams({ boardId: "b1", target: "mobile", width: 10 }), /width/);
    });
});

describe("AdaptPluginCode", () => {
    it("embeds params as JSON and refuses unknown functions", () => {
        const code = AdaptPluginCode.build("pfCheck", { boardId: '"); evil(); ("' });
        assert.match(code, /return await pfCheck\(\{"boardId":"\\"\); evil\(\); \(\\""\}\);/);
        assert.throws(() => AdaptPluginCode.build("eval" as any, {}), /Unknown plugin function/);
    });

    it("pfPrepare copies, renames, resizes without constraints and links the boards", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        const result = await runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(board.id)));

        assert.equal(result.status, "created");
        assert.equal(result.variantOf, board.id);
        assert.equal(page.children.length, 2);
        const copy = page.children[1];
        assert.equal(result.board.id, copy.id);
        assert.equal(copy.name, "Landing / Mobile");
        assert.equal(copy.width, 390);
        assert.equal(copy.height, 1024);
        assert.equal(copy.x, 1540, "placed right of the source with the gap");
        assert.equal(copy.y, 0);

        // children kept size and relative position although constraints would scale/stretch them
        const copiedColumn = copy.children[1];
        assert.equal(copiedColumn.width, 360);
        assert.equal(copiedColumn.x - copy.x, 120);
        assert.equal(copy.children[0].width, 1440);
        assert.equal(copy.children[4].y - copy.y, 904);
        // and constraints are restored
        assert.equal(copiedColumn.constraintsHorizontal, "scale");
        assert.equal(copy.children[4].constraintsVertical, "bottom");

        assert.equal(copy.getSharedPluginData("penforge", "variantOf"), board.id);
        assert.equal(copy.getSharedPluginData("penforge", "variantTarget"), "mobile");
        assert.equal(copy.getSharedPluginData("penforge", "variantSource"), board.id);
        assert.equal(board.getSharedPluginData("penforge", "variantTarget"), "desktop");
        // the source is untouched
        assert.equal(board.width, 1440);
        assert.equal(board.resizes, 0);
    });

    it("pfPrepare places the copy where it does not overlap other boards", async () => {
        const { page, board } = landingPage();
        page.add(new FakeShape("board", "Other", 1500, 300, 800, 600));
        const penpot = new FakePenpot(page);
        const result = await runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(board.id)));
        assert.equal(result.board.x, 2400);
    });

    it("pfPrepare reports an existing variant of the group unless allowed", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        await runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(board.id)));
        const mobile = page.children[1];

        const again = await runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(board.id)));
        assert.equal(again.status, "exists");
        assert.deepEqual(again.existing, [{ id: mobile.id, name: "Landing / Mobile" }]);
        assert.equal(page.children.length, 2);

        const forced = await runCode(
            penpot,
            AdaptPluginCode.build("pfPrepare", prepareParams(board.id, { allowExisting: true }))
        );
        assert.equal(forced.status, "created");
        assert.equal(page.children.length, 3);
    });

    it("pfPrepare links a variant of a variant to the first board and strips the old suffix", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        await runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(board.id)));
        const mobile = page.children[1];
        const result = await runCode(
            penpot,
            AdaptPluginCode.build("pfPrepare", {
                ...prepareParams(mobile.id),
                target: "desktop",
                sourceTarget: "mobile",
                label: "Desktop",
                width: 1440,
                height: 1024,
            })
        );
        assert.equal(result.status, "exists", "the source already is the desktop board of the group");
        assert.deepEqual(result.existing, [{ id: board.id, name: "Landing" }]);

        board.setSharedPluginData("penforge", "variantTarget", "");
        const created = await runCode(
            penpot,
            AdaptPluginCode.build("pfPrepare", {
                ...prepareParams(mobile.id),
                target: "desktop",
                sourceTarget: "mobile",
                label: "Desktop",
                width: 1440,
                height: 1024,
            })
        );
        const desktop = page.find(created.board.id)!;
        assert.equal(desktop.name, "Landing / Desktop");
        assert.equal(desktop.getSharedPluginData("penforge", "variantOf"), board.id);
        assert.equal(desktop.getSharedPluginData("penforge", "variantSource"), mobile.id);
    });

    it("pfPrepare opens the board's page and rejects nested boards and other layers", async () => {
        const { page, board, columns } = landingPage();
        const penpot = new FakePenpot(root(), page);
        const result = await runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(board.id)));
        assert.equal(result.pageId, "page-2");
        assert.deepEqual(penpot.opened, ["page-2"]);

        await assert.rejects(
            runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(columns[0].id))),
            /Only top-level boards/
        );
        await assert.rejects(
            runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams(columns[0].children[0].id))),
            /not a board/
        );
        await assert.rejects(
            runCode(penpot, AdaptPluginCode.build("pfPrepare", prepareParams("missing"))),
            /not found/
        );
    });

    it("pfCheck lists the outermost overflowing layers and small text", async () => {
        const board = new FakeShape("board", "Mobile", 1000, 0, 390, 844);
        const row = new FakeShape("board", "Row", 1000, 100, 900, 200);
        row.add(new FakeShape("text", "Inside row", 1500, 120, 300, 20));
        const clipped = new FakeShape("board", "Carousel", 1000, 400, 390, 200);
        clipped.add(new FakeShape("rect", "Slide 3", 1600, 400, 300, 200));
        const hidden = new FakeShape("rect", "Hidden", 900, 700, 50, 50);
        hidden.hidden = true;
        const tiny = new FakeShape("text", "Legal", 1016, 800, 200, 10);
        tiny.fontSize = "9";
        const mixed = new FakeShape("text", "Mixed", 1016, 820, 200, 10);
        mixed.fontSize = "mixed";
        board.add(row, clipped, hidden, tiny, mixed);
        const penpot = new FakePenpot(root().add(board));

        const result: CheckResult = await runCode(
            penpot,
            AdaptPluginCode.build("pfCheck", { boardId: board.id, minFontSize: 12, tolerance: 1, maxIssues: 30 })
        );
        assert.deepEqual(result.issues, [
            { kind: "overflow-x", id: row.id, name: "Row", type: "board", x: 0, width: 900, overBy: 510 },
            { kind: "small-text", id: tiny.id, name: "Legal", type: "text", fontSize: 9 },
        ]);
        assert.equal(result.issueCount, 2);
        assert.equal(result.contentBottom, 830);

        const capped: CheckResult = await runCode(
            penpot,
            AdaptPluginCode.build("pfCheck", { boardId: board.id, minFontSize: 12, tolerance: 1, maxIssues: 1 })
        );
        assert.equal(capped.issues.length, 1);
        assert.equal(capped.issueCount, 2);
    });

    it("pfFitHeight grows and shrinks to the content but not below the preset height", async () => {
        const board = new FakeShape("board", "Mobile", 0, 0, 390, 1024);
        const content = new FakeShape("rect", "Content", 0, 0, 390, 2000);
        content.constraintsVertical = "scale";
        board.add(content);
        const penpot = new FakePenpot(root().add(board));
        const fit = (minHeight: number) =>
            runCode(penpot, AdaptPluginCode.build("pfFitHeight", { boardId: board.id, minHeight, tolerance: 1 }));

        assert.deepEqual(await fit(844), { changed: true, height: 2000 });
        assert.equal(content.height, 2000, "children are pinned while resizing");
        assert.equal(content.constraintsVertical, "scale");

        content.height = 300;
        assert.deepEqual(await fit(844), { changed: true, height: 844 });
        assert.deepEqual(await fit(844), { changed: false, height: 844 });

        board.verticalSizing = "auto";
        content.height = 3000;
        assert.deepEqual(await fit(844), { changed: false, height: 844 });
    });

    it("pfFitHeight keeps the bottom padding of a layout", async () => {
        const board = new FakeShape("board", "Mobile", 0, 0, 390, 844);
        board.flex = { bottomPadding: 24 };
        board.add(new FakeShape("rect", "Content", 0, 0, 390, 1200));
        const penpot = new FakePenpot(root().add(board));
        const result = await runCode(
            penpot,
            AdaptPluginCode.build("pfFitHeight", { boardId: board.id, minHeight: 844, tolerance: 1 })
        );
        assert.deepEqual(result, { changed: true, height: 1224 });
    });
});

/** Workflow context whose `execute_code` runs against a fake Penpot. */
function fakeContext(
    penpot: FakePenpot,
    options: {
        onTurn?: (request: WorkflowClaudeRequest, turn: number) => void;
        answer?: string;
        screenshotError?: boolean;
    } = {}
) {
    const events: { kind: WorkflowEventKind; payload: any }[] = [];
    const turns: WorkflowClaudeRequest[] = [];
    const questions: WorkflowQuestion[] = [];
    const toolCalls: { name: string; args: any }[] = [];
    const reply = (text: string, content: unknown[] = [{ type: "text", text }]): WorkflowToolResult => ({
        isError: false,
        content,
        text,
    });
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: "f",
            fileName: "File",
            projectId: "p",
            teamId: "t",
            pageId: "page-1",
            persona: "designer",
            platform: "web",
        },
        runner: {
            run: async (request) => {
                turns.push(request);
                options.onTurn?.(request, turns.length);
                return { text: "Done.", sessionId: `session-${turns.length}` };
            },
        },
        tools: {
            call: async (name, args = {}) => {
                toolCalls.push({ name, args });
                switch (name) {
                    case "execute_code":
                        try {
                            const result = await runCode(penpot, String(args.code));
                            return reply(JSON.stringify({ result, log: "" }, null, 2));
                        } catch (error) {
                            return { isError: true, content: [], text: (error as Error).message };
                        }
                    case "get_node_properties":
                        return reply(JSON.stringify({ id: args.nodeId, children: [] }));
                    case "capture_node_screenshot":
                        if (options.screenshotError) {
                            return { isError: true, content: [], text: "export failed" };
                        }
                        return reply("{}", [
                            { type: "image", data: `img-${args.nodeId}`, mimeType: "image/jpeg" },
                            { type: "text", text: "{}" },
                        ]);
                    default:
                        throw new Error(`unexpected tool ${name}`);
                }
            },
            list: async () => [],
        },
        workspace: {} as WorkflowContext["workspace"],
        signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async (question) => {
            questions.push(question);
            return options.answer ?? "cancel";
        },
    };
    return { ctx, events, turns, questions, toolCalls };
}

/** Plays Claude: stacks the columns of the mobile copy, leaving `leave` of them too wide. */
function stackColumns(page: FakeShape, leave: number) {
    return (request: WorkflowClaudeRequest) => {
        const id = /new board "[^"]+" \(id ([^)]+)\)/.exec(request.prompt)?.[1] ?? "";
        const target = /board "[^"]+" \(id ([^,]+),/.exec(request.prompt)?.[1] ?? id;
        const board = page.find(id) ?? page.find(target)!;
        let y = board.y + 96;
        board.children.forEach((child, index) => {
            const tooWide = index > 0 && index <= leave;
            child.x = board.x + (tooWide ? 0 : 16);
            child.width = tooWide ? 500 : 358;
            child.y = y;
            y += child.height + 24;
        });
    };
}

describe("adapt-responsive workflow", () => {
    it("adapts the landing page to mobile in one turn when the check passes", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        const { ctx, events, turns } = fakeContext(penpot, { onTurn: stackColumns(page, 0) });

        const result = await workflow.run(ctx, { boardId: board.id, target: "mobile" });

        assert.equal(turns.length, 1);
        const copy = page.children[1];
        assert.match(turns[0].prompt, /Adapt a desktop screen to mobile/);
        assert.match(turns[0].prompt, new RegExp(`new board "Landing / Mobile" \\(id ${copy.id}\\)`));
        assert.deepEqual(
            turns[0].attachments?.map((a) => (a.kind === "image" ? a.base64 : a.kind)),
            [`img-${board.id}`, `img-${copy.id}`]
        );
        // stacked content (header 80 + 3×400 + footer 120 + gaps) is taller than the preset
        assert.equal(copy.height, 96 + 80 + 3 * 400 + 120 + 4 * 24);
        const done = events.find((e) => e.kind === "result")!.payload;
        assert.equal(done.boardId, copy.id);
        assert.equal(done.sourceId, board.id);
        assert.equal(done.variantOf, board.id);
        assert.equal(done.fixPass, false);
        assert.deepEqual(done.issues, []);
        assert.equal(result?.summary, `Made "Landing / Mobile" (390×${copy.height}).`);
        assert.ok(events.some((e) => e.kind === "progress" && typeof e.payload.text === "string"));
    });

    it("runs one fix turn on the same Claude session when layers stick out", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        const { ctx, events, turns } = fakeContext(penpot, {
            onTurn: (request, turn) => stackColumns(page, turn === 1 ? 2 : 1)(request),
        });

        const result = await workflow.run(ctx, { boardId: board.id, target: "mobile" });

        assert.equal(turns.length, 2, "fixes once only");
        assert.equal(turns[1].resumeSessionId, "session-1");
        assert.match(turns[1].prompt, /Fix these 2 problems/);
        assert.match(turns[1].prompt, /"Feature 1" \(board, id [^)]+\) sticks out of the board by 110px/);
        assert.equal(turns[1].attachments?.length, 1);
        const done = events.find((e) => e.kind === "result")!.payload;
        assert.equal(done.fixPass, true);
        assert.equal(done.issues.length, 1);
        assert.match(result?.summary ?? "", /1 layer needs a look\.$/);
    });

    it("asks before making a second variant and stops on cancel", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        const first = fakeContext(penpot, { onTurn: stackColumns(page, 0) });
        await workflow.run(first.ctx, { boardId: board.id, target: "mobile" });

        const second = fakeContext(penpot, { answer: "cancel" });
        const result = await workflow.run(second.ctx, { boardId: board.id, target: "mobile" });
        assert.equal(second.questions.length, 1);
        assert.match(second.questions[0].text, /already has a mobile version \("Landing \/ Mobile"\)/);
        assert.equal(second.turns.length, 0);
        assert.equal(page.children.length, 2);
        assert.equal(result?.summary, 'Kept "Landing / Mobile"');

        const third = fakeContext(penpot, { answer: "create", onTurn: stackColumns(page, 0) });
        await workflow.run(third.ctx, { boardId: board.id, target: "mobile" });
        assert.equal(page.children.length, 3);
    });

    it("works without screenshots and fails with the plugin's message", async () => {
        const { page, board, columns } = landingPage();
        const penpot = new FakePenpot(page);
        const ok = fakeContext(penpot, { screenshotError: true, onTurn: stackColumns(page, 0) });
        await workflow.run(ok.ctx, { boardId: board.id, target: "mobile" });
        assert.deepEqual(ok.turns[0].attachments, []);
        assert.ok(ok.events.some((e) => e.kind === "log"));

        const bad = fakeContext(penpot);
        await assert.rejects(
            workflow.run(bad.ctx, { boardId: columns[0].id, target: "mobile" }) as Promise<unknown>,
            /Only top-level boards/
        );
    });

    it("stops between steps when cancelled", async () => {
        const { page, board } = landingPage();
        const penpot = new FakePenpot(page);
        const run = fakeContext(penpot);
        (run.ctx as any).signal = { aborted: true, addEventListener: () => {}, removeEventListener: () => {} };
        await assert.rejects(
            workflow.run(run.ctx, { boardId: board.id, target: "mobile" }) as Promise<unknown>,
            /cancelled/
        );
        assert.equal(page.children.length, 1);
    });

    it("has a workflow prompt with platform and persona sections", () => {
        const prompts = PromptRegistry.locate();
        const web = prompts.build({
            persona: "designer",
            platform: "web",
            projectName: "P",
            workflow: "adapt-responsive",
        });
        const app = prompts.build({
            persona: "developer",
            platform: "mobile",
            projectName: "P",
            workflow: "adapt-responsive",
        });
        assert.match(web, /## Task: adapt a screen to another screen size/);
        assert.doesNotMatch(web, /safe areas|\{\{/);
        assert.match(web, /plain words/);
        assert.match(app, /safe areas/);
        assert.match(app, /name the layout changes/);
    });

    it("builds a fix prompt that mentions cut issues", () => {
        const prompt = AdaptResponsive.fixPrompt("mobile", {
            board: { id: "b", name: "M", x: 0, y: 0, width: 390, height: 900 },
            issues: [{ kind: "small-text", id: "t", name: "Legal", type: "text", fontSize: 9 }],
            issueCount: 3,
            contentBottom: 900,
        });
        assert.match(prompt, /text "Legal" \(id t\) has font size 9px; use at least 12px/);
        assert.match(prompt, /and 2 more of the same kind/);
    });
});
