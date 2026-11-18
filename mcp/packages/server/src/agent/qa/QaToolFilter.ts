import { isAbsolute, relative, resolve } from "path";
import type { WorkflowToolFilter } from "@penpot/mcp-common";

/**
 * Tools Claude may use while it fixes the app's code during a visual QA: read the project, change
 * files of `app-src/` only, and read (never change) the design.
 */
export class QaToolFilter implements WorkflowToolFilter {
    private static readonly PENPOT_PREFIX = "mcp__penpot__";
    private static readonly READ_ONLY_PENPOT = new Set([
        "get_node_properties",
        "list_boards",
        "get_prototype_graph",
        "generate_code_hints",
        "capture_node_screenshot",
        "penforge_overview",
        "high_level_overview",
        "penpot_api_info",
    ]);
    private static readonly READ = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite"]);
    private static readonly WRITE = new Set(["Write", "Edit", "MultiEdit"]);

    /**
     * @param projectRoot - the project folder (Claude's working directory)
     * @param appSrcDir - the generated app's folder, the only place Claude may change
     */
    constructor(
        private readonly projectRoot: string,
        private readonly appSrcDir: string
    ) {}

    public check(toolName: string, input: Record<string, unknown>): string | null {
        if (toolName.startsWith(QaToolFilter.PENPOT_PREFIX)) {
            const name = toolName.slice(QaToolFilter.PENPOT_PREFIX.length);
            return QaToolFilter.READ_ONLY_PENPOT.has(name)
                ? null
                : "The design must not change during a visual check; change the app's code instead.";
        }
        if (QaToolFilter.READ.has(toolName)) {
            return null;
        }
        if (QaToolFilter.WRITE.has(toolName)) {
            const target = input.file_path;
            return typeof target === "string" && this.insideAppSrc(target)
                ? null
                : "Only files inside app-src/ may be changed during a visual check.";
        }
        return "Not available during a visual check: Penforge reloads and checks the app itself.";
    }

    private insideAppSrc(file: string): boolean {
        const absolute = isAbsolute(file) ? resolve(file) : resolve(this.projectRoot, file);
        const rel = relative(resolve(this.appSrcDir), absolute);
        return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
    }
}
