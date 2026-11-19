import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
    FOLDER_ATTACHMENT_LIMITS,
    type Attachment,
    type FileAttachment,
    type FolderAttachment,
} from "@penpot/mcp-common";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { AttachmentPrompt } from "./AttachmentPrompt";
import { UploadRefusedError, UploadStore } from "./UploadStore";

const PROJECT_ID = "5b2a9c11-3f4e-4c70-8a1d-0e6f2b7c9d31";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = Buffer.from("%PDF-1.4\n%fake\n", "latin1");

let projectsDir: string;
let workspace: ProjectWorkspace;

function file(name: string, mime: string, bytes: Buffer, size = bytes.length): FileAttachment {
    return { kind: "file", name, mime, size, base64: bytes.toString("base64") };
}

function uploads(): string[] {
    try {
        return readdirSync(join(workspace.metaDir, UploadStore.FOLDER));
    } catch {
        return [];
    }
}

async function refused(attachments: Attachment[], reason: string, pattern: RegExp): Promise<void> {
    await assert.rejects(new UploadStore(workspace).saveAll(attachments), (error: unknown) => {
        assert.ok(error instanceof UploadRefusedError);
        assert.equal(error.code, "bad-request");
        assert.equal(error.reason, reason);
        assert.match(error.message, pattern);
        return true;
    });
    assert.deepEqual(uploads(), []);
}

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-uploads-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    mkdirSync(workspace.metaDir, { recursive: true });
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

test("files are saved under .penforge/uploads with a safe name and keep their bytes", async () => {
    const text = Buffer.from("# Design\n\nPrimary: #3366FF\n", "utf8");
    const node: Attachment = { kind: "node", fileId: "f", pageId: "p", nodeId: "n", name: "Button", type: "rect" };
    const saved = await new UploadStore(workspace).saveAll([
        node,
        file("../../etc/DESIGN.md", "text/markdown", text),
        file("shot.png", "image/png", PNG),
    ]);

    assert.ok(saved);
    assert.deepEqual(saved[0], node);
    const [, markdown, image] = saved as FileAttachment[];
    assert.match(markdown.path!, /^\.penforge\/uploads\/\d{8}T\d{6}-[0-9a-f]{6}-DESIGN\.md$/);
    assert.match(image.path!, /^\.penforge\/uploads\/.*-shot\.png$/);
    assert.equal(markdown.base64, text.toString("base64"));
    assert.deepEqual(readFileSync(join(workspace.root, markdown.path!)), text);
    assert.deepEqual(readFileSync(join(workspace.root, image.path!)), PNG);
    assert.equal(uploads().length, 2);
});

test("messages without files are returned unchanged", async () => {
    const store = new UploadStore(workspace);
    assert.equal(await store.saveAll(undefined), undefined);
    assert.deepEqual(await store.saveAll([]), []);
});

test("unsupported types are refused", async () => {
    await refused(
        [file("tool.exe", "application/x-msdownload", Buffer.from("MZ"))],
        "file-type",
        /not a supported file type/
    );
    await refused([file("logo.svg", "image/svg+xml", Buffer.from("<svg/>"))], "file-type", /not a supported/);
});

test("the bytes decide the real type of a file", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Merhaba ğ", "utf16le")]);
    const saved = (await new UploadStore(workspace).saveAll([
        file("photo.png", "image/png", jpeg),
        file("spec.png", "image/png", PDF),
        file("notes.txt", "text/plain", utf16),
    ])) as FileAttachment[];

    assert.deepEqual(
        saved.map((attachment) => attachment.mime),
        ["image/jpeg", "application/pdf", "text/plain"]
    );
    assert.equal(Buffer.from(saved[2].base64!, "base64").toString("utf8"), "Merhaba ğ", "UTF-16 becomes UTF-8");
    assert.equal(saved[2].size, Buffer.byteLength("Merhaba ğ"));
    assert.deepEqual(readFileSync(join(workspace.root, saved[2].path!)).toString("utf8"), "Merhaba ğ");
});

test("content that is no accepted type is refused", async () => {
    await refused([file("fake.png", "image/png", Buffer.from("hello"))], "file-type", /does not contain an image/);
    await refused([file("bin.txt", "text/plain", Buffer.from([0x61, 0x00, 0x62]))], "file-type", /does not contain/);
    await refused([file("latin.txt", "text/plain", Buffer.from([0xe9, 0x41, 0xe8]))], "file-type", /does not contain/);
});

