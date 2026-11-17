import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { AiReview } from "./AiReview";
import { AuditComments } from "./AuditComments";
import { AuditConfig } from "./AuditConfig";
import type { AuditFinding } from "./AuditFinding";
import { AuditReport } from "./AuditReport";
import {
    ColorDuplicateCheck,
    ContrastCheck,
    DefaultNameCheck,
    DetachedInstanceCheck,
    SpacingCheck,
    TextOverflowCheck,
    TouchTargetCheck,
    TypeScaleCheck,
} from "./checks";
import { DesignAuditor } from "./DesignAuditor";
import { DesignTree } from "./DesignTree";
import { ReportCommitter } from "./ReportCommitter";
import { Rgb } from "./Rgb";
import { fill, loginBoard, node, text } from "./testing/fixtures";
import { DesignReader, TreeLoader } from "./TreeLoader";

const WEB = new AuditConfig("web");
const MOBILE = new AuditConfig("mobile");

function board(children: ReturnType<typeof node>[], extra: Partial<Parameters<typeof node>[0]> = {}) {
    return node({
        id: "board",
        name: "Screen",
        type: "board",
        width: 400,
        height: 800,
        fills: fill("#FFFFFF"),
        children,
        ...extra,
    });
}

describe("Rgb", () => {
    test("computes WCAG contrast ratios", () => {
        assert.equal(Math.round(Rgb.WHITE.contrast(new Rgb(0, 0, 0)) * 10) / 10, 21);
        assert.equal(Math.round(Rgb.parse("#777777")!.contrast(Rgb.WHITE) * 100) / 100, 4.48);
        assert.equal(Rgb.parse("#abc")!.hex(), "#AABBCC");
        assert.equal(Rgb.parse("nope"), null);
    });

    test("blends with opacity and measures distance", () => {
        assert.equal(new Rgb(0, 0, 0).over(Rgb.WHITE, 0.5).hex(), "#808080");
        assert.ok(Rgb.parse("#333333")!.distance(Rgb.parse("#343434")!) < 1);
        assert.ok(Rgb.parse("#FF0000")!.distance(Rgb.parse("#0000FF")!) > 50);
    });
});

describe("ContrastCheck", () => {
    test("flags light gray text on white as an error and suggests a darker color", () => {
        const tree = new DesignTree([board([text({ id: "t", content: "Hint", color: "#BBBBBB", fontSize: 14 })])]);
        const [finding] = new ContrastCheck().run(tree);
        assert.equal(finding.nodeId, "t");
        assert.equal(finding.severity, "error");
        assert.equal(finding.data?.required, 4.5);
        assert.equal(finding.data?.background, "#FFFFFF");
        const suggested = Rgb.parse(finding.data?.suggestedColor as string)!;
        assert.ok(suggested.contrast(Rgb.WHITE) >= 4.5);
    });

    test("uses the 3:1 threshold for large text", () => {
        // #949494 on white is about 3.03:1
        const tree = new DesignTree([board([text({ id: "t", content: "Big", color: "#949494", fontSize: 24 })])]);
        assert.deepEqual(new ContrastCheck().run(tree), []);
        const small = new DesignTree([board([text({ id: "t", content: "Small", color: "#949494", fontSize: 14 })])]);
        assert.equal(new ContrastCheck().run(small)[0].severity, "warning");
    });

    test("takes the background from a shape painted below the text", () => {
        const button = node({
            id: "btn",
            name: "Button",
            type: "group",
            x: 10,
            y: 10,
            width: 120,
            height: 48,
            children: [
                node({ id: "bg", name: "Background", x: 10, y: 10, width: 120, height: 48, fills: fill("#1E40AF") }),
                text({ id: "label", content: "Buy", x: 40, y: 24, width: 60, height: 20, color: "#FFFFFF" }),
            ],
        });
        const tree = new DesignTree([board([button])]);
        assert.equal(ContrastCheck.background(tree, tree.get("label")!)!.hex(), "#1E40AF");
        assert.deepEqual(new ContrastCheck().run(tree), []);
    });

    test("composites translucent fills and skips unknown (gradient) backgrounds", () => {
        const overlay = node({ id: "veil", x: 0, y: 0, width: 400, height: 800, fills: fill("#000000", 0.5) });
        const tree = new DesignTree([board([overlay, text({ id: "t", content: "Hi", color: "#FFFFFF" })])]);
        assert.equal(ContrastCheck.background(tree, tree.get("t")!)!.hex(), "#808080");

        const gradient = node({
            id: "g",
            width: 400,
            height: 800,
            fills: [{ color: null, opacity: 1, gradient: { type: "linear" }, image: null, colorRef: null }],
        });
        const unknown = new DesignTree([board([gradient, text({ id: "t", content: "Hi", color: "#EEEEEE" })])]);
        assert.deepEqual(new ContrastCheck().run(unknown), []);
    });

    test("ignores hidden texts", () => {
        const tree = new DesignTree([board([text({ id: "t", content: "Hint", color: "#EEEEEE", visible: false })])]);
        assert.deepEqual(new ContrastCheck().run(tree), []);
    });
});

