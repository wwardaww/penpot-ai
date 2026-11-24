import { isAbsolute, relative, resolve } from "path";
import type { WorkflowToolFilter } from "@penpot/mcp-common";

/**
 * Tool filter of the W38 workflow turns on a linked folder: Claude may read inside the given
 * folders, use the read-only Penpot tools when allowed, and change files only inside one writable
 * folder (none for the background read). Everything else is denied, Bash included.
 *
 * The daemon's permission policy still runs after this filter; {@link allowedTools} lists the same
 * rules for the `local-cli-spawn` runner, which can only approve up front (its read rules are not
 * limited to the folders).
 */
export class LinkedToolFilter implements WorkflowToolFilter {
    private static readonly PENPOT_PREFIX = "mcp__penpot__";
    private static readonly READ_ONLY_PENPOT = new Set([
        "get_node_properties",
        "list_boards",
        "get_prototype_graph",
        "generate_code_hints",
        "capture_node_screenshot",
        "penforge_overview",
        "penforge_skill",
        "high_level_overview",
        "penpot_api_info",
        "export_shape",
    ]);
    private static readonly READ = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite"]);
    private static readonly WRITE = new Set(["Write", "Edit", "MultiEdit"]);
    private static readonly PATH_FIELDS = ["file_path", "path", "notebook_path"];

    public readonly allowedTools: readonly string[];

    /**
     * @param cwd - Claude's working directory (relative paths resolve against it)
     * @param readable - folders Claude may read
     * @param writable - the only folder Claude may change, or null
     * @param penpot - whether the read-only Penpot tools are allowed
     */
    constructor(
        private readonly cwd: string,
        private readonly readable: readonly string[],
        private readonly writable: string | null,
        private readonly penpot: boolean
    ) {
        this.allowedTools = [
            ...LinkedToolFilter.READ,
            ...(penpot
                ? [...LinkedToolFilter.READ_ONLY_PENPOT].map((name) => `${LinkedToolFilter.PENPOT_PREFIX}${name}`)
                : []),
            ...(writable
                ? ["Edit", "Write", "MultiEdit"].map((tool) => `${tool}(${LinkedToolFilter.rulePath(cwd, writable)})`)
                : []),
        ];
    }

    public check(toolName: string, input: Record<string, unknown>): string | null {
        if (toolName.startsWith(LinkedToolFilter.PENPOT_PREFIX)) {
            const name = toolName.slice(LinkedToolFilter.PENPOT_PREFIX.length);
            if (!this.penpot) {
                return "Penpot tools are not available in this step.";
            }
            return LinkedToolFilter.READ_ONLY_PENPOT.has(name)
                ? null
                : "The design must not change in this step; Penpot tools may only read it.";
        }
        const paths = LinkedToolFilter.PATH_FIELDS.map((field) => input[field]).filter(
            (value): value is string => typeof value === "string" && value.length > 0
        );
        if (LinkedToolFilter.READ.has(toolName)) {
            const outside = paths.find((path) => !this.readable.some((folder) => this.inside(folder, path)));
            return outside === undefined ? null : `Only files of the project folder may be read: ${outside}`;
        }
        if (LinkedToolFilter.WRITE.has(toolName)) {
            if (
                this.writable !== null &&
                paths.length > 0 &&
                paths.every((path) => this.inside(this.writable!, path))
            ) {
                return null;
            }
            return this.writable
                ? `Only files inside ${this.writable} may be changed in this step.`
                : "No file may be changed in this step.";
        }
        return "Not available in this step: use Read, Glob and Grep (and Edit/Write where allowed).";
    }

    private inside(folder: string, path: string): boolean {
        const absolute = isAbsolute(path) ? resolve(path) : resolve(this.cwd, path);
        const norm = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
        const rel = relative(norm(resolve(folder)), norm(absolute));
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    }

    /** Claude Code rule path of a folder: relative to the working directory, else absolute (`//`). */
    private static rulePath(cwd: string, dir: string): string {
        const rel = relative(cwd, dir).split("\\").join("/");
        if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
            return `${rel}/**`;
        }
        // `//<absolute path>`; Windows drive paths as `//c/Users/...`
        const absolute = resolve(dir)
            .split("\\")
            .join("/")
            .replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`);
        return `/${absolute.startsWith("/") ? absolute : `/${absolute}`}/**`;
    }
}
