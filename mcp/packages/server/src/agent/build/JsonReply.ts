import type { z } from "zod";

/**
 * Reader of the JSON object Claude puts at the end of a build turn.
 *
 * Claude is asked to end its reply with one fenced ```json block. The last such block wins; when
 * there is none, the last top-level `{…}` of the text is tried.
 */
export class JsonReply {
    private static readonly FENCE = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;

    /**
     * Parses the JSON object of a reply.
     *
     * @param text - the reply text
     * @param schema - schema the object must satisfy
     * @returns the validated object, or null when the reply has no valid object
     */
    public static parse<T>(text: string, schema: z.ZodType<T>): T | null {
        for (const candidate of JsonReply.candidates(text)) {
            let value: unknown;
            try {
                value = JSON.parse(candidate);
            } catch {
                continue;
            }
            const parsed = schema.safeParse(value);
            if (parsed.success) {
                return parsed.data;
            }
        }
        return null;
    }

    /** JSON candidates of a reply, most likely first. */
    private static candidates(text: string): string[] {
        const fenced = [...text.matchAll(JsonReply.FENCE)].map((match) => match[1].trim()).reverse();
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        const bare = start >= 0 && end > start ? [text.slice(start, end + 1)] : [];
        return [...fenced, ...bare];
    }
}
