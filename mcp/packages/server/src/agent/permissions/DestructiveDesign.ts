/**
 * Detector of Penpot tool uses that delete whole pages, library items, tokens or comments (W11).
 *
 * Penpot MCP tools are allowed without asking, so a prompt injected through design content (a
 * comment, a layer name) could make Claude run `execute_code` that deletes pages or the shared
 * library. Such uses are put to the user first. Deleting single layers stays allowed: it is the
 * everyday design edit and Penpot's undo covers it.
 *
 * The check reads the code Claude sends, so it is a safety net, not a sandbox: code built to hide
 * its intent (string tricks, `eval`) gets through. The prompt rules stay the first line.
 */
export class DestructiveDesign {
    /** collections whose items a deletion must not reach silently */
    private static readonly COLLECTION =
        "pages?|components?|colou?rs?|typograph(?:y|ies)|tokens?|tokenSets?|sets?|themes?|librar(?:y|ies)|threads?|comments?";

    private static readonly RULES: { kind: string; pattern: RegExp }[] = [
        { kind: "pages", pattern: /\b(?:removePage|deletePage)\s*\(/ },
        { kind: "pages", pattern: /\b(?:current)?pages?(?:\[[^\]]*\])?\s*\??\.\s*remove\s*\(/i },
        {
            kind: "library items, tokens or comments",
            pattern: new RegExp(
                `\\b(?:${DestructiveDesign.COLLECTION})\\b(?:\\[[^\\]]*\\])?\\s*\\??\\.\\s*remove\\s*\\(`,
                "i"
            ),
        },
        {
            // a removal inside a loop or callback over one of the collections
            kind: "items of pages, the library or comments",
            pattern: new RegExp(
                `\\b(?:${DestructiveDesign.COLLECTION})\\b[^;]{0,80}(?:forEach|map|for\\s*\\()[\\s\\S]{0,200}?\\.remove\\s*\\(`,
                "i"
            ),
        },
        {
            // `for (const item of <collection>) { item.remove(); }`
            kind: "items of pages, the library or comments",
            pattern: new RegExp(
                `\\bfor\\s*\\([^)]*\\b(?:${DestructiveDesign.COLLECTION})\\b[^)]*\\)[\\s\\S]{0,200}?\\.remove\\s*\\(`,
                "i"
            ),
        },
    ];

    /**
     * Checks a Penpot tool use.
     *
     * @param toolName - the Penpot tool name without the `mcp__penpot__` prefix
     * @param input - the tool input
     * @returns what the use would delete, or null when it deletes no page, library item or comment
     */
    public static check(toolName: string, input: Record<string, unknown>): string | null {
        if (toolName !== "execute_code" || typeof input.code !== "string") {
            return null;
        }
        const code = DestructiveDesign.withoutComments(input.code);
        const hit = DestructiveDesign.RULES.find((rule) => rule.pattern.test(code));
        return hit ? hit.kind : null;
    }

    private static withoutComments(code: string): string {
        return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    }
}
