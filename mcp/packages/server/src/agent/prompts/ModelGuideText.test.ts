import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ApiDocs } from "../../ApiDocs";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import { ExecuteCodeTool } from "../../tools/ExecuteCodeTool";
import { ExportShapeTool } from "../../tools/ExportShapeTool";
import { HighLevelOverviewTool } from "../../tools/HighLevelOverviewTool";
import { PenforgeTools } from "../../tools/penforge/PenforgeTools";
import { PenpotApiInfoTool } from "../../tools/PenpotApiInfoTool";
import { DestructiveDesign } from "../permissions/DestructiveDesign";
import { PromptRegistry } from "./promptRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..", "..", "..");
const TYPES = join(PACKAGES, "..", "..", "plugins", "libs", "plugin-types", "index.d.ts");
const UTILS = join(PACKAGES, "plugin", "src", "PenpotUtils.ts");

/**
 * The names a script of `execute_code` sees, and those the guide's table uses, with the types of the
 * Penpot plugin API. `Any` is a shape of unknown type: it has the members the guide reads after
 * looking at `type`, or with `?.`.
 */
const SCOPE = `
import type { Board, Fill, FlexLayout, Font, Penpot, Rectangle, Shape, ShapeBase, Text } from "@penpot/plugin-types";
import type { PenpotUtils } from ${JSON.stringify(UTILS)};
type Any = Omit<ShapeBase, "fills" | "parent"> & Pick<Text, "fontSize"> & {
    type: Shape["type"]; fills: Fill[]; parent: Any; children?: Any[];
};
export interface Scope {
    penpot: Omit<Penpot, "root"> & { root: { children: Any[] } };
    penpotUtils: Omit<typeof PenpotUtils, "findShapes" | "getBounds"> & {
        findShapes(predicate: (shape: Any) => boolean, root: Board): Any[];
        getBounds(shape: Any): ReturnType<typeof PenpotUtils.getBounds>;
    };
    storage: {
        font: Font;
        board: Board;
        step<T>(draw: () => T): T;
        box(parent: Board, name: string, dir: FlexLayout["dir"], options?: {
            gap?: number; padX?: number; padY?: number; fill?: string; width?: "fill" | "auto" | "fix";
        }): Board;
        text(parent: Board, characters: string, size: number, options?: {
            weight?: number; color?: string; wrap?: boolean;
        }): Text;
    };
    shape: Rectangle;
    text: Text;
    parent: Board;
    child: Shape;
    font: Font;
    flex: FlexLayout;
    id: string;
}
`;
const NAMES = "penpot, penpotUtils, storage, shape, text, parent, child, font, flex, id";

/** A tool name in inline code. */
const TOOL = /^[a-z]+(?:_[a-z]+)+$/;

