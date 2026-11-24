import { existsSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import type { AgentContext } from "@penpot/mcp-common";
import type { ToolPermissionHandler, ToolUseDecision, ToolUseRequest } from "../runner/ClaudeRunner";
import type { ProjectWorkspace } from "./ProjectWorkspace";

/** Workspace parts the prompt needs. */
export type AppFolderWorkspace = Pick<ProjectWorkspace, "root" | "appSrcDir" | "internalAppDir" | "appRoot">;

/**
 * What Claude is told about a project's app folder when it is not `app-src/` in the working
 * directory (W41).
 *
 * The daemon's prompts name the app folder `app-src/`. For an app in a folder the user picked,
 * that text is replaced with the folder's absolute path, a section explains it, and file tools
 * that still write to `app-src/` are refused with the right path, so no app file lands in the
 * project folder by mistake.
 */
export class AppFolderPrompt {
    private static readonly NAME = /(?<![\w./\\-])app-src\//g;
    private static readonly WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
    private static readonly PATH_FIELDS = ["file_path", "path", "notebook_path"];

    /**
     * @param workspace - the project workspace
     */
    constructor(private readonly workspace: AppFolderWorkspace) {}

    /** Whether the app is in a folder the user picked. */
    private get external(): boolean {
        return this.workspace.appSrcDir !== this.workspace.internalAppDir;
    }

    /**
     * The section of a chat turn of a project without an app: app code is not written before the
     * user picked a folder with Build. "" for other projects.
     *
     * @param context - the tab context
     */
    public noAppSection(context: AgentContext): string {
        if (
            context.projectType === "game" ||
            context.projectType === "existing" ||
            this.external ||
            existsSync(join(this.workspace.internalAppDir, "package.json"))
        ) {
            return "";
        }
        return [
            "## The app folder",
            "This project has no app yet. The Build button asks the user which folder the app goes to, so write",
            "no app code in this chat; when the user asks for the app, tell them to press Build (or Instruct for",
            "a specification without code).",
        ].join("\n");
    }

    /** Folders outside the working directory Claude works in. */
    public get directories(): string[] {
        return this.workspace.appRoot ? [this.workspace.appRoot] : [];
    }

    /**
     * Replaces `app-src/` in prompt text with the app folder.
     *
     * @param prompt - text written by the daemon
     */
    public text(prompt: string): string {
        if (!this.external) {
            return prompt;
        }
        const folder = AppFolderPrompt.forward(this.workspace.appSrcDir);
        return prompt.replace(AppFolderPrompt.NAME, () => `${folder}/`);
    }

    /**
     * The section about the app folder, or "" when the app is in `app-src/`.
     *
     * @param context - the tab context
     */
    public section(context: AgentContext): string {
        if (context.projectType === "game" || context.projectType === "existing" || !this.external) {
            return "";
        }
        const folder = AppFolderPrompt.forward(this.workspace.appSrcDir);
        if (this.workspace.appRoot === null) {
            return [
                "## The app folder",
                `The generated app is in \`${folder}\`, which is not available on this computer right now. Do not`,
                "read or write app code anywhere else; tell the user to press Build and pick the folder again.",
            ].join("\n");
        }
        return [
            "## The app folder",
            `The generated app is in \`${folder}\`, outside your working directory. Where a task or a tool`,
            "answer says `app-src`, it means this folder. Use absolute paths for its files; when a task asks",
            "for paths relative to the app, leave the folder out.",
        ].join("\n");
    }

    /**
     * Wraps a permission policy: writes to the unused `app-src/` of the project folder are refused.
     *
     * @param inner - the policy
     */
    public permissions(inner: ToolPermissionHandler): ToolPermissionHandler {
        if (!this.external) {
            return inner;
        }
        return {
            decide: (request: ToolUseRequest): Promise<ToolUseDecision> => {
                if (AppFolderPrompt.WRITE_TOOLS.has(request.toolName) && this.namesUnused(request.input)) {
                    return Promise.resolve({
                        allow: false,
                        message: `The app is in ${this.workspace.appSrcDir}; use the absolute path of the file there.`,
                    });
                }
                return inner.decide(request);
            },
        };
    }

    private namesUnused(input: Record<string, unknown>): boolean {
        const norm = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
        return AppFolderPrompt.PATH_FIELDS.map((field) => input[field])
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .some((value) => {
                const rel = relative(norm(this.workspace.internalAppDir), norm(resolve(this.workspace.root, value)));
                return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
            });
    }

    private static forward(path: string): string {
        return path.split("\\").join("/").replace(/\/+$/, "");
    }
}
