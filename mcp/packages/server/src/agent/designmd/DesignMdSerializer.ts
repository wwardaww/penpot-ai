import * as yaml from "js-yaml";
import type { DesignMdDocument, DesignMdTokens } from "./DesignMdTypes";

/**
 * Deterministic writer of a {@link DesignMdDocument} as DESIGN.md text.
 *
 * Front matter keys come in a fixed order (`version`, `name`, `description`, `omitted`, `colors`,
 * `typography`, `rounded`, `spacing`, `components`, then unknown keys); token names keep their map
 * order; typography properties come in spec order. Strings are quoted only when YAML needs it.
 * `DesignMdParser.parse(serialize(doc))` gives back `doc`, and serializing that again gives the
 * same text.
 */
export class DesignMdSerializer {
    private static readonly TYPOGRAPHY_ORDER = [
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "fontFeature",
        "fontVariation",
    ];

    private static readonly PLAIN_KEY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;
    private static readonly PLAIN_STRING_PATTERN = /^-?[A-Za-z0-9][^"'#{}[\]`|>&*!%@,\\]*$/;

    private constructor() {}

    /**
     * Writes a document as text, ending with a newline.
     *
     * @param document - the document
     */
    public static serialize(document: DesignMdDocument): string {
        const parts = [`---\n${DesignMdSerializer.frontMatter(document.tokens)}---`];
        if (document.preamble.length > 0) {
            parts.push(document.preamble);
        }
        for (const section of document.sections) {
            parts.push(section.body.length > 0 ? `## ${section.heading}\n\n${section.body}` : `## ${section.heading}`);
        }
        return parts.join("\n\n") + "\n";
    }

    /**
     * Writes the YAML of a token set (without the `---` fences).
     *
     * @param tokens - the tokens
     */
    public static frontMatter(tokens: DesignMdTokens): string {
        const lines: string[] = [];
        for (const key of ["version", "name", "description"] as const) {
            if (tokens[key] !== undefined) {
                lines.push(`${key}: ${DesignMdSerializer.scalar(tokens[key]!)}`);
            }
        }
        if (tokens.omitted && tokens.omitted.length > 0) {
            lines.push("omitted:");
            for (const entry of tokens.omitted) {
                if (typeof entry === "string") {
                    lines.push(`  - ${DesignMdSerializer.scalar(entry)}`);
                } else {
                    lines.push(`  - section: ${DesignMdSerializer.scalar(entry.section)}`);
                    if (entry.reason !== undefined) {
                        lines.push(`    reason: ${DesignMdSerializer.scalar(entry.reason)}`);
                    }
                }
            }
        }
        DesignMdSerializer.scalarGroup(lines, "colors", tokens.colors);
        DesignMdSerializer.compositeGroup(lines, "typography", tokens.typography, DesignMdSerializer.TYPOGRAPHY_ORDER);
        DesignMdSerializer.scalarGroup(lines, "rounded", tokens.rounded);
        DesignMdSerializer.scalarGroup(lines, "spacing", tokens.spacing);
        DesignMdSerializer.compositeGroup(lines, "components", tokens.components, []);
        for (const [key, value] of Object.entries(tokens.extra)) {
            const dumped = yaml.dump({ [key]: value }, { lineWidth: -1, noRefs: true, sortKeys: false });
            lines.push(dumped.replace(/\n$/, ""));
        }
        return lines.length > 0 ? lines.join("\n") + "\n" : "";
    }

    private static scalarGroup(lines: string[], group: string, values: Record<string, string | number>): void {
        const entries = Object.entries(values);
        if (entries.length === 0) {
            return;
        }
        lines.push(`${group}:`);
        for (const [name, value] of entries) {
            lines.push(`  ${DesignMdSerializer.key(name)}: ${DesignMdSerializer.scalar(value)}`);
        }
    }

    private static compositeGroup(
        lines: string[],
        group: string,
        values: Record<string, Record<string, unknown>>,
        order: string[]
    ): void {
        const entries = Object.entries(values);
        if (entries.length === 0) {
            return;
        }
        lines.push(`${group}:`);
        for (const [name, properties] of entries) {
            const keys = Object.keys(properties);
            if (keys.length === 0) {
                lines.push(`  ${DesignMdSerializer.key(name)}: {}`);
                continue;
            }
            lines.push(`  ${DesignMdSerializer.key(name)}:`);
            const ordered = [
                ...order.filter((key) => keys.includes(key)),
                ...keys.filter((key) => !order.includes(key)),
            ];
            for (const property of ordered) {
                const value = properties[property];
                if (value === undefined) {
                    continue;
                }
                lines.push(
                    `    ${DesignMdSerializer.key(property)}: ${DesignMdSerializer.scalar(value as string | number)}`
                );
            }
        }
    }

    private static key(name: string): string {
        return DesignMdSerializer.PLAIN_KEY_PATTERN.test(name) ? name : JSON.stringify(name);
    }

    /**
     * Writes a scalar: numbers bare, strings plain when YAML reads them back as the same string,
     * else double-quoted.
     */
    private static scalar(value: string | number): string {
        if (typeof value === "number") {
            return String(value);
        }
        if (
            DesignMdSerializer.PLAIN_STRING_PATTERN.test(value) &&
            !value.includes(": ") &&
            !value.endsWith(":") &&
            value.trim() === value &&
            DesignMdSerializer.readsBackAs(value)
        ) {
            return value;
        }
        return JSON.stringify(value);
    }

    private static readsBackAs(text: string): boolean {
        try {
            const loaded = yaml.load(`v: ${text}`, { schema: yaml.CORE_SCHEMA }) as { v?: unknown } | null;
            return loaded?.v === text;
        } catch {
            return false;
        }
    }
}
