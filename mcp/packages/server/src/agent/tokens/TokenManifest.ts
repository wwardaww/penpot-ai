import { createHash } from "crypto";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { DesignTokens, type TokenCategory, type TokenValue } from "./DesignTokens";
import type { ThemeFormat } from "./ThemeGenerator";
import { ThemeModel } from "./ThemeModel";

/** Code names and last value of one token in the theme block. */
export interface ManifestToken {
    type: string;
    category: TokenCategory;
    key: string;
    cssName: string;
    value: TokenValue;
}

/**
 * Record of the last theme block a sync wrote (`.penforge/token-theme.json`): where, in which
 * format, from which token sets, a hash of the block (to notice hand edits) and the code names of
 * every token (so names stay stable and tokens that left Penpot can be kept while the code still
 * uses them).
 */
export interface TokenManifestData {
    schemaVersion: 1;
    /** theme file relative to `app-src/` */
    file: string;
    format: ThemeFormat;
    /** name of the JS theme object (`tokens` unless the file already used that name) */
    objectName: string;
    /** active token sets the theme was made from, in order */
    sets: string[];
    themes: string[];
    /** sha256 of the block as written (LF line ends) */
    blockHash: string;
    /** by Penpot token name */
    tokens: Map<string, ManifestToken>;
}

/**
 * Store of the {@link TokenManifestData} in `.penforge/`.
 *
 * Reading checks the shape and drops entries with names that are not plain token names, so a
 * broken or hand-made file cannot inject names into the generated code.
 */
export class TokenManifest {
    public static readonly FILE = "token-theme.json";

    private constructor() {}

    /** Hash of a block's text. */
    public static hash(block: string): string {
        return createHash("sha256").update(block.replace(/\r\n/g, "\n")).digest("hex");
    }

    /** Reads the manifest, or null when missing or unusable. */
    public static async read(workspace: WorkflowWorkspaceApi): Promise<TokenManifestData | null> {
        let raw: unknown;
        try {
            raw = await workspace.readJson<unknown>(TokenManifest.FILE, null);
        } catch {
            return null;
        }
        if (typeof raw !== "object" || raw === null) {
            return null;
        }
        const data = raw as Record<string, unknown>;
        const strings = (value: unknown) =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
        if (data.schemaVersion !== 1 || typeof data.file !== "string" || typeof data.format !== "string") {
            return null;
        }
        const tokens = new Map<string, ManifestToken>();
        const entries = typeof data.tokens === "object" && data.tokens !== null ? data.tokens : {};
        for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
            const token = entry as Partial<ManifestToken> | null;
            const plain = /^[A-Za-z0-9]+$/;
            if (
                name.split(".").some((segment) => ["__proto__", "prototype", "constructor", ""].includes(segment)) ||
                typeof token?.type !== "string" ||
                typeof token.category !== "string" ||
                typeof token.key !== "string" ||
                !plain.test(token.key) ||
                typeof token.cssName !== "string" ||
                !/^[a-z0-9-]+$/.test(token.cssName) ||
                !ThemeModel.ORDER.includes(token.category as TokenCategory)
            ) {
                continue;
            }
            const value = DesignTokens.checkValue(token.value);
            if (value === null) {
                continue;
            }
            tokens.set(name, {
                type: token.type,
                category: token.category as TokenCategory,
                key: token.key,
                cssName: token.cssName,
                value,
            });
        }
        return {
            schemaVersion: 1,
            file: data.file,
            format: data.format as ThemeFormat,
            objectName:
                typeof data.objectName === "string" && /^[A-Za-z_$][\w$]*$/.test(data.objectName)
                    ? data.objectName
                    : "tokens",
            sets: strings(data.sets),
            themes: strings(data.themes),
            blockHash: typeof data.blockHash === "string" ? data.blockHash : "",
            tokens,
        };
    }

    /** Writes the manifest. */
    public static async write(workspace: WorkflowWorkspaceApi, data: TokenManifestData): Promise<void> {
        const tokens: Record<string, ManifestToken> = Object.create(null);
        for (const [name, token] of [...data.tokens].sort(([a], [b]) => a.localeCompare(b))) {
            tokens[name] = token;
        }
        await workspace.writeJson(TokenManifest.FILE, { ...data, tokens });
    }
}
