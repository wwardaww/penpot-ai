import type { DesignMdTokens } from "./DesignMdTypes";

/** Token reference such as `{colors.primary}`. */
export interface DesignMdReference {
    group: string;
    name: string;
}

/** Result of resolving a value. */
export type ResolvedValue = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Token references of one DESIGN.md: parsing `{group.name}` and following them to literal values.
 */
export class DesignMdReferences {
    private static readonly PATTERN = /^\{([A-Za-z]+)\.([^{}\s]+)\}$/;
    private static readonly GROUPS = ["colors", "typography", "rounded", "spacing", "components"];

    /**
     * @param tokens - the tokens references point into
     */
    constructor(private readonly tokens: DesignMdTokens) {}

    /**
     * Parses a reference.
     *
     * @param value - any value
     * @returns the reference, or null if the value is not one
     */
    public static parse(value: unknown): DesignMdReference | null {
        if (typeof value !== "string") {
            return null;
        }
        const match = DesignMdReferences.PATTERN.exec(value.trim());
        return match ? { group: match[1], name: match[2] } : null;
    }

    /**
     * Formats a reference.
     */
    public static format(group: string, name: string): string {
        return `{${group}.${name}}`;
    }

    /**
     * Gets the raw value a reference points at.
     *
     * @returns the value, or undefined if there is none
     */
    public lookup(reference: DesignMdReference): unknown {
        if (!DesignMdReferences.GROUPS.includes(reference.group)) {
            return undefined;
        }
        const group = this.tokens[reference.group as keyof DesignMdTokens] as Record<string, unknown>;
        return Object.prototype.hasOwnProperty.call(group, reference.name) ? group[reference.name] : undefined;
    }

    /**
     * Follows references until a literal value.
     *
     * @param value - a literal or a reference
     * @param expectedGroup - when set, every reference on the way must point into this group
     */
    public resolve(value: unknown, expectedGroup?: string): ResolvedValue {
        const seen = new Set<string>();
        let current = value;
        for (;;) {
            const reference = DesignMdReferences.parse(current);
            if (reference === null) {
                return { ok: true, value: current };
            }
            const key = `${reference.group}.${reference.name}`;
            if (seen.has(key)) {
                return { ok: false, error: `Reference cycle through {${key}}` };
            }
            seen.add(key);
            if (expectedGroup !== undefined && reference.group !== expectedGroup) {
                return { ok: false, error: `{${key}} must point into ${expectedGroup}` };
            }
            const target = this.lookup(reference);
            if (target === undefined) {
                return { ok: false, error: `{${key}} points to a token that does not exist` };
            }
            current = target;
        }
    }
}
