import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { WorkflowWorkspaceApi } from "@penpot/mcp-common";
import { QaConfig } from "./QaConfig";
import { QaRun, type QaScreenReport, type VisualQaServices } from "./QaRun";
import { QaSessionTools } from "./QaSessionTools";
import { QaError, type QaEnv, type QaShot, VisualQa } from "./VisualQa";

/** Request of the `penforge_visual_qa` tool. */
export interface QaChatRequest {
    fileId: string;
    boardIds?: string[];
    commit?: boolean;
    sessionId?: string;
}

/** Content block of the tool's answer. */
export type QaChatContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Visual QA for the AI chat (`penforge_visual_qa` MCP tool): Claude, in a chat turn, checks the
 * running app against the design, sees the worst screen's images, fixes the code itself with its
 * file tools, checks again, and finally asks Penforge to commit (`commit: true`).
 *
 * The tool runs inside the MCP server, outside any client session, so it finds the project by
 * the file id (`.penforge/project.json` `fileIds`, recorded when a tab opens the project).
 */
export class QaChat {
    /** failing screens whose images go back to Claude */
    private static readonly IMAGE_SCREENS = 1;

    constructor(private readonly services: VisualQaServices) {}

    public async handle(request: QaChatRequest): Promise<QaChatContent[]> {
        const workspace = await this.findWorkspace(request.fileId);
        if (request.commit) {
            const commit = await workspace.commitAll("app-src", "penforge(qa): match the app to the design");
            return [QaChat.text({ commit, message: commit ? "Code changes committed." : "Nothing to commit." })];
        }
        if (!this.services.tools) {
            throw new Error("Penpot tools are not available in this daemon.");
        }
        const sessionId = request.sessionId;
        const env: QaEnv = {
            workspace,
            tools: new QaSessionTools(
                this.services.tools.forSession(() => sessionId),
                request.fileId,
                sessionId
            ),
            fileId: request.fileId,
            progress: () => {},
        };
        const settings = await new QaConfig(workspace).read();
        try {
            const { screens, skipped } = await VisualQa.screens(env, request.boardIds ?? []);
            if (screens.length === 0) {
                throw new QaError("None of the screens can be opened in the app.", "no-screens");
            }
            const run = await QaRun.start(env, this.services, settings);
            try {
                const shots: QaShot[] = [];
                for (const screen of screens) {
                    shots.push(await run.qa.check(screen));
                }
                const reports: QaScreenReport[] = [];
                for (const shot of shots) {
                    reports.push(await run.screenReport(shot, { images: false, developer: true }));
                }
                const summary = {
                    runName: run.qa.runName,
                    threshold: settings.threshold,
                    score: QaRun.averageScore(shots),
                    passed: shots.every((shot) => shot.passed),
                    screens: reports.map((report, index) => ({
                        ...report,
                        files: shots[index].screen.files,
                        regions: shots[index].regions,
                    })),
                    skippedScreens: QaRun.skippedReport(skipped),
                };
                await run.qa.writeReport({ ...summary, source: "chat", createdAt: new Date().toISOString() });
                await VisualQa.prune(workspace);
                return [QaChat.text(summary), ...QaChat.images(shots), QaChat.text(QaChat.advice(summary.passed))];
            } finally {
                await run.close();
            }
        } catch (error) {
            if (error instanceof QaError) {
                return [QaChat.text({ error: error.code, message: error.message })];
            }
            throw error;
        }
    }

    /**
     * Finds the project folder whose `.penforge/project.json` lists the file.
     *
     * @throws Error when no project has opened the file
     */
    private async findWorkspace(fileId: string): Promise<WorkflowWorkspaceApi> {
        let names: string[] = [];
        try {
            names = (await readdir(this.services.projectsDir, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name);
        } catch {
            names = [];
        }
        let found: { projectId: string; updatedAt: string } | null = null;
        for (const name of names) {
            const info = await QaChat.projectInfo(join(this.services.projectsDir, name));
            if (info && Array.isArray(info.fileIds) && info.fileIds.includes(fileId)) {
                const updatedAt = String(info.updatedAt ?? "");
                if (!found || updatedAt > found.updatedAt) {
                    found = { projectId: name, updatedAt };
                }
            }
        }
        if (!found) {
            throw new Error(`No Penforge project has the file ${fileId}; open it in Penpot first.`);
        }
        return this.services.workspaces.get(found.projectId);
    }

    private static async projectInfo(dir: string): Promise<{ fileIds?: unknown; updatedAt?: unknown } | null> {
        try {
            return JSON.parse(await readFile(join(dir, ".penforge", "project.json"), "utf8"));
        } catch {
            return null;
        }
    }

    private static images(shots: QaShot[]): QaChatContent[] {
        return shots
            .filter((shot) => !shot.passed)
            .sort((a, b) => a.score - b.score)
            .slice(0, QaChat.IMAGE_SCREENS)
            .flatMap((shot) => [
                QaChat.text(
                    `Images of "${shot.screen.name}" (score ${shot.score}): 1. design, 2. app now, ` +
                        "3. differences (red = differs, grey = design)."
                ),
                { type: "image" as const, data: shot.design.toString("base64"), mimeType: "image/png" },
                { type: "image" as const, data: shot.app.toString("base64"), mimeType: "image/png" },
                { type: "image" as const, data: shot.diff.toString("base64"), mimeType: "image/png" },
            ]);
    }

    private static advice(passed: boolean): string {
        return passed
            ? "Every screen matches the design. Tell the user; no code change is needed."
            : "Screens below the threshold differ from the design. To fix them, change only the listed " +
                  "files in app-src/ (read exact values with get_node_properties / generate_code_hints; " +
                  "never change the design), then call penforge_visual_qa again with their boardIds to " +
                  "re-check (the saved PNG paths are in the project folder). Stop after 3 rounds or when a " +
                  "change does not raise the score (undo it). When done, call it once with commit: true " +
                  "to save the code, and tell the user the scores before and after.";
    }

    private static text(value: unknown): QaChatContent {
        return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
    }
}
