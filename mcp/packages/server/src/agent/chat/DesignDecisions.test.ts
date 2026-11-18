import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { DesignDecisions } from "./DesignDecisions";
import { DesignTree } from "./DesignTree";

const PROJECT_ID = "3a9f1c2e-5b7d-4e8f-a0b1-c2d3e4f5a6b7";
const DESIGN_MD = `---
version: alpha
name: To-do
colors:
  primary: "#7B61FF"
---

## Overview

A calm to-do app.
`;

let projectsDir: string;
let workspace: ProjectWorkspace;

beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), "penforge-decisions-"));
    workspace = new ProjectWorkspace(projectsDir, PROJECT_ID);
    await workspace.ensure();
});

afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
});

test("decisions go to Do's and Don'ts of DESIGN.md and are committed", async () => {
    writeFileSync(join(workspace.designDir, "DESIGN.md"), DESIGN_MD);
    const decisions = new DesignDecisions(workspace);

    assert.equal(await decisions.record("Progress Card: fill #ff9a3d → #f26b1d on every screen."), true);
    assert.equal(await decisions.record("Primary button: radius 12 on every screen."), true);

    const text = readFileSync(join(workspace.designDir, "DESIGN.md"), "utf8");
    assert.match(
        text,
        /## Do's and Don'ts\n\n- Progress Card: fill #ff9a3d → #f26b1d on every screen\.\n- Primary button: radius 12 on every screen\./
    );
    assert.match(text, /## Overview\n\nA calm to-do app\./, "the rest of the file stays");
    assert.match(text, /primary: "#7B61FF"/);
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: workspace.designDir }).toString();
    assert.match(log, /penforge\(design-md\): record decision: Primary button/);
});

test("projects without DESIGN.md are left alone", async () => {
    assert.equal(await new DesignDecisions(workspace).record("Anything"), false);
});

test("style descriptions name colors, radius and opacity", () => {
    assert.equal(
        DesignTree.describe({
            fills: [{ gradient: { stops: [{ color: "#ff9a3d" }, { color: "#f26b1d" }] } }],
            radius: 12,
            opacity: 0.8,
        }),
        "fill #ff9a3d → #f26b1d, radius 12, opacity 0.8"
    );
});

test("snapshots parse with their style and children; styles compare by value", () => {
    const tree = DesignTree.parse(
        JSON.stringify({
            id: "b",
            name: "Home",
            type: "board",
            fills: [{ color: "#fff", opacity: 1 }],
            children: [{ id: "c", name: "Card", type: "board", fills: [{ opacity: 1, color: "#000" }], children: [] }],
        })
    );
    assert.ok(tree);
    assert.deepEqual(
        DesignTree.descendants(tree).map((node) => node.name),
        ["Card"]
    );
    assert.equal(DesignTree.same([{ color: "#000", opacity: 1 }], tree.children[0].style.fills), true);
    assert.equal(DesignTree.same([{ color: "#111", opacity: 1 }], tree.children[0].style.fills), false);
    assert.equal(DesignTree.parse("no snapshot"), null);
});
