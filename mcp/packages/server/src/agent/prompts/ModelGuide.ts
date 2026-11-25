import type { WorkflowToolFilter } from "@penpot/mcp-common";
import { createLogger } from "../../logger";
import { SkillLibrary } from "../skills/SkillLibrary";

/** Turn a {@link ModelGuide} may be added to. */
export interface GuidedTurn {
    /** workflow prompt of the turn */
    workflow?: string;
    /** what the turn's tools may do */
    toolFilter?: WorkflowToolFilter;
}

/**
 * Drawing guide for models other than Claude (`prompts/model-guide.md`).
 *
 * Local models started through the user's own Claude command know neither the Penpot API nor how to
 * work on a canvas. The guide goes into the system prompt of the turns that draw: those whose
 * workflow prompt makes a design ({@link SkillLibrary.DESIGNING}) and whose tools let them run the
 * scripts the guide teaches. With Claude no prompt changes.
 */
export class ModelGuide {
    /** workflow prompts that make a design as text and leave the canvas alone */
    public static readonly TEXT_ONLY: ReadonlySet<string> = new Set(["design-md-draft"]);

    /** what the guide asks for: a script that keeps shapes in `storage` */
    private static readonly SCRIPT = {
        tool: "mcp__penpot__execute_code",
        code: "storage.board = penpot.createBoard();",
    };

    private readonly logger = createLogger("ModelGuide");

    /**
     * @param text - the guide
     * @param isNeeded - whether the next turn runs another model than Claude
     */
    constructor(
        private readonly text: string,
        private readonly isNeeded: () => boolean
    ) {}

    /**
     * Gets the guide for the system prompt of a turn, and logs that it is sent.
     *
     * @param turn - the turn
     * @returns the guide, or undefined when the turn runs Claude or does not draw
     */
    public section(turn: GuidedTurn): string | undefined {
        if (!this.isNeeded() || !ModelGuide.draws(turn)) {
            return undefined;
        }
        this.logger.info("Drawing guide added to the system prompt (%s)", turn.workflow);
        return this.text.trim();
    }

    /**
     * Whether a turn draws on the canvas with scripts.
     *
     * @param turn - the turn
     */
    public static draws({ workflow, toolFilter }: GuidedTurn): boolean {
        if (SkillLibrary.targetOf(workflow) !== "canvas" || ModelGuide.TEXT_ONLY.has(workflow!)) {
            return false;
        }
        const { tool, code } = ModelGuide.SCRIPT;
        return !toolFilter || toolFilter.check(tool, { code }) === null;
    }
}
