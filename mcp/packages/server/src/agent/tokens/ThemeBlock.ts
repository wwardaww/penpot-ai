import type { CommentStyle } from "./ThemeGenerator";
import { TokenSyncError } from "./TokenSyncError";

/** Where a theme file's generated block is. */
interface BlockRange {
    /** index of the begin marker line */
    begin: number;
    /** index of the end marker line */
    end: number;
}

/**
 * The generated part of a theme file: lines between a `penforge:tokens:begin` and a
 * `penforge:tokens:end` marker comment. Penforge owns those lines and rewrites them on every sync;
 * the rest of the file (written by the build or by hand) is never touched.
 *
 * A file without a block gets one after its prologue (directives, comments, imports), keeping
 * its line endings.
 */
export class ThemeBlock {
    public static readonly BEGIN = "penforge:tokens:begin";
    public static readonly END = "penforge:tokens:end";

    private static readonly NOTE = "generated from the Penpot design tokens; change the tokens in Penpot, not here";

    private constructor() {}

    /** Tells whether a text holds a complete block. */
    public static has(text: string): boolean {
        return ThemeBlock.find(ThemeBlock.lines(text)) !== null;
    }

    /**
     * Gets the text without its block, so searches for token uses skip the generated lines.
     *
     * @param text - the file text
     */
    public static strip(text: string): string {
        const lines = ThemeBlock.lines(text);
        const range = ThemeBlock.find(lines);
        return range === null ? text : [...lines.slice(0, range.begin), ...lines.slice(range.end + 1)].join("\n");
    }

    /**
     * Gets the block lines of a text (markers included), or null without a block.
     *
     * @param text - the file text
     */
    public static extract(text: string): string | null {
        const lines = ThemeBlock.lines(text);
        const range = ThemeBlock.find(lines);
        return range === null ? null : lines.slice(range.begin, range.end + 1).join("\n");
    }

    /**
     * Writes a block body into a file text: replaces the existing block, or inserts one.
     *
     * @param text - the current file text ("" for a new file)
     * @param body - the block body lines (without markers)
     * @param comment - comment syntax of the file
     * @param prologue - how the file's leading part looks, to insert after it
     * @returns the new text
     * @throws TokenSyncError `broken-block` when only one marker is present
     */
    public static write(text: string, body: string[], comment: CommentStyle, prologue: "js" | "css"): string {
        const eol = text.includes("\r\n") ? "\r\n" : "\n";
        const lines = ThemeBlock.lines(text);
        const block = [
            ThemeBlock.marker(comment, `${ThemeBlock.BEGIN} (${ThemeBlock.NOTE})`),
            ...body,
            ThemeBlock.marker(comment, ThemeBlock.END),
        ];
        const range = ThemeBlock.find(lines);
        let result: string[];
        if (range !== null) {
            result = [...lines.slice(0, range.begin), ...block, ...lines.slice(range.end + 1)];
        } else {
            const at = prologue === "js" ? ThemeBlock.jsPrologueEnd(lines) : ThemeBlock.cssPrologueEnd(lines);
            const before = lines.slice(0, at);
            const after = lines.slice(at);
            while (before.length > 0 && before[before.length - 1].trim() === "") {
                before.pop();
            }
            while (after.length > 0 && after[0].trim() === "") {
                after.shift();
            }
            result = [
                ...before,
                ...(before.length > 0 ? [""] : []),
                ...block,
                ...(after.length > 0 ? ["", ...after] : []),
            ];
        }
        let out = result.join(eol);
        if (!out.endsWith(eol)) {
            out += eol;
        }
        return out;
    }

    private static marker(comment: CommentStyle, text: string): string {
        return comment === "line" ? `// ${text}` : `/* ${text} */`;
    }

    private static lines(text: string): string[] {
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
        }
        return lines;
    }

    private static find(lines: string[]): BlockRange | null {
        const begin = lines.findIndex((line) => line.includes(ThemeBlock.BEGIN));
        const end = lines.findIndex((line) => line.includes(ThemeBlock.END));
        if (begin === -1 && end === -1) {
            return null;
        }
        if (begin === -1 || end === -1 || end < begin) {
            throw new TokenSyncError(
                "broken-block",
                "The theme file has a broken generated block (one of its marker comments is missing)."
            );
        }
        return { begin, end };
    }

    /**
     * Index of the first line after a JS/TS prologue: blank lines, comments, directives
     * (`"use client"`), imports (also multi-line) and `require` lines.
     */
    private static jsPrologueEnd(lines: string[]): number {
        return ThemeBlock.prologueEnd(lines, (line) => {
            if (/^["']use [a-z ]+["'];?$/.test(line) || /^(const|let|var)\s+[\w${}\s,:]+=\s*require\(/.test(line)) {
                return (index) => index;
            }
            if (/^import\b/.test(line) || /^export\s+(\*|\{[^}]*\})\s+from\b/.test(line)) {
                return (index) => ThemeBlock.lastLine(lines, index, (text) => /["'`]\s*;?\s*$/.test(text.trim()));
            }
            return null;
        });
    }

    /** Index of the first line after a CSS prologue: blank lines, comments and leading at-rules. */
    private static cssPrologueEnd(lines: string[]): number {
        return ThemeBlock.prologueEnd(lines, (line) =>
            /^@(charset|import|use|forward|plugin|config|source|reference)\b/.test(line)
                ? (index) => ThemeBlock.lastLine(lines, index, (text) => text.includes(";"))
                : null
        );
    }

    /**
     * Index of the first line after a file's prologue.
     *
     * Comments count as prologue only when a blank line or another prologue statement follows
     * them; a comment directly above code documents that code and stays with it.
     *
     * @param lines - the file lines
     * @param statement - for a trimmed line that starts a prologue statement, a function giving
     *   the index of the statement's last line; null for any other line
     */
    private static prologueEnd(
        lines: string[],
        statement: (line: string) => ((index: number) => number) | null
    ): number {
        let index = 0;
        let end = 0;
        while (index < lines.length) {
            const line = lines[index].trim();
            if (line === "") {
                index++;
                continue;
            }
            const isComment = line.startsWith("//") || line.startsWith("/*");
            if (isComment) {
                const last = line.startsWith("//")
                    ? ThemeBlock.lastLine(lines, index, (_, at) => !lines[at + 1]?.trim().startsWith("//"))
                    : ThemeBlock.lastLine(lines, index, (text) => text.includes("*/"));
                const next = lines[last + 1]?.trim();
                const nextIsCode =
                    next !== undefined &&
                    next !== "" &&
                    !next.startsWith("//") &&
                    !next.startsWith("/*") &&
                    statement(next) === null;
                if (nextIsCode) {
                    break;
                }
                index = last + 1;
                end = index;
                continue;
            }
            const lastOf = statement(line);
            if (lastOf === null) {
                break;
            }
            index = lastOf(index) + 1;
            end = index;
        }
        return Math.min(end, lines.length);
    }

    /** Index of the first line from `start` that matches, or the last line of the file. */
    private static lastLine(lines: string[], start: number, matches: (line: string, index: number) => boolean): number {
        for (let index = start; index < lines.length; index++) {
            if (matches(lines[index], index)) {
                return index;
            }
        }
        return lines.length - 1;
    }
}
