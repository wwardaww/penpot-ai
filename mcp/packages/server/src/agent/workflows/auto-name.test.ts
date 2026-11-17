import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorkflowClaudeRequest, WorkflowContext, WorkflowEventKind, WorkflowToolResult } from "@penpot/mcp-common";
import {
    autoName,
    AutoNamer,
    DefaultNames,
    describeResult,
    NameFormatter,
    workflow,
    type LayerRecord,
} from "./auto-name";
import { WorkflowRegistry } from "./WorkflowRegistry";

function layer(id: string, name: string, extra: Partial<LayerRecord> = {}): LayerRecord {
    return {
        id,
        pageId: "page-1",
        pageName: "Page 1",
        name,
        type: "rect",
        parentId: null,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        visible: true,
        component: null,
        variant: false,
        layout: null,
        children: [],
        ...extra,
    };
}

/** Fake workflow context: `execute_code` returns the given layers, Claude answers with `answer`. */
function fakeContext(layers: LayerRecord[], answer: (request: WorkflowClaudeRequest) => string) {
    const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
    const prompts: WorkflowClaudeRequest[] = [];
    const events: { kind: WorkflowEventKind; payload: any }[] = [];
    const text = (value: unknown): WorkflowToolResult => {
        const json = JSON.stringify({ result: value, log: "" });
        return { isError: false, content: [{ type: "text", text: json }], text: json };
    };
    const ctx: WorkflowContext = {
        runId: "run-1",
        context: {
            fileId: "file-1",
            fileName: "File",
            projectId: "project-1",
            teamId: "team-1",
            pageId: "page-1",
            persona: "designer",
            platform: "web",
        },
        runner: {
            run: async (request) => {
                prompts.push(request);
                return { text: answer(request) };
            },
        },
        tools: {
            call: async (name, args = {}) => {
                toolCalls.push({ name, args });
                if (name === "capture_node_screenshot") {
                    return {
                        isError: false,
                        content: [{ type: "image", data: "aW1n", mimeType: "image/jpeg" }],
                        text: "",
                    };
                }
                const code = String(args.code);
                if (code.includes("undoBlockBegin")) {
                    const groups = JSON.parse(/const G = (.*);/.exec(code)![1]);
                    const applied = groups.reduce((sum: number, group: any) => sum + group.items.length, 0);
                    return text({ applied, skipped: [] });
                }
                return text({ layers });
            },
            list: async () => ["execute_code", "capture_node_screenshot"],
        },
        workspace: {} as WorkflowContext["workspace"],
        signal: new AbortController().signal,
        emit: (kind, payload) => events.push({ kind, payload }),
        ask: async () => "none",
    };
    return { ctx, toolCalls, prompts, events };
}

/** Claude stand-in: names every layer of the prompt `<type> <n>`-free, from its id. */
function namesFromPrompt(names: Record<string, string>) {
    return (request: WorkflowClaudeRequest) => {
        const ids = request.prompt
            .split("\n")
            .filter((line) => line.startsWith("{"))
            .map((line) => JSON.parse(line).id as string);
        const answer: Record<string, string> = {};
        for (const id of ids) {
            answer[id] = names[id] ?? `Layer ${id}`;
        }
        return "Here you go:\n```json\n" + JSON.stringify(answer) + "\n```";
    };
}

describe("DefaultNames", () => {
    test("detects Penpot, Figma and Sketch default names", () => {
        for (const name of [
            "Board",
            "Board 4",
            "Rectangle 12",
            "Frame 5",
            "Frame 1171275887",
            "Group 7",
            "Ellipse",
            "Vector 3",
            "Path",
            "Mask",
            "Union",
            "Subtract 2",
            "Image 3",
            "Text",
            "Artboard – 1",
            "Rectangle-2",
            "Rectangle copy",
            "Rectangle copy 3",
            "Combined Shape",
            "rectangle 9",
            "  Group 1  ",
            "",
        ]) {
            assert.equal(DefaultNames.isDefault(name), true, name);
        }
    });

    test("detects localized default names", () => {
        for (const name of [
            "Tablero 3",
            "Rectángulo 2",
            "Zeichenfläche 1",
            "Gruppe 4",
            "Прямоугольник 5",
            "長方形 2",
            "그룹 1",
            "Grupo",
        ]) {
            assert.equal(DefaultNames.isDefault(name), true, name);
        }
    });

    test("leaves meaningful names alone", () => {
        for (const name of [
            "Header",
            "Primary Button",
            "Avatar",
            "Board games",
            "Group chat",
            "Rectangle background",
            "Frame 5 hero",
            "Image gallery",
            "Text field",
            "Step 2",
            "Container",
        ]) {
            assert.equal(DefaultNames.isDefault(name), false, name);
        }
    });

    test("treats missing names as default", () => {
        assert.equal(DefaultNames.isDefault(undefined), true);
        assert.equal(DefaultNames.isDefault(null), true);
    });
});

