// Bundles the Electron main process and the preload script into dist/.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });

const common = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
};

await build({ ...common, entryPoints: [join(root, "src", "main.ts")], outfile: join(root, "dist", "main.js") });
await build({ ...common, entryPoints: [join(root, "src", "preload.ts")], outfile: join(root, "dist", "preload.js") });
