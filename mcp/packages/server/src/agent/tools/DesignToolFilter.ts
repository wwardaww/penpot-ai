import { isAbsolute, relative, resolve } from "path";
import type { WorkflowToolFilter } from "@penpot/mcp-common";

/**
 * Tool filter of workflow turns that may read the design but never change it: Claude may read the
 * project, use only the read-only Penpot tools and, when a writable folder is given, change files
 * inside it (the visual QA allows `app-src/`; the build planner allows nothing).
 *
 * Besides {@link check} (applied per use by runners with a permission channel), it lists the same
 * rules as {@link allowedTools} for the `local-cli-spawn` runner, which can only approve up front.
 */
export class DesignToolFilter implements WorkflowToolFilter {
    private static readonly PENPOT_PREFIX = "mcp__penpot__";
    /** Penpot tools that only read the design */
    public static readonly READ_ONLY_PENPOT = [
        "get_node_properties",
        "list_boards",
        "get_prototype_graph",
        "generate_code_hints",
        "capture_node_screenshot",
        "list_canvas_comments",
        "get_animations",
        "get_animation_spec",
        "penforge_overview",
        "high_level_overview",
        "penpot_api_info",
    ] as const;
    private static readonly READ = ["Read", "Glob", "Grep", "LS", "TodoWrite"] as const;
    private static readonly WRITE = new Set(["Write", "Edit", "MultiEdit"]);

    public readonly allowedTools: readonly string[];
    private readonly readOnlyPenpot = new Set<string>(DesignToolFilter.READ_ONLY_PENPOT);

    /**
     * @param projectRoot - the project folder (Claude's working directory)
     * @param writableDir - the only folder Claude may change, or null for none
     * @param reason - why other tools are denied, told to Claude
     */
    constructor(
        private readonly projectRoot: string,
        private readonly writableDir: string | null,
        private readonly reason = "Not available in this step."
    ) {
        const writable = writableDir ? DesignToolFilter.ruleGlob(projectRoot, writableDir) : null;
        this.allowedTools = [
            ...DesignToolFilter.READ,
            ...DesignToolFilter.READ_ONLY_PENPOT.map((name) => `${DesignToolFilter.PENPOT_PREFIX}${name}`),
            ...(writable ? ["Edit", "Write", "MultiEdit"].map((tool) => `${tool}(${writable})`) : []),
        ];
    }

    public check(toolName: string, input: Record<string, unknown>): string | null {
        if (toolName.startsWith(DesignToolFilter.PENPOT_PREFIX)) {
            const name = toolName.slice(DesignToolFilter.PENPOT_PREFIX.length);
            return this.readOnlyPenpot.has(name)
                ? null
                : "The design must not change in this step; Penpot tools may only read it.";
        }
        if ((DesignToolFilter.READ as readonly string[]).includes(toolName)) {
            return null;
        }
        if (DesignToolFilter.WRITE.has(toolName)) {
            const target = input.file_path;
            if (this.writableDir && typeof target === "string" && this.inside(target)) {
                return null;
            }
            return this.writableDir
                ? `Only files inside ${DesignToolFilter.folderName(this.projectRoot, this.writableDir)} may be changed in this step.`
                : "No file may be changed in this step.";
        }
        return this.reason;
    }

    private inside(file: string): boolean {
        const absolute = isAbsolute(file) ? resolve(file) : resolve(this.projectRoot, file);
        const norm = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
        const rel = relative(norm(resolve(this.writableDir!)), norm(absolute));
        return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
    }

    /**
     * Rule path of a folder: `app-src/**` style below the working directory, else absolute
     * (`//c/apps/shop/**`, W41 app folders).
     */
    private static ruleGlob(root: string, dir: string): string {
        if (DesignToolFilter.isBelow(root, dir)) {
            return `${relative(root, dir).split("\\").join("/")}/**`;
        }
        const absolute = resolve(dir)
            .split("\\")
            .join("/")
            .replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
        return `/${absolute}/**`;
    }

    /** Name of the writable folder as Claude is told it: `app-src/`, or an absolute path. */
    private static folderName(root: string, dir: string): string {
        return DesignToolFilter.isBelow(root, dir) ? `${relative(root, dir).split("\\").join("/")}/` : dir;
    }

    private static isBelow(root: string, dir: string): boolean {
        const rel = relative(root, dir);
        return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
    }
}