test("size limits per file and per message are enforced", async () => {
    const bigImage = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    await refused([file("big.png", "image/png", bigImage)], "file-size", /too large \(limit 3.75 MB\)/);

    const pdf = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]);
    await refused(
        [
            file("a.pdf", "application/pdf", pdf),
            file("b.pdf", "application/pdf", pdf),
            file("c.pdf", "application/pdf", pdf),
        ],
        "files-total",
        /too large together/
    );

    const many = Array.from({ length: 11 }, (_, index) => file(`f${index}.txt`, "text/plain", Buffer.from("x")));
    await refused(many, "file-count", /At most 10 files/);
});

test("a declared size that differs from the bytes is refused", async () => {
    await refused([file("cut.pdf", "application/pdf", PDF, PDF.length + 10)], "file-incomplete", /incomplete/);
});

test("malformed base64 is refused", async () => {
    await refused(
        [{ kind: "file", name: "x.txt", mime: "text/plain", size: 1, base64: "@@@=" }],
        "file-read",
        /could not be read/
    );
    await refused([{ kind: "file", name: "x.txt", mime: "text/plain", size: 1 }], "file-read", /could not be read/);
});

test("safe names drop folders and odd characters", () => {
    assert.equal(UploadStore.safeName("C:\\Users\\me\\My Screen shot (2).png"), "My_Screen_shot_2_.png");
    assert.equal(UploadStore.safeName(".env"), "env");
    assert.equal(UploadStore.safeName("../.."), "file");
    const long = UploadStore.safeName(`${"a".repeat(200)}.markdown`);
    assert.equal(long.length, 80);
    assert.ok(long.endsWith(".markdown"));
});

// --- AttachmentPrompt

