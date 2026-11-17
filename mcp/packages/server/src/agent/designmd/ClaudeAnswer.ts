/**
 * Reader of the structured parts of Claude's answers in DESIGN.md workflows.
 */
export class ClaudeAnswer {
    private constructor() {}

    /**
     * Gets a whole DESIGN.md out of an answer: the text itself, or the content of the one fence
     * that wraps it, starting at its `---` front matter line.
     *
     * @param answer - Claude's answer
     * @returns the DESIGN.md text ending with a newline, or null if the answer has none
     */
    public static designMd(answer: string): string | null {
        let text = answer.replace(/\r\n?/g, "\n").trim();
        const wrapped = /^(`{3,}|~{3,})[a-z]*\n([\s\S]*)\n\1$/.exec(text);
        if (wrapped) {
            text = wrapped[2].trim();
        }
        const start = text.startsWith("---\n") ? 0 : text.indexOf("\n---\n") + 1;
        if (start < 0 || !text.slice(start).startsWith("---\n")) {
            return null;
        }
        text = text.slice(start);
        // a fence closing a wrapper that started before the front matter
        const fenceEnd = /\n(`{3,}|~{3,})\s*$/.exec(text);
        if (fenceEnd && !ClaudeAnswer.hasOpeningFence(text.slice(0, fenceEnd.index), fenceEnd[1])) {
            text = text.slice(0, fenceEnd.index);
        }
        return text.trimEnd() + "\n";
    }

    /**
     * Gets the JSON object out of an answer (the last `{…}` block, fenced or not).
     *
     * @param answer - Claude's answer
     * @returns the parsed object, or null if there is none
     */
    public static json(answer: string): Record<string, unknown> | null {
        const fenced = [...answer.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((match) => match[1]);
        const candidates = [...fenced.reverse()];
        const first = answer.indexOf("{");
        const last = answer.lastIndexOf("}");
        if (first >= 0 && last > first) {
            candidates.push(answer.slice(first, last + 1));
        }
        for (const candidate of candidates) {
            try {
                const value = JSON.parse(candidate);
                if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                    return value as Record<string, unknown>;
                }
            } catch {
                // try the next candidate
            }
        }
        return null;
    }

    private static hasOpeningFence(text: string, fence: string): boolean {
        const count = text.split("\n").filter((line) => line.trim().startsWith(fence)).length;
        return count % 2 === 1;
    }
}