describe("NameFormatter", () => {
    test("formats Title Case and keeps acronyms", () => {
        assert.equal(NameFormatter.format("primary button", "title"), "Primary Button");
        assert.equal(NameFormatter.format("primaryButton", "title"), "Primary Button");
        assert.equal(NameFormatter.format("CTA banner", "title"), "CTA Banner");
        assert.equal(NameFormatter.format("hero_image-left", "title"), "Hero Image Left");
    });

    test("formats kebab-case", () => {
        assert.equal(NameFormatter.format("Primary Button", "kebab"), "primary-button");
        assert.equal(NameFormatter.format("navBar item", "kebab"), "nav-bar-item");
    });

    test("formats BEM", () => {
        assert.equal(NameFormatter.format("Card__Title", "bem"), "card__title");
        assert.equal(
            NameFormatter.format("product card__price tag--on sale", "bem"),
            "product-card__price-tag--on-sale"
        );
        assert.equal(NameFormatter.format("Button--Primary", "bem"), "button--primary");
        assert.equal(NameFormatter.format("Search Field", "bem"), "search-field");
    });

    test("cleans proposals", () => {
        assert.equal(NameFormatter.clean('  "Header"  '), "Header");
        assert.equal(NameFormatter.clean("Nav\nBar"), "Nav Bar");
        assert.equal(NameFormatter.clean("   "), null);
        assert.equal(NameFormatter.clean(42), null);
        assert.equal(NameFormatter.clean("x".repeat(100))!.length, 64);
    });
});

