import * as yaml from "js-yaml";
import {
    emptyDesignMdTokens,
    type DesignMdComponent,
    type DesignMdDocument,
    type DesignMdIssue,
    type DesignMdOmitted,
    type DesignMdSection,
    type DesignMdTokens,
    type DesignMdTypography,
} from "./DesignMdTypes";

/** Result of parsing a DESIGN.md. */
export interface DesignMdParseResult {
    document: DesignMdDocument;
    /** structural problems (YAML syntax, wrong value types); see `DesignMdValidator` for the rest */
    issues: DesignMdIssue[];
}

/**
 * Parser of DESIGN.md text into a {@link DesignMdDocument}.
 *
 * Never throws: problems are reported as issues, and the values that could be read are kept.
 */
export class DesignMdParser {
    /** front matter keys this parser knows */
    public static readonly KNOWN_KEYS = [
        "version",
        "name",
        "description",
        "omitted",
        "colors",
        "typography",
        "rounded",
        "spacing",
        "components",
    ];

    private static readonly HEADING_PATTERN = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/;
    private static readonly FENCE_PATTERN = /^[ \t]{0,3}(```|~~~)/;

    private readonly issues: DesignMdIssue[] = [];

    private constructor() {}

    /**
     * Parses DESIGN.md text.
     *
     * @param text - the file content
     */
    public static parse(text: string): DesignMdParseResult {
        return new DesignMdParser().parseText(text);
    }

    private parseText(text: string): DesignMdParseResult {
        const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
        const lines = normalized.split("\n");
        let tokens = emptyDesignMdTokens();
        let bodyStart = 0;
        if (lines[0]?.trim() === "---") {
            const end = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
            if (end < 0) {
                this.issue(
                    "error",
                    "front-matter",
                    "The front matter has no closing --- line",
                    "front-matter-unclosed"
                );
                bodyStart = lines.length;
            } else {
                tokens = this.parseFrontMatter(lines.slice(1, end).join("\n"));
                bodyStart = end + 1;
            }
        } else {
            this.issue(
                "error",
                "front-matter",
                "The file does not start with a --- front matter block",
                "front-matter-missing"
            );
        }
        const { preamble, sections } = this.parseBody(lines.slice(bodyStart));
        return { document: { tokens, preamble, sections }, issues: this.issues };
    }

    private parseFrontMatter(source: string): DesignMdTokens {
        const tokens = emptyDesignMdTokens();
        let data: unknown;
        try {
            data = yaml.load(source, { schema: yaml.CORE_SCHEMA });
        } catch (error) {
            this.issue(
                "error",
                "front-matter",
                `Invalid YAML: ${error instanceof Error ? error.message : error}`,
                "yaml-invalid",
                {
                    detail: error instanceof Error ? error.message : String(error),
                }
            );
            return tokens;
        }
        if (data === null || data === undefined) {
            return tokens;
        }
        if (!DesignMdParser.isMap(data)) {
            this.issue("error", "front-matter", "The front matter must be a map of keys", "front-matter-not-map");
            return tokens;
        }
        for (const [key, value] of Object.entries(data)) {
            switch (key) {
                case "version":
                case "name":
                case "description":
                    if (typeof value === "string" || typeof value === "number") {
                        tokens[key] = String(value);
                    } else if (value !== null) {
                        this.issue("error", key, `${key} must be text`, "not-text");
                    }
                    break;
                case "omitted":
                    tokens.omitted = this.parseOmitted(value);
                    break;
                case "colors":
                    tokens.colors = this.parseScalarGroup(key, value, false) as Record<string, string>;
                    break;
                case "rounded":
                case "spacing":
                    tokens[key] = this.parseScalarGroup(key, value, true);
                    break;
                case "typography":
                    tokens.typography = this.parseCompositeGroup(key, value) as Record<string, DesignMdTypography>;
                    break;
                case "components":
                    tokens.components = this.parseCompositeGroup(key, value) as Record<string, DesignMdComponent>;
                    break;
                default:
                    tokens.extra[key] = value;
                    this.issue("warning", key, `Unknown front matter key "${key}" is kept as it is`, "unknown-key");
            }
        }
        return tokens;
    }

    private parseOmitted(value: unknown): DesignMdOmitted[] | undefined {
        if (value === null || value === undefined) {
            return undefined;
        }
        if (!Array.isArray(value)) {
            this.issue("error", "omitted", "omitted must be a list", "omitted-not-list");
            return undefined;
        }
        const result: DesignMdOmitted[] = [];
        for (const entry of value) {
            if (typeof entry === "string") {
                result.push(entry);
            } else if (DesignMdParser.isMap(entry) && typeof entry.section === "string") {
                result.push(
                    typeof entry.reason === "string"
                        ? { section: entry.section, reason: entry.reason }
                        : { section: entry.section }
                );
            } else {
                this.issue(
                    "error",
                    "omitted",
                    "Each omitted entry must be a section name or {section, reason}",
                    "omitted-entry"
                );
            }
        }
        return result;
    }

    private parseScalarGroup(group: string, value: unknown, allowNumbers: boolean): Record<string, string | number> {
        const result: Record<string, string | number> = {};
        if (value === null || value === undefined) {
            return result;
        }
        if (!DesignMdParser.isMap(value)) {
            this.issue("error", group, `${group} must be a map of token names to values`, "group-not-map");
            return result;
        }
        for (const [name, entry] of Object.entries(value)) {
            if (typeof entry === "string") {
                result[name] = entry;
            } else if (typeof entry === "number" && allowNumbers) {
                result[name] = entry;
            } else {
                this.issue(
                    "error",
                    `${group}.${name}`,
                    `${group}.${name} must be ${allowNumbers ? "a dimension or number" : "text"}`,
                    allowNumbers ? "not-dimension" : "not-text",
                    { value: String(entry) }
                );
            }
        }
        return result;
    }

    private parseCompositeGroup(group: string, value: unknown): Record<string, Record<string, unknown>> {
        const result: Record<string, Record<string, unknown>> = {};
        if (value === null || value === undefined) {
            return result;
        }
        if (!DesignMdParser.isMap(value)) {
            this.issue("error", group, `${group} must be a map of token names to property maps`, "group-not-map");
            return result;
        }
        for (const [name, entry] of Object.entries(value)) {
            if (!DesignMdParser.isMap(entry)) {
                this.issue(
                    "error",
                    `${group}.${name}`,
                    `${group}.${name} must be a map of properties`,
                    "entry-not-map"
                );
                continue;
            }
            const properties: Record<string, unknown> = {};
            for (const [property, propertyValue] of Object.entries(entry)) {
                if (typeof propertyValue === "string" || typeof propertyValue === "number") {
                    properties[property] = propertyValue;
                } else {
                    this.issue(
                        "error",
                        `${group}.${name}.${property}`,
                        `${group}.${name}.${property} must be text or a number`,
                        "property-type"
                    );
                }
            }
            result[name] = properties;
        }
        return result;
    }

    private parseBody(lines: string[]): { preamble: string; sections: DesignMdSection[] } {
        const sections: DesignMdSection[] = [];
        let current: string[] = [];
        let heading: string | null = null;
        let fence: string | null = null;
        const flush = () => {
            const body = DesignMdParser.trimBlankLines(current);
            if (heading !== null) {
                sections.push({ heading, body });
            }
            current = [];
            return body;
        };
        let preamble = "";
        for (const line of lines) {
            const fenceMatch = DesignMdParser.FENCE_PATTERN.exec(line);
            if (fenceMatch) {
                fence = fence === null ? fenceMatch[1] : fence === fenceMatch[1] ? null : fence;
            }
            const headingMatch = fence === null ? DesignMdParser.HEADING_PATTERN.exec(line) : null;
            if (headingMatch) {
                const body = flush();
                if (heading === null) {
                    preamble = body;
                }
                heading = headingMatch[1];
            } else {
                current.push(line);
            }
        }
        const body = flush();
        if (heading === null) {
            preamble = body;
        }
        return { preamble, sections };
    }

    private issue(
        severity: DesignMdIssue["severity"],
        path: string,
        message: string,
        code: string,
        params?: Record<string, string>
    ): void {
        this.issues.push(params ? { severity, path, message, code, params } : { severity, path, message, code });
    }

    private static trimBlankLines(lines: string[]): string {
        let start = 0;
        let end = lines.length;
        while (start < end && lines[start].trim() === "") {
            start++;
        }
        while (end > start && lines[end - 1].trim() === "") {
            end--;
        }
        return lines.slice(start, end).join("\n");
    }

    private static isMap(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
}
