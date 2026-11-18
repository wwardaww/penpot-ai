import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { tempDir } from "../testing/helpers";
import { DesktopState } from "./DesktopState";
import { dataLayout, missingParts, runtimeLayout } from "./layout";

const temp = tempDir();
after(() => temp.cleanup());

describe("DesktopState", () => {
    it("creates fresh secrets once and keeps them", () => {
        const file = join(temp.dir, "a", "desktop.json");
        const first = DesktopState.load(file);
        assert.ok(first.data.localLoginSecret.length >= 40);
        assert.notEqual(first.data.localLoginSecret, first.data.postgresPassword);
        first.update((d) => {
            d.ports.gateway = 1234;
            d.wizard = { done: true, persona: "developer" };
        });
        const second = DesktopState.load(file);
        assert.equal(second.data.localLoginSecret, first.data.localLoginSecret);
        assert.equal(second.data.ports.gateway, 1234);
        assert.equal(second.data.wizard.persona, "developer");
        if (process.platform !== "win32") {
            assert.equal(statSync(file).mode & 0o777, 0o600);
        }
    });

    it("replaces a broken file", () => {
        const file = join(temp.dir, "broken.json");
        writeFileSync(file, "{not json");
        const state = DesktopState.load(file);
        assert.equal(state.data.version, 1);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    });
});

describe("layout", () => {
    it("names platform executables", () => {
        assert.ok(runtimeLayout("/r", "win32").java.endsWith(join("jre", "bin", "java.exe")));
        assert.ok(runtimeLayout("/r", "darwin").java.endsWith(join("jre", "bin", "java")));
        assert.ok(dataLayout("/d").pgdata.endsWith("pgdata"));
    });

    it("lists the missing parts of an empty bundle", () => {
        assert.deepEqual(missingParts(runtimeLayout(join(temp.dir, "nothing"))), ["jre", "postgres", "backend", "frontend", "daemon"]);
    });
});