describe("AutoNamer", () => {
    test("parses JSON objects, fenced answers and arrays", () => {
        assert.deepEqual([...AutoNamer.parseAnswer('{"a": "Header", "b": 3}')], [["a", "Header"]]);
        assert.deepEqual([...AutoNamer.parseAnswer('Sure:\n```json\n{"a": "Header"}\n```')], [["a", "Header"]]);
        assert.deepEqual([...AutoNamer.parseAnswer('[{"id": "a", "name": "Header"}]')], [["a", "Header"]]);
        assert.deepEqual([...AutoNamer.parseAnswer('{"names": {"a": "Header"}}')], [["a", "Header"]]);
        assert.equal(AutoNamer.parseAnswer("no json here").size, 0);
        assert.equal(AutoNamer.parseAnswer("{broken").size, 0);
    });

    test("selects default-named layers and skips components, variants and named text", () => {
        const layers = [
            layer("1", "Rectangle 1"),
            layer("2", "Header"),
            layer("3", "Board 2", { component: "main" }),
            layer("4", "Group 3", { component: "copy" }),
            layer("5", "Rectangle 4", { component: "main-child" }),
            layer("6", "Board", { variant: true }),
            layer("7", "Text", { type: "text", text: "Text" }),
            layer("8", "Text 2", { type: "text", text: "Sign in" }),
        ];
        const plain = AutoNamer.selectCandidates(layers, { includeComponents: false });
        assert.deepEqual(
            plain.candidates.map((l) => l.id),
            ["1", "5", "8"]
        );
        assert.equal(plain.skippedComponents, 2);
        const all = AutoNamer.selectCandidates(layers, { includeComponents: true });
        assert.deepEqual(
            all.candidates.map((l) => l.id),
            ["1", "3", "4", "5", "8"]
        );
    });

    test("read script is valid JavaScript", () => {
        const body = AutoNamer.readScript({ scope: "page", pageId: "p", limit: 10 });
        assert.doesNotThrow(() => new Function(`return (async () => { ${body} })`));
        const apply = AutoNamer.applyScript([{ pageId: "p", items: [["a", "Board 1", "Header"]] }]);
        assert.doesNotThrow(() => new Function(`return (async () => { ${apply} })`));
    });

    test("names 30 default layers of a page, top-down, without touching named ones", async () => {
        const layers: LayerRecord[] = [
            layer("board", "Board 1", {
                type: "frame",
                width: 1440,
                height: 1024,
                children: Array.from({ length: 29 }, (_, i) => `c${i}`).concat(["named"]),
            }),
            ...Array.from({ length: 29 }, (_, i) =>
                layer(`c${i}`, i % 2 === 0 ? `Rectangle ${i}` : `Text ${i}`, {
                    parentId: "board",
                    type: i % 2 === 0 ? "rect" : "text",
                    text: i % 2 === 0 ? undefined : `Label ${i}`,
                    x: 10,
                    y: i * 30,
                })
            ),
            layer("named", "Logo", { parentId: "board" }),
        ];
        const names: Record<string, string> = { board: "home screen", named: "Should Not Apply" };
        const { ctx, prompts, events, toolCalls } = fakeContext(layers, namesFromPrompt(names));

        const result = await autoName(ctx, { scope: "page", batchSize: 20 });

        assert.equal(result.scanned, 31);
        assert.equal(result.candidates, 30);
        assert.equal(result.renames.length, 30);
        assert.equal(result.applied, false);
        assert.equal(
            result.renames.find((r) => r.nodeId === "named"),
            undefined
        );
        assert.deepEqual(result.renames[0], {
            nodeId: "board",
            pageId: "page-1",
            type: "frame",
            oldName: "Board 1",
            newName: "Home Screen",
        });
        // two batches, parents first: the second batch sees the board's new name
        assert.equal(prompts.length, 2);
        assert.equal(prompts[0].promptName, "auto-name");
        assert.match(prompts[1].prompt, /"board":"Home Screen"/);
        assert.equal(prompts[0].attachments?.length, 1);
        // one screenshot for the board, cached across batches
        assert.equal(toolCalls.filter((call) => call.name === "capture_node_screenshot").length, 1);
        assert.ok(events.some((e) => e.kind === "progress" && e.payload.stage === "name" && e.payload.done === 30));
        assert.equal(describeResult(result), "Suggested names for 30 of 30 default-named layers");
    });

    test("applies the names with one undo block per page", async () => {
        const layers = [layer("a", "Rectangle 1", { pageId: "p1" }), layer("b", "Rectangle 2", { pageId: "p2" })];
        const { ctx, toolCalls } = fakeContext(layers, namesFromPrompt({ a: "card", b: "badge" }));
        const result = await autoName(ctx, { scope: "file", apply: true, screenshots: false });
        assert.equal(result.appliedCount, 2);
        const applyCall = toolCalls.find((call) => String(call.args.code).includes("undoBlockBegin"));
        assert.ok(applyCall);
        const groups = JSON.parse(/const G = (.*);/.exec(String(applyCall!.args.code))![1]);
        assert.deepEqual(groups, [
            { pageId: "p1", items: [["a", "Rectangle 1", "Card"]] },
            { pageId: "p2", items: [["b", "Rectangle 2", "Badge"]] },
        ]);
    });

    test("drops answers that are missing, default names or unchanged", async () => {
        const layers = [layer("a", "Rectangle 1"), layer("b", "Rectangle 2"), layer("c", "Group 1")];
        const { ctx } = fakeContext(layers, () => JSON.stringify({ a: "Rectangle 7", b: "  ", x: "Header" }));
        const result = await autoName(ctx, { screenshots: false });
        assert.equal(result.renames.length, 0);
        assert.equal(describeResult(result), "Suggested names for 0 of 3 default-named layers");
    });

    test("selection scope needs node ids and maxNodes limits the run", async () => {
        const { ctx } = fakeContext([], () => "{}");
        await assert.rejects(autoName(ctx, { scope: "selection" }), /nodeIds/);
        await assert.rejects(autoName(ctx, { scope: "nope" as any }), /Unknown scope/);

        const layers = [layer("a", "Rectangle 1"), layer("b", "Rectangle 2"), layer("c", "Rectangle 3")];
        const second = fakeContext(layers, namesFromPrompt({}));
        const result = await autoName(second.ctx, { nodeIds: ["a"], maxNodes: 2, screenshots: false });
        assert.equal(result.scope, "selection");
        assert.equal(result.renames.length, 2);
        assert.equal(result.remaining, 1);
    });

    test("uses the convention for every name", async () => {
        const { ctx } = fakeContext([layer("a", "Rectangle 1")], namesFromPrompt({ a: "Primary Button" }));
        const result = await autoName(ctx, { convention: "kebab", screenshots: false });
        assert.equal(result.renames[0].newName, "primary-button");
    });
});

describe("auto-name workflow", () => {
    test("is shipped and reports its result", async () => {
        assert.ok(WorkflowRegistry.withShippedWorkflows().get("auto-name"));
        const { ctx, events } = fakeContext([], () => "{}");
        const done = await workflow.run(ctx, {});
        assert.equal(done?.summary, "No layers with default names found");
        const result = events.find((e) => e.kind === "result");
        assert.equal(result?.payload.candidates, 0);
    });
});