test("files reach Claude as image and document blocks and inline text", async () => {
    const text = Buffer.from("# Brand\nUse Inter.", "utf8");
    const input = await new AttachmentPrompt(null).build("build this", [
        { ...file("shot.png", "image/png", PNG), path: ".penforge/uploads/1-shot.png" },
        { ...file("spec.pdf", "application/pdf", PDF), path: ".penforge/uploads/2-spec.pdf" },
        { ...file("DESIGN.md", "text/markdown", text), path: ".penforge/uploads/3-DESIGN.md" },
    ]);

    assert.deepEqual(input.images, [{ mime: "image/png", base64: PNG.toString("base64") }]);
    assert.deepEqual(input.documents, [{ mime: "application/pdf", base64: PDF.toString("base64"), title: "spec.pdf" }]);
    assert.match(input.text, /^build this\n\nAttached by the user:\n/);
    assert.match(
        input.text,
        /File "shot.png" \(image\/png, 12 bytes, saved at \.penforge\/uploads\/1-shot\.png\): image 1 below/
    );
    assert.match(input.text, /File "spec.pdf" .*: document 1 below/);
    assert.match(input.text, /<attached-file name="DESIGN.md">\n# Brand\nUse Inter.\n<\/attached-file>/);
});

test("long text files are cut and point at the saved file", async () => {
    const text = Buffer.from("x".repeat(AttachmentPrompt.MAX_TEXT_CHARS + 50), "utf8");
    const input = await new AttachmentPrompt(null).build("read", [file("big.txt", "text/plain", text)]);
    assert.match(input.text, /Only the first 100000 characters are shown/);
    assert.ok(!input.text.includes("x".repeat(AttachmentPrompt.MAX_TEXT_CHARS + 1)));
});

// --- Folders

function folder(name: string, files: Record<string, Buffer>): FolderAttachment {
    return {
        kind: "folder",
        name,
        files: Object.entries(files).map(([path, bytes]) => ({
            path,
            size: bytes.length,
            base64: bytes.toString("base64"),
        })),
    };
}

function sources(): string[] {
    try {
        return readdirSync(join(workspace.metaDir, UploadStore.SOURCES_FOLDER));
    } catch {
        return [];
    }
}

test("folders are saved under .penforge/sources with their tree, any file type, no bytes kept", async () => {
    const svg = Buffer.from("<svg/>", "utf8");
    const code = Buffer.from("export const x = 1;\n", "utf8");
    const [saved] = (await new UploadStore(workspace).saveAll([
        folder("Brand kit", { "logo.svg": svg, "icons/home.png": PNG, "src/app.tsx": code }),
    ])) as FolderAttachment[];

    assert.match(saved.path!, /^\.penforge\/sources\/\d{8}T\d{6}-[0-9a-f]{6}-Brand_kit$/);
    assert.deepEqual(saved.files, [
        { path: "logo.svg", size: svg.length },
        { path: "icons/home.png", size: PNG.length },
        { path: "src/app.tsx", size: code.length },
    ]);
    assert.deepEqual(readFileSync(join(workspace.root, saved.path!, "icons", "home.png")), PNG);
    assert.deepEqual(readFileSync(join(workspace.root, saved.path!, "src", "app.tsx")), code);
    assert.equal(sources().length, 1);
});

test("folder paths cannot leave the folder", async () => {
    for (const path of ["../secret.txt", "a/../../b.txt", "/etc/passwd", "C:/Windows/x.txt", String.raw`\\server\x`]) {
        await assert.rejects(
            new UploadStore(workspace).saveAll([folder("f", { [path]: Buffer.from("x") })]),
            (error: unknown) => error instanceof UploadRefusedError && error.reason === "folder-path"
        );
    }
    assert.deepEqual(sources(), []);
});

test("folder path segments are made safe and clashes get a number", () => {
    assert.deepEqual(UploadStore.pathSegments("./a b/CON.txt"), ["a_b", "-CON.txt"]);
    const used = new Set<string>();
    assert.equal(UploadStore.uniquePath(["a", "x.png"], used), "a/x.png");
    assert.equal(UploadStore.uniquePath(["a", "X.png"], used), "a/X-2.png");
    assert.equal(UploadStore.uniquePath(["a", "x.png"], used), "a/x-3.png");
    assert.equal(UploadStore.uniquePath(["v1.2", "README"], used), "v1.2/README");
    assert.equal(UploadStore.uniquePath(["v1.2", "readme"], used), "v1.2/readme-2");
});

test("empty, crowded, oversized and too-large-together folders are refused before anything is written", async () => {
    const store = new UploadStore(workspace);
    const reasonOf = async (attachments: Attachment[]) => {
        try {
            await store.saveAll(attachments);
            return "saved";
        } catch (error) {
            assert.ok(error instanceof UploadRefusedError);
            return error.reason;
        }
    };
    assert.equal(await reasonOf([folder("empty", {})]), "folder-empty");

    const many: Record<string, Buffer> = {};
    for (let i = 0; i <= FOLDER_ATTACHMENT_LIMITS.maxFiles; i++) {
        many[`f${i}.txt`] = Buffer.from("x");
    }
    assert.equal(await reasonOf([folder("many", many)]), "folder-count");

    const big = Buffer.alloc(FOLDER_ATTACHMENT_LIMITS.maxFileBytes + 1);
    assert.equal(await reasonOf([folder("big", { "video.mp4": big })]), "folder-file-size");

    // a file of the message and a folder share the total limit
    const half = Buffer.alloc(9 * 1024 * 1024);
    const pdf = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]);
    assert.equal(
        await reasonOf([
            file("spec.pdf", "application/pdf", pdf),
            folder("assets", { "a.bin": half, "b.bin": Buffer.alloc(3 * 1024 * 1024) }),
        ]),
        "files-total"
    );

    const truncated = folder("cut", { "a.txt": Buffer.from("hello") });
    truncated.files[0].size = 99;
    assert.equal(await reasonOf([truncated]), "file-incomplete");

    assert.deepEqual(sources(), []);
    assert.deepEqual(uploads(), []);
});

test("an attached folder reaches Claude as its path and file list, not inline", async () => {
    const input = await new AttachmentPrompt(null).build("use these", [
        {
            kind: "folder",
            name: "Brand kit",
            path: ".penforge/sources/1-Brand_kit",
            files: [
                { path: "logo.svg", size: 6 },
                { path: "icons/home.png", size: 12 },
            ],
        },
    ]);
    assert.deepEqual(input.images, []);
    assert.match(input.text, /Folder "Brand kit" \(2 files, 18 bytes, saved at \.penforge\/sources\/1-Brand_kit\/\)/);
    assert.match(input.text, /Every file in it is source material/);
    assert.match(input.text, /\n {2}- icons\/home\.png \(12 bytes\)/);
});

test("long folder lists are cut with a hint to use Glob", () => {
    const files = Array.from({ length: AttachmentPrompt.MAX_LISTED_FOLDER_FILES + 5 }, (_, i) => ({
        path: `f${i}.txt`,
        size: 1,
    }));
    const lines = AttachmentPrompt.folderLines({ kind: "folder", name: "big", files });
    assert.equal(lines.length, AttachmentPrompt.MAX_LISTED_FOLDER_FILES + 2);
    assert.match(lines.at(-1)!, /and 5 more files \(use Glob on the folder\)/);
});