const guide = PromptRegistry.locate().modelGuide();
const prose = guide.replace(/^```js\n[\s\S]*?^```$/gm, "");
const examples = [...guide.matchAll(/^```js\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
const rows = prose
    .split("\n")
    .filter((line) => line.startsWith("| ") && !/^\| (?:Wrong|---) \|/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()));
const wrong = rows.flatMap((row) => inlineCode(row[1]));
const right = [
    ...rows.flatMap((row) => inlineCode(row[2])),
    ...inlineCode(prose.replace(/^\|.*$/gm, "").replace(/\n(?!\n)/g, " ")),
];

function inlineCode(text: string): string[] {
    return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/**
 * Type-checks pieces of code as the bodies of `execute_code` calls.
 *
 * @returns the problems of each piece
 */
function problems(pieces: string[]): string[][] {
    const at = (name: string) => join(dirname(UTILS), name);
    const files = new Map([
        [at("guide-scope.ts"), SCOPE],
        ...pieces.map((code, i): [string, string] => [
            at(`guide-piece${i}.ts`),
            `import type { Scope } from "./guide-scope";\n` +
                `export async function piece({ ${NAMES} }: Scope) {\n${code}\n}\n`,
        ]),
    ]);
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        lib: ["lib.es2022.d.ts"],
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        strict: false,
        types: [],
        paths: { "@penpot/plugin-types": [TYPES] },
    };
    const host = ts.createCompilerHost(options);
    const { getSourceFile, fileExists, readFile } = host;
    host.fileExists = (file) => files.has(file) || fileExists(file);
    host.readFile = (file) => files.get(file) ?? readFile(file);
    host.getSourceFile = (file, target, ...rest) => {
        const text = files.get(file);
        return text === undefined
            ? getSourceFile.call(host, file, target, ...rest)
            : ts.createSourceFile(file, text, target);
    };
    const program = ts.createProgram([...files.keys()], options, host);
    const found = (name: string) => {
        const source = program.getSourceFile(at(name));
        return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map((problem) =>
            ts.flattenDiagnosticMessageText(problem.messageText, " ")
        );
    };
    assert.deepEqual(found("guide-scope.ts"), [], "the types of the test do not load");
    return pieces.map((_code, i) => found(`guide-piece${i}.ts`));
}

/** Turns inline code into a statement, or null when it is not about the API. */
function statement(code: string): string | null {
    if (/^(?:penpot|penpotUtils|storage|shape|text|parent|child|font)\..*/.test(code)) {
        return `${code};`;
    }
    if (/^\w+ = /.test(code)) {
        return `text.${code};`;
    }
    if (/^(?:rowGap|columnGap|verticalPadding|horizontalPadding)$/.test(code)) {
        return `flex.${code} = 8;`;
    }
    if (/^(?:justifyContent|alignItems)$/.test(code)) {
        return `flex.${code} = "center";`;
    }
    if (/^"(?:start|center|end|space-between)"$/.test(code)) {
        return `flex.justifyContent = ${code};`;
    }
    if (/^"(?:fill|fix|auto)"$/.test(code)) {
        return `child.layoutChild.horizontalSizing = ${code};`;
    }
    if (/^(?:fontSize|x|y|resize)$/.test(code)) {
        return `text.${code};`;
    }
    return code === "appendChild" ? "parent.appendChild;" : null;
}

describe("the drawing guide", () => {
    test("stays small enough for a model with a small context", () => {
        // about 3.6 characters a token
        assert.ok(guide.length < 9500, `the guide has ${guide.length} characters`);
        assert.ok(examples.length >= 4);
        assert.ok(rows.length >= 10);
    });

    test("has examples that follow the types of the plugin API", () => {
        const found = problems(examples);
        examples.forEach((code, i) => assert.deepEqual(found[i], [], code));
    });

    test("has examples that run without asking the user", () => {
        for (const code of examples) {
            assert.equal(DestructiveDesign.check("execute_code", { code }), null, code);
        }
    });

    test("names only members of the API that exist", () => {
        const statements = right.map(statement).filter((code) => code !== null);
        for (const name of ["penpot.createRectangle()", "penpotUtils.findShapeById(id)", "parent.appendChild(shape)"]) {
            assert.ok(statements.includes(`${name};`), name);
        }
        const found = problems(statements);
        statements.forEach((code, i) => assert.deepEqual(found[i], [], code));
    });

    test("leaves no code unchecked", () => {
        const other = [
            "return",
            "storage",
            "page",
            "nodeId",
            "type",
            "member",
            "mcp__penpot__",
            "[]",
            "layoutProblems",
            "warnings",
        ];
        const unchecked = right.filter((code) => statement(code) === null && !other.includes(code) && !TOOL.test(code));
        assert.deepEqual(unchecked, []);
    });

    test("calls wrong what the API does not have", () => {
        const statements = wrong.filter((code) => /^penpot\b|^shape\.(?!x\b)|^text\.|^flex\./.test(code));
        assert.ok(statements.length >= 6, "nothing to check");
        const found = problems(statements.map((code) => `${code};`));
        statements.forEach((code, i) => assert.notDeepEqual(found[i], [], code));
    });

    test("is checked against invented names and wrong values", () => {
        const invented = [
            "penpot.createFrame();",
            "penpot.createText();",
            "penpotUtils.findByName('x');",
            "shape.radius = 4;",
            "shape.width = 4;",
            "shape.strokes = [{ strokeStyle: 'line' }];",
            "flex.justifyContent = 'flex-start';",
            "child.layoutChild.horizontalSizing = 'hug';",
            "storage.box(storage.board, 'Header', 'horizontal');",
        ];
        const found = problems(invented);
        invented.forEach((code, i) => assert.notDeepEqual(found[i], [], code));
    });

    test("names only MCP tools that exist", () => {
        const server = { isFileSystemAccessEnabled: () => true } as unknown as PenpotMcpServer;
        const tools = new Set(
            [
                new ExecuteCodeTool(server),
                new ExportShapeTool(server),
                new HighLevelOverviewTool(server),
                new PenpotApiInfoTool(server, {} as ApiDocs),
                ...PenforgeTools.create(server),
            ].map((tool) => tool.getToolName())
        );
        const named = new Set(right.filter((code) => TOOL.test(code)));
        assert.ok(named.has("execute_code") && named.has("capture_node_screenshot"));
        for (const name of named) {
            assert.ok(tools.has(name), name);
        }
        // a tool named outside of inline code would escape the check above
        const bare = prose.replace(/`[^`]+`/g, "").match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
        assert.deepEqual(bare, []);
    });

    test("points to API types that penpot_api_info knows", () => {
        const docs = new ApiDocs();
        const [, list] = /`penpot_api_info` \(`type`: ([^;]+);/.exec(prose)!;
        const types = [...list.matchAll(/"(\w+)"/g)].map((match) => match[1]);
        assert.ok(types.length >= 5);
        for (const type of types) {
            assert.ok(docs.getType(type), type);
        }
    });
});