describe("TouchTargetCheck", () => {
    test("flags a 20px button on web and a 40px one only on mobile", () => {
        const tree = new DesignTree([
            board([
                node({ id: "small", name: "Icon button", x: 0, y: 0, width: 20, height: 20 }),
                node({ id: "medium", name: "Primary button", x: 0, y: 40, width: 120, height: 40 }),
            ]),
        ]);
        assert.deepEqual(
            new TouchTargetCheck().run(tree, WEB).map((f) => f.nodeId),
            ["small"]
        );
        assert.deepEqual(
            new TouchTargetCheck().run(tree, MOBILE).map((f) => f.nodeId),
            ["small", "medium"]
        );
    });

    test("treats nodes with interactions as targets and checks only the outermost one", () => {
        const tree = new DesignTree([
            board([
                node({
                    id: "card",
                    name: "Card",
                    width: 200,
                    height: 100,
                    interactions: [{ trigger: "click" }],
                    children: [node({ id: "inner", name: "Close button", width: 10, height: 10 })],
                }),
                node({ id: "tiny", name: "Dot", width: 8, height: 8, interactions: [{ trigger: "click" }] }),
                text({ id: "label", name: "Button", content: "Button", width: 40, height: 14 }),
            ]),
        ]);
        assert.deepEqual(
            new TouchTargetCheck().run(tree, WEB).map((f) => f.nodeId),
            ["tiny"]
        );
    });

    test("looks inside large containers named like a bar", () => {
        const tree = new DesignTree([
            board([
                node({
                    id: "bar",
                    name: "Tab bar",
                    width: 390,
                    height: 60,
                    children: [node({ id: "tab", name: "Tab", width: 30, height: 30 })],
                }),
            ]),
        ]);
        assert.deepEqual(
            new TouchTargetCheck().run(tree, MOBILE).map((f) => f.nodeId),
            ["tab"]
        );
    });
});

describe("SpacingCheck", () => {
    test("flags off-grid gaps and paddings unless a token is applied", () => {
        const layout = (tokens: Record<string, string>, id: string) =>
            node({
                id,
                type: "board",
                tokens,
                layout: { type: "flex", rowGap: 0, columnGap: 13, padding: { top: 16, right: 7, bottom: 16, left: 8 } },
            });
        const tree = new DesignTree([board([layout({}, "a"), layout({ columnGap: "space.s", p2: "space.xs" }, "b")])]);
        const findings = new SpacingCheck().run(tree, WEB);
        assert.deepEqual(
            findings.map((f) => f.nodeId),
            ["a"]
        );
        assert.match(findings[0].suggestion, /^Change it to 13 → 12 px, 7 → 8 px/);
        assert.deepEqual(findings[0].params, {
            label: '"a"',
            values: "13 px, 7 px",
            base: 4,
            replacements: "13 → 12 px, 7 → 8 px",
        });
    });
});

