import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { DesignMdRepository } from "../../designmd";
import { designSystemDesignMd } from "../DesignSystemWorkspace";
import type { DesignSystemBinding } from "./Binding";

/** Heading of the section that points at the linked design system. */
export const POINTER_HEADING = "## Linked design system";

/** What the pointer step did. */
export interface PointerReport {
    /** `copied`: the project had no DESIGN.md and got the system's; `updated`: section written */
    outcome: "copied" | "updated" | "unchanged" | "skipped";
    commit: string | null;
}

/**
 * Makes the project's DESIGN.md point at its design system (W30). A project without a DESIGN.md
 * gets the design system's own (so every workflow that reads DESIGN.md follows the system), with
 * the section at the end; a project with one gets the section added or replaced. W22 keeps
 * unknown sections, so the section survives DESIGN.md imports and exports.
 */
export class DesignMdPointer {
    /**
     * @param project - the project's workspace
     * @param system - the workspace of the project holding the design system
     */
    constructor(
        private readonly project: WorkflowWorkspaceApi,
        private readonly system: WorkflowWorkspaceApi
    ) {}

    public async link(binding: DesignSystemBinding): Promise<PointerReport> {
        const repository = new DesignMdRepository(this.project);
        const current = await repository.read();
        let next: string;
        let outcome: PointerReport["outcome"];
        if (current === null) {
            const systemText = await designSystemDesignMd(this.system, binding.fileId)
                .read()
                .catch(() => null);
            if (systemText === null) {
                return { outcome: "skipped", commit: null };
            }
            next = DesignMdPointer.withSection(systemText, binding);
            outcome = "copied";
        } else {
            next = DesignMdPointer.withSection(current, binding);
            outcome = next === DesignMdRepository.normalize(current) ? "unchanged" : "updated";
        }
        if (outcome === "unchanged") {
            return { outcome, commit: null };
        }
        await repository.write(next);
        const commit = await repository.commit(`link design system ${binding.name}`);
        return { outcome, commit };
    }

    /** The section text for a binding. */
    public static section(binding: DesignSystemBinding): string {
        const name = binding.name.replace(/[\r\n`]/g, " ").trim() || "Design system";
        return [
            POINTER_HEADING,
            "",
            `This project uses the design system "${name}" (Penpot shared library, file id ${binding.fileId}).`,
            "Use only its colors, text styles, tokens and components; never invent new ones. What the design",
            'needs and the system lacks goes to the missing items list ("Add to design system" / "Don\'t add").',
            `Its DESIGN.md lives with the design system: \`design/systems/${binding.fileId}/DESIGN.md\` of the`,
            "Design Systems project.",
        ].join("\n");
    }

    /** The text with the section added at the end or put in place of the old one. */
    public static withSection(text: string, binding: DesignSystemBinding): string {
        const normalized = DesignMdRepository.normalize(text);
        const section = DesignMdPointer.section(binding);
        const start = normalized.indexOf(`\n${POINTER_HEADING}`);
        if (start < 0) {
            return DesignMdRepository.normalize(`${normalized.trimEnd()}\n\n${section}\n`);
        }
        const after = normalized.indexOf("\n## ", start + POINTER_HEADING.length + 1);
        const tail = after < 0 ? "" : normalized.slice(after);
        return DesignMdRepository.normalize(`${normalized.slice(0, start).trimEnd()}\n\n${section}\n${tail}`);
    }
}
