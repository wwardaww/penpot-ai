import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { DesignMdBody, DesignMdParser, DesignMdRepository, DesignMdSerializer } from "../designmd";
import { createLogger } from "../../logger";

/**
 * Recorder of design decisions in the project's DESIGN.md (W22), so later screens follow them.
 *
 * A decision becomes one bullet at the end of the `## Do's and Don'ts` section (created at its
 * spec position when missing); nothing else of the file changes. Projects without a DESIGN.md are
 * left alone: the file is only written when the user made one.
 */
export class DesignDecisions {
    /** Heading of the section that holds the decisions. */
    public static readonly SECTION = "Do's and Don'ts";
    /** Longest layer name written; longer names are cut. */
    public static readonly MAX_NAME_LENGTH = 60;
    /** Longest change text written. */
    public static readonly MAX_CHANGE_LENGTH = 240;
    private readonly logger = createLogger("DesignDecisions");

    /**
     * @param workspace - the project folder
     */
    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /**
     * Records that a layer's style changed on every screen.
     *
     * The layer name comes from the design (people, imported files), so it is written as quoted
     * data only: no line breaks, no Markdown or quote characters, at most
     * {@link MAX_NAME_LENGTH} characters. The sentence around it is fixed.
     *
     * @param layerName - the layer name
     * @param change - the change, old → new (see `DesignTree.describeChange`)
     * @param seqNumber - number of the comment the decision came from
     * @returns true when DESIGN.md was updated and committed
     */
    public async record(layerName: string, change: string, seqNumber: number): Promise<boolean> {
        const name = DesignDecisions.clean(layerName, DesignDecisions.MAX_NAME_LENGTH);
        const what = DesignDecisions.clean(change, DesignDecisions.MAX_CHANGE_LENGTH, true);
        if (name.length === 0 || what.length === 0) {
            return false;
        }
        const line = `Layer "${name}" on every screen: ${what} (from comment #${Math.trunc(seqNumber)}).`;
        try {
            const repository = new DesignMdRepository(this.workspace);
            const check = await repository.prepareWrite();
            if (check.current === null) {
                return false;
            }
            const document = DesignMdParser.parse(check.current).document;
            const bullet = `- ${line}`;
            const existing = DesignMdBody.section(document, DesignDecisions.SECTION);
            const updated =
                existing && existing.body.trim().length > 0
                    ? {
                          ...document,
                          sections: document.sections.map((section) =>
                              section === existing
                                  ? { ...section, body: `${section.body.trimEnd()}\n${bullet}` }
                                  : section
                          ),
                      }
                    : DesignMdBody.fillSection(document, DesignDecisions.SECTION, bullet);
            await repository.write(DesignMdSerializer.serialize(updated));
            return (await repository.commit(`record decision for layer "${name}"`)) !== null;
        } catch (error) {
            this.logger.warn("Could not record a design decision: %s", String(error));
            return false;
        }
    }

    /**
     * Text as plain data: one line, no Markdown, quote or control characters, cut to `max`.
     *
     * @param text - the text
     * @param max - most characters
     * @param keepHash - keep `#` (color values of a change text)
     */
    public static clean(text: string, max: number, keepHash: boolean = false): string {
        const markup = keepHash ? /[`*_[\]()<>|\\"{}~]+/g : /[`*_#[\]()<>|\\"{}~]+/g;
        const plain = text
            .replace(/\p{Cc}+/gu, " ")
            .replace(markup, "")
            .replace(/\s+/g, " ")
            .trim();
        return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
    }
}