describe("ColorDuplicateCheck", () => {
    test("reports the rarer of two nearly equal colors once", () => {
        const tree = new DesignTree([
            board([
                node({ id: "a", fills: fill("#333333") }),
                node({ id: "b", fills: fill("#333333") }),
                node({ id: "c", fills: fill("#343434") }),
                node({ id: "d", fills: fill("#343535") }),
                node({ id: "lib", fills: [{ color: "#353535", opacity: 1, colorRef: { id: "x" } }] }),
                node({ id: "far", fills: fill("#FF0000") }),
            ]),
        ]);
        const findings = new ColorDuplicateCheck().run(tree, WEB);
        assert.deepEqual(
            findings.map((f) => [f.nodeId, f.data?.color, f.data?.canonical]),
            [
                ["c", "#343434", "#333333"],
                ["d", "#343535", "#333333"],
            ]
        );
    });
});

describe("TypeScaleCheck", () => {
    test("groups off-scale font sizes per board", () => {
        const tree = new DesignTree([
            board([
                text({ id: "a", content: "A", fontSize: 17 }),
                text({ id: "b", content: "B", fontSize: 17 }),
                text({ id: "c", content: "C", fontSize: 16 }),
                text({ id: "d", content: "D", fontSize: 19, tokens: { fontSize: "font.body" } }),
            ]),
        ]);
        const findings = new TypeScaleCheck().run(tree, WEB);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].nodeId, "a");
        assert.deepEqual(findings[0].relatedNodeIds, ["b"]);
        assert.equal(findings[0].data?.nearest, 16);
    });
});

describe("DefaultNameCheck", () => {
    test("recognizes default names and reports them once per board", () => {
        assert.ok(DefaultNameCheck.isDefaultName("Rectangle 12"));
        assert.ok(DefaultNameCheck.isDefaultName("Group"));
        assert.ok(!DefaultNameCheck.isDefaultName("Hero image"));
        const tree = new DesignTree([
            board([
                node({ id: "r", name: "Rectangle 12" }),
                node({ id: "g", name: "Group 3" }),
                node({ id: "ok", name: "Avatar" }),
            ]),
        ]);
        const findings = new DefaultNameCheck().run(tree);
        assert.equal(findings.length, 1);
        assert.equal(findings[0].nodeId, "board");
        assert.deepEqual(findings[0].relatedNodeIds, ["r", "g"]);
    });
});

describe("DetachedInstanceCheck", () => {
    test("reports broken copies and unlinked look-alikes of used components", () => {
        const instance = (id: string, componentId: string | null) =>
            node({
                id,
                name: "Button",
                type: "board",
                component: { isInstance: true, isMainInstance: false, componentId, componentName: "Button" },
                children: [text({ id: `${id}-label`, content: "Go" })],
            });
        const detached = node({
            id: "copy",
            name: "Button",
            type: "board",
            children: [text({ id: "copy-label", content: "Go" })],
        });
        const tree = new DesignTree([board([instance("ok", "cmp-1"), instance("broken", null), detached])]);
        const findings = new DetachedInstanceCheck().run(tree);
        assert.deepEqual(
            findings.map((f) => [f.nodeId, f.title]),
            [
                ["broken", "Broken component copy"],
                ["copy", "Detached component"],
            ]
        );
    });
});

describe("TextOverflowCheck", () => {
    test("flags text clipped by its board and long text in a small fixed box", () => {
        const tree = new DesignTree([
            board(
                [
                    text({ id: "out", content: "Outside", x: 380, y: 10, width: 60, height: 20 }),
                    text({
                        id: "long",
                        content: "A very long paragraph that cannot possibly fit into a tiny fixed box",
                        x: 10,
                        y: 100,
                        width: 80,
                        height: 20,
                        growType: "fixed",
                    }),
                    text({ id: "fine", content: "Short", x: 10, y: 200, width: 80, height: 20, growType: "fixed" }),
                ],
                { layout: { type: "none", clipContent: true } }
            ),
        ]);
        assert.deepEqual(
            new TextOverflowCheck().run(tree).map((f) => [f.nodeId, f.title]),
            [
                ["out", "Text cut off"],
                ["long", "Text may overflow"],
            ]
        );
    });
});

