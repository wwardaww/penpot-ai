// Copies the Penforge daemon's prompt files to dist/agent/, where the bundled daemon looks for them.
// Run from mcp/packages/server as part of `pnpm run build`.
import { cpSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const source = join("src", "agent");
const target = join("dist", "agent");

// base and persona prompts
cpSync(join(source, "prompts"), join(target, "prompts"), {
    recursive: true,
    filter: (path) => !/\.(ts|mjs)$/.test(path),
});

// workflow prompts (`<name>.prompt.md`)
const workflows = join(source, "workflows");
mkdirSync(join(target, "workflows"), { recursive: true });
if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)) {
        if (name.endsWith(".prompt.md")) {
            cpSync(join(workflows, name), join(target, "workflows", name));
        }
    }
}
