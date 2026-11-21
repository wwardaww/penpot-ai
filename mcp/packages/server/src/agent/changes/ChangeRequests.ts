import { mkdir, readdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { z } from "zod";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { type BuildInstructionSet } from "./BuildInstructions";
import { type ChangeItem, type ChangeSet, ChangeSetSchema, type ScreenChange } from "./ChangeSet";

/** A change request (`.penforge/changes/CR-<n>.json`). */
export const ChangeRequestSchema = z.object({
    schemaVersion: z.literal(1),
    /** `CR-<n>` */
    id: z.string().regex(/^CR-\d+$/),
    n: z.number().int().min(1),
    createdAt: z.string(),
    fileId: z.string(),
    /** build the changes are measured from (0: a build made before change requests) */
    baseBuild: z.number().int().min(0),
    changes: ChangeSetSchema,
    instructions: z.object({ text: z.string(), kept: z.string() }),
    /** build that carried out the request, once done */
    builtAs: z.number().int().nullable().default(null),
});

export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

/**
 * Store and wording of the change requests: `.penforge/changes/CR-<n>.json` (read by the build)
 * and `CR-<n>.md`, the short plain-words list grouped by screen that the AI reads instead of the
 * whole design.
 */
export class ChangeRequests {
    public static readonly DIR = "changes";
    private static readonly ID = /^CR-(\d+)\.json$/;

    constructor(private readonly workspace: WorkflowWorkspaceApi) {}

    /**
     * Writes a new change request.
     *
     * @param fileId - the Penpot file
     * @param baseBuild - number of the build the changes are measured from
     * @param changes - the detected changes
     * @param instructions - the instructions for the AI of this update
     */
    public async create(
        fileId: string,
        baseBuild: number,
        changes: ChangeSet,
        instructions: BuildInstructionSet
    ): Promise<ChangeRequest> {
        const n = (await this.lastNumber()) + 1;
        const request: ChangeRequest = {
            schemaVersion: 1,
            id: `CR-${n}`,
            n,
            createdAt: new Date().toISOString(),
            fileId,
            baseBuild,
            changes,
            instructions: { text: instructions.text, kept: instructions.kept },
            builtAs: null,
        };
        await this.save(request);
        return request;
    }

    /** Reads a change request; null when missing or invalid. */
    public async read(id: string): Promise<ChangeRequest | null> {
        if (!/^CR-\d+$/.test(id)) {
            return null;
        }
        try {
            const parsed = ChangeRequestSchema.safeParse(
                await this.workspace.readJson<unknown>(`${ChangeRequests.DIR}/${id}.json`, null)
            );
            return parsed.success ? parsed.data : null;
        } catch {
            return null;
        }
    }

    /** Marks a request as carried out by a build. */
    public async markBuilt(request: ChangeRequest, build: number): Promise<void> {
        await this.save({ ...request, builtAs: build });
    }

    /** True when the request asks for nothing: no change and no instructions. */
    public static isEmpty(request: ChangeRequest): boolean {
        return request.changes.count === 0 && request.instructions.text.length === 0;
    }

    /**
     * Markdown of a change request: screens first, then tokens, flows, design system and the
     * instructions for the AI.
     */
    public static markdown(request: ChangeRequest): string {
        const { changes } = request;
        const lines = [
            `# Change request ${request.id}`,
            "",
            `Changes since ${request.baseBuild > 0 ? `build ${request.baseBuild}` : "the last build"}, written ${request.createdAt}.`,
        ];
        if (changes.baseline === "hashes") {
            lines.push(
                "",
                "No design state was saved with that build, so the list names the screens that changed, " +
                    "not the single changes. Compare each screen with the code."
            );
        }
        if (changes.screens.length > 0) {
            lines.push("", "## Screens");
            for (const screen of changes.screens) {
                lines.push("", `### ${screen.name} (${ChangeRequests.statusText(screen)})`, "");
                lines.push(...ChangeRequests.screenLines(screen));
            }
        }
        ChangeRequests.section(lines, "## Design tokens", changes.tokens);
        ChangeRequests.section(lines, "## Prototype flows", changes.flows);
        ChangeRequests.section(lines, "## Design system", changes.designSystem ? [changes.designSystem] : []);
        if (request.instructions.text.length > 0 || request.instructions.kept.length > 0) {
            lines.push("", "## Instructions for the AI");
            if (request.instructions.text.length > 0) {
                lines.push("", "New with this update:", "", request.instructions.text);
            }
            if (request.instructions.kept.length > 0) {
                lines.push("", "Kept for every build:", "", request.instructions.kept);
            }
        }
        if (changes.count === 0 && request.instructions.text.length === 0) {
            lines.push("", "Nothing changed.");
        }
        return lines.join("\n") + "\n";
    }

    /** Bullet lines of one screen's changes. */
    public static screenLines(screen: ScreenChange): string[] {
        switch (screen.status) {
            case "added":
                return ["- New screen: build it from the board."];
            case "removed":
                return ["- The screen was deleted from the design: remove it from the app."];
            case "renamed":
                return [`- Renamed from "${screen.previousName ?? "?"}".`];
            default: {
                const lines = screen.items.map((item) => `- ${item.text}`);
                if (screen.previousName) {
                    lines.unshift(`- Renamed from "${screen.previousName}".`);
                }
                if (screen.more > 0) {
                    lines.push(`- …and ${screen.more} more changes on this screen.`);
                }
                return lines;
            }
        }
    }

    /** Lines of the app-wide part (tokens, flows, design system), or none. */
    public static appWideLines(request: ChangeRequest): string[] {
        const lines: string[] = [];
        ChangeRequests.section(
            lines,
            "### Design tokens (the theme file follows them already)",
            request.changes.tokens
        );
        ChangeRequests.section(lines, "### Prototype flows", request.changes.flows);
        ChangeRequests.section(
            lines,
            "### Design system",
            request.changes.designSystem ? [request.changes.designSystem] : []
        );
        return lines;
    }

    private async save(request: ChangeRequest): Promise<void> {
        await this.workspace.writeJson(`${ChangeRequests.DIR}/${request.id}.json`, request);
        const file = this.workspace.resolve(join(this.workspace.metaDir, ChangeRequests.DIR, `${request.id}.md`));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, ChangeRequests.markdown(request), "utf8");
    }

    private async lastNumber(): Promise<number> {
        let names: string[];
        try {
            names = await readdir(this.workspace.resolve(join(this.workspace.metaDir, ChangeRequests.DIR)));
        } catch {
            return 0;
        }
        return Math.max(0, ...names.map((name) => Number(ChangeRequests.ID.exec(name)?.[1] ?? 0)));
    }

    private static section(lines: string[], title: string, items: ChangeItem[]): void {
        if (items.length > 0) {
            lines.push("", title, "", ...items.map((item) => `- ${item.text}`));
        }
    }

    private static statusText(screen: ScreenChange): string {
        switch (screen.status) {
            case "added":
                return "new";
            case "removed":
                return "removed";
            case "renamed":
                return "renamed";
            default:
                return "changed";
        }
    }
}
