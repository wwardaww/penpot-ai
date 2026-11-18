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
    private readonly logger = createLogger("DesignDecisions");

    /**
     * @param workspace - the project folder
     */
    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /**
     * Records a decision.
     *
     * @param decision - one line of text, e.g. `Progress Card: fill #ff9a3d → #f26b1d on every screen`
     * @returns true when DESIGN.md was updated and committed
     */
    public async record(decision: string): Promise<boolean> {
        const line = decision.replace(/\s+/g, " ").trim();
        if (line.length === 0) {
            return false;
        }
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
            return (await repository.commit(`record decision: ${line}`)) !== null;
        } catch (error) {
            this.logger.warn("Could not record a design decision: %s", String(error));
            return false;
        }
    }
}
