import path from "path";

/**
 * Output folder of a project on this computer (W41), as kept in `.penforge/project.json`
 * (`outputRoot`, `appRoot`, `outputAt`). Never sent to the Penpot backend.
 */
export interface ProjectOutput {
    /** folder Instruct writes to (real path); null until the user picked one for Instruct */
    outputRoot: string | null;
    /** the app folder, once Build prepared one; null while the app stays in the project folder */
    appRoot: string | null;
    /** ISO time of the last pick */
    outputAt: string;
}

/** Fields of `project.json` that hold a {@link ProjectOutput}. */
export interface ProjectOutputFields {
    outputRoot?: string | null;
    appRoot?: string | null;
    outputAt?: string;
}

/** Conversion between {@link ProjectOutput} and the `project.json` fields. */
export class ProjectOutputRecord {
    /**
     * Reads the output folder from `project.json` fields.
     *
     * @param fields - the parsed `project.json` (or null)
     * @returns the output folder, or null when the fields hold none or are malformed
     */
    public static read(fields: ProjectOutputFields | null | undefined): ProjectOutput | null {
        const outputRoot = ProjectOutputRecord.isFolder(fields?.outputRoot) ? fields.outputRoot : null;
        const appRoot = ProjectOutputRecord.isFolder(fields?.appRoot) ? fields.appRoot : null;
        if (!fields || (outputRoot === null && appRoot === null)) {
            return null;
        }
        return {
            outputRoot,
            appRoot,
            outputAt: typeof fields.outputAt === "string" ? fields.outputAt : "",
        };
    }

    /** Gets the `project.json` fields of an output folder. */
    public static fields(output: ProjectOutput): Required<ProjectOutputFields> {
        return { outputRoot: output.outputRoot, appRoot: output.appRoot, outputAt: output.outputAt };
    }

    private static isFolder(value: unknown): value is string {
        return typeof value === "string" && value.length > 0 && path.isAbsolute(value);
    }
}
