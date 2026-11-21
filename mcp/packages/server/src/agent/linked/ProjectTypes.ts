import type { AgentContext, ContextSetMessage, LinkedProjectKind, Platform, ScreenPlatform } from "@penpot/mcp-common";
import type { ProjectLink } from "./ProjectLink";

/**
 * Project types (W38): what the screens of each type are designed for.
 *
 * Web and mobile projects design for their platform. A Game UI project designs game screens at
 * game resolutions, closest to `web` where a web/mobile choice is needed (wide, pointer or
 * controller). An Existing project designs for the platform detected in its code (`web` until
 * known).
 */
export class ProjectTypes {
    /**
     * Tells whether a project type is linked to a folder of this computer.
     *
     * @param type - the project type
     */
    public static isLinked(type: Platform | undefined): type is LinkedProjectKind {
        return type === "game" || type === "existing";
    }

    /**
     * Gets the screen platform of a project type.
     *
     * @param type - the project type
     * @param link - the project's link, whose detected stack decides for an Existing project
     */
    public static screenPlatform(type: Platform, link: ProjectLink | null = null): ScreenPlatform {
        switch (type) {
            case "mobile":
                return "mobile";
            case "existing":
                return link?.stack?.platform ?? "web";
            default:
                return "web";
        }
    }

    /**
     * Gets the agent context of a `context.set`: `platform` becomes the screen platform and the
     * chosen type moves to `projectType`.
     *
     * @param sent - the message fields without `type`
     */
    public static context(sent: Omit<ContextSetMessage, "type">): AgentContext {
        return { ...sent, platform: ProjectTypes.screenPlatform(sent.platform), projectType: sent.platform };
    }

    /**
     * Refines a context with the project's link (the detected platform of an Existing project).
     *
     * @param context - the context
     * @param link - the project's link
     */
    public static withLink(context: AgentContext, link: ProjectLink | null): AgentContext {
        const type = context.projectType ?? context.platform;
        const platform = ProjectTypes.screenPlatform(type, link);
        return platform === context.platform ? context : { ...context, platform };
    }
}
