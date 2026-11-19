import { DesignMdBody, DesignMdReferences, PenpotImportPlanner, type DesignMdDocument } from "../designmd";

/** Components every design system gets unless the brand clearly has no use for one. */
export const BASE_COMPONENTS = [
    "button",
    "icon button",
    "text input",
    "checkbox",
    "radio",
    "switch",
    "select",
    "card",
    "list item",
    "tab bar",
    "navigation bar",
    "modal",
    "toast",
    "badge",
    "avatar",
];

/**
 * The user message of the components stage: the component specs of DESIGN.md (references
 * resolved and mapped to their Penpot library entries and tokens), its usage notes, and the base
 * list of components to cover.
 *
 * @param document - the parsed DESIGN.md
 */
export function componentBrief(document: DesignMdDocument): string {
    const references = new DesignMdReferences(document.tokens);
    const specs = Object.entries(document.tokens.components).map(([key, component]) => {
        const properties: Record<string, unknown> = {};
        for (const [property, value] of Object.entries(component)) {
            const resolved = references.resolve(value);
            const reference = DesignMdReferences.parse(value);
            properties[property] =
                reference && resolved.ok
                    ? { value, resolved: resolved.value, use: penpotName(reference.group, reference.name) }
                    : value;
        }
        return { key, properties };
    });
    const notes = DesignMdBody.section(document, "Components")?.body ?? "";
    const elevation = DesignMdBody.section(document, "Elevation & Depth")?.body ?? "";
    return [
        `Design system: ${document.tokens.name ?? "(no name)"}`,
        "",
        "Components to cover (skip only those the brand clearly has no use for; add what it needs):",
        BASE_COMPONENTS.map((name) => `- ${name}`).join("\n"),
        "",
        specs.length > 0
            ? [
                  "Component specs from DESIGN.md (implement each key; tag it, see the rules):",
                  "",
                  "```json",
                  JSON.stringify(specs, null, 2),
                  "```",
              ].join("\n")
            : "DESIGN.md has no component specs: derive the components from its colors, typography, radius and spacing.",
        notes.length > 0 ? ["", "Usage notes from DESIGN.md:", "", notes].join("\n") : null,
        elevation.length > 0 ? ["", "Elevation notes from DESIGN.md:", "", elevation].join("\n") : null,
    ]
        .filter((part): part is string => part !== null)
        .join("\n");
}

function penpotName(group: string, name: string): string {
    switch (group) {
        case "colors":
            return `library color "${name}" / token ${PenpotImportPlanner.TOKEN_PREFIX.colors}.${name}`;
        case "typography":
            return `library typography "${name}"`;
        case "rounded":
            return `token ${PenpotImportPlanner.TOKEN_PREFIX.rounded}.${name}`;
        case "spacing":
            return `token ${PenpotImportPlanner.TOKEN_PREFIX.spacing}.${name}`;
        default:
            return `${group}.${name}`;
    }
}
