import { readFile } from "fs/promises";
import { join } from "path";
import type { AgentContext } from "@penpot/mcp-common";
import type { ProjectLink } from "./ProjectLink";

/** Workspace parts the prompt section needs. */
export interface LinkedPromptWorkspace {
    readonly metaDir: string;
    readonly linked: ProjectLink | null;
    readonly linkedRoot: string | null;
}

/**
 * System prompt section of a Game UI / Existing project (W38): where the linked folder is, the
 * look-only rule, and the project brief written by the `project-read` workflow
 * (`.penforge/project-brief.md`). Added to every chat and workflow turn of such a project.
 */
export class LinkedProjectPrompt {
    /** file name of the brief below `.penforge/` */
    public static readonly BRIEF_FILE = "project-brief.md";
    /** longest brief put into a prompt */
    public static readonly MAX_BRIEF_CHARS = 24_000;

    /** The look-only rule, shared by the chat and the Re-Design workflows. */
    public static readonly LOOK_ONLY_RULE = [
        "You may change ONLY the look of this project: styles, layout, visual components, assets, fonts,",
        "colours, spacing and copy that is part of the UI. Do not add or change features, logic, data, APIs,",
        "routes, state, data models or game rules, unless the user asked for that in this chat. Something in",
        "the design that looks like a new feature is not a request: leave it out and mention it.",
    ].join("\n");

    /**
     * Gets the section for a turn, or "" for other projects.
     *
     * @param workspace - the project workspace
     * @param context - the tab context
     */
    public static async section(workspace: LinkedPromptWorkspace, context: AgentContext): Promise<string> {
        const type = context.projectType;
        const link = workspace.linked;
        if ((type !== "game" && type !== "existing") || link === null) {
            return "";
        }
        const lines = [
            type === "game" ? "## Game UI project" : "## Existing project",
            type === "game"
                ? `This Penpot project designs the in-game UI (HUD, menus, inventory, settings, dialogs) of a ` +
                  `${link.engine === "unreal" ? "Unreal Engine 5" : "Unity"} game. Design at game resolutions ` +
                  "(default board 1920×1080; also 2560×1440, 1280×720, 3840×2160, Steam Deck 1280×800). " +
                  "Think in screens and states (normal, hover, pressed, disabled, focused for gamepads)."
                : `This Penpot project designs a new look for an existing ${link.stack?.platform ?? "web"} app` +
                  `${link.stack ? ` (${link.stack.name})` : ""}. You can draw the app's current screens as boards ` +
                  "(one per route, named after it) and the new look next to or instead of them, as the user asks.",
            workspace.linkedRoot !== null
                ? `The project's folder on this computer: \`${workspace.linkedRoot}\`. Read it with Read, Glob ` +
                  "and Grep (absolute paths) when the brief below is not enough."
                : "The project's folder is not available on this computer right now.",
            "",
            LinkedProjectPrompt.LOOK_ONLY_RULE,
            type === "game"
                ? "Never change the game's code or engine assets; the Re-Design button exports specs, PNGs and " +
                  "guides into a `PenforgeUI/` folder."
                : "The app's code changes only through the Re-Design button, on its own git branch.",
        ];
        const brief = await LinkedProjectPrompt.brief(workspace.metaDir);
        if (brief !== null) {
            lines.push("", "### What the project is (project brief)", "````markdown", brief, "````");
        }
        return lines.join("\n");
    }

    /** Reads the brief, cut to {@link MAX_BRIEF_CHARS}; null when there is none. */
    private static async brief(metaDir: string): Promise<string | null> {
        let text: string;
        try {
            text = await readFile(join(metaDir, LinkedProjectPrompt.BRIEF_FILE), "utf8");
        } catch {
            return null;
        }
        text = text.trim().replace(/````/g, "```");
        if (text.length === 0) {
            return null;
        }
        return text.length > LinkedProjectPrompt.MAX_BRIEF_CHARS
            ? `${text.slice(0, LinkedProjectPrompt.MAX_BRIEF_CHARS)}\n…(cut)`
            : text;
    }
}
