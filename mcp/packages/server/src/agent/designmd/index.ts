import type { WorkflowContext } from "@penpot/mcp-common";
import { DesignMdParser } from "./DesignMdParser";
import { DesignMdRepository } from "./DesignMdRepository";
import type { DesignMdDocument, DesignMdIssue } from "./DesignMdTypes";
import { DesignMdValidator } from "./DesignMdValidator";

export * from "./DesignMdTypes";
export { CssColor, CssValues } from "./CssValues";
export { DesignMdParser } from "./DesignMdParser";
export { DesignMdSerializer } from "./DesignMdSerializer";
export { DesignMdValidator } from "./DesignMdValidator";
export { DesignMdReferences } from "./DesignMdReferences";
export { DesignMdBody } from "./DesignMdBody";
export { DesignMdRepository } from "./DesignMdRepository";
export { DesignMdFromPenpot } from "./DesignMdFromPenpot";
export { DtcgTokens } from "./DtcgTokens";
export { PenpotImportPlanner } from "./PenpotImportPlan";
export { PenpotScripts } from "./PenpotScripts";
export { ClaudeAnswer } from "./ClaudeAnswer";
export { DesignMdFailure, DesignMdRun } from "./DesignMdRun";
export type { DesignMdFailureCode, DesignMdProgressCode } from "./DesignMdRun";

/** DESIGN.md of a project as loaded by {@link loadDesignMd}. */
export interface LoadedDesignMd {
    /** the file text */
    text: string;
    document: DesignMdDocument;
    /** parse and validation issues, errors first */
    issues: DesignMdIssue[];
    /** absolute path of the file */
    path: string;
}

/**
 * Parses and validates DESIGN.md text.
 *
 * @param text - the file content
 */
export function parseDesignMd(text: string): { document: DesignMdDocument; issues: DesignMdIssue[] } {
    const parsed = DesignMdParser.parse(text);
    const issues = [...parsed.issues, ...DesignMdValidator.validate(parsed.document)];
    return {
        document: parsed.document,
        issues: [...issues.filter((i) => i.severity === "error"), ...issues.filter((i) => i.severity === "warning")],
    };
}

/**
 * Loads the DESIGN.md of the run's project (`design/DESIGN.md`).
 *
 * For workflows that want the design system as context (W13 generate-screen, W08 build, W15
 * audit…):
 * ```ts
 * const designMd = await loadDesignMd(ctx);
 * if (designMd) { ...designMd.document.tokens.colors... }
 * ```
 *
 * @param ctx - the workflow context
 * @returns the parsed file, or null when the project has none
 */
export async function loadDesignMd(ctx: Pick<WorkflowContext, "workspace">): Promise<LoadedDesignMd | null> {
    const repository = new DesignMdRepository(ctx.workspace);
    const text = await repository.read();
    if (text === null) {
        return null;
    }
    return { text, ...parseDesignMd(text), path: repository.path };
}

/**
 * Gets the project's DESIGN.md as a system prompt section, ready for `runner.run({
 * systemPromptAppend })`.
 *
 * @param ctx - the workflow context
 * @param maxChars - cut the file after this many characters
 * @returns the section, or "" when the project has no DESIGN.md
 */
export async function designMdPromptContext(
    ctx: Pick<WorkflowContext, "workspace">,
    maxChars: number = 12000
): Promise<string> {
    const designMd = await loadDesignMd(ctx);
    if (designMd === null || designMd.text.trim().length === 0) {
        return "";
    }
    const text = designMd.text.length > maxChars ? `${designMd.text.slice(0, maxChars)}\n…(cut)` : designMd.text;
    return [
        "## Project design system (DESIGN.md)",
        "Follow this design system: use its colors, typography, spacing, radius and component specs, and the",
        "matching library entries and tokens (`color.<name>`, `radius.<name>`, `spacing.<name>`) in the file.",
        "",
        "````markdown",
        text.trimEnd(),
        "````",
    ].join("\n");
}