describe("DesignAuditor", () => {
    test("finds exactly the low-contrast label and the small close button of the login board", () => {
        const tree = new DesignTree([loginBoard()]);
        const findings = new DesignAuditor().audit(tree, WEB);
        assert.deepEqual(
            findings.map((f) => [f.id, f.severity, f.title]),
            [
                ["contrast:text-hint", "error", "Low contrast"],
                ["touch-target:close-button", "warning", "Small tap target"],
            ]
        );
        // comments land on the nodes: the label's center and inside the button's corner
        assert.deepEqual(findings[0].position, { x: 124, y: 150 });
        assert.deepEqual(findings[1].position, { x: 354, y: 24 });
        assert.equal(findings[0].boardName, "Login");
    });

    test("skips disabled checks", () => {
        const tree = new DesignTree([loginBoard()]);
        const config = new AuditConfig("web", { disabledChecks: ["contrast"] });
        assert.deepEqual(
            new DesignAuditor().audit(tree, config).map((f) => f.check),
            ["touch-target"]
        );
    });
});

describe("TreeLoader", () => {
    test("fetches nodes whose children came back as summaries", async () => {
        const deep = node({ id: "deep", name: "Deep" });
        const calls: string[] = [];
        const tools = {
            list: async () => [],
            call: async (_name: string, args: Record<string, unknown> = {}) => {
                calls.push(String(args.nodeId));
                const result =
                    args.nodeId === "root"
                        ? node({
                              id: "root",
                              type: "board",
                              children: [{ id: "deep", name: "Deep", type: "rectangle", visible: true }],
                          })
                        : deep;
                return { isError: false, content: [], text: JSON.stringify(result) };
            },
        };
        const roots = await new TreeLoader(new DesignReader(tools)).load(["root"]);
        assert.deepEqual(calls, ["root", "deep"]);
        assert.ok(roots[0].children![0].geometry);
    });

    test("reports tool errors", async () => {
        const tools = {
            list: async () => [],
            call: async () => ({ isError: true, content: [], text: "Node not found" }),
        };
        await assert.rejects(new TreeLoader(new DesignReader(tools)).load(["x"]), /Node not found/);
    });
});

describe("AuditComments", () => {
    const finding = {
        id: "contrast:t",
        ref: DesignAuditor.ref("contrast:t"),
        check: "contrast",
        code: "contrast",
        params: {},
        severity: "error",
        nodeId: "t",
        nodeName: "Hint",
        boardId: "b",
        boardName: "Login",
        title: "Low contrast",
        message: "Too light.",
        suggestion: "Darken it.",
        position: { x: 100, y: 100 },
    } as AuditFinding;

    test("ends comments with the finding's ref and matches open threads by ref only", () => {
        assert.match(finding.ref, /^A-[0-9a-f]{8}$/);
        assert.equal(
            AuditComments.content(finding),
            `[Audit] Low contrast: Too light.\nSuggested fix: Darken it.\nRef: ${finding.ref}`
        );
        const thread = (content: string, nodeId: string | null, position = { x: 0, y: 0 }) => ({
            threadId: "th",
            nodeId,
            position,
            comments: [{ content }],
        });
        // wherever the thread landed and whatever its title says
        assert.ok(
            AuditComments.duplicateOf(finding, [
                thread(`[Audit] Other words\nRef: ${finding.ref}`, "x", { x: 500, y: 9 }),
            ])
        );
        assert.equal(
            AuditComments.duplicateOf(finding, [thread("[Audit] Low contrast: Too light.", "t", { x: 100, y: 100 })]),
            undefined
        );
        assert.equal(AuditComments.duplicateOf(finding, [thread("[Audit] x\nRef: A-00000000", "t")]), undefined);
    });

    test("keeps the ref when a long comment is cut", () => {
        const long = AuditComments.content({ ...finding, message: "x".repeat(2000) });
        assert.ok(long.length <= 750);
        assert.ok(long.endsWith(`Ref: ${finding.ref}`));
    });
});

