import { CssValues } from "./CssValues";
import { DesignMdReferences } from "./DesignMdReferences";
import type { DesignMdDocument } from "./DesignMdTypes";
import { PenpotImportPlanner } from "./PenpotImportPlan";

/** W3C Design Tokens (DTCG) group or token. */
type DtcgNode = { [key: string]: DtcgNode | string | number | Record<string, unknown> };

/**
 * Converter of DESIGN.md tokens to W3C Design Tokens Community Group JSON (`tokens.json`), the
 * format Penpot's token import and most token tools read.
 *
 * Groups are named like the Penpot tokens (`color`, `radius`, `spacing`, `typography`), so
 * references stay valid after an import into Penpot.
 */
export class DtcgTokens {
    private constructor() {}

    /**
     * Converts the tokens of a document.
     *
     * @param document - the document
     */
    public static fromDocument(document: DesignMdDocument): DtcgNode {
        const { tokens } = document;
        const result: DtcgNode = {};
        const prefix = PenpotImportPlanner.TOKEN_PREFIX;
        const value = (raw: unknown, group: "colors" | "rounded" | "spacing") => {
            const reference = DesignMdReferences.parse(raw);
            return reference ? `{${prefix[group]}.${reference.name}}` : raw;
        };
        if (Object.keys(tokens.colors).length > 0) {
            const colors: DtcgNode = {};
            for (const [name, raw] of Object.entries(tokens.colors)) {
                colors[name] = { $type: "color", $value: value(raw, "colors") as string };
            }
            result[prefix.colors] = colors;
        }
        if (Object.keys(tokens.typography).length > 0) {
            const typography: DtcgNode = {};
            for (const [name, entry] of Object.entries(tokens.typography)) {
                const composite: Record<string, unknown> = {};
                for (const [property, raw] of Object.entries(entry)) {
                    composite[property] = raw;
                }
                typography[name] = { $type: "typography", $value: composite };
            }
            result.typography = typography;
        }
        for (const group of ["rounded", "spacing"] as const) {
            const entries = Object.entries(tokens[group]);
            if (entries.length === 0) {
                continue;
            }
            const node: DtcgNode = {};
            for (const [name, raw] of entries) {
                const unitless = DesignMdReferences.parse(raw) === null ? CssValues.parseNumber(raw) : null;
                node[name] =
                    unitless !== null
                        ? { $type: "number", $value: unitless }
                        : { $type: "dimension", $value: value(raw, group) as string };
            }
            result[prefix[group]] = node;
        }
        return result;
    }
}
