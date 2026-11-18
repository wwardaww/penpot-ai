import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { tempDir } from "../testing/helpers";
import { findOnPath, parseAuthStatus } from "./detectClaude";

const temp = tempDir();
after(() => temp.cleanup());

describe("findOnPath", () => {
    it("finds a Windows executable through PATHEXT", () => {
        const dir = join(temp.dir, "win");
        mkdirSync(dir);
        writeFileSync(join(dir, "claude.cmd"), "@echo off");
        const found = findOnPath("claude", { PATH: `C:\\nowhere;${dir}`, PATHEXT: ".EXE;.CMD" }, "win32");
        assert.ok(found?.toLowerCase().endsWith("claude.cmd"));
    });

    it("finds a POSIX executable", () => {
        const dir = join(temp.dir, "posix");
        mkdirSync(dir);
        writeFileSync(join(dir, "claude"), "#!/bin/sh");
        assert.equal(findOnPath("claude", { PATH: dir }, "linux"), join(dir, "claude"));
    });

    it("answers undefined when missing", () => {
        assert.equal(findOnPath("claude", { PATH: join(temp.dir, "empty") }, "linux"), undefined);
    });
});

describe("parseAuthStatus", () => {
    it("reads the JSON answer", () => {
        assert.equal(parseAuthStatus({ code: 0, output: '{"loggedIn": true, "authMethod": "claude.ai"}' }).loggedIn, true);
        assert.equal(parseAuthStatus({ code: 0, output: '{"loggedIn": false}' }).loggedIn, false);
    });

    it("reads the text answer and the exit code", () => {
        assert.equal(parseAuthStatus({ code: 0, output: "Logged in as someone" }).loggedIn, true);
        assert.equal(parseAuthStatus({ code: 0, output: "Not logged in" }).loggedIn, false);
        assert.equal(parseAuthStatus({ code: 1, output: "error" }).loggedIn, false);
    });
});