describe("AiReview", () => {
    test("parses the fenced JSON answer onto known nodes", () => {
        const tree = new DesignTree([loginBoard()]);
        const review = new AiReview(tree);
        assert.match(review.prompt([]), /"Login" id board-login/);
        const drafts = review.parse(
            'Here you go:\n```json\n[{"nodeId":"text-title","severity":"warning","title":"Weak heading",' +
                '"message":"The heading does not stand out.","suggestion":"Make it bolder."},' +
                '{"nodeId":"missing","severity":"bogus","title":"Misaligned","message":"Left edges differ."},' +
                '{"title":"","message":"no title"}]\n```'
        );
        assert.deepEqual(
            drafts.map((d) => [d.nodeId, d.severity, d.title, d.check]),
            [
                ["text-title", "warning", "Weak heading", "ai-review"],
                ["board-login", "info", "Misaligned", "ai-review"],
            ]
        );
        assert.deepEqual(review.parse("no json here"), []);
    });
});

describe("AuditReport", () => {
    test("renders findings grouped by severity", () => {
        const tree = new DesignTree([loginBoard()]);
        const findings = new DesignAuditor().audit(tree, WEB);
        const report = new AuditReport(
            {
                fileName: "Shop",
                pageId: "page-1",
                pageName: "Home",
                platform: "web",
                boards: ["Login"],
                nodeCount: tree.size,
                aiReview: false,
            },
            findings,
            new Date(2026, 10, 17, 9, 5)
        );
        assert.equal(report.path(), "design/audits/2026-11-17.md");
        const markdown = report.render(true);
        assert.match(markdown, /^# Design audits — 2026-11-17\n\n## 09:05 — Home\n/);
        assert.match(markdown, /- Result: 1 error, 1 warning\n/);
        assert.match(markdown, /### Errors\n\n- \*\*Low contrast\*\* — Login › Hint \(`text-hint`, contrast\)/);
        assert.equal(AuditReport.counts([]), "no findings");
    });
});

describe("audit of selected nodes", () => {
    const button = (labelColor: string) =>
        node({
            id: "btn",
            name: "Buy button",
            type: "board",
            parentId: "card",
            x: 20,
            y: 20,
            width: 120,
            height: 40,
            children: [text({ id: "label", content: "Buy", x: 40, y: 30, width: 60, height: 20, color: labelColor })],
        });
    const ancestors = new Map([
        [
            "btn",
            [
                node({
                    id: "card",
                    name: "Card",
                    type: "board",
                    parentId: "screen",
                    width: 300,
                    height: 200,
                    fills: fill("#111827"),
                }),
                node({ id: "screen", name: "Screen", type: "board", width: 400, height: 800, fills: fill("#FFFFFF") }),
            ],
        ],
    ]);

    test("takes the background from ancestors outside the tree", () => {
        const light = new DesignTree([button("#FFFFFF")], ancestors);
        assert.equal(ContrastCheck.background(light, light.get("label")!)!.hex(), "#111827");
        assert.deepEqual(new ContrastCheck().run(light), []);
        const dark = new DesignTree([button("#1F2937")], ancestors);
        assert.equal(new ContrastCheck().run(dark)[0]?.nodeId, "label");
    });

    test("does not assume white when nothing opaque is below the text", () => {
        const check = new ContrastCheck();
        assert.deepEqual(check.run(new DesignTree([button("#FFFFFF")])), []);
        assert.deepEqual(check.unknownBackgrounds, ["label"]);
        const auditor = new DesignAuditor();
        auditor.audit(new DesignTree([button("#FFFFFF")]), WEB);
        assert.deepEqual(auditor.unknownBackgrounds, ["label"]);
    });

    test("checks a selected target itself and hides nodes under hidden ancestors", () => {
        const small = node({ id: "x", name: "Close button", parentId: "card", width: 16, height: 16 });
        const tree = new DesignTree([small], new Map([["x", [node({ id: "card", visible: true })]]]));
        assert.deepEqual(
            new TouchTargetCheck().run(tree, WEB).map((f) => f.nodeId),
            ["x"]
        );
        const hidden = new DesignTree([small], new Map([["x", [node({ id: "card", visible: false })]]]));
        assert.equal(hidden.get("x")!.isVisible(), false);
    });

    test("TreeLoader loads the ancestor chain up to the page root", async () => {
        const snapshots: Record<string, ReturnType<typeof node>> = {
            card: node({ id: "card", parentId: "screen" }),
            screen: node({ id: "screen", parentId: "00000000-0000-0000-0000-000000000000" }),
        };
        const calls: string[] = [];
        const tools = {
            list: async () => [],
            call: async (_name: string, args: Record<string, unknown> = {}) => {
                calls.push(String(args.nodeId));
                return { isError: false, content: [], text: JSON.stringify(snapshots[String(args.nodeId)]) };
            },
        };
        const loader = new TreeLoader(new DesignReader(tools));
        const ancestry = await loader.ancestry([
            node({ id: "btn", parentId: "card" }),
            node({ id: "top", parentId: null }),
        ]);
        assert.deepEqual(
            ancestry.get("btn")!.map((a) => a.id),
            ["card", "screen"]
        );
        assert.deepEqual(ancestry.get("top"), []);
        assert.deepEqual(calls, ["card", "screen"]);
    });
});

describe("stable finding ids", () => {
    test("do not depend on positions, order or Claude's wording", () => {
        const tree = new DesignTree([loginBoard()]);
        const ids = new DesignAuditor().audit(tree, WEB).map((f) => [f.id, f.ref]);
        assert.deepEqual(
            ids,
            new DesignAuditor().audit(new DesignTree([loginBoard()]), WEB).map((f) => [f.id, f.ref])
        );
        const review = new AiReview(tree);
        const first = review.parse(
            '[{"nodeId":"text-title","category":"hierarchy","title":"Weak heading","message":"a"}]'
        );
        const second = review.parse(
            '[{"nodeId":"text-title","category":"hierarchy","title":"Heading too quiet","message":"b"}]'
        );
        assert.equal(first[0].key, "ai-review:hierarchy:text-title");
        assert.equal(first[0].key, second[0].key);
        const other = review.parse('[{"nodeId":"text-title","category":"made-up","title":"T","message":"m"}]');
        assert.equal(other[0].key, "ai-review:other:text-title");
    });
});

describe("ReportCommitter", () => {
    test("commits the report file only, leaving the user's other changes alone", async () => {
        const repo = mkdtempSync(join(tmpdir(), "penforge-report-"));
        try {
            const git = (...args: string[]) =>
                execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@localhost", ...args], {
                    cwd: repo,
                    encoding: "utf8",
                });
            git("init", "-q", "-b", "main");
            writeFileSync(join(repo, "DESIGN.md"), "v1\n");
            git("add", "DESIGN.md");
            git("commit", "-q", "-m", "init");
            // user edits: one staged, one not, one untracked file
            writeFileSync(join(repo, "DESIGN.md"), "v2\n");
            git("add", "DESIGN.md");
            writeFileSync(join(repo, "notes.tmp"), "scratch\n");
            mkdirSync(join(repo, "audits"));
            writeFileSync(join(repo, "audits", "2026-11-17.md"), "# report\n");

            const hash = await new ReportCommitter().commitFile(repo, "audits/2026-11-17.md", "penforge(audit): x");
            assert.match(hash!, /^[0-9a-f]{40}$/);
            assert.equal(git("show", "--name-only", "--format=", "HEAD").trim(), "audits/2026-11-17.md");
            assert.equal(git("status", "--porcelain").trim().split("\n").sort().join("|"), "?? notes.tmp|M  DESIGN.md");
            assert.equal(await new ReportCommitter().commitFile(repo, "audits/2026-11-17.md", "again"), null);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
