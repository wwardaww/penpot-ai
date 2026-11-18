import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Attachment, FileAttachment } from "@penpot/mcp-common";
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
