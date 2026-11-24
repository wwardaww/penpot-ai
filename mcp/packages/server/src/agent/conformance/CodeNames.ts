import { MotionCode } from "./MotionCode";

/**
 * Names that code may give to a thing of the design.
 */
export class CodeNames {
    private constructor() {}

    /** Component name of a board or component: `order summary` → `OrderSummary`. */
    public static component(name: string): string {
        const pascal = MotionCode.pascal(CodeNames.ascii(name));
        return pascal.length === 0 ? "Screen" : /^[0-9]/.test(pascal) ? `Screen${pascal}` : pascal;
    }

    /** Spellings of a board's name in code: PascalCase, camelCase, kebab-case and as drawn. */
    public static variants(name: string): string[] {
        const pascal = CodeNames.component(name);
        return [
            ...new Set([
                pascal,
                pascal.charAt(0).toLowerCase() + pascal.slice(1),
                MotionCode.kebab(pascal),
                name.trim(),
            ]),
        ].filter((variant) => variant.length > 1);
    }

    /**
     * Names a design component may have in code: `Button` / `Primary` → `Primary`, `ButtonPrimary`,
     * `PrimaryButton`, `Button`.
     *
     * @param path - path of the component in the library (`Buttons/Main`)
     * @param name - its name; variant properties after a comma or `=` are left out
     */
    public static componentNames(path: string, name: string): string[] {
        const clean = CodeNames.component(name.split(/[,=]/)[0]);
        const folder = path
            .split("/")
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .pop();
        const parent = folder === undefined ? "" : CodeNames.component(folder);
        const single = parent.replace(/s$/, "");
        return [
            ...new Set([
                clean,
                ...(parent.length > 0
                    ? [
                          `${parent}${clean}`,
                          `${clean}${parent}`,
                          `${single}${clean}`,
                          `${clean}${single}`,
                          parent,
                          single,
                      ]
                    : []),
                `${clean}Component`,
            ]),
        ].filter((candidate) => candidate.length > 1);
    }

    /** Pattern of a name as a whole word. */
    public static word(name: string): RegExp {
        return new RegExp(`(?<![A-Za-z0-9_$])${CodeNames.escape(name)}(?![A-Za-z0-9_$])`);
    }

    public static escape(text: string): string {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private static ascii(name: string): string {
        return name
            .normalize("NFKD")
            .replace(/\p{Mn}/gu, "")
            .replace(/ı/g, "i");
    }
}
