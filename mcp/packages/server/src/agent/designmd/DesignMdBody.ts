import type { DesignMdDocument, DesignMdSection } from "./DesignMdTypes";
import { DesignMdValidator } from "./DesignMdValidator";

/**
 * Editor of the Markdown body of a DESIGN.md: section text and the `### <component-key>` usage
 * notes inside `## Components`. Returns new documents; never changes the one it gets.
 */
export class DesignMdBody {
    private static readonly SUBHEADING_PATTERN = /^###[ \t]+(.+?)[ \t]*#*[ \t]*$/;
    private static readonly COMPONENTS = "Components";

    private constructor() {}

    /**
     * Gets a section by heading (case-insensitive, aliases included).
     */
    public static section(document: DesignMdDocument, heading: string): DesignMdSection | undefined {
        const index = DesignMdValidator.sectionIndex(heading);
        return document.sections.find((section) =>
            index >= 0
                ? DesignMdValidator.sectionIndex(section.heading) === index
                : section.heading.trim().toLowerCase() === heading.trim().toLowerCase()
        );
    }

    /**
     * Gets the component keys that have a `###` subsection under `## Components`.
     */
    public static componentNoteKeys(document: DesignMdDocument): Set<string> {
        const body = DesignMdBody.section(document, DesignMdBody.COMPONENTS)?.body ?? "";
        const keys = new Set<string>();
        for (const line of body.split("\n")) {
            const match = DesignMdBody.SUBHEADING_PATTERN.exec(line);
            if (match) {
                keys.add(match[1].trim());
            }
        }
        return keys;
    }

    /**
     * Sets the text of a section that is empty or missing; sections with text stay as they are.
     * A missing canonical section is inserted at its spec position.
     *
     * @returns the new document
     */
    public static fillSection(document: DesignMdDocument, heading: string, text: string): DesignMdDocument {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            return document;
        }
        const existing = DesignMdBody.section(document, heading);
        if (existing && existing.body.trim().length > 0) {
            return document;
        }
        if (existing) {
            return {
                ...document,
                sections: document.sections.map((section) =>
                    section === existing ? { ...section, body: trimmed } : section
                ),
            };
        }
        return { ...document, sections: DesignMdBody.insert(document.sections, { heading, body: trimmed }) };
    }

    /**
     * Adds usage notes for components that have none yet, as `### <key>` subsections at the end of
     * `## Components` (created when missing).
     *
     * @param notes - component key to Markdown text
     * @returns the new document
     */
    public static addComponentNotes(document: DesignMdDocument, notes: Record<string, string>): DesignMdDocument {
        const known = DesignMdBody.componentNoteKeys(document);
        const additions = Object.entries(notes)
            .filter(([key, text]) => !known.has(key) && text.trim().length > 0)
            .map(([key, text]) => `### ${key}\n\n${DesignMdBody.demoteHeadings(text.trim())}`);
        if (additions.length === 0) {
            return document;
        }
        const existing = DesignMdBody.section(document, DesignMdBody.COMPONENTS);
        if (existing) {
            const body = [existing.body, ...additions].filter((part) => part.trim().length > 0).join("\n\n");
            return {
                ...document,
                sections: document.sections.map((section) => (section === existing ? { ...section, body } : section)),
            };
        }
        return {
            ...document,
            sections: DesignMdBody.insert(document.sections, {
                heading: DesignMdBody.COMPONENTS,
                body: additions.join("\n\n"),
            }),
        };
    }

    /** Inserts a canonical section before the first section that comes after it in spec order. */
    private static insert(sections: DesignMdSection[], section: DesignMdSection): DesignMdSection[] {
        const index = DesignMdValidator.sectionIndex(section.heading);
        const position = sections.findIndex((other) => DesignMdValidator.sectionIndex(other.heading) > index);
        return position < 0
            ? [...sections, section]
            : [...sections.slice(0, position), section, ...sections.slice(position)];
    }

    /** Keeps note text from opening new `##`/`###` sections. */
    private static demoteHeadings(text: string): string {
        return text.replace(/^(#{1,3})([ \t])/gm, "####$2");
    }
}
