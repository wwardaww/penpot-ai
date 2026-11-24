import { existsSync, lstatSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { ThemeLocator } from "../tokens/ThemeTarget";
import type { AnimatedDesignLayer } from "./DesignContract";
import { MotionCode, type MotionLibraryId, type NamedMotion } from "./MotionCode";
import { MotionModel } from "./MotionModel";

/** Animated layer of the contract with its name and motion in the code. */
export interface MotionEntry extends NamedMotion {
    layer: AnimatedDesignLayer;
}

/** Content of `.penforge/motion.json`: where the motion file is and the name of every layer in it. */
interface MotionRecord {
    schemaVersion: 1;
    file: string;
    library: MotionLibraryId;
    /** node id → key */
    keys: Record<string, string>;
}

/**
 * The generated motion file of the app (`src/penforge/motion.*`): chooses the animation library
 * of the stack, names every animated layer (names stay the same between builds) and writes the
 * file. Claude only applies the motions; the values are never typed by hand.
 */
export class MotionFile {
    public static readonly RECORD = "motion.json";

    private static readonly PACKAGES: Record<MotionLibraryId, string[]> = {
        "framer-motion": ["framer-motion", "motion"],
        reanimated: ["react-native-reanimated"],
        css: [],
    };

    /**
     * @param library - animation library of the app
     * @param file - path in the app folder, forward slashes
     * @param entries - animated layers in design order
     */
    private constructor(
        private readonly appDir: string,
        public readonly library: MotionLibraryId,
        public readonly file: string,
        public readonly entries: MotionEntry[],
        private readonly code: MotionCode
    ) {}

    /**
     * Chooses the animation library of a stack: Reanimated for React Native and Expo, Framer Motion
     * for React on the web, CSS for everything else.
     *
     * @param appDir - the app folder (its `package.json` may not exist yet)
     * @param stack - name and version of the stack
     */
    public static async library(
        appDir: string,
        stack: { name: string; version?: string; platform?: string }
    ): Promise<MotionLibraryId> {
        const family = await ThemeLocator.family(appDir, { name: stack.name, version: stack.version ?? "" });
        if (family.native) {
            return "reanimated";
        }
        const dependencies = await MotionFile.dependencies(appDir);
        const text = `${stack.name} ${stack.version ?? ""}`;
        return dependencies.has("react") || /\b(react|next(\.js)?|remix|gatsby)\b/i.test(text)
            ? "framer-motion"
            : "css";
    }

    /**
     * Plans the motion file of a build.
     *
     * @param workspace - the project workspace
     * @param library - the animation library
     * @param layers - animated layers of the contract
     */
    public static async plan(
        workspace: WorkflowWorkspaceApi,
        library: MotionLibraryId,
        layers: AnimatedDesignLayer[]
    ): Promise<MotionFile> {
        const appDir = workspace.appSrcDir;
        const record = await MotionFile.record(workspace);
        const code = MotionCode.of(library, existsSync(join(appDir, "tsconfig.json")));
        const folder = existsSync(join(appDir, "src")) ? "src/penforge" : "penforge";
        const same = record !== null && record.library === library && record.file.endsWith(code.extension);
        const file = same ? record.file : `${folder}/motion${code.extension}`;
        const taken = new Set<string>();
        const keys = new Map<string, string>();
        for (const layer of layers) {
            const known = record?.keys[layer.nodeId];
            if (known !== undefined && !taken.has(known)) {
                keys.set(layer.nodeId, known);
                taken.add(known);
            }
        }
        const entries: MotionEntry[] = [];
        for (const layer of layers) {
            const motion = MotionModel.compile(layer.animations, layer.smart);
            if (MotionModel.isEmpty(motion)) {
                continue;
            }
            let key = keys.get(layer.nodeId);
            if (key === undefined) {
                const base = MotionFile.key(layer);
                key = base;
                for (let n = 2; taken.has(key); n++) {
                    key = `${base}${n}`;
                }
                taken.add(key);
                keys.set(layer.nodeId, key);
            }
            entries.push({ key, label: `${layer.boardName} / ${layer.path || layer.name}`, motion, layer });
        }
        const planned = new MotionFile(appDir, library, file, entries, code);
        if (entries.length > 0 || record !== null) {
            await workspace.writeJson(MotionFile.RECORD, {
                schemaVersion: 1,
                file,
                library,
                keys: { ...record?.keys, ...Object.fromEntries(keys) },
            } satisfies MotionRecord);
        }
        return planned;
    }

    /** Npm packages of the library (any one will do); empty when it needs none. */
    public get packages(): string[] {
        return MotionFile.PACKAGES[this.library];
    }

    /** Writes the file when its content differs; skipped when the app never had an animation. */
    public async write(): Promise<void> {
        const path = join(this.appDir, ...this.file.split("/"));
        const present = existsSync(path);
        if (this.entries.length === 0 && !present) {
            return;
        }
        this.refuseLinks();
        const text = this.code.file(this.entries);
        if (!present || (await readFile(path, "utf8")) !== text) {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, text, "utf8");
        }
    }

    /** How code names the motion of an entry. */
    public references(entry: MotionEntry): string[] {
        return this.code.references(entry);
    }

    /** Pattern finding a use of an entry's motion. */
    public usage(entry: MotionEntry): RegExp {
        return this.code.usage(entry.key);
    }

    /** The app folder must not reach outside through a link. */
    private refuseLinks(): void {
        const segments = this.file.split("/");
        for (let end = 1; end <= segments.length; end++) {
            const path = join(this.appDir, ...segments.slice(0, end));
            if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
                throw new Error(`The motion file path ${this.file} goes through a link`);
            }
        }
    }

    private static key(layer: AnimatedDesignLayer): string {
        const screen = MotionCode.pascal(layer.boardName) || "Screen";
        const name = layer.nodeId === layer.boardId ? "Screen" : MotionCode.pascal(layer.name) || "Layer";
        const key = screen.charAt(0).toLowerCase() + screen.slice(1) + name;
        return /^[0-9]/.test(key) ? `screen${key}` : key;
    }

    private static async record(workspace: WorkflowWorkspaceApi): Promise<MotionRecord | null> {
        const raw = await workspace.readJson<Partial<MotionRecord> | null>(MotionFile.RECORD, null).catch(() => null);
        if (
            raw === null ||
            typeof raw !== "object" ||
            typeof raw.file !== "string" ||
            !/^(?:src\/)?penforge\/motion\.(?:ts|js|css)$/.test(raw.file) ||
            (raw.library !== "framer-motion" && raw.library !== "css" && raw.library !== "reanimated")
        ) {
            return null;
        }
        const keys: Record<string, string> = {};
        for (const [nodeId, key] of Object.entries(raw.keys ?? {})) {
            if (typeof key === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
                keys[nodeId] = key;
            }
        }
        return { schemaVersion: 1, file: raw.file, library: raw.library, keys };
    }

    /** Dependency names of the app's `package.json`. */
    public static async dependencies(appDir: string): Promise<Set<string>> {
        try {
            const pkg = JSON.parse(await readFile(join(appDir, "package.json"), "utf8")) as Record<string, unknown>;
            return new Set(
                ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) =>
                    Object.keys((pkg[field] as Record<string, unknown> | undefined) ?? {})
                )
            );
        } catch {
            return new Set();
        }
    }
}
