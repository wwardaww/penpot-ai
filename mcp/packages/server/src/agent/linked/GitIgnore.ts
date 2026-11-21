/**
 * Matcher for `.gitignore` rules of one folder: `#` comments, `!` negation, a leading `/` (or a `/`
 * inside the pattern) anchors to the folder, a trailing `/` matches folders only, `*`, `?`, `[…]`
 * and `**`. Later rules win, as in git. Paths are relative to the folder, with `/` separators.
 */
export class GitIgnore {
    private readonly rules: Array<{ regex: RegExp; negate: boolean; dirOnly: boolean }> = [];

    /**
     * @param text - the content of a `.gitignore` file
     */
    constructor(text: string) {
        for (const rawLine of text.split(/\r?\n/)) {
            const rule = GitIgnore.parse(rawLine);
            if (rule !== null) {
                this.rules.push(rule);
            }
        }
    }

    /** Whether the file holds no rule. */
    public get empty(): boolean {
        return this.rules.length === 0;
    }

    /**
     * Tells whether a path is ignored by these rules.
     *
     * @param relativePath - path relative to the folder of the `.gitignore`, `/` separated
     * @param isDir - whether the path is a folder
     * @returns true (ignored), false (re-included by a `!` rule) or null (no rule matched)
     */
    public match(relativePath: string, isDir: boolean): boolean | null {
        let result: boolean | null = null;
        for (const rule of this.rules) {
            if (rule.dirOnly && !isDir) {
                continue;
            }
            if (rule.regex.test(relativePath)) {
                result = !rule.negate;
            }
        }
        return result;
    }

    private static parse(rawLine: string): { regex: RegExp; negate: boolean; dirOnly: boolean } | null {
        let line = rawLine.replace(/(?<!\\)\s+$/, "");
        if (line.length === 0 || line.startsWith("#")) {
            return null;
        }
        let negate = false;
        if (line.startsWith("!")) {
            negate = true;
            line = line.slice(1);
        }
        line = line.replace(/^\\([#!])/, "$1");
        let dirOnly = false;
        if (line.endsWith("/")) {
            dirOnly = true;
            line = line.slice(0, -1);
        }
        if (line.length === 0) {
            return null;
        }
        const anchored = line.includes("/");
        if (line.startsWith("/")) {
            line = line.slice(1);
        }
        const body = GitIgnore.globToRegex(line);
        const regex = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
        return { regex, negate, dirOnly };
    }

    private static globToRegex(glob: string): string {
        let out = "";
        for (let i = 0; i < glob.length; i++) {
            const char = glob[i];
            if (char === "*") {
                if (glob[i + 1] === "*") {
                    const slashAfter = glob[i + 2] === "/";
                    out += slashAfter ? "(?:.*/)?" : ".*";
                    i += slashAfter ? 2 : 1;
                } else {
                    out += "[^/]*";
                }
            } else if (char === "?") {
                out += "[^/]";
            } else if (char === "[") {
                const end = glob.indexOf("]", i + 1);
                if (end === -1) {
                    out += "\\[";
                } else {
                    const set = glob
                        .slice(i + 1, end)
                        .replace(/^!/, "^")
                        .replace(/\\/g, "\\\\");
                    out += `[${set}]`;
                    i = end;
                }
            } else if (char === "\\" && i + 1 < glob.length) {
                out += GitIgnore.escape(glob[i + 1]);
                i++;
            } else {
                out += GitIgnore.escape(char);
            }
        }
        return out;
    }

    private static escape(char: string): string {
        return /[.+^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
    }
}
